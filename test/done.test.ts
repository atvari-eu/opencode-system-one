// Done-check helper tests: transcript tail building, change detection,
// thresholds and the verdict bands the command + auto path share.

import { describe, expect, test } from "bun:test"
import {
  clampThreshold,
  doneTranscript,
  doneVerdict,
  shouldNotifyIncomplete,
  NOTIFY_BELOW_DEFAULT,
} from "../src/logic"

const row = (text: string) => ({ info: { text }, type: "message" })

describe("doneTranscript", () => {
  test("joins the tail, capping per message and in total", () => {
    const messages = Array.from({ length: 40 }, (_, i) => row(`message ${i} ${"x".repeat(600)}`))
    const tail = doneTranscript(messages)
    expect(tail.text.length).toBeGreaterThan(0)
    expect(tail.text.length).toBeLessThanOrEqual(12000)
    // Per-message cap: no single row's filler survives past 500 chars.
    expect(tail.text.includes("x".repeat(510))).toBe(false)
  })

  test("hash is stable and changes with the transcript", () => {
    const a = doneTranscript([row("one"), row("two")])
    const b = doneTranscript([row("one"), row("two")])
    const c = doneTranscript([row("one"), row("two"), row("three")])
    expect(a.hash).toBe(b.hash)
    expect(a.hash).not.toBe(c.hash)
  })

  test("own plugin notices are excluded from text and hash", () => {
    const plain = doneTranscript([row("user ask"), row("assistant reply")])
    const afterNotice = doneTranscript([
      row("user ask"),
      row("assistant reply"),
      row("[jev-done-check] p(complete)=0.30 → likely INCOMPLETE"),
    ])
    expect(plain.hash).toBe(afterNotice.hash)
    expect(afterNotice.text).not.toContain("[jev-done-check]")
  })
})

describe("doneVerdict bands", () => {
  test("matches the command's bands exactly", () => {
    expect(doneVerdict(0.9)).toBe("complete")
    expect(doneVerdict(0.85)).toBe("complete")
    expect(doneVerdict(0.5)).toContain("INCOMPLETE")
    expect(doneVerdict(0.2)).toContain("INCOMPLETE")
    expect(doneVerdict(0.7)).toContain("uncertain")
    expect(doneVerdict(undefined)).toContain("fail closed")
  })
})

describe("shouldNotifyIncomplete", () => {
  test("notifies only at or below the threshold, missing answers never notify", () => {
    expect(shouldNotifyIncomplete(0.3, 0.45)).toBe(true)
    expect(shouldNotifyIncomplete(0.45, 0.45)).toBe(true)
    expect(shouldNotifyIncomplete(0.46, 0.45)).toBe(false)
    expect(shouldNotifyIncomplete(0.9, 0.45)).toBe(false)
    expect(shouldNotifyIncomplete(undefined, 0.45)).toBe(false)
  })
})

describe("clampThreshold", () => {
  test("clamps to the band, defaults otherwise", () => {
    expect(clampThreshold(0.01, 0.01, 0.85, 0.45)).toBe(0.01)
    expect(clampThreshold(0.99, 0.01, 0.85, 0.45)).toBe(0.85)
    expect(clampThreshold(0.45, 0.01, 0.85, 0.45)).toBe(0.45)
    expect(clampThreshold(undefined, 0.01, 0.85, 0.45)).toBe(0.45)
    expect(clampThreshold("x" as any, 0.01, 0.85, 0.45)).toBe(0.45)
    expect(clampThreshold(NaN, 0.01, 0.85, 0.45)).toBe(0.45)
  })
})
