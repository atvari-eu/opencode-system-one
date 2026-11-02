/** @jsxImportSource @opentui/solid */
// TUI event-audit panel. Pure renderer: src/tui.ts owns every RPC
// subscription, reconnect, and the durable `jev-audit` store; this module
// only filters and renders it. Keep it free of ./rpc imports (see
// AGENTS.md: panels must not subscribe themselves).
//
// Filter and expansion state live in a host-owned memory store rather than
// local signals: the panel and its keymap layer must observe the same reactive
// runtime the host uses for JSX, and a plain getter read inside JSX is the
// simplest way to keep that true.
import type { JSX } from "@opentui/solid"
import type { ScrollBoxRenderable } from "@opentui/core"
import {
  AUDIT_FILTERS,
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

interface ViewStore {
  filter: AuditKind | "all"
  expanded: Record<string, boolean>
}

const FILTER_KEYS = AUDIT_FILTERS

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

function formatEntry(entry: AuditEntry, expanded: boolean, width: number): string {
  const at = new Date(entry.at)
  const time = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`
  const summary = entry.summary ?? ""
  const flat = oneLine(summary)
  const more = summary.includes("\n") || flat.length > Math.max(24, width - 22)
  const marker = more ? (expanded ? "▾" : "▸") : " "
  const body = expanded ? summary.trim().replace(/\n/g, "\n  ") : flat
  return `${marker} ${time}  ${entry.kind.padEnd(8)}  ${body}`
}

function panelText(entries: readonly AuditEntry[], filter: AuditKind | "all"): string {
  return [`jev audit — ${entries.length} ${filter === "all" ? "entries" : filter + " entries"}`, ...entries.map((entry) => formatEntry(entry, true, 80))].join("\n")
}

function Panel(props: {
  store: readonly [Store, unknown]
  view: readonly [ViewStore, (mutation: (draft: ViewStore) => void) => void]
  context: any
  panel: PanelInput
}): JSX.Element {
  let list: ScrollBoxRenderable | undefined

  // Plain reads inside JSX keep reactivity in the host's Solid runtime.
  const view = (): ViewStore => props.view?.[0] ?? { filter: "all", expanded: {} }
  const all = (): AuditEntry[] => props.store?.[0]?.items ?? []
  const entries = (): AuditEntry[] => filterAudit(all(), view().filter ?? "all")
  const total = (): number => all().length
  const filterLabel = (): string => {
    const current = view().filter ?? "all"
    return current === "all" ? "all" : current
  }
  const expanded = (id: string): boolean => Boolean(view().expanded?.[id])
  const setFilter = (kind: AuditKind | "all"): void => {
    props.view[1]((draft) => {
      draft.filter = kind
    })
    list?.scrollTo(0)
  }
  const toggleExpanded = (id: string): void => {
    props.view[1]((draft) => {
      draft.expanded = { ...(draft.expanded ?? {}) }
      if (draft.expanded[id]) delete draft.expanded[id]
      else draft.expanded[id] = true
    })
  }

  // Footer hints use the host's live bindings, so a remapped key is shown as
  // configured. `shortcuts` is reactive and must be read inside JSX.
  const key = (id: string, fallback: string): string => {
    try {
      return props.context.keymap.shortcuts(id).join("/") || fallback
    } catch {
      return fallback
    }
  }
  const navigationHints = (): string => {
    if ((props.panel.width ?? 0) < 72) {
      return `${key("jev.audit.down", "j")}/${key("jev.audit.up", "k")} scroll · ${key("jev.audit.copy", "c")} copy · esc/q close`
    }
    return `${key("jev.audit.down", "j")}/${key("jev.audit.up", "k")} scroll · ${key("jev.audit.top", "g")}/${key("jev.audit.bottom", "shift+g")} top/bottom · ${key("jev.audit.copy", "c")} copy · ${key("jev.audit.fullscreen", "f")} fullscreen · esc/q close`
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
            ok = props.context.renderer?.copyToClipboardOSC52?.(panelText(shown, view().filter ?? "all")) === true
          } catch {}
          props.context.ui.toast.show({
            title: "jev-audit",
            message: ok
              ? `copied ${shown.length} ${filterLabel() === "all" ? "entries" : filterLabel() + " entries"}`
              : "clipboard unavailable - this terminal rejected OSC52",
            variant: ok ? "success" : "warning",
            duration: 4_000,
          })
        },
      },
      { id: "jev.audit.filter-all", title: "Jev audit filter: all", bind: "a", run: () => setFilter("all") },
      { id: "jev.audit.filter-screen", title: "Jev audit filter: screen", bind: "s", run: () => setFilter("screen") },
      { id: "jev.audit.filter-error", title: "Jev audit filter: errors", bind: "e", run: () => setFilter("error") },
      {
        id: "jev.audit.filter-approval",
        title: "Jev audit filter: approvals",
        bind: "p",
        run: () => setFilter("approval"),
      },
      { id: "jev.audit.filter-scrub", title: "Jev audit filter: scrub", bind: "r", run: () => setFilter("scrub") },
      { id: "jev.audit.filter-config", title: "Jev audit filter: config", bind: "x", run: () => setFilter("config") },
    ],
  }))

  const muted = () => props.context?.theme?.text?.muted
  const active = () => props.context?.theme?.text?.base
  const width = () => props.panel.width ?? 80
  return (
    <box flexDirection="column" flexGrow={1} height="100%" minHeight={0} paddingLeft={1} paddingRight={1} selectable={false}>
      <box flexShrink={0} flexDirection="row" gap={1} marginBottom={1}>
        <text flexShrink={0} selectable={false}>{`jev audit — ${total()} entries · `}</text>
        {FILTER_KEYS.map((item) => (
          <text
            flexShrink={0}
            selectable={false}
            fg={view().filter === item.kind ? active() : muted()}
            onMouseUp={() => setFilter(item.kind)}
          >
            {`${item.key} ${item.label}`}
          </text>
        ))}
      </box>
      <scrollbox ref={(value: ScrollBoxRenderable) => (list = value)} flexGrow={1} minHeight={0} selectable={false}>
        {() => {
          const rows = entries()
          if (rows.length === 0) return <text selectable={false}>{"no events yet"}</text>
          return rows.map((entry) => {
            const isExpanded = expanded(entry.id)
            return (
              <text
                selectable={false}
                wrapMode={isExpanded ? "word" : "none"}
                truncate={!isExpanded}
                onMouseUp={() => toggleExpanded(entry.id)}
              >
                {formatEntry(entry, isExpanded, width())}
              </text>
            )
          })
        }}
      </scrollbox>
      <box flexShrink={0} flexDirection="row" paddingTop={1}>
        <text flexGrow={1} minWidth={0} wrapMode="none" truncate selectable={false} fg={muted()}>
          {entries().some((entry) => entry.summary?.includes("\n") || oneLine(entry.summary ?? "").length > Math.max(24, width() - 22)) ? "▸ click a row to expand" : ""}
        </text>
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
    const view = context.storage.memory<ViewStore>("jev-audit-view", {
      initial: { filter: "all", expanded: {} },
    })
    const unslot = context.ui.slot({
      append: "session.panel",
      render: (input: PanelInput) =>
        input?.name === "jev-audit" ? <Panel store={store} view={view} context={context} panel={input} /> : null,
    })
    return async () => {
      unslot()
    }
  },
}
