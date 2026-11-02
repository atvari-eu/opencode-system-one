// Host-free audit model for the TUI event panel: every UI-only RPC event
// (screen verdict, failed call, config fault, scrub hit, approval resolution)
// is appended to one durable ring and rendered by src/audit-panel.tsx.
// tui.ts owns the subscriptions and the store; this module only maps payloads.

export type AuditKind = "screen" | "error" | "config" | "scrub" | "approval"

export type AuditTone = "ok" | "warn" | "error" | "info"

export interface AuditEntry {
  /** Stable reconcile key for the durable Solid store. */
  id: string
  /** Arrival time, ms since epoch. */
  at: number
  kind: AuditKind
  summary: string
  sessionID?: string
  tone: AuditTone
  /** Structured table cells. Older persisted rows may not have them. */
  decision?: string
  subject?: string
  detail?: string
}

export const AUDIT_STORE_KEY = "jev-audit"

/** Ring size: the panel scrolls and filters over this, so it stays bounded. */
export const AUDIT_CAP = 200

export const AUDIT_KINDS: readonly AuditKind[] = ["screen", "error", "config", "scrub", "approval"]

/** Single-key filters shown in the panel header and bound in the TUI layer. */
export const AUDIT_FILTERS: ReadonlyArray<{ key: string; kind: AuditKind | "all"; label: string }> = [
  { key: "a", kind: "all", label: "all" },
  { key: "s", kind: "screen", label: "screen" },
  { key: "e", kind: "error", label: "errors" },
  { key: "p", kind: "approval", label: "approvals" },
  { key: "r", kind: "scrub", label: "scrub" },
  { key: "x", kind: "config", label: "config" },
]

const fixed = (value: unknown): string => (typeof value === "number" ? value.toFixed(2) : "?")

let sequence = 0

/** The storage store reconciles arrays by `id`; entries need one even when
 * several events land in the same millisecond. */
function entryID(at: number): string {
  sequence = (sequence + 1) % 1_000_000
  return `${at.toString(36)}-${sequence.toString(36)}`
}

/** Maps one event payload to an audit entry. Unknown/malformed payloads are
 * dropped rather than rendered as a bogus row. `at` is injectable for tests. */
export function auditEntryOf(
  kind: AuditKind,
  data: any,
  at: number = Date.now(),
): AuditEntry | undefined {
  if (!data || typeof data !== "object") return undefined
  const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined
  let summary = ""
  let tone: AuditTone = "info"
  let decision = kind
  let subject = ""
  let detail = ""
  switch (kind) {
    case "screen": {
      const label = typeof data.label === "string" ? data.label : "tool"
      const verdict = typeof data.verdict === "string" ? data.verdict : "?"
      detail = `junk=${fixed(data.junk)} injection=${fixed(data.injection)} secret=${fixed(data.secret)}`
      summary = `${verdict}: ${label} — ${detail}`
      decision = verdict
      subject = label
      tone = verdict === "unsafe" || verdict === "error" ? "error" : verdict === "flagged" ? "warn" : "ok"
      break
    }
    case "error": {
      const message = typeof data.message === "string" ? data.message : ""
      if (!message) return undefined
      decision = "error"
      subject = "call"
      detail = message
      summary = message
      tone = "error"
      break
    }
    case "config": {
      const message = typeof data.message === "string" ? data.message : ""
      if (!message) return undefined
      decision = "config"
      subject = "config"
      detail = message
      summary = message
      tone = "error"
      break
    }
    case "scrub": {
      const hits = typeof data.hits === "number" ? data.hits : 0
      if (hits <= 0) return undefined
      const where = data.kind === "prompt" ? "the prompt" : (typeof data.tool === "string" ? data.tool : "a tool input")
      decision = "scrub"
      subject = where
      detail = `${hits} secret-like token(s)`
      summary = `removed ${hits} secret-like token(s) from ${where}`
      tone = "warn"
      break
    }
    case "approval": {
      const outcome = typeof data.outcome === "string" ? data.outcome : "?"
      const action = typeof data.action === "string" ? data.action : "permission"
      const resource = typeof data.resource === "string" && data.resource ? data.resource : ""
      decision = outcome
      subject = action
      detail = resource
      summary = `${outcome}: ${action}${resource ? ` ${resource}` : ""}`
      tone = outcome === "allow" ? "ok" : outcome === "ask" ? "info" : outcome === "fail" ? "warn" : "error"
      break
    }
  }
  return { id: entryID(at), at, kind, summary, decision, subject, detail, ...(sessionID ? { sessionID } : {}), tone }
}

/** Appends one entry, keeping the newest `cap` rows. */
export function appendAudit(items: readonly AuditEntry[], entry: AuditEntry, cap = AUDIT_CAP): AuditEntry[] {
  const next = [...items, entry]
  return next.length > cap ? next.slice(next.length - cap) : next
}

export function filterAudit(items: readonly AuditEntry[], kind: AuditKind | "all"): AuditEntry[] {
  return kind === "all" ? [...items] : items.filter((item) => item.kind === kind)
}
