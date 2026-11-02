/** @jsxImportSource @opentui/solid */
// TUI event-audit panel. Pure renderer: src/tui.ts owns every RPC
// subscription, reconnect, and the durable `jev-audit` store; this module
// only pages/filters/renders it. Keep it free of ./rpc imports (see
// AGENTS.md: panels must not subscribe themselves).
import type { JSX } from "@opentui/solid"
import { createSignal } from "solid-js"
import {
  AUDIT_STORE_KEY,
  filterAudit,
  type AuditEntry,
  type AuditKind,
} from "./audit"

interface PanelInput {
  readonly name: string
  readonly sessionID: string
  readonly close: () => void
  readonly toggleFullscreen: () => void
}

interface Store {
  readonly items: AuditEntry[]
}

const PANEL_PAGE = 15

const FILTER_KEYS: ReadonlyArray<{ key: string; kind: AuditKind | "all"; label: string }> = [
  { key: "a", kind: "all", label: "all" },
  { key: "s", kind: "screen", label: "screen" },
  { key: "e", kind: "error", label: "errors" },
  { key: "p", kind: "approval", label: "approvals" },
  { key: "r", kind: "scrub", label: "scrub" },
  { key: "x", kind: "config", label: "config" },
]

function formatEntry(entry: AuditEntry): string {
  const at = new Date(entry.at)
  const time = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`
  return `${time}  ${entry.kind.padEnd(8)}  ${entry.summary}`
}

function panelText(entries: readonly AuditEntry[], filter: AuditKind | "all"): string {
  return [`jev audit — ${entries.length} ${filter === "all" ? "entries" : filter + " entries"}`, ...entries.map(formatEntry)].join("\n")
}

function Row(props: { entry: AuditEntry; index: number }): JSX.Element {
  return <text key={props.index} selectable={false}>{formatEntry(props.entry)}</text>
}

function Panel(props: { store: readonly [Store, unknown]; context: any; panel: PanelInput }): JSX.Element {
  const [filter, setFilter] = createSignal<AuditKind | "all">("all")
  const [start, setStart] = createSignal(0)
  const all = (): AuditEntry[] => props.store?.[0]?.items ?? []
  const filtered = (): AuditEntry[] => filterAudit(all(), filter())
  const clampStart = (value: number): number => {
    const total = filtered().length
    return Math.max(0, Math.min(value, Math.max(0, total - PANEL_PAGE)))
  }

  props.context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "jev.audit.close",
        title: "Close jev audit",
        bind: "escape",
        run: () => props.panel.close(),
      },
      {
        id: "jev.audit.close-q",
        title: "Close jev audit",
        bind: "q",
        run: () => props.panel.close(),
      },
      {
        id: "jev.audit.fullscreen",
        title: "Toggle jev audit fullscreen",
        bind: "f",
        run: () => props.panel.toggleFullscreen(),
      },
      {
        id: "jev.audit.down",
        title: "Scroll audit down",
        bind: "j",
        run: () => setStart((value) => clampStart(value + 1)),
      },
      {
        id: "jev.audit.up",
        title: "Scroll audit up",
        bind: "k",
        run: () => setStart((value) => clampStart(value - 1)),
      },
      {
        id: "jev.audit.top",
        title: "Audit top",
        bind: "g",
        run: () => setStart(0),
      },
      {
        id: "jev.audit.bottom",
        title: "Audit bottom",
        bind: "shift+g",
        run: () => setStart(clampStart(Number.MAX_SAFE_INTEGER)),
      },
      {
        id: "jev.audit.copy",
        title: "Copy jev audit",
        bind: "c",
        run: () => {
          const entries = filtered()
          let ok = false
          try {
            ok = props.context.renderer?.copyToClipboardOSC52?.(panelText(entries, filter())) === true
          } catch {}
          props.context.ui.toast.show({
            title: "jev-audit",
            message: ok
              ? `copied ${entries.length} ${filter() === "all" ? "entries" : filter() + " entries"}`
              : "clipboard unavailable - this terminal rejected OSC52",
            variant: ok ? "success" : "warning",
            duration: 4_000,
          })
        },
      },
      ...FILTER_KEYS.map((entry) => ({
        id: `jev.audit.filter-${entry.kind}`,
        title: `Audit filter: ${entry.label}`,
        bind: entry.key,
        run: () => {
          setFilter(entry.kind)
          setStart(0)
        },
      })),
    ],
  }))

  const items = all()
  const entries = filtered()
  const first = Math.min(start(), Math.max(0, entries.length - PANEL_PAGE))
  const visible = entries.slice(first, first + PANEL_PAGE)
  const range = entries.length === 0 ? "0-0" : `${first + 1}-${first + visible.length}`
  const filterLabel = filter() === "all" ? "all" : filter()
  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} selectable={false}>
      <box marginBottom={1}>
        <text selectable={false}>{`jev audit — ${items.length} entries · ${filterLabel}`}</text>
      </box>
      {visible.length === 0 ? <text selectable={false}>{"no events yet"}</text> : visible.map((entry, i) => <Row entry={entry} index={i} />)}
      <box marginTop={1}>
        <text selectable={false}>{`${range} of ${entries.length} · j/k scroll · g/G top/bottom`}</text>
      </box>
      <text selectable={false}>{"a all · s screen · e error · p approval · r scrub · x config"}</text>
      <text selectable={false}>{"esc/q close · f fullscreen · c copy"}</text>
    </box>
  )
}

export default {
  id: "atvari.jev.tui.audit",
  setup(context: any) {
    const store = context.storage.store<Store>(AUDIT_STORE_KEY, { initial: { items: [] } })
    const unslot = context.ui.slot({
      append: "session.panel",
      render: (input: PanelInput) =>
        input?.name === "jev-audit" ? <Panel store={store} context={context} panel={input} /> : null,
    })
    return async () => {
      unslot()
    }
  },
}
