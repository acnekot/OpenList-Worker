import assert from "node:assert/strict"
import test from "node:test"
import { GoogleDriveClient } from "./util"

test("Google Drive large upload starts a resumable session with the target folder and file size", async () => {
  const client = new GoogleDriveClient({} as any)
  ;(client as any).accessToken = "test-access-token"
  ;(client as any).tokenExpiresAt = Date.now() + 60_000
  client.resolveParentAndName = async () => ({ parentId: "folder-id", name: "large.bin" })
  const originalFetch = globalThis.fetch
  let called = false
  globalThis.fetch = async (input, init) => {
    called = true
    assert.match(String(input), /uploadType=resumable/)
    assert.equal(init?.method, "POST")
    assert.equal((init?.headers as Record<string, string>)["X-Upload-Content-Length"], "1048576000")
    assert.deepEqual(JSON.parse(String(init?.body)), {
      name: "large.bin",
      parents: ["folder-id"],
    })
    return new Response(null, {
      status: 200,
      headers: { Location: "https://www.googleapis.com/upload/drive/v3/files?upload_id=abc" },
    })
  }
  try {
    const url = await client.startResumableUpload("/large.bin", 1_048_576_000, "application/octet-stream")
    assert.equal(url, "https://www.googleapis.com/upload/drive/v3/files?upload_id=abc")
    assert.ok(called)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("folder quota counts nested files without counting a shortcut target", async () => {
  const client = new GoogleDriveClient({} as any)
  client.resolveFileId = async () => "root-id"
  const calls: string[] = []
  client.request = async (url: string) => {
    const params = new URL(url).searchParams
    calls.push(params.get("q") || "")
    if (calls.length === 1) return {
      files: [
        { id: "sub-id", mimeType: "application/vnd.google-apps.folder" },
        { id: "file-id", mimeType: "application/octet-stream", size: "100" },
        { id: "shortcut-id", mimeType: "application/vnd.google-apps.shortcut" },
      ],
    }
    return { files: [{ id: "nested-id", mimeType: "application/octet-stream", size: "200" }] }
  }
  assert.equal(await client.getFolderUsage("/root"), 300)
  assert.deepEqual(calls, ["'root-id' in parents and trashed = false", "'sub-id' in parents and trashed = false"])
})
