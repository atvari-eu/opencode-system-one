import { describe, expect, test } from "bun:test"
import {
  AUDIT_CAP,
  appendAudit,
  auditEntryOf,
  filterAudit,
  type AuditEntry,
} from "../src/audit"

const at = 1_700_000_000_000
const entry = (kind: AuditEntry["kind"], summary = "x"): AuditEntry => ({
  id: `${at}-${summary}`,
  at,
  kind,
  summary,
  tone: "info",
})

describe("auditEntryOf", () => {
  test("screen verdicts carry numbers, label, and tone", () => {
    const pass = auditEntryOf("screen", {
      label: "shell",
      verdict: "pass",
      junk: 0.1,
      injection: 0.2,
      secret: 0.3,
      call: "ls -la",
    }, at)
    expect(pass?.kind).toBe("screen")
    expect(pass?.tone).toBe("ok")
    expect(pass?.summary).toContain("pass: shell")
    expect(pass?.summary).toContain("junk=0.10")
    expect(pass?.summary).toContain("injection=0.20")
    expect(pass?.summary).toContain("secret=0.30")
    expect(pass?.decision).toBe("pass")
    expect(pass?.subject).toBe("shell")
    expect(pass?.call).toBe("ls -la")
    expect(pass?.detail).toContain("ls -la")
    expect(pass?.detail).toContain("junk=0.10")
    expect(pass?.at).toBe(at)

    expect(auditEntryOf("screen", { label: "read", verdict: "flagged" })?.tone).toBe("warn")
    expect(auditEntryOf("screen", { label: "read", verdict: "unsafe" })?.tone).toBe("error")
    expect(auditEntryOf("screen", { label: "read", verdict: "error" })?.tone).toBe("error")

    // The prefix makes clear the verdict is for the tool's output, not the call itself.
    const web = auditEntryOf("screen", {
      label: "https://example.test/a",
      verdict: "pass",
      call: "https://example.test/a",
      junk: 0,
    }, at)
    expect(web?.detail).toContain("Screened output of: https://example.test/a")
    expect(web?.detail).toContain("junk=0.00")

    const flagged = auditEntryOf("screen", {
      label: "webfetch",
      tool: "webfetch",
      verdict: "flagged",
      preview: "line one\nline two",
    }, at)
    expect(flagged?.preview).toContain("line two")

    const webCall = auditEntryOf("screen", {
      label: "https://example.test/a",
      tool: "webfetch",
      verdict: "pass",
      call: "https://example.test/a",
      junk: 0,
    }, at)
    expect(webCall?.subject).toBe("webfetch")
    expect(webCall?.detail).toContain("Screened output of: https://example.test/a")
    const passWithPreview = auditEntryOf("screen", { label: "webfetch", verdict: "pass", preview: "nope" }, at)
    expect(passWithPreview?.preview).toBeUndefined()
  })

  test("errors and config faults are error-toned and require a message", () => {
    const err = auditEntryOf("error", { message: "no credential", sessionID: "ses_1" }, at)
    expect(err?.tone).toBe("error")
    expect(err?.sessionID).toBe("ses_1")
    expect(auditEntryOf("error", {})).toBeUndefined()
    expect(auditEntryOf("config", { message: "deployment fault" })?.tone).toBe("error")
    expect(auditEntryOf("config", {})).toBeUndefined()
  })

  test("scrub hits are warn-toned and count-only", () => {
    const tool = auditEntryOf("scrub", { kind: "tool", tool: "shell", hits: 2 }, at)
    expect(tool?.tone).toBe("warn")
    expect(tool?.summary).toBe("removed 2 secret-like token(s) from shell")
    expect(tool?.decision).toBe("scrub")
    expect(tool?.subject).toBe("shell")
    expect(tool?.detail).toBe("2 secret-like token(s)")
    const prompt = auditEntryOf("scrub", { kind: "prompt", hits: 1 }, at)
    expect(prompt?.summary).toContain("the prompt")
    expect(auditEntryOf("scrub", { kind: "tool", hits: 0 })).toBeUndefined()
  })

  test("approval outcomes map to tones, including delegated allow/ask", () => {
    const allow = auditEntryOf("approval", { action: "shell", outcome: "allow", resource: "git status" }, at)
    expect(allow?.tone).toBe("ok")
    expect(allow?.summary).toBe("allow: shell git status")
    expect(allow?.decision).toBe("allow")
    expect(allow?.subject).toBe("shell")
    expect(allow?.detail).toBe("git status")
    expect(auditEntryOf("approval", { action: "shell", outcome: "ask" })?.tone).toBe("info")
    expect(auditEntryOf("approval", { action: "shell", outcome: "deny" })?.tone).toBe("error")
    expect(auditEntryOf("approval", { action: "shell", outcome: "gate" })?.tone).toBe("error")
    expect(auditEntryOf("approval", { action: "shell", outcome: "fail" })?.tone).toBe("warn")
  })

  test("malformed payloads are dropped", () => {
    expect(auditEntryOf("screen", undefined)).toBeUndefined()
    expect(auditEntryOf("screen", {})).toBeDefined() // defaults to ?: tool
    expect(auditEntryOf("error", null)).toBeUndefined()
  })

  test("entries get a unique reconcile id, even in the same millisecond", () => {
    const first = auditEntryOf("error", { message: "same" }, at)
    const second = auditEntryOf("error", { message: "same" }, at)
    expect(first?.id).toBeTruthy()
    expect(first?.id).not.toBe(second?.id)
  })
})

describe("appendAudit + filterAudit", () => {
  test("keeps the newest cap rows", () => {
    expect(AUDIT_CAP).toBe(200)
    let items: AuditEntry[] = []
    for (let i = 0; i < 5; i++) items = appendAudit(items, entry("screen", String(i)), 3)
    expect(items.map((i) => i.summary)).toEqual(["2", "3", "4"])
  })

  test("filter selects by kind or all", () => {
    const items = [entry("screen"), entry("error"), entry("approval"), entry("screen")]
    expect(filterAudit(items, "all")).toHaveLength(4)
    expect(filterAudit(items, "screen")).toHaveLength(2)
    expect(filterAudit(items, "approval")).toHaveLength(1)
    expect(filterAudit(items, "scrub")).toHaveLength(0)
  })

  test("anomalies keep only warn and error tones", () => {
    const items: AuditEntry[] = [
      { ...entry("screen"), tone: "ok" },
      { ...entry("screen"), tone: "warn" },
      { ...entry("screen"), tone: "error" },
      { ...entry("approval"), tone: "info" },
    ]
    expect(filterAudit(items, "anomaly").map((item) => item.tone)).toEqual(["warn", "error"])
  })
})
