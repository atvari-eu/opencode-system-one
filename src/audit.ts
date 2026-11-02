// Host-free audit model for the TUI event panel: every UI-only RPC event
// (screen verdict, failed call, config fault, scrub hit, approval resolution)
// is appended to one durable ring and rendered by src/audit-panel.tsx.
// tui.ts owns the subscriptions and the store; this module only maps payloads.

export type AuditKind = "screen" | "error" | "config" | "scrub" | "approval"

export type AuditTone = "ok" | "warn" | "error" | "info"

export interface AuditEntry {
  /** Arrival time, ms since epoch. */
  at: number
  kind: AuditKind
  summary: string
  sessionID?: string
  tone: AuditTone
}

export const AUDIT_STORE_KEY = "jev-audit"

/** Ring size: the panel pages and filters over this, so it stays bounded. */
export const AUDIT_CAP = 200

export const AUDIT_KINDS: readonly AuditKind[] = ["screen", "error", "config", "scrub", "approval"]

const fixed = (value: unknown): string => (typeof value === "number" ? value.toFixed(2) : "?")

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
  switch (kind) {
    case "screen": {
      const label = typeof data.label === "string" ? data.label : "tool"
      const verdict = typeof data.verdict === "string" ? data.verdict : "?"
      summary = `${verdict}: ${label} — junk=${fixed(data.junk)} injection=${fixed(data.injection)} secret=${fixed(data.secret)}`
      tone = verdict === "unsafe" || verdict === "error" ? "error" : verdict === "flagged" ? "warn" : "ok"
      break
    }
    case "error": {
      const message = typeof data.message === "string" ? data.message : ""
      if (!message) return undefined
      summary = message
      tone = "error"
      break
    }
    case "config": {
      const message = typeof data.message === "string" ? data.message : ""
      if (!message) return undefined
      summary = message
      tone = "error"
      break
    }
    case "scrub": {
      const hits = typeof data.hits === "number" ? data.hits : 0
      if (hits <= 0) return undefined
      const where = data.kind === "prompt" ? "the prompt" : (typeof data.tool === "string" ? data.tool : "a tool input")
      summary = `removed ${hits} secret-like token(s) from ${where}`
      tone = "warn"
      break
    }
    case "approval": {
      const outcome = typeof data.outcome === "string" ? data.outcome : "?"
      const action = typeof data.action === "string" ? data.action : "permission"
      const resource = typeof data.resource === "string" && data.resource ? ` ${data.resource}` : ""
      summary = `${outcome}: ${action}${resource}`
      tone = outcome === "allow" ? "ok" : outcome === "ask" ? "info" : outcome === "fail" ? "warn" : "error"
      break
    }
  }
  return { at, kind, summary, ...(sessionID ? { sessionID } : {}), tone }
}

/** Appends one entry, keeping the newest `cap` rows. */
export function appendAudit(items: readonly AuditEntry[], entry: AuditEntry, cap = AUDIT_CAP): AuditEntry[] {
  const next = [...items, entry]
  return next.length > cap ? next.slice(next.length - cap) : next
}

export function filterAudit(items: readonly AuditEntry[], kind: AuditKind | "all"): AuditEntry[] {
  return kind === "all" ? [...items] : items.filter((item) => item.kind === kind)
}
