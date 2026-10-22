// TUI half of the jev plugin: turns the server plugin's "[jev-error] …"
// synthetic rows into the same top-corner error toasts OpenCode shows for
// its own failures, and its "[jev-config-error] …" init-fault rows into a
// once-per-config-change toast (same mark-rows channel, own layer). The
// server posts one row per failed jev call (see src/index.ts surfaceJev) -
// every failure toasts, on purpose; the config layer is the only cadence
// that keeps a dedupe gate.
//
// Also composes the screen-verdict panel (src/screen-panel.tsx, solid JSX -
// the TUI loader compiles TSX with babel-preset-solid; the dynamic import
// keeps the error-toast path working even if the panel fails to load). The
// "open the verdict panel" command lives HERE, not in the panel module, so
// /jev-screen-history exists even when the TSX panel itself fails to load.
//
// Also drives /jev-models (switch the System One judgment model for the
// current session): the dialog calls the server half through the jev-config
// rpc (src/rpc.ts), which verifies every pick with the init ping before
// storing the pin. The prompt-footer marker for the active model renders in
// src/footer-jev-model.tsx.
//
// Kept import-free: this module is loaded by the TUI plugin runtime, whose
// own `@opencode/plugin/tui` re-exports pull solid-js in. A structural shape
// (id + setup, exactly what the runtime validates) avoids that dependency.
import { JEVS_ERROR_MARK, JEV_CONFIG_ERROR_MARK, jevModelTag } from "./logic"
import { jevRpcClientOf, JEV_MODEL_STORE_KEY, type JevModelStore } from "./rpc"

interface ToastOptions {
  readonly title?: string
  readonly message: string
  readonly variant?: "info" | "success" | "warning" | "error"
  readonly duration?: number
  readonly sessionID?: string
}

interface SelectAction {
  readonly bind: string
  readonly title: string
  readonly side?: "left" | "right"
  /** "none" keeps the dialog open for follow-ups (the picker's reset). */
  readonly selection: "none"
  readonly onTrigger: () => void | Promise<void>
}

interface SelectOptions {
  readonly title: string
  readonly placeholder?: string
  readonly current?: string
  readonly options: ReadonlyArray<{
    readonly title: string
    readonly value: string
    readonly description?: string
  }>
  readonly actions?: ReadonlyArray<SelectAction>
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
    /** Host versions with the model-style picker dialog (optional surface;
     * /jev-models toasts the direct `/jev-models <id>` remedy when missing). */
    readonly dialog?: {
      /** Resolves the picked option's value, or undefined on Escape/clear. */
      readonly select?: (options: SelectOptions) => Promise<string | undefined>
      /** Force-closes an open dialog (resolves a pending select). */
      readonly clear?: () => void
    }
  }
  /** Host versions that expose generated rpc clients (optional surface) -
   * the how /jev-models reaches the server half; see src/rpc.ts. */
  readonly client?: {
    readonly rpc?: (definition: unknown) => {
      readonly describe?: (input: { sessionID?: string }) => Promise<any>
      readonly set?: (input: { sessionID: string; model: string }) => Promise<any>
      readonly reset?: (input: { sessionID: string }) => Promise<any>
    }
  }
}

export default {
  id: "atvari.jev.tui",
  async setup(context: TuiContext & Record<string, any>) {
    const cleanups: Array<() => void | Promise<void>> = []
    // -- error toasts --
    // Two layers, both synthetic-row marks from the server half:
    //   [jev-error]        one row per failed jev call, no dedupe (the
    //                      regular, per-call failure surface)
    //   [jev-config-error] posted by the init deployment check only when the
    //                      broken deployment (endpoint+model fingerprint)
    //                      changed since the last report - heads up once
    //                      per config change, shown a little longer
    const unlisten = context.data.on("session.synthetic", (event) => {
      const text = typeof event?.text === "string" ? event.text : ""
      if (text.startsWith(JEV_CONFIG_ERROR_MARK)) {
        context.ui.toast.show({
          title: "jev config",
          message: text.slice(JEV_CONFIG_ERROR_MARK.length),
          variant: "error",
          duration: 20_000,
        })
        return
      }
      if (!text.startsWith(JEVS_ERROR_MARK)) return
      context.ui.toast.show({
        title: "jev",
        message: text.slice(JEVS_ERROR_MARK.length),
        variant: "error",
        duration: 10_000,
        ...(typeof event?.sessionID === "string" ? { sessionID: event.sessionID } : {}),
      })
    })
    cleanups.push(unlisten)

    // -- screen verdict panel + flagged/unsafe toasts --
    let panelLoaded = false
    try {
      const { default: panel } = await import("./screen-panel.tsx")
      const panelCleanup = await panel.setup(context)
      cleanups.push(panelCleanup)
      panelLoaded = true
    } catch (err) {
      console.log(`[jev] tui: screen panel unavailable: ${String((err as Error)?.message ?? err)}`)
    }

    // /jev-screen-history: open the recent screening-verdicts panel. Always
    // registered, so the command exists even if the TSX panel failed to load
    // (in that case it toasts why instead of silently disappearing).
    const unlayer = context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "jev.screen-verdicts",
          title: "Jev screening verdicts",
          description: "Open the recent jev-screen verdict panel",
          group: "jev",
          palette: true,
          slash: { name: "jev-screen-history" },
          run: () => {
            if (!panelLoaded) {
              context.ui.toast.show({
                title: "jev",
                message: "screen panel unavailable - check the TUI log for the load error",
                variant: "warning",
                duration: 10_000,
              })
            }
            context.ui.panel.open("jev-screen")
          },
        },
        {
          id: "jev.model",
          title: "Switch System One model",
          description:
            "Pin the System One judgment model for this session (/jev-models [<id>|reset]); every pick is verified against the deployment first",
          group: "jev",
          palette: true,
          slash: { name: "jev-models", arguments: true },
          run: (input?: unknown) => {
            // Hosts pass the trailing text as a string, an object shape, or
            // nothing (palette); all degrade to the dialog.
            const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : undefined
            const text =
              typeof input === "string"
                ? input
                : typeof obj?.text === "string"
                  ? obj.text
                  : typeof obj?.arguments === "string"
                    ? obj.arguments
                    : typeof obj?.prompt === "string"
                      ? obj.prompt
                      : ""
            void runModelPicker(text)
          },
        },
      ],
    }))
    cleanups.push(unlayer)

    // -- prompt footer markers --
    // "(auto)" (the routing entry marker) plus "(jev:<model>)" (the active
    // System One judgment model, src/footer-jev-model.tsx). Failure of one
    // marker module never hides the other.
    try {
      const { default: footerMarker } = await import("./footer-marker.tsx")
      const markerCleanup = await footerMarker.setup(context)
      cleanups.push(markerCleanup)
    } catch (err) {
      console.log(`[jev] tui: footer marker unavailable: ${String((err as Error)?.message ?? err)}`)
    }
    // Also the picker's current-session source: the footer slot carries the
    // session id of the session on screen, which command runs do not receive.
    let lastSessionHolder: { current?: string } | undefined
    try {
      const mod: any = await import("./footer-jev-model.tsx")
      const modelCleanup = await mod.default.setup(context)
      cleanups.push(modelCleanup)
      lastSessionHolder = mod.sessionHolder
    } catch (err) {
      console.log(`[jev] tui: footer model marker unavailable: ${String((err as Error)?.message ?? err)}`)
    }

    // -- /jev-models: switch this session's System One judgment model --
    //
    // Session-scoped like the native /models pick: it pins which System One
    // model jev's judged calls use in THIS session only, riding over the
    // configured chain (plugin "model" option / JEV_MODEL). Every pick is
    // verified against the deployment by the server half (same ping the init
    // check runs) before it sticks; ctrl+r or "/jev-models reset" clears the
    // pin. The footer marker updates instantly, so the model that actually
    // judges is always visible at the prompt.
    const labelStore = context.storage.store(JEV_MODEL_STORE_KEY, {
      initial: { sessions: {} } as JevModelStore,
    })
    // Mirrors the pin into the footer label store; "" marks "no pin, shows
    // the chain model" so the slot never has to re-ask the server for it.
    const writeLabel = (sessionID: string, model: string): void => {
      try {
        labelStore[1]?.((draft: JevModelStore) => {
          draft.sessions = { ...(draft.sessions ?? {}), [sessionID]: model }
        })
      } catch {}
    }

    const currentSessionID = (): string | undefined => {
      const fromSlot = lastSessionHolder?.current
      if (typeof fromSlot === "string" && fromSlot) return fromSlot
      try {
        const route: any = (context as any).ui?.router?.current?.()
        if (typeof route?.sessionID === "string" && route.sessionID) return route.sessionID
        if (typeof route?.data?.sessionID === "string" && route.data.sessionID) return route.data.sessionID
      } catch {}
      return undefined
    }

    // The jev-config subclient, built once (the descriptor construction
    // resolves @opencode/plugin/rpc when the host has it; failure degrades
    // to undefined and the command toasts the remedy).
    let cachedRpc: any | undefined
    let rpcChecked = false
    const rpcOf = async (): Promise<any | undefined> => {
      if (!rpcChecked) {
        rpcChecked = true
        cachedRpc = await jevRpcClientOf(context)
      }
      return cachedRpc
    }

    const toastOf = (message: string, variant: ToastOptions["variant"] = "info", duration = 8_000): void => {
      context.ui.toast.show({ title: "jev models", message, variant, duration })
    }
    const RPC_REMEDY =
      "/jev-models needs a newer OpenCode (plugin rpc unavailable) - set the jev plugin's model option or JEV_MODEL instead"

    const applyPick = async (jev: any, sessionID: string, model: string): Promise<void> => {
      try {
        const res = await jev.set({ sessionID, model })
        if (res?.ok) {
          writeLabel(sessionID, model)
          toastOf(`System One model for this session: ${jevModelTag(model)}`, "success")
        } else {
          toastOf(`${model}: ${res?.message ?? "unavailable - kept the previous model"}`, "error", 15_000)
        }
      } catch (err) {
        toastOf(`${model}: ${String((err as Error)?.message ?? err)}`, "error", 15_000)
      }
    }

    const resetPin = async (jev: any, sessionID: string): Promise<void> => {
      try {
        const res = await jev.reset({ sessionID })
        if (res?.ok) {
          writeLabel(sessionID, "")
          toastOf("System One model cleared - this session rides the configured chain again", "success")
        } else {
          toastOf(`reset failed${res?.message ? `: ${res.message}` : ""}`, "error", 10_000)
        }
      } catch (err) {
        toastOf(`reset failed: ${String((err as Error)?.message ?? err)}`, "error", 10_000)
      }
    }

    let pickerBusy = false
    const PICK_RESET_ARG = /^(reset|clear|off)$/i
    const runModelPicker = async (arg: string): Promise<void> => {
      if (pickerBusy) return
      pickerBusy = true
      try {
        const jev = await rpcOf()
        if (!jev?.set || !jev?.reset || !jev?.describe) {
          toastOf(RPC_REMEDY, "warning", 20_000)
          return
        }
        const sessionID = currentSessionID()
        if (!sessionID) {
          toastOf("no active session - /jev-models pins the System One judgment model per session", "warning", 12_000)
          return
        }
        const argTrim = String(arg ?? "").trim()
        if (PICK_RESET_ARG.test(argTrim)) {
          await resetPin(jev, sessionID)
          return
        }
        if (argTrim) {
          // Direct pick by id, for when the dialog is unavailable or scripting.
          await applyPick(jev, sessionID, argTrim)
          return
        }
        const dialog = (context as any).ui?.dialog as TuiContext["ui"]["dialog"]
        if (!dialog?.select) {
          toastOf('picker dialog unavailable - use "/jev-models <model-id>" or /jev-models reset', "warning", 15_000)
          return
        }
        const info = await jev.describe({ sessionID })
        const models = (Array.isArray(info?.models) ? info.models : []).filter(
          (m: any) => m && typeof m.id === "string" && m.id.trim() !== "",
        )
        if (models.length === 0) {
          toastOf('no candidate models - configure the jev plugin\'s "models" option', "warning", 10_000)
          return
        }
        const pick = typeof info?.pick === "string" ? info.pick : ""
        const base = typeof info?.base === "string" ? info.base : ""
        const actions = pick
          ? [
              {
                bind: "ctrl+r",
                title: "Reset",
                side: "right" as const,
                selection: "none" as const,
                onTrigger: async () => {
                  await resetPin(jev, sessionID)
                  dialog.clear?.()
                },
              },
            ]
          : undefined
        const picked = await dialog.select({
          title: "System One model for this session",
          placeholder: "filter models (enter picks, ctrl+r resets)...",
          current: pick || (models.some((m: any) => m.id === base) ? base : undefined),
          options: models.map((m: any) => ({
            title: m.id,
            value: m.id,
            ...(m.fault ? { description: `no: ${m.fault}` } : {}),
          })),
          ...(actions ? { actions } : {}),
        })
        if (!picked) return
        if (!models.some((m: any) => m.id === picked)) return
        await applyPick(jev, sessionID, picked)
      } catch (err) {
        toastOf(`[jev-models] ${String((err as Error)?.message ?? err)}`, "error", 15_000)
      } finally {
        pickerBusy = false
      }
    }

    return async () => {
      for (const cleanup of cleanups) {
        // hosts have logged "cleanup is not a function" when a registration
        // API returned nothing - never let one missing unregister break the
        // others
        if (typeof cleanup === "function") await cleanup()
      }
    }
  },
}
