/** @jsxImportSource @opentui/solid */
// TUI event-audit panel. Pure renderer: src/tui.ts owns every RPC
// subscription, reconnect, and the durable `jev-audit` store; this module
// only filters and renders it. Keep it free of ./rpc imports (see
// AGENTS.md: panels must not subscribe themselves).
import type { JSX } from "@opentui/solid"
import type { ScrollBoxRenderable } from "@opentui/core"
import { createMemo, createSignal, For } from "solid-js"
import {
  AUDIT_STORE_KEY,
  filterAudit,
  type AuditEntry,
  type AuditKind,
} from "./audit"

interface PanelInput {
  readonly name: string
  readonly sessionID: string
  readonly width: number
  readonly close: () => void
  readonly toggleFullscreen: () => void
}

interface Store {
  readonly items: AuditEntry[]
}

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

function Panel(props: { store: readonly [Store, unknown]; context: any; panel: PanelInput }): JSX.Element {
  const [filter, setFilter] = createSignal<AuditKind | "all">("all")
  let list: ScrollBoxRenderable | undefined

  // Every read below is reactive: the storage tuple is a Solid store, and the
  // panel stays mounted while events stream in.
  const all = (): AuditEntry[] => props.store?.[0]?.items ?? []
  const total = createMemo(() => all().length)
  const entries = createMemo(() => filterAudit(all(), filter()))
  const filterLabel = (): string => (filter() === "all" ? "all" : filter())

  // Footer hints use the host's live bindings, so a remapped key is shown as
  // configured. `shortcuts` is reactive and must be read inside JSX/memos.
  const key = (id: string, fallback: string): string => {
    try {
      return props.context.keymap.shortcuts(id).join("/") || fallback
    } catch {
      return fallback
    }
  }
  const navigationHints = createMemo(() => {
    const compact = (props.panel.width ?? 0) < 72
    if (compact) return `${key("jev.audit.down", "j")}/${key("jev.audit.up", "k")} scroll · c copy · esc/q close`
    return `${key("jev.audit.down", "j")}/${key("jev.audit.up", "k")} scroll · ${key("jev.audit.top", "g")}/${key("jev.audit.bottom", "shift+g")} top/bottom · ${key("jev.audit.copy", "c")} copy · ${key("jev.audit.fullscreen", "f")} fullscreen · esc/q close`
  })

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
        run: () => list?.scrollBy(1),
      },
      {
        id: "jev.audit.up",
        title: "Scroll audit up",
        bind: "k",
        run: () => list?.scrollBy(-1),
      },
      {
        id: "jev.audit.top",
        title: "Audit top",
        bind: "g",
        run: () => list?.scrollTo(0),
      },
      {
        id: "jev.audit.bottom",
        title: "Audit bottom",
        bind: "shift+g",
        run: () => list?.scrollTo(Infinity),
      },
      {
        id: "jev.audit.copy",
        title: "Copy jev audit",
        bind: "c",
        run: () => {
          const shown = entries()
          let ok = false
          try {
            ok = props.context.renderer?.copyToClipboardOSC52?.(panelText(shown, filter())) === true
          } catch {}
          props.context.ui.toast.show({
            title: "jev-audit",
            message: ok
              ? `copied ${shown.length} ${filter() === "all" ? "entries" : filter() + " entries"}`
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
          list?.scrollTo(0)
        },
      })),
    ],
  }))

  const muted = () => props.context?.theme?.text?.muted
  return (
    <box flexDirection="column" flexGrow={1} height="100%" minHeight={0} paddingLeft={1} paddingRight={1} selectable={false}>
      <box flexShrink={0} marginBottom={1}>
        <text selectable={false}>{`jev audit — ${total()} entries · ${filterLabel()} · a/s/e/p/r/x filter`}</text>
      </box>
      <scrollbox ref={(value: ScrollBoxRenderable) => (list = value)} flexGrow={1} minHeight={0} selectable={false}>
        <For each={entries()} fallback={<text selectable={false}>{"no events yet"}</text>}>
          {(entry) => <text selectable={false}>{formatEntry(entry)}</text>}
        </For>
      </scrollbox>
      <box flexShrink={0} flexDirection="row" paddingTop={1}>
        <box flexGrow={1} />
        <text flexShrink={0} wrapMode="none" truncate selectable={false} fg={muted()}>
          {navigationHints()}
        </text>
      </box>
    </box>
  )
}

export default {
  id: "atvari.jev.tui.audit",
  setup(context: any) {
    const store = context.storage.store<Store>(AUDIT_STORE_KEY, { initial: { items: [] }, key: "id" })
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
