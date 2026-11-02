/** @jsxImportSource @opentui/solid */
// TUI verdict panel for the jev screening notices. This module is a pure
// renderer: src/tui.ts owns all RPC event subscriptions, reconnects, and
// writes the durable `jev-screen-verdicts` store (including the
// flagged/unsafe/failed toasts). Keeping `./rpc` out of this module means a
// stale or unavailable RPC export can never stop the panel itself from
// loading - the half-updated-module failure mode that took
// /jev-screen-history down on a pin update.
// Solid scope is provided by the TUI plugin runtime; no solid import is
// needed to read the reactive store.
import type { JSX } from "@opentui/solid"
import { createSignal } from "solid-js"
import { SCREEN_VERDICT_CAP, type ScreenVerdictItem } from "./logic"

interface PanelInput {
  readonly name: string
  readonly sessionID: string
  readonly close: () => void
  readonly toggleFullscreen: () => void
}

interface Store {
  readonly items: ScreenVerdictItem[]
}

/** Rows shown at once; j/k move the window over the capped verdict ring. */
const PANEL_PAGE = 15

const VERDICT_PREFIX: Record<string, string> = {
  pass: "✓ pass",
  flagged: "⚠ flagged",
  unsafe: "✗ unsafe",
  error: "✗ error",
}

function formatItem(item: ScreenVerdictItem): string {
  const at = typeof item.at === "number" ? new Date(item.at) : undefined
  const time = at
    ? `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`
    : "--:--"
  const counts = [
    item.junk !== undefined ? `junk=${item.junk.toFixed(2)}` : undefined,
    item.injection !== undefined ? `injection=${item.injection.toFixed(2)}` : undefined,
    item.secret !== undefined ? `secret=${item.secret.toFixed(2)}` : undefined,
  ]
    .filter(Boolean)
    .join(" ")
  return `${time}  ${VERDICT_PREFIX[item.verdict] ?? item.verdict}  ${item.label}${counts ? " — " + counts : ""}${item.note ? " — " + item.note : ""}`
}

function Row(props: { item: ScreenVerdictItem; index: number }): JSX.Element {
  return <text key={props.index} selectable={false}>{formatItem(props.item)}</text>
}

function panelText(items: ScreenVerdictItem[]): string {
  return [`jev screening — last ${items.length}/${SCREEN_VERDICT_CAP} verdicts`, ...items.map(formatItem)].join("\n")
}

function Panel(props: { store: readonly [Store, unknown]; context: any; panel: PanelInput }): JSX.Element {
  const [start, setStart] = createSignal(0)
  // store[0] is the reactive value; items can be briefly undefined while the
  // initial value syncs, or if an older host ignored the { initial } default.
  const all = (): ScreenVerdictItem[] => props.store?.[0]?.items ?? []
  const clampStart = (value: number): number => {
    const total = all().length
    return Math.max(0, Math.min(value, Math.max(0, total - PANEL_PAGE)))
  }
  // The host owns the panel chrome; expose explicit keys so the panel is
  // never a dead end. The layer is disposed with the component.
  props.context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "jev.screen.close",
        title: "Close jev screening verdicts",
        bind: "escape",
        run: () => props.panel.close(),
      },
      {
        id: "jev.screen.close-q",
        title: "Close jev screening verdicts",
        bind: "q",
        run: () => props.panel.close(),
      },
      {
        id: "jev.screen.fullscreen",
        title: "Toggle jev screening fullscreen",
        bind: "f",
        run: () => props.panel.toggleFullscreen(),
      },
      {
        id: "jev.screen.down",
        title: "Scroll verdicts down",
        bind: "j",
        run: () => setStart((value) => clampStart(value + 1)),
      },
      {
        id: "jev.screen.up",
        title: "Scroll verdicts up",
        bind: "k",
        run: () => setStart((value) => clampStart(value - 1)),
      },
      {
        id: "jev.screen.top",
        title: "Verdicts top",
        bind: "g",
        run: () => setStart(0),
      },
      {
        id: "jev.screen.bottom",
        title: "Verdicts bottom",
        bind: "shift+g",
        run: () => setStart(clampStart(Number.MAX_SAFE_INTEGER)),
      },
      {
        id: "jev.screen.copy",
        title: "Copy jev screening verdicts",
        bind: "c",
        run: () => {
          // Read the store at press time, not the value captured on mount.
          const current = all()
          let ok = false
          try {
            ok = props.context.renderer?.copyToClipboardOSC52?.(panelText(current)) === true
          } catch {}
          props.context.ui.toast.show({
            title: "jev-screen",
            message: ok
              ? `copied ${current.length} verdict(s)`
              : "clipboard unavailable - this terminal rejected OSC52",
            variant: ok ? "success" : "warning",
            duration: 4_000,
          })
        },
      },
    ],
  }))
  const items = all()
  const first = Math.min(start(), Math.max(0, items.length - PANEL_PAGE))
  const visible = items.slice(first, first + PANEL_PAGE)
  const range = items.length === 0 ? "0-0" : `${first + 1}-${first + visible.length}`
  const scrollable = items.length > PANEL_PAGE
  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} selectable={false}>
      <box marginBottom={1}>
        <text selectable={false}>{`jev screening — last ${items.length}/${SCREEN_VERDICT_CAP} verdicts`}</text>
      </box>
      {visible.length === 0 ? <text selectable={false}>{"no verdicts yet"}</text> : visible.map((item, i) => <Row item={item} index={i} />)}
      <box marginTop={1}>
        <text selectable={false}>{`${range} of ${items.length}${scrollable ? " · j/k scroll · g/G top/bottom" : ""}`}</text>
      </box>
      <text selectable={false}>{"esc/q close · f fullscreen · c copy"}</text>
    </box>
  )
}

export default {
  id: "atvari.jev.tui.screen",
  setup(context: any) {
    // Docs shape: context.storage.store("key", { initial: value }) returns a
    // [value, updater] pair. The { initial } wrap prevents hosts that treat
    // the second argument as options from dropping a malformed raw default.
    const store = context.storage.store<Store>("jev-screen-verdicts", { initial: { items: [] } })
    const unslot = context.ui.slot({
      append: "session.panel",
      render: (input: PanelInput) =>
        input?.name === "jev-screen" ? <Panel store={store} context={context} panel={input} /> : null,
    })
    return async () => {
      unslot()
    }
  },
}
