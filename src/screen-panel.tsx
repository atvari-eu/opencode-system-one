// TUI verdict panel for the jev screening notices. The screen hook posts
// "[jev-screen] …" synthetic rows; this half subscribes, keeps the last 50
// verdicts in durable live-synced storage, toasts on flagged/unsafe (passes
// stay silent), and renders the panel at session.panel when opened (/jev-screen-history
// registers in src/tui.ts so it exists even if this module fails to load). Solid scope is provided by the TUI
// plugin runtime; no solid import is needed to read the reactive store.
import type { JSX } from "@opentui/solid"
import { parseScreenNotice, SCREEN_NOTICE_MARK, type ScreenVerdictItem } from "./logic"

interface PanelInput {
  readonly name: string
  readonly sessionID: string
}

interface Store {
  readonly items: ScreenVerdictItem[]
}

const CAP = 50

const VERDICT_PREFIX: Record<string, string> = {
  pass: "✓ pass",
  flagged: "⚠ flagged",
  unsafe: "✗ unsafe",
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
        {`jev screening — last ${items.length}/${CAP} verdicts`}
      </box>
      {items.length === 0 ? <box>{"no verdicts yet"}</box> : items.map((item, i) => <Row item={item} index={i} />)}
    </box>
  )
}

export default {
  id: "atvari.jev.tui.screen",
  async setup(context: any) {
    // Docs shape: context.storage.store("key", { initial: value }) returns a
    // [value, updater] pair. The { initial } wrap prevents hosts that treat
    // the second argument as options from dropping a malformed raw default.
    const store = context.storage.store<Store>("jev-screen-verdicts", { initial: { items: [] } })

    const unlisten = context.data.on("session.synthetic", (event: { text?: unknown }) => {
      const text = typeof event?.text === "string" ? event.text : ""
      if (!text.startsWith(SCREEN_NOTICE_MARK)) return
      const parsed = parseScreenNotice(text)
      if (!parsed) return
      store[1]((draft: Store) => {
        draft.items.push(parsed)
        if (draft.items.length > CAP) draft.items.splice(0, draft.items.length - CAP)
      })
      if (parsed.verdict === "pass") return
      context.ui.toast.show({
        title: "jev-screen",
        message: `${parsed.verdict}: ${parsed.label}${parsed.junk !== undefined || parsed.injection !== undefined ? ` (junk=${parsed.junk ?? "?"} injection=${parsed.injection ?? "?"})` : ""}`,
        variant: parsed.verdict === "unsafe" ? "error" : "warning",
        duration: 10_000,
      })
    })

    const unslot = context.ui.slot({
      append: "session.panel",
      render: (input: PanelInput) =>
        input?.name === "jev-screen" ? <Panel store={store} /> : <box>{""}</box>,
    })

    return async () => {
      unlisten()
      unslot()
    }
  },
}
