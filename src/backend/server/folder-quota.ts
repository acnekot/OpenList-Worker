import { resolvePath } from "../internal/model/db"
import { getDriver } from "../internal/op/storage"
import type { UserPermissionObj } from "../pkg/permission"

type QuotaPolicy = { base_path: string; limit_bytes: number }

function policies(env: any): Record<string, QuotaPolicy> {
  try {
    return JSON.parse(String(env?.USER_FOLDER_QUOTAS || "{}"))
  } catch {
    throw new Error("Invalid USER_FOLDER_QUOTAS configuration")
  }
}

export function folderQuotaPolicy(user: UserPermissionObj | null | undefined, env: any): QuotaPolicy | null {
  if (!user?.username || user.disabled) return null
  const policy = policies(env)[user.username]
  if (!policy && user.username === "wxb_nb") {
    throw new Error("Required folder quota policy is missing")
  }
  if (!policy) return null
  if (!policy.base_path?.startsWith("/") ||
      !Number.isSafeInteger(policy.limit_bytes) || policy.limit_bytes <= 0 ||
      user.base_path?.replace(/\/$/, "") !== policy.base_path.replace(/\/$/, "")) {
    throw new Error("User folder quota configuration does not match account root")
  }
  return policy
}

async function liveUsage(policy: QuotaPolicy, env: any): Promise<{ used: number; scannedAt: number }> {
  const scannedAt = Date.now()
  const resolved = await resolvePath(policy.base_path, env)
  if (!resolved.storage || resolved.isVirtual || !resolved.physical) {
    throw new Error("Quota folder is unavailable")
  }
  const driver = await getDriver(resolved.storage.driver, resolved.storage)
  if (typeof (driver as any).getFolderUsage !== "function") {
    throw new Error("Quota folder is not on Google Drive")
  }
  const used = await (driver as any).getFolderUsage(resolved.physical)
  return { used, scannedAt }
}

function database(env: any) {
  if (!env?.DB?.prepare) throw new Error("Quota database is unavailable")
  return env.DB
}

export async function folderQuotaStatus(user: UserPermissionObj, env: any) {
  const policy = folderQuotaPolicy(user, env)
  if (!policy) return null
  const { used } = await liveUsage(policy, env)
  return { used, limit: policy.limit_bytes }
}

export async function reserveFolderQuota(
  user: UserPermissionObj,
  env: any,
  bytes: number,
): Promise<string | null> {
  const policy = folderQuotaPolicy(user, env)
  if (!policy) return null
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Invalid upload size")
  if (bytes > policy.limit_bytes) throw new Error("文件超过 500 GiB 容量上限")
  const { used, scannedAt } = await liveUsage(policy, env)
  const id = crypto.randomUUID()
  const now = Date.now()
  await database(env).prepare(
    "DELETE FROM user_quota_reservations WHERE (completed_at IS NOT NULL AND completed_at < ?) OR (completed_at IS NULL AND expires_at < ?)",
  ).bind(now - 60 * 60 * 1000, now).run()
  // A completed upload remains reserved when a concurrent scan began before
  // it finished. The extra minute covers Drive list propagation lag.
  const result = await database(env).prepare(`
    INSERT INTO user_quota_reservations (id, username, bytes, expires_at, completed_at)
    SELECT ?, ?, ?, ?, NULL
    WHERE ? + ? + COALESCE((
      SELECT SUM(bytes) FROM user_quota_reservations
      WHERE username = ? AND (
        (completed_at IS NULL AND expires_at > ?) OR completed_at > ?
      )
    ), 0) <= ?
  `).bind(id, user.username, bytes, now + 7 * 60 * 60 * 1000,
    used, bytes, user.username, now, scannedAt - 60_000, policy.limit_bytes).run()
  if (result.meta?.changes !== 1) throw new Error("此用户的 500 GiB 文件夹容量不足")
  return id
}

export async function completeFolderQuotaReservation(env: any, id: string | null | undefined) {
  if (!id) return
  await database(env).prepare(
    "UPDATE user_quota_reservations SET completed_at = ? WHERE id = ? AND completed_at IS NULL",
  ).bind(Date.now(), id).run()
}

export async function releaseFolderQuotaReservation(env: any, id: string | null | undefined) {
  if (!id) return
  await database(env).prepare(
    "DELETE FROM user_quota_reservations WHERE id = ? AND completed_at IS NULL",
  ).bind(id).run()
}

export async function activeFolderQuotaReservation(env: any, id: string | null | undefined) {
  if (!id) return true
  const row = await database(env).prepare(
    "SELECT id FROM user_quota_reservations WHERE id = ? AND expires_at > ?",
  ).bind(id, Date.now()).first()
  return !!row
}
