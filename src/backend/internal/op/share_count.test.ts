import assert from "node:assert/strict"
import { test } from "node:test"
import { isShareDownloadStart } from "./share"

test("share access count: only a download start consumes quota", () => {
  const counted: Array<[string, string | undefined]> = [
    ["GET", undefined],
    ["GET", ""],
    ["GET", "bytes=0-"],
    ["GET", "BYTES=0-"],
    ["GET", "bytes=0-1048575"],
    ["GET", "bytes=0-65536"],
  ]
  for (const [method, range] of counted) {
    assert.equal(isShareDownloadStart(method, range), true, `${method} ${range}`)
  }

  const free: Array<[string, string | undefined]> = [
    ["HEAD", undefined],
    ["POST", undefined],
    ["GET", "bytes=0-0"],
    ["GET", "bytes=0-1"],
    ["GET", "bytes=0-65535"],
    ["GET", "bytes=1-"],
    ["GET", "bytes=1048576-"],
    ["GET", "bytes=100-2000000"],
    ["GET", "bytes=-500"],
    ["GET", "bytes=0-5,10-20"],
    ["GET", "items=0-"],
  ]
  for (const [method, range] of free) {
    assert.equal(isShareDownloadStart(method, range), false, `${method} ${range}`)
  }
})
