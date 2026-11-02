/** @jsxImportSource @opentui/solid */
// TUI event-audit panel. Pure renderer: src/tui.ts owns every RPC
// subscription, reconnect, and the durable `jev-audit` store; this module
// only filters, selects, and renders it. Keep it free of ./rpc imports (see
// AGENTS.md: panels must not subscribe themselves).
//
// Filter, selection, and expansion state live in a host-owned memory store
// rather than local signals: the panel and its keymap layer must observe the
// same reactive runtime the host uses for JSX.
import type { JSX } from "@opentui/solid"
import type { ScrollBoxRenderable } from "@opentui/core"
import {
  AUDIT_FILTERS,
  AUDIT_STORE_KEY,
  filterAudit,
  type AuditEntry,
  type AuditFilter,
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
  filter: AuditFilter
  expanded: Record<string, boolean>
  selected?: string
}

const FILTER_KEYS = AUDIT_FILTERS

const TIME_W = 8
const KIND_W = 9
const DECISION_W = 12
const SUBJECT_W = 14

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

/** Single-cell status glyphs. No emoji: double-width glyphs break column alignment. */
function toneGlyph(tone: AuditEntry["tone"]): string {
  switch (tone) {
    case "ok":
      return "✓"
    case "warn":
      return "!"
    case "error":
      return "✗"
    case "info":
      return "?"
  }
}

function cell(value: string, width: number): string {
  const text = oneLine(value)
  if (text.length > width) return text.slice(0, Math.max(0, width - 1)) + "…"
  return text.padEnd(width)
}

function timeOf(entry: AuditEntry): string {
  const at = new Date(entry.at)
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}:${String(at.getSeconds()).padStart(2, "0")}`
}

const decisionOf = (entry: AuditEntry): string => entry.decision ?? entry.kind
const subjectOf = (entry: AuditEntry): string => entry.subject ?? ""
const detailOf = (entry: AuditEntry): string => entry.detail ?? entry.summary ?? ""

function showSubject(width: number): boolean {
  return width >= 92
}

function detailWidth(width: number): number {
  const fixed = 2 + 1 + TIME_W + 1 + KIND_W + (showSubject(width) ? 1 + SUBJECT_W : 0) + 1 + DECISION_W + 1
  return Math.max(8, width - fixed)
}

function moreThanRow(entry: AuditEntry, width: number): boolean {
  const detail = detailOf(entry)
  return Boolean(entry.preview) || detail.includes("\n") || oneLine(detail).length > detailWidth(width)
}

function formatRow(entry: AuditEntry, width: number, selected: boolean, expanded: boolean): string {
  const marker = `${selected ? "›" : " "}${moreThanRow(entry, width) ? (expanded ? "▾" : "▸") : " "}`
  let line = `${marker} ${cell(timeOf(entry), TIME_W)} ${cell(entry.kind, KIND_W)}`
  if (showSubject(width)) line += ` ${cell(subjectOf(entry), SUBJECT_W)}`
  return `${line} ${cell(`${toneGlyph(entry.tone)} ${decisionOf(entry)}`, DECISION_W)} ${oneLine(detailOf(entry))}`
}

function headerRow(width: number): string {
  let line = `   ${cell("TIME", TIME_W)} ${cell("KIND", KIND_W)}`
  if (showSubject(width)) line += ` ${cell("SUBJECT", SUBJECT_W)}`
  return `${line} ${cell("DECISION", DECISION_W)} DETAIL`
}

function detailBlock(entry: AuditEntry): string {
  const lines = [detailOf(entry)]
  if (entry.preview) lines.push(`content: ${entry.preview}`)
  if (entry.sessionID) lines.push(`session ${entry.sessionID}`)
  return lines.join("\n").replace(/\r\n?/g, "\n")
}

function filterName(filter: AuditFilter): string {
  return filter === "all" ? "all" : filter === "anomaly" ? "anomalies" : filter
}

function panelText(entries: readonly AuditEntry[], filter: AuditFilter): string {
  const lines = [`jev audit — ${entries.length} ${filter === "all" ? "entries" : filterName(filter) + " entries"}`]
  for (const entry of entries) {
    lines.push(`${toneGlyph(entry.tone)} ${timeOf(entry)} ${entry.kind} ${decisionOf(entry)} ${subjectOf(entry)}`.trimEnd())
    lines.push(`  ${detailBlock(entry).replace(/\n/g, "\n  ")}`)
  }
  return lines.join("\n")
}

const rowDomID = (id: string): string => `jev-audit-row-${id}`

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
  // Ascending: oldest at the top, newest at the bottom.
  const entries = (): AuditEntry[] => filterAudit(all(), view().filter ?? "all")
  const total = (): number => all().length
  const filterLabel = (): string => filterName(view().filter ?? "all")
  const expanded = (id: string): boolean => Boolean(view().expanded?.[id])
  const selectedId = (): string | undefined => {
    const current = view().selected
    if (!current) return undefined
    return entries().some((entry) => entry.id === current) ? current : undefined
  }
  const selectedEntry = (): AuditEntry | undefined => entries().find((entry) => entry.id === selectedId())
  const following = (): boolean => selectedId() === undefined
  const selectedBg = () => props.context?.theme?.background?.action?.primary?.focused
  const selectedFg = () =>
    props.context?.theme?.text?.action?.primary?.focused ?? props.context?.theme?.text?.base
  const muted = () => props.context?.theme?.text?.muted
  const width = () => props.panel.width ?? 80

  const select = (id: string): void => {
    props.view[1]((draft) => {
      draft.selected = id
    })
    list?.scrollChildIntoView?.(rowDomID(id))
  }
  const selectAt = (index: number): void => {
    const rows = entries()
    if (rows.length === 0) return
    const at = Math.max(0, Math.min(rows.length - 1, index))
    select(rows[at].id)
  }
  const moveSelection = (delta: number): void => {
    const rows = entries()
    if (rows.length === 0) return
    const current = rows.findIndex((entry) => entry.id === selectedId())
    // With no selection the view is following the newest row at the bottom;
    // the first move selects that row, later moves walk from there.
    if (current < 0) {
      selectAt(rows.length - 1)
      return
    }
    selectAt(current + delta)
  }
  const deselect = (): void => {
    props.view[1]((draft) => {
      draft.selected = undefined
    })
    list?.scrollTo(Infinity)
  }
  const toggle = (id: string): void => {
    props.view[1]((draft) => {
      draft.expanded = { ...(draft.expanded ?? {}) }
      if (draft.expanded[id]) delete draft.expanded[id]
      else draft.expanded[id] = true
    })
  }
  const selectAndToggle = (id: string): void => {
    props.view[1]((draft) => {
      draft.selected = id
      draft.expanded = { ...(draft.expanded ?? {}) }
      if (draft.expanded[id]) delete draft.expanded[id]
      else draft.expanded[id] = true
    })
    list?.scrollChildIntoView?.(rowDomID(id))
  }
  const toggleSelected = (): void => {
    const entry = selectedEntry()
    if (entry) toggle(entry.id)
  }
  const setFilter = (kind: AuditFilter): void => {
    props.view[1]((draft) => {
      draft.filter = kind
    })
    const stillVisible = selectedEntry()
    if (stillVisible) {
      list?.scrollChildIntoView?.(rowDomID(stillVisible.id))
      return
    }
    props.view[1]((draft) => {
      draft.selected = undefined
    })
    list?.scrollTo(Infinity)
  }
  const copy = (text: string, what: string): void => {
    let ok = false
    try {
      ok = props.context.renderer?.copyToClipboardOSC52?.(text) === true
    } catch {}
    props.context.ui.toast.show({
      title: "jev-audit",
      message: ok ? `copied ${what}` : "clipboard unavailable - this terminal rejected OSC52",
      variant: ok ? "success" : "warning",
      duration: 4_000,
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
    if ((props.panel.width ?? 0) < 88) {
      return `${key("jev.audit.down", "j")}/${key("jev.audit.up", "k")} select · ${key("jev.audit.expand", "enter")} expand · ${key("jev.audit.copy-row", "y")} copy · ${key("jev.audit.deselect", "d")} follow · esc/q close`
    }
    return `${key("jev.audit.down", "j")}/${key("jev.audit.up", "k")} select · ${key("jev.audit.top", "g")}/G top/bottom · ${key("jev.audit.expand", "enter")} expand · ${key("jev.audit.copy-row", "y")} copy · ${key("jev.audit.copy", "c")} copy all · ${key("jev.audit.deselect", "d")} follow · ${key("jev.audit.fullscreen", "f")} fullscreen · esc/q close`
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
        title: "Select next audit row",
        bind: "j",
        run: () => moveSelection(1),
      },
      {
        id: "jev.audit.up",
        title: "Select previous audit row",
        bind: "k",
        run: () => moveSelection(-1),
      },
      {
        id: "jev.audit.top",
        title: "Audit oldest",
        bind: "g",
        run: () => {
          selectAt(0)
          list?.scrollTo(0)
        },
      },
      {
        id: "jev.audit.bottom",
        title: "Audit newest",
        bind: "shift+g",
        run: () => {
          selectAt(entries().length - 1)
          list?.scrollTo(Infinity)
        },
      },
      {
        id: "jev.audit.deselect",
        title: "Deselect audit row and follow newest",
        bind: "d",
        run: deselect,
      },
      {
        id: "jev.audit.expand",
        title: "Toggle selected audit row",
        bind: "return",
        run: toggleSelected,
      },
      {
        id: "jev.audit.expand-space",
        title: "Toggle selected audit row",
        bind: "space",
        run: toggleSelected,
      },
      {
        id: "jev.audit.copy-row",
        title: "Copy selected audit row",
        bind: "y",
        run: () => {
          const entry = selectedEntry()
          if (entry) copy(panelText([entry], view().filter ?? "all"), "selected event")
        },
      },
      {
        id: "jev.audit.copy",
        title: "Copy jev audit",
        bind: "c",
        run: () => copy(panelText(entries(), view().filter ?? "all"), filterLabel() === "all" ? "all entries" : "filtered entries"),
      },
      { id: "jev.audit.filter-all", title: "Jev audit filter: all", bind: "a", run: () => setFilter("all") },
      {
        id: "jev.audit.filter-anomaly",
        title: "Jev audit filter: anomalies",
        bind: "n",
        run: () => setFilter("anomaly"),
      },
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

  return (
    <box flexDirection="column" flexGrow={1} height="100%" minHeight={0} paddingLeft={1} paddingRight={1} selectable={false}>
      <box flexShrink={0} flexDirection="row" gap={1} marginBottom={1}>
        <text flexShrink={0} selectable={false}>{`jev audit — ${total()} entries · filter: ${filterLabel()} ·`}</text>
        {() => {
          const current = view().filter
          return FILTER_KEYS.map((item) => (
            <text
              flexShrink={0}
              selectable={false}
              fg={muted()}
              onMouseUp={() => setFilter(item.kind)}
            >
              {`${current === item.kind ? "▸" : " "}${item.key} ${item.label}`}
            </text>
          ))
        }}
      </box>
      <text flexShrink={0} selectable={false} fg={muted()}>{headerRow(width())}</text>
      <scrollbox
        ref={(value: ScrollBoxRenderable) => {
          list = value
          if (following()) value.scrollTo(Infinity)
        }}
        flexGrow={1}
        minHeight={0}
        stickyScroll={following()}
        stickyStart="bottom"
        focusable={false}
        selectable={false}
      >
        {() => {
          const rows = entries()
          if (rows.length === 0) return <text selectable={false}>{"no events yet"}</text>
          const selected = selectedId()
          const w = width()
          const nodes: JSX.Element[] = []
          for (const entry of rows) {
            const isSelected = entry.id === selected
            const isExpanded = expanded(entry.id)
            nodes.push(
              <text
                id={rowDomID(entry.id)}
                selectable={false}
                bg={isSelected ? selectedBg() : undefined}
                fg={isSelected ? selectedFg() : undefined}
                wrapMode="none"
                truncate
                onMouseUp={() => selectAndToggle(entry.id)}
              >
                {formatRow(entry, w, isSelected, isExpanded)}
              </text>,
            )
            if (isExpanded) {
              nodes.push(
                <text selectable={false} wrapMode="word" fg={muted()}>
                  {`    ${detailBlock(entry).replace(/\n/g, "\n    ")}`}
                </text>,
              )
            }
          }
          return nodes
        }}
      </scrollbox>
      <box flexShrink={0} flexDirection="row" paddingTop={1}>
        <text flexGrow={1} minWidth={0} wrapMode="none" truncate selectable={false} fg={muted()}>
          {following()
            ? "following newest · click a row to select"
            : entries().some((entry) => moreThanRow(entry, width()))
              ? "▸ click or enter to expand"
              : "selected"}
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
