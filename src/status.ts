// Host-free model for the /jev-status panel: the snapshot shape the server
// publishes over the jev-config rpc, plus the pure presentation helpers the
// panel renders (sections, severity statistics, copy text). No host imports.
import type { AuditEntry } from "./audit"
import type { JevStatusInfo, JevStatusPool } from "./rpc"

export const STATUS_STORE_KEY = "jev-status"

/** The live snapshot store tui.ts writes and status-panel.tsx reads. */
export interface StatusStore {
  status: JevStatusInfo | null
  /** Fetch time, ms since epoch; 0 means "never fetched". */
  at: number
  /** A refresh is in flight. */
  fetching?: boolean
  /** The last refresh failed; the panel shows the reason instead of a guess. */
  error?: string
}

export interface StatusLine {
  text: string
  muted?: boolean
}

export interface StatusSection {
  title: string
  lines: StatusLine[]
}

export interface EventStats {
  total: number
  ok: number
  warn: number
  error: number
  info: number
  kinds: Array<{ kind: string; count: number }>
  lastError?: AuditEntry
}

const KIND_ORDER = ["screen", "error", "config", "scrub", "approval"] as const

/** Severity and per-kind counts over the audit ring (newest last). */
export function eventStats(items: readonly AuditEntry[]): EventStats {
  const stats: EventStats = { total: items.length, ok: 0, warn: 0, error: 0, info: 0, kinds: [] }
  const counts = new Map<string, number>()
  for (const item of items) {
    stats[item.tone] += 1
    counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1)
    if (item.tone === "error") stats.lastError = item
  }
  const order = new Map<string, number>(KIND_ORDER.map((kind, index) => [kind, index]))
  stats.kinds = [...counts.entries()]
    .sort((a, b) => (order.get(a[0]) ?? 99) - (order.get(b[0]) ?? 99))
    .map(([kind, count]) => ({ kind, count }))
  return stats
}

/** The model whose judgments this session actually rides. */
export function effectiveModel(status: JevStatusInfo): string {
  return status.pick || status.model
}

function clockOf(at: number): string {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`
}

/** Local date and time, for timestamps that can be on another day. */
function localStamp(at: number): string {
  const date = new Date(at)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${clockOf(at)}`
}

function joined(values: readonly string[], empty = "none"): string {
  return values.length > 0 ? values.join(", ") : empty
}

function poolLines(pool: JevStatusPool): StatusLine[] {
  const label = pool.name ?? pool.id
  if (!pool.enabled) return [{ text: `${label}: off (entry not registered)`, muted: true }]
  const lines: StatusLine[] = [
    {
      text: `${label}: ${pool.usable.length} usable · ${pool.explicit.length} declared · ${pool.sourced.length} sourced`,
    },
  ]
  if (pool.explicit.length > 0) lines.push({ text: `  declared: ${joined(pool.explicit)}`, muted: true })
  if (pool.sourced.length > 0) lines.push({ text: `  sourced: ${joined(pool.sourced)}`, muted: true })
  if (pool.shape) lines.push({ text: `  pool: ${pool.shape}`, muted: true })
  if (pool.excluded.length > 0) {
    lines.push({ text: `  excluded (shared with the default pool): ${joined(pool.excluded)}`, muted: true })
  }
  if (pool.usable.length > 0) lines.push({ text: `  usable: ${joined(pool.usable)}` })
  if (pool.fallback) lines.push({ text: `  fallback: ${pool.fallback}`, muted: true })
  if (pool.usable.length === 0) {
    lines.push({ text: "  no usable candidates - routing stays off for this entry", muted: true })
    if (pool.reason) lines.push({ text: `  reason: ${pool.reason}`, muted: true })
  }
  return lines
}

/** The whole panel body as sections, in display order. */
export function statusSections(
  status: JevStatusInfo,
  items: readonly AuditEntry[],
  at = Date.now(),
): StatusSection[] {
  const effective = effectiveModel(status)
  const current: StatusLine[] = [
    { text: `current: ${effective} (${status.pick ? "pinned for this session" : "chain default"})` },
    { text: `provider: ${status.provider}`, muted: true },
    { text: `endpoint: ${status.endpoint}`, muted: true },
  ]
  if (status.pick) current.push({ text: `chain: ${status.model}`, muted: true })
  if (status.session) {
    current.push({
      text: `session: ${status.session.model} · routing ${status.session.routing}`,
      muted: true,
    })
    if (status.session.entry) {
      const title = status.session.entryTitle ? `${status.session.entryTitle} (${status.session.entry})` : status.session.entry
      current.push({ text: `  entry: ${title}`, muted: true })
    }
    const agent = [status.session.agent, status.session.profile ? `profile ${status.session.profile}` : ""]
      .filter(Boolean)
      .join(" · ")
    if (agent) current.push({ text: `  agent: ${agent}`, muted: true })
  } else {
    current.push({ text: "session: unknown (no active session)", muted: true })
  }

  const models: StatusLine[] =
    status.models.length === 0
      ? [{ text: "no candidates configured", muted: true }]
      : status.models.map((model) => ({
          text:
            `${model.id === effective ? "›" : " "} ${model.id}` +
            (model.fault ? `  ✗ ${model.fault}` : "") +
            (model.id === effective ? "  (current)" : ""),
        }))

  const health: StatusLine[] = [
    {
      text: status.health.ok
        ? "deployment: ok (init ping)"
        : `deployment: FAULT - ${status.health.fault ?? "unknown"}`,
    },
  ]
  if (status.health.checkedAt) {
    const checked = Date.parse(status.health.checkedAt)
    if (Number.isFinite(checked)) {
      health.push({ text: `deployment check: ${localStamp(checked)}`, muted: true })
    }
  }
  health.push(
    { text: `decision catalog: ${status.catalog}`, muted: true },
    {
      text: `event channel: ${status.health.events ? "on (jev-config rpc)" : "unavailable (toasts fall back to rows)"}`,
      muted: true,
    },
  )
  const auth = status.auth
  if (auth) {
    const kind = auth.type ? ` ${auth.type}` : ""
    const expiresAt = auth.expires ? Date.parse(auth.expires) : NaN
    const expires = Number.isFinite(expiresAt) ? ` · expires ${localStamp(expiresAt)}` : ""
    health.push({ text: `credential: ${auth.source}${kind}${expires}`, muted: true })
    if (auth.endpointOverride) {
      health.push({
        text: "endpoint override: JEV_ENDPOINT (CLI credential store skipped)",
        muted: true,
      })
    }
  } else {
    health.push({ text: "credential: not resolved yet (no judged call this process)", muted: true })
  }
  if (status.version) {
    health.push({
      text: `plugin ${status.version}${status.host ? ` · host opencode ${status.host}` : ""}`,
      muted: true,
    })
  }
  health.push({ text: `snapshot: ${clockOf(at)}`, muted: true })

  const stats = eventStats(items)
  const events: StatusLine[] = [
    {
      text: `severity: ok ${stats.ok} · warn ${stats.warn} · error ${stats.error} · info ${stats.info} (${stats.total} events)`,
    },
  ]
  if (stats.kinds.length > 0) {
    events.push({
      text: `kinds: ${stats.kinds.map((kind) => `${kind.kind} ${kind.count}`).join(" · ")}`,
      muted: true,
    })
  }
  if (stats.lastError) {
    events.push({ text: `last error: ${clockOf(stats.lastError.at)} ${stats.lastError.summary}`, muted: true })
  } else {
    events.push({ text: "no error-severity events in the ring", muted: true })
  }

  const sections: StatusSection[] = [
    { title: "decision model", lines: current },
    { title: `available decision models (${status.models.length})`, lines: models },
    {
      title: "model pools",
      lines:
        status.pools.length > 0
          ? status.pools.flatMap(poolLines)
          : [{ text: "no routing entries", muted: true }],
    },
    { title: "health", lines: health },
    {
      title: "features",
      lines: status.features.length > 0
        ? status.features.map((feature) => ({ text: `${feature.name}: ${feature.state}` }))
        : [{ text: "none reported", muted: true }],
    },
    { title: "recent events", lines: events },
  ]
  return sections
}

/** Plain-text rendering for the panel's copy shortcut. */
export function statusText(status: JevStatusInfo, items: readonly AuditEntry[], at = Date.now()): string {
  const lines: string[] = [`jev status - ${effectiveModel(status)} - ${clockOf(at)}`]
  for (const section of statusSections(status, items, at)) {
    lines.push("")
    lines.push(section.title)
    for (const line of section.lines) lines.push(`  ${line.text}`)
  }
  return lines.join("\n")
}
