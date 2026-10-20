// Host-shape tolerance tests: the envelope unwrap for single-object SDK
// responses (session.get) and the rows normalizer for list responses
// (session.context). Pure logic, no plugin host, no network.

import { describe, expect, test } from "bun:test"
import { contextRows, unwrapEnvelope } from "../src/logic"

describe("unwrapEnvelope", () => {
  test("unwraps the { data } envelope", () => {
    const session = { id: "ses_1", model: { id: "gpt", providerID: "acme" } }
    expect(unwrapEnvelope({ data: session })).toEqual(session)
  })

  test("passes plain single-object reads through untouched", () => {
    const session = { id: "ses_1", model: { id: "gpt", providerID: "acme" } }
    expect(unwrapEnvelope(session)).toEqual(session)
  })

  test("passes non-objects through (arrays, primitives, null, undefined)", () => {
    expect(unwrapEnvelope([1, 2, 3])).toEqual([1, 2, 3])
    expect(unwrapEnvelope("plain")).toBe("plain")
    expect(unwrapEnvelope(null)).toBe(null)
    expect(unwrapEnvelope(undefined)).toBe(undefined)
  })

  test("unwraps any object holding a data key (a real envelope; session payloads carry none)", () => {
    // Deliberate: the helper cannot tell a real envelope from a payload that
    // happens to carry a data key, and guessing is worse than unwrapping -
    // host payloads of the session kind carry no data key.
    expect(unwrapEnvelope({ data: { deep: true } })).toEqual({ deep: true })
  })

  test("envelope wrapping undefined stays itself (nothing to unwrap)", () => {
    expect(unwrapEnvelope({ data: undefined })).toEqual({ data: undefined })
    expect(unwrapEnvelope({})).toEqual({})
  })
})

describe("contextRows", () => {
  test("unwraps an envelope-wrapped rows list", () => {
    const rows = [{ id: "r1", type: "text", text: "hi" }]
    expect(contextRows({ data: rows })).toEqual(rows)
  })

  test("keeps plain rows lists", () => {
    const rows = [{ id: "r1", type: "text", text: "hi" }]
    expect(contextRows(rows)).toEqual(rows)
  })

  test("unreadable shapes become an empty list, never a throw", () => {
    expect(contextRows(null)).toEqual([])
    expect(contextRows(undefined)).toEqual([])
    expect(contextRows({ nope: 1 })).toEqual([])
    expect(contextRows("rows")).toEqual([])
  })
})
