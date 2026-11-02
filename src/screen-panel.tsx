// TUI verdict panel for the jev screening notices. The server half emits a
// `screen` RPC event for every verdict (passes included) - that is the
// primary, transcript-free transport. This half subscribes, keeps the last 50
// verdicts in durable live-synced storage, toasts on flagged/unsafe/failed,
// and renders the panel at session.panel when opened (/jev-screen-history
// registers in src/tui.ts so it exists even if this module fails to load).
// On hosts without the RPC event surface it falls back to the legacy
// "[jev-screen] …" synthetic rows (anomalies only, in current builds).
// Solid scope is provided by the TUI plugin runtime; no solid import is
// needed to read the reactive store.
import type { JSX } from "@opentui/solid"
import {
  parseScreenNotice,
  SCREEN_NOTICE_MARK,
  screenEventItemOf,
  type ScreenVerdictItem,
} from "./logic"
import { subscribeJevEvents } from "./rpc"

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

    const record = (item: ScreenVerdictItem): void => {
      store[1]((draft: Store) => {
        draft.items.push(item)
        if (draft.items.length > CAP) draft.items.splice(0, draft.items.length - CAP)
      })
      if (item.verdict === "pass") return
      if (item.verdict === "error") {
        context.ui.toast.show({
          title: "jev-screen",
          message: `screen unavailable: ${item.note ?? item.label}`,
          variant: "error",
          duration: 10_000,
        })
        return
      }
      context.ui.toast.show({
        title: "jev-screen",
        message: `${item.verdict}: ${item.label}${item.junk !== undefined || item.injection !== undefined ? ` (junk=${item.junk ?? "?"} injection=${item.injection ?? "?"})` : ""}`,
        variant: item.verdict === "unsafe" ? "error" : "warning",
        duration: 10_000,
      })
    }

    // Primary channel: the server half's transcript-free `screen` event.
    // Subscriptions are re-established on `server.connected`: ctx.client
    // changes when the server restarts and old listeners go stale. The
    // synthetic fallback below remains for hosts without the event surface.
    let rpcActive = false
    let stopScreenEvents: (() => void) | undefined
    const connectScreen = async (): Promise<void> => {
      stopScreenEvents?.()
      const sub = await subscribeJevEvents(context, {
        screen: (data) => {
          const item = screenEventItemOf(data)
          if (item) record(item)
        },
      })
      stopScreenEvents = sub.dispose
      rpcActive = sub.active
    }
    await connectScreen()
    let stopServer: (() => void) | undefined
    try {
      stopServer = context.data.on("server.connected", () => {
        void connectScreen()
      })
    } catch {}

    // Legacy/fallback channel: synthetic rows (anomalies only in current
    // builds). Kept for hosts whose RPC surface has no events.
    const unlisten = context.data.on("session.synthetic", (event: { text?: unknown }) => {
      if (rpcActive) return
      const text = typeof event?.text === "string" ? event.text : ""
      if (!text.startsWith(SCREEN_NOTICE_MARK)) return
      const parsed = parseScreenNotice(text)
      if (parsed) record(parsed)
    })

    const unslot = context.ui.slot({
      append: "session.panel",
      render: (input: PanelInput) =>
        input?.name === "jev-screen" ? <Panel store={store} /> : <box>{""}</box>,
    })

    return async () => {
      if (typeof stopServer === "function") stopServer()
      if (typeof stopScreenEvents === "function") stopScreenEvents()
      unlisten()
      unslot()
    }
  },
}
