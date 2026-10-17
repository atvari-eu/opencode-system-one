// User-relevant jev failure classification: only what a user can act on
// (credential, funds, endpoint gate) reaches the popup surface; transport and
// tool-level noise stays console-only.

import { describe, expect, test } from "bun:test"
import { jevUserError } from "../src/logic"

describe("jevUserError", () => {
  test("free-tier gate and funds and credential classes surface", () => {
    expect(jevUserError("jev: 402 - Upstream request failed: Insufficient account funds")?.title).toContain("no funds")
    expect(
      jevUserError(
        "jev: 403 - OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building.",
      )?.title,
    ).toContain("free tier only works inside")
    expect(jevUserError("jev: no credential (set TYPESAFE_API_KEY, ...)")?.title).toContain("no credential")
    expect(jevUserError("jev: 401 - credential rejected")?.title).toContain("401")
    expect(jevUserError("jev: 422 - endpoint rejected the request")?.title).toContain("422")
    expect(jevUserError("free tier unavailable - sign in")?.title).toContain("free tier unavailable")
  })

  test("transport and local-tool noise stays console-only", () => {
    expect(jevUserError("jev: upstream 500 - gateway timeout")).toBeUndefined()
    expect(jevUserError("TypeError: Cannot read properties of undefined")).toBeUndefined()
    expect(jevUserError(undefined)).toBeUndefined()
    expect(jevUserError("")).toBeUndefined()
  })
})
