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
import { SCREEN_VERDICT_CAP, type ScreenVerdictItem } from "./logic"

interface PanelInput {
  readonly name: string
  readonly sessionID: string
}

interface Store {
  readonly items: ScreenVerdictItem[]
}

const VERDICT_PREFIX: Record<string, string> = {
  pass: "✓ pass",
  flagged: "⚠ flagged",
  unsafe: "✗ unsafe",
  error: "✗ error",
}

function Row(props: { item: ScreenVerdictItem; index: number }): JSX.Element {
  const at = new Date(props.item.at)
  const time = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`
  const counts = [
    props.item.junk !== undefined ? `junk=${props.item.junk.toFixed(2)}` : undefined,
    props.item.injection !== undefined ? `injection=${props.item.injection.toFixed(2)}` : undefined,
    props.item.secret !== undefined ? `secret=${props.item.secret.toFixed(2)}` : undefined,
  ]
    .filter(Boolean)
    .join(" ")
  const text = `${time}  ${VERDICT_PREFIX[props.item.verdict] ?? props.item.verdict}  ${props.item.label}${counts ? " — " + counts : ""}${props.item.note ? " — " + props.item.note : ""}`
  return <box key={props.index}>{text}</box>
}

function Panel(props: { store: readonly [Store, unknown] }): JSX.Element {
  // store[0] is the reactive value; items can be briefly undefined while the
  // initial value syncs, or if an older host ignored the { initial } default
  const items = props.store?.[0]?.items ?? []
  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1}>
      <box marginBottom={1}>
        {`jev screening — last ${items.length}/${SCREEN_VERDICT_CAP} verdicts`}
      </box>
      {items.length === 0 ? <box>{"no verdicts yet"}</box> : items.map((item, i) => <Row item={item} index={i} />)}
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
        input?.name === "jev-screen" ? <Panel store={store} /> : <box>{""}</box>,
    })
    return async () => {
      unslot()
    }
  },
}
