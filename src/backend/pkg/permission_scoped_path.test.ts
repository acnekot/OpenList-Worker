import assert from "node:assert/strict"
import test from "node:test"
import { getActualPath } from "./permission"

const user = { role: 0, permission: 8, base_path: "/GoogleDrive2/wxb_nb" }

test("scoped account paths stay inside their assigned folder", () => {
  assert.equal(getActualPath(user, "/"), "/GoogleDrive2/wxb_nb")
  assert.equal(getActualPath(user, "/sub/file"), "/GoogleDrive2/wxb_nb/sub/file")
  for (const path of ["/../other", "/%2e%2e/other", "/%252e%252e/other", "/..\\other"]) {
    assert.throws(() => getActualPath(user, path), /escapes user root/)
  }
})
