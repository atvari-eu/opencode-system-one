// TUI half of the jev plugin: turns the server plugin's "[jev-error] …"
// synthetic rows into the same top-corner error toasts OpenCode shows for
// its own failures. The server posts at most one row per failure class per
// minute (see src/index.ts surfaceJev), so toast spam stays bounded.
//
// Kept import-free: this module is loaded by the TUI plugin runtime, whose
// own `@opencode/plugin/tui` re-exports pull solid-js in. A structural shape
// (id + setup, exactly what the runtime validates) avoids that dependency.
import { JEVS_ERROR_MARK } from "./logic"

interface ToastOptions {
  readonly title?: string
  readonly message: string
  readonly variant?: "info" | "success" | "warning" | "error"
  readonly duration?: number
  readonly sessionID?: string
}

interface TuiContext {
  readonly data: {
    readonly on: (
      type: string,
      handler: (event: { readonly text?: unknown; readonly sessionID?: unknown }) => void,
    ) => () => void
  }
  readonly ui: {
    readonly toast: {
      readonly show: (options: ToastOptions) => void
    }
  }
}

export default {
  id: "atvari.jev.tui",
  async setup(context: TuiContext) {
    const unlisten = context.data.on("session.synthetic", (event) => {
      const text = typeof event?.text === "string" ? event.text : ""
      if (!text.startsWith(JEVS_ERROR_MARK)) return
      context.ui.toast.show({
        title: "jev",
        message: text.slice(JEVS_ERROR_MARK.length),
        variant: "error",
        duration: 10_000,
        ...(typeof event?.sessionID === "string" ? { sessionID: event.sessionID } : {}),
      })
    })
    return async () => unlisten()
  },
}
