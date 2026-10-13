import assert from "node:assert/strict"
import test, { afterEach } from "node:test"
import { saveDb } from "../../internal/model/db"
import { copyItems, getDriver, moveItems } from "../../internal/op/storage"
import { GoogleDrive } from "./driver"
import { GoogleDriveClient } from "./util"

/**
 * Regression: moving or copying inside a mounted Google Drive (for example
 * /GoogleDrive2) failed with "[GoogleDrive] Path 'GoogleDrive2' not found",
 * because the destination folder was looked up by its virtual path, which
 * still contains the mount name.
 */
const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

function recordingDriver() {
  const driver = new GoogleDrive({} as any)
  const client: any = (driver as any).client
  const resolved: string[] = []
  const calls: unknown[][] = []
  client.resolveFileId = async (path: string) => {
    resolved.push(path)
    return `id:${path}`
  }
  client.move = async (...args: unknown[]) => calls.push(["move", ...args])
  client.copy = async (...args: unknown[]) => calls.push(["copy", ...args])
  return { driver, resolved, calls }
}

test("move resolves the destination folder inside the storage, not by its mount path", async () => {
  const { driver, resolved, calls } = recordingDriver()
  // What moveItems passes for /GoogleDrive2/a.zip -> /GoogleDrive2/VRChat/a.zip
  await driver.move("/GoogleDrive2", "/GoogleDrive2/VRChat", ["a.zip"], "/a.zip", "/VRChat/a.zip")
  assert.deepEqual(resolved, ["/a.zip", "/", "/VRChat"])
  assert.deepEqual(calls, [["move", "id:/a.zip", "id:/", "id:/VRChat"]])
})

test("move out of a subfolder into the storage root", async () => {
  const { driver, resolved, calls } = recordingDriver()
  await driver.move("/GoogleDrive2/Docs", "/GoogleDrive2", ["a.zip"], "/Docs/a.zip", "/a.zip")
  assert.deepEqual(resolved, ["/Docs/a.zip", "/Docs", "/"])
  assert.deepEqual(calls, [["move", "id:/Docs/a.zip", "id:/Docs", "id:/"]])
})

test("copy resolves the destination folder inside the storage", async () => {
  const { driver, resolved, calls } = recordingDriver()
  await driver.copy("/GoogleDrive2", "/GoogleDrive2/VRChat", ["a.zip"], "/a.zip", "/VRChat/a.zip")
  assert.deepEqual(resolved, ["/a.zip", "/VRChat"])
  assert.deepEqual(calls, [["copy", "id:/a.zip", "id:/VRChat", "a.zip"]])
})

test("forget drops a path and its descendants from the id cache only", () => {
  const client: any = new GoogleDriveClient({} as any)
  for (const key of ["a", "a/b", "a/b/c", "ab", "c"]) client.pathCache.set(key, key)
  client.forget("/a")
  assert.deepEqual([...client.pathCache.keys()].sort(), ["ab", "c"])
  client.forget("/")
  assert.equal(client.pathCache.size, 0)
})

// A tiny Drive: root -> { VRChat/, a.zip }
function fakeDrive() {
  const children: Record<string, Array<{ id: string; name: string; mimeType: string }>> = {
    root: [
      { id: "vrchat-id", name: "VRChat", mimeType: "application/vnd.google-apps.folder" },
      { id: "zip-id", name: "a.zip", mimeType: "application/zip" },
    ],
    "vrchat-id": [],
  }
  const patches: Array<{ id: string; add: string | null; remove: string | null }> = []
  const copies: Array<{ id: string; body: any }> = []
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = new URL(String(input))
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
    if (url.pathname === "/drive/v3/files" && init.method === undefined) {
      const parent = /'([^']+)' in parents/.exec(url.searchParams.get("q") || "")?.[1] || ""
      return json({ files: children[parent] || [] })
    }
    const patch = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname)
    if (patch && init.method === "PATCH") {
      patches.push({
        id: patch[1],
        add: url.searchParams.get("addParents"),
        remove: url.searchParams.get("removeParents"),
      })
      return json({})
    }
    const copy = /^\/drive\/v3\/files\/([^/]+)\/copy$/.exec(url.pathname)
    if (copy && init.method === "POST") {
      copies.push({ id: copy[1], body: JSON.parse(init.body) })
      return json({})
    }
    throw new Error(`unexpected Drive call: ${init.method || "GET"} ${url}`)
  }) as any
  return { patches, copies }
}

async function seedStorages() {
  const storage = (id: number, mount: string) => ({
    id, mount_path: mount, driver: "GoogleDrive", disabled: false,
    modified: `2026-10-13T00:00:0${id}Z`, addition: "{}",
  })
  await saveDb({ settings: [], users: [], metas: [], shares: [], storages: [storage(1, "/GoogleDrive"), storage(2, "/GoogleDrive2")] }, {})
  // Skip the OAuth refresh: hand each cached driver a live access token.
  const dbStorages = [storage(1, "/GoogleDrive"), storage(2, "/GoogleDrive2")]
  for (const s of dbStorages) {
    const driver: any = await getDriver(s.driver, s)
    driver.client.accessToken = "test-token"
    driver.client.tokenExpiresAt = Date.now() + 3_600_000
  }
}

test("moveItems inside /GoogleDrive2 puts the file in the VRChat folder", async () => {
  await seedStorages()
  const drive = fakeDrive()
  await moveItems("/GoogleDrive2", "/GoogleDrive2/VRChat", ["a.zip"])
  assert.deepEqual(drive.patches, [{ id: "zip-id", add: "vrchat-id", remove: "root" }])
})

test("copyItems inside /GoogleDrive2 copies the file into the VRChat folder", async () => {
  await seedStorages()
  const drive = fakeDrive()
  await copyItems("/GoogleDrive2", "/GoogleDrive2/VRChat", ["a.zip"])
  assert.deepEqual(drive.copies, [{ id: "zip-id", body: { name: "a.zip", parents: ["vrchat-id"] } }])
})

test("moving or copying between two Google Drive storages is refused, not misrouted", async () => {
  await seedStorages()
  const drive = fakeDrive()
  await assert.rejects(moveItems("/GoogleDrive", "/GoogleDrive2/VRChat", ["a.zip"]), /different Google Drive storages/)
  await assert.rejects(copyItems("/GoogleDrive", "/GoogleDrive2", ["a.zip"]), /different Google Drive storages/)
  assert.deepEqual(drive.patches, [])
  assert.deepEqual(drive.copies, [])
})
