import assert from "node:assert/strict"
import { afterEach, test } from "node:test"
import { Hono } from "hono"
import { saveDb } from "../internal/model/db"
import { fsRouter, googleFreeSpace, readBoundedBody } from "./fs"

/**
 * Large uploads go browser -> Worker -> Google one chunk at a time. These tests
 * pin the parts that decide whether a multi-hour upload survives: the token and
 * quota reservation renew on progress, permanent Google answers stop the
 * retries, transient ones keep them going, and a cancelled upload is released.
 */
const env: any = { JWT_SECRET: "test-secret-for-google-upload-tests" }
const AUTH = { Authorization: "UPLOAD_TEST_TOKEN" }
const SESSION_URL = "https://www.googleapis.com/upload/drive/v3/files?upload_id=abc"
const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const seed = () =>
  saveDb(
    { settings: [{ key: "token", value: "UPLOAD_TEST_TOKEN" }], users: [], storages: [], shares: [], metas: [] },
    env,
  )

const b64 = (data: Uint8Array | string) => Buffer.from(data).toString("base64url")
async function tokenFor(grant: Record<string, unknown>) {
  const payload = b64(JSON.stringify(grant))
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(env.JWT_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  )
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))
  return `${payload}.${b64(new Uint8Array(signature))}`
}
const payloadOf = (token: string) => JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString())
const grantOf = (over: Record<string, unknown> = {}) => ({
  url: SESSION_URL, size: 1024 * 1024, path: "/x/big.bin", userId: 0, expires: Date.now() + 1000, ...over,
})

const app = () => {
  const router = new Hono()
  router.route("/api/fs", fsRouter)
  return router
}
const chunk = async (body: Uint8Array<ArrayBuffer>, headers: Record<string, string>, grant = grantOf()) =>
  app().request("/api/fs/google_drive/upload/chunk", {
    method: "PUT",
    headers: { ...AUTH, "X-Google-Upload-Token": await tokenFor(grant), "X-Upload-Offset": "0", ...headers },
    body,
  }, env)
const googleError = (status: number, reason: string) =>
  new Response(JSON.stringify({ error: { errors: [{ reason }] } }), { status })

test("chunk: sends one exactly-sized buffer to Google and renews the token", async () => {
  await seed()
  const calls: any[] = []
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), init })
    return new Response(null, { status: 308, headers: { Range: "bytes=0-262143" } })
  }) as any
  const body = new Uint8Array(256 * 1024).fill(7)
  for (const declared of [true, false]) {
    calls.length = 0
    const res = await chunk(body, declared ? { "Content-Length": String(body.length) } : {})
    const json: any = await res.json()
    assert.equal(res.status, 200, JSON.stringify(json))
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, SESSION_URL)
    assert.equal(calls[0].init.body.byteLength, body.length)
    assert.equal(calls[0].init.body[0], 7)
    assert.equal(calls[0].init.headers["Content-Range"], `bytes 0-${body.length - 1}/${1024 * 1024}`)
    assert.equal(json.data.next_offset, body.length)
    assert.equal(json.data.complete, false)
    assert.ok(payloadOf(json.data.token).expires > Date.now() + 5 * 60 * 60 * 1000, "token is good for hours again")
  }
})

test("chunk: the final chunk completes the upload without a new token", async () => {
  await seed()
  globalThis.fetch = (async () => new Response("{}", { status: 200 })) as any
  const size = 256 * 1024 + 1000
  const res = await chunk(new Uint8Array(1000), { "X-Upload-Offset": String(256 * 1024) }, grantOf({ size }))
  const json: any = await res.json()
  assert.equal(res.status, 200)
  assert.deepEqual(json.data, { complete: true, next_offset: size })
})

test("chunk: Google answers map to retryable and permanent statuses", async () => {
  await seed()
  const body = new Uint8Array(256 * 1024)
  const cases: Array<[Response, number, RegExp]> = [
    [googleError(403, "storageQuotaExceeded"), 403, /存储空间已满/],
    [googleError(403, "dailyLimitExceeded"), 403, /每日上传上限/],
    [googleError(403, "userRateLimitExceeded"), 503, /过于频繁/],
    [new Response("", { status: 429 }), 503, /过于频繁/],
    [new Response("", { status: 500 }), 502, /暂时不可用/],
    [new Response("", { status: 404 }), 410, /已失效/],
    [new Response("", { status: 400 }), 422, /拒绝/],
  ]
  for (const [answer, status, message] of cases) {
    globalThis.fetch = (async () => answer.clone()) as any
    const res = await chunk(body, { "Content-Length": String(body.length) })
    const json: any = await res.json()
    assert.equal(res.status, status, JSON.stringify(json))
    assert.match(json.message, message)
  }
})

test("chunk: rejects oversized, mis-sized and unsigned requests", async () => {
  await seed()
  globalThis.fetch = (async () => {
    throw new Error("Google must not be called")
  }) as any
  const small = new Uint8Array(256 * 1024)
  assert.equal((await chunk(small, { "Content-Length": String(9 * 1024 * 1024) })).status, 413)
  assert.equal((await chunk(small, { "Content-Length": "10" })).status, 413, "body longer than declared")
  assert.equal((await chunk(new Uint8Array(1000), {})).status, 400, "short non-final chunk")
  const forged = await app().request("/api/fs/google_drive/upload/chunk", {
    method: "PUT",
    headers: { ...AUTH, "X-Google-Upload-Token": "x.y", "X-Upload-Offset": "0" },
    body: small,
  }, env)
  assert.equal(forged.status, 403)
  const expired = await chunk(small, { "Content-Length": String(small.length) }, grantOf({ expires: Date.now() - 1 }))
  assert.equal(expired.status, 403)
})

test("status: reports progress with a renewed token", async () => {
  await seed()
  globalThis.fetch = (async (_url: any, init: any) => {
    assert.equal(init.headers["Content-Range"], `bytes */${1024 * 1024}`)
    return new Response(null, { status: 308, headers: { Range: "bytes=0-524287" } })
  }) as any
  const res = await app().request("/api/fs/google_drive/upload/status", {
    headers: { ...AUTH, "X-Google-Upload-Token": await tokenFor(grantOf()) },
  }, env)
  const json: any = await res.json()
  assert.equal(res.status, 200)
  assert.equal(json.data.next_offset, 524288)
  assert.ok(payloadOf(json.data.token).expires > Date.now() + 5 * 60 * 60 * 1000)
})

test("cancel: drops Google's session and rejects bad tokens", async () => {
  await seed()
  const calls: any[] = []
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), method: init.method })
    return new Response(null, { status: 499 })
  }) as any
  const res = await app().request("/api/fs/google_drive/upload/cancel", {
    method: "POST",
    headers: { ...AUTH, "X-Google-Upload-Token": await tokenFor(grantOf()) },
  }, env)
  assert.equal(res.status, 200)
  assert.deepEqual(calls, [{ url: SESSION_URL, method: "DELETE" }])
  const bad = await app().request("/api/fs/google_drive/upload/cancel", {
    method: "POST",
    headers: { ...AUTH, "X-Google-Upload-Token": "nope" },
  }, env)
  assert.equal(bad.status, 403)
  assert.equal(calls.length, 1)
})

test("readBoundedBody: fills a declared length in place and enforces limits", async () => {
  const stream = (...parts: number[][]) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(new Uint8Array(part))
        controller.close()
      },
    })
  const known = await readBoundedBody(stream([1, 2], [3, 4, 5]), 100, 5)
  assert.deepEqual(Array.from(known!), [1, 2, 3, 4, 5])
  const unknown = await readBoundedBody(stream([1, 2], [3]), 100, 0)
  assert.deepEqual(Array.from(unknown!), [1, 2, 3])
  assert.equal(await readBoundedBody(stream([1, 2, 3]), 100, 2), null, "longer than declared")
  assert.equal(await readBoundedBody(stream([1, 2, 3]), 2, 0), null, "longer than the limit")
})

test("googleFreeSpace: remaining bytes, or null when unlimited or unknown", async () => {
  const driver = (quota: unknown) => ({ getStorageQuota: async () => quota })
  assert.equal(await googleFreeSpace(driver({ limit: "16106127360", usage: "6106127360" })), 10_000_000_000)
  assert.equal(await googleFreeSpace(driver({ limit: "100", usage: "250" })), 0)
  assert.equal(await googleFreeSpace(driver({ usage: "250" })), null, "unlimited Workspace storage")
  assert.equal(await googleFreeSpace({ getStorageQuota: async () => { throw new Error("offline") } }), null)
  assert.equal(await googleFreeSpace({}), null)
})
