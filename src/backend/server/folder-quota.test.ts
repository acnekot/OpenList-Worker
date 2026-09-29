import assert from "node:assert/strict"
import test from "node:test"
import { folderQuotaPolicy, reserveFolderQuota } from "./folder-quota"

const user = { username: "wxb_nb", role: 0, permission: 8, base_path: "/GoogleDrive2/wxb_nb" }
const env = { USER_FOLDER_QUOTAS: JSON.stringify({
  wxb_nb: { base_path: "/GoogleDrive2/wxb_nb", limit_bytes: 500 * 1024 ** 3 },
}) }

test("the quota account is bound to its exact root and rejects oversized files before contacting Drive", async () => {
  assert.equal(folderQuotaPolicy(user, env)?.limit_bytes, 500 * 1024 ** 3)
  assert.throws(() => folderQuotaPolicy({ ...user, base_path: "/GoogleDrive2" }, env), /does not match/)
  await assert.rejects(
    reserveFolderQuota(user, env, 500 * 1024 ** 3 + 1),
    /500 GiB/,
  )
})
