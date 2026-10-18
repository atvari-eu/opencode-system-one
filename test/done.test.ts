// Done-check helper tests: transcript tail building, change detection,
// thresholds and the verdict bands the command + auto path share.

import { describe, expect, test } from "bun:test"
import {
  clampThreshold,
  doneCheckStandDown,
  doneTranscript,
  doneVerdict,
  idleSessionID,
  isLoopingTail,
  LOOP_MIN_RUN,
  shouldNotifyIncomplete,
  userRowCount,
  NOTIFY_BELOW_DEFAULT,
} from "../src/logic"

const row = (text: string) => ({ info: { text }, type: "message" })
const userRow = (text: string) => ({ info: { text, role: "user" }, type: "message" })
const assistantRow = (text: string) => ({ info: { text, role: "assistant" }, type: "message" })

describe("idleSessionID", () => {
  test("reads sessionID from the v2 event data field", () => {
    const e = { id: "evt_1", type: "session.idle", data: { sessionID: "ses_abc" } }
    expect(idleSessionID(e)).toBe("ses_abc")
  })

  test("treats terminal v2 execution events as end-of-turn", () => {
    for (const status of ["succeeded", "failed", "interrupted"]) {
      const e = { type: `session.execution.${status}`, data: { sessionID: `ses_${status}` } }
      expect(idleSessionID(e)).toBe(`ses_${status}`)
    }
    expect(idleSessionID({ type: "session.execution.started", data: { sessionID: "ses_1" } })).toBeUndefined()
  })

  test("matches qualified idle type names and skips other events", () => {
    expect(idleSessionID({ type: "app.session.idle", data: { sessionID: "ses_1" } })).toBe("ses_1")
    expect(idleSessionID({ type: "session.created", data: { sessionID: "ses_1" } })).toBeUndefined()
  })

  test("still supports the legacy v1 name/properties shapes", () => {
    expect(idleSessionID({ name: "session.idle", properties: { sessionID: "ses_old" } })).toBe("ses_old")
    expect(idleSessionID({ type: "session.idle", sessionID: "ses_direct" })).toBe("ses_direct")
  })

  test("never returns a non-string or blank sessionID", () => {
    expect(idleSessionID({ type: "session.idle", data: {} })).toBeUndefined()
    expect(idleSessionID({ type: "session.idle", data: { sessionID: "  " } })).toBeUndefined()
    expect(idleSessionID({ type: "session.execution.succeeded", data: { sessionID: 42 } })).toBeUndefined()
    expect(idleSessionID(undefined)).toBeUndefined()
  })
})

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

  test("loop is true on a run of identical rows, false otherwise", () => {
    expect(doneTranscript([row("same"), row("same"), row("same")]).loop).toBe(true)
    expect(doneTranscript([row("same"), row("same")]).loop).toBe(false)
    expect(doneTranscript([row("a"), row("b"), row("a"), row("b")]).loop).toBe(false)
    // whitespace-only differences do not break the run
    expect(doneTranscript([row("same"), row("same "), row("  same")]).loop).toBe(true)
    // own notices are removed before run detection, so a run interrupted
    // only by a notice still counts (the notice cannot mask a loop)
    expect(
      doneTranscript([row("same"), row("same"), row("[jev-done-check] nudge"), row("same")]).loop,
    ).toBe(true)
    expect(
      doneTranscript([row("same"), row("same"), row("[jev-done-check] nudge"), row("other")]).loop,
    ).toBe(false)
  })

  test("isLoopingTail honors the minRun parameter and default", () => {
    expect(LOOP_MIN_RUN).toBe(3)
    expect(isLoopingTail(["x", "x"])).toBe(false)
    expect(isLoopingTail(["x", "x", "x"])).toBe(true)
    expect(isLoopingTail(["x", "x"], 2)).toBe(true)
    expect(isLoopingTail([])).toBe(false)
  })
})

describe("userRowCount + doneCheckStandDown", () => {
  test("counts only real user rows, never own notices", () => {
    const messages = [
      userRow("fix it"),
      assistantRow("done"),
      row("[jev-done-check] p(complete)=0.20 → likely INCOMPLETE"),
      assistantRow("Holding - no change."),
      row("noop row without role"),
    ]
    expect(userRowCount(messages)).toBe(1)
    expect(userRowCount([])).toBe(0)
  })

  test("stand-down holds until a new user message arrives", () => {
    // a notice was posted for the 1st user message
    const state = { userCountAtNotice: 1 }
    // agent replies (no new user message) - stood down, even at p=0
    expect(doneCheckStandDown(state, 1)).toBe(true)
    expect(doneCheckStandDown(state, 0)).toBe(true)
    // a new user message lifts the stand-down
    expect(doneCheckStandDown(state, 2)).toBe(false)
    // no notice ever posted - never stood down
    expect(doneCheckStandDown(undefined, 1)).toBe(false)
    expect(doneCheckStandDown(null, 0)).toBe(false)
    expect(doneCheckStandDown({}, 0)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// v2 host rows: shapes captured verbatim from a live OpenCode v2
// /session/{id}/context response (flat rows - no info wrapper, no role field;
// assistant text lives in content parts; synthetic posts carry top-level text).
// The stand-down and tail hashing must hold on these, not only on the legacy
// wrapped shape above.
// ---------------------------------------------------------------------------

const flatUser = {
  id: "msg_u1",
  time: { created: 1 },
  text: "fix the loop",
  files: [],
  agents: [],
  type: "user",
}
const flatOtherUser = { ...flatUser, id: "msg_u2", text: "second ask" }
const flatSynthetic = {
  id: "msg_s1",
  time: { created: 2 },
  text: "[jev-done-check] p(complete)=0.13 → likely INCOMPLETE - do not silently stop: continue the remaining work or list it for the user",
  type: "synthetic",
}
const flatAssistant = {
  id: "msg_a1",
  time: { created: 3 },
  type: "assistant",
  agent: "build",
  content: [
    { type: "reasoning", text: "hidden deliberation" },
    { type: "text", text: "the visible reply" },
  ],
}
const flatIdle = { id: "msg_i1", time: { created: 4 }, type: "idle" }

describe("userRowCount + doneCheckStandDown on flat v2 rows", () => {
  test("counts typed user rows; synthetic and idle rows never count without a role field", () => {
    expect(userRowCount([flatUser, flatAssistant, flatSynthetic, flatIdle])).toBe(1)
    expect(userRowCount([flatUser, flatOtherUser])).toBe(2)
    // legacy wrapped shapes keep working
    expect(userRowCount([userRow("legacy role field")])).toBe(1)
  })

  test("doneTranscript reads content-part text and skips reasoning parts", () => {
    const tail = doneTranscript([flatUser, flatAssistant])
    expect(tail.text).toContain("fix the loop")
    expect(tail.text).toContain("the visible reply")
    expect(tail.text).not.toContain("hidden deliberation")
    // an unknown row shape still degrades to its JSON - never to an empty tail
    expect(doneTranscript([flatIdle]).text.length).toBeGreaterThan(0)
  })

  test("own synthetic notices stay excluded from text and hash on flat rows", () => {
    const plain = doneTranscript([flatUser, flatAssistant])
    const after = doneTranscript([flatUser, flatAssistant, flatSynthetic])
    expect(plain.hash).toBe(after.hash)
    expect(after.text).not.toContain("[jev-done-check]")
  })

  test("the nudge loop cannot restart without a new user message (the live failure)", () => {
    // Real-failure chain: probe judged p=0.13 with userCount 0 (v2 rows lacked
    // role), stored userCountAtNotice 0, and the next probe - still 0 - was
    // treated as a brand-new user turn. With typed rows the count is real, so
    // the same-count probe stands down.
    expect(userRowCount([flatUser, flatOtherUser])).toBe(2)
    expect(doneCheckStandDown({ userCountAtNotice: 2 }, 2)).toBe(true)
    expect(doneCheckStandDown({ userCountAtNotice: 2 }, 3)).toBe(false)
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
