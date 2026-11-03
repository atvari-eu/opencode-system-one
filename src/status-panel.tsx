/** @jsxImportSource @opentui/solid */
// TUI status panel. Pure renderer: src/tui.ts owns the jev-config rpc call,
// the snapshot store, and the refresh trigger; this module only lays the
// snapshot out. Keep it free of ./rpc imports (see AGENTS.md: panels must not
// subscribe themselves).
import type { JSX } from "@opentui/solid"
import { AUDIT_STORE_KEY, type AuditEntry } from "./audit"
import {
  STATUS_STORE_KEY,
  effectiveModel,
  statusSections,
  statusText,
  type StatusStore,
} from "./status"

interface PanelInput {
  readonly name: string
  readonly sessionID: string
  readonly width: number
  readonly close: () => void
  readonly toggleFullscreen: () => void
}

interface AuditItems {
  readonly items: AuditEntry[]
}

/** tui.ts assigns the refresh callback once its rpc client exists; the
 * panel's keymap calls through it so no subscription lives here. */
export const statusRefresh: { current?: () => void } = {}

/** OpenTUI renders accessor children reactively; its JSX types only accept
 * `string | Element`, so returning the function unchanged keeps the runtime
 * shape while satisfying the types. */
const reactiveChild = (render: () => unknown): any => render

/** AGENTS.md requires panels stay unselectable (mouse text selection over the
 * panel tree corrupts the TUI). `list`, `text` expose the prop, `box` /
 * `scrollbox` do not in the host's JSX types, so spread it there. */
const NO_SELECT = { selectable: false }

function clockOf(at: number): string {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`
}

function Panel(props: {
  store: readonly [StatusStore, unknown]
  audit: readonly [AuditItems, unknown]
  context: any
  panel: PanelInput
}): JSX.Element {
  const state = (): StatusStore => props.store?.[0] ?? { status: null, at: 0 }
  const items = (): AuditEntry[] => props.audit?.[0]?.items ?? []
  const muted = () => props.context?.theme?.text?.muted

  const copy = (text: string): void => {
    let ok = false
    try {
      ok = props.context.renderer?.copyToClipboardOSC52?.(text) === true
    } catch {}
    props.context.ui.toast.show({
      title: "jev-status",
      message: ok ? "copied the status snapshot" : "clipboard unavailable - this terminal rejected OSC52",
      variant: ok ? "success" : "warning",
      duration: 4_000,
    })
  }

  // Footer hints use the host's live bindings, so a remapped key shows as
  // configured. `shortcuts` is reactive and must be read inside JSX.
  const key = (id: string, fallback: string): string => {
    try {
      return props.context.keymap.shortcuts(id).join("/") || fallback
    } catch {
      return fallback
    }
  }
  const navigationHints = (): string => {
    const refresh = `${key("jev.status.refresh", "r")} refresh`
    if ((props.panel.width ?? 0) < 88) return `${refresh} · ${key("jev.status.copy", "c")} copy · esc/q close`
    return `${refresh} · ${key("jev.status.copy", "c")} copy · ${key("jev.status.fullscreen", "f")} fullscreen · esc/q close`
  }

  props.context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "jev.status.close",
        title: "Close jev status",
        bind: "escape",
        run: () => props.panel.close(),
      },
      {
        id: "jev.status.close-q",
        title: "Close jev status",
        bind: "q",
        run: () => props.panel.close(),
      },
      {
        id: "jev.status.fullscreen",
        title: "Toggle jev status fullscreen",
        bind: "f",
        run: () => props.panel.toggleFullscreen(),
      },
      {
        id: "jev.status.refresh",
        title: "Refresh jev status",
        bind: "r",
        run: () => statusRefresh.current?.(),
      },
      {
        id: "jev.status.copy",
        title: "Copy jev status",
        bind: "c",
        run: () => {
          const snapshot = state()
          if (!snapshot.status) return
          copy(statusText(snapshot.status, items(), snapshot.at || Date.now()))
        },
      },
    ],
  }))

  return (
    <box flexDirection="column" flexGrow={1} height="100%" minHeight={0} paddingLeft={1} paddingRight={1} {...NO_SELECT}>
      <box flexShrink={0} flexDirection="row" gap={1} marginBottom={1}>
        {reactiveChild(() => {
          const snapshot = state()
          const model = snapshot.status ? effectiveModel(snapshot.status) : "no snapshot"
          const at = snapshot.at > 0 ? ` · ${clockOf(snapshot.at)}` : ""
          return <text flexShrink={0} selectable={false}>{`jev status — ${model}${at}${snapshot.fetching ? " · refreshing…" : ""}`}</text>
        })}
      </box>
      <scrollbox flexGrow={1} minHeight={0} focusable={false} {...NO_SELECT}>
        {reactiveChild(() => {
          const snapshot = state()
          const nodes: JSX.Element[] = []
          if (!snapshot.status) {
            nodes.push(
              <text selectable={false} wrapMode="word">
                {snapshot.error
                  ? `status unavailable: ${snapshot.error}`
                  : "no snapshot yet - press r to refresh"}
              </text>,
            )
            return nodes
          }
          const sections = statusSections(snapshot.status, items(), snapshot.at || Date.now())
          for (const section of sections) {
            nodes.push(
              <text selectable={false} fg={muted()} marginTop={1}>
                {`▌ ${section.title}`}
              </text>,
            )
            for (const line of section.lines) {
              nodes.push(
                <text selectable={false} fg={line.muted ? muted() : undefined} wrapMode="word">
                  {line.text}
                </text>,
              )
            }
          }
          return nodes
        })}
      </scrollbox>
      <box flexShrink={0} flexDirection="row" paddingTop={1}>
        {reactiveChild(() => (
          <text flexGrow={1} minWidth={0} wrapMode="none" truncate selectable={false} fg={muted()}>
            {state().error ? `last refresh failed: ${state().error}` : ""}
          </text>
        ))}
        {reactiveChild(() => (
          <text flexShrink={0} wrapMode="none" truncate selectable={false} fg={muted()}>
            {navigationHints()}
          </text>
        ))}
      </box>
    </box>
  )
}

/** Minimal host surface this setup uses; the full TUI context is host-owned
 * and much larger, so only the touched members are declared. */
type StoreEntry<T> = [T, (updater: (draft: T) => void) => void]

interface PanelContext {
  readonly storage: {
    store<T>(key: string, options: { initial: T; key?: string }): StoreEntry<T>
  }
  readonly ui: {
    readonly toast: { readonly show: (options: any) => void }
    readonly slot?: (input: any) => () => void
  }
  readonly keymap: {
    readonly layer: (input: any) => any
    readonly shortcuts: (id: string) => string[]
  }
  readonly renderer?: any
}

export default {
  id: "atvari.jev.tui.status",
  setup(context: PanelContext) {
    const store = context.storage.store<StatusStore>(STATUS_STORE_KEY, {
      initial: { status: null, at: 0 },
    })
    const audit = context.storage.store<AuditItems>(AUDIT_STORE_KEY, {
      initial: { items: [] },
      key: "id",
    })
    const unslot = context.ui.slot?.({
      append: "session.panel",
      render: (input: PanelInput) =>
        input?.name === "jev-status" ? (
          <Panel store={store} audit={audit} context={context} panel={input} />
        ) : null,
    })
    return async () => {
      unslot?.()
    }
  },
}
