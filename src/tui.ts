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
import {
  JEVS_ERROR_MARK,
  JEV_CONFIG_ERROR_MARK,
  SCREEN_NOTICE_MARK,
  SCREEN_VERDICT_CAP,
  jevModelTag,
  parseScreenNotice,
  screenEventItemOf,
  type ScreenVerdictItem,
} from "./logic"
import { jevRpcClientOf, subscribeJevEvents, JEV_MODEL_STORE_KEY, type JevModelStore } from "./rpc"
// Static imports: the TUI loader compiles these TSX modules with its Solid
// transform. Dynamic `import("./…tsx")` is resolved by Bun instead, which
// cannot see the runtime-provided `solid-js` ("Cannot find package
// 'solid-js'"). Static imports also let one module graph share the host's
// Solid instance.
import screenPanel from "./screen-panel.tsx"
import footerMarker from "./footer-marker.tsx"
import footerModel, { sessionHolder } from "./footer-jev-model.tsx"

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
    // -- status toasts --
    // Primary channel: the server half's RPC events (transcript-free):
    //   error   failed judged call (one per 60 s window per title)
    //   config  init deployment fault, once per changed config
    //   scrub   secret-like tokens removed from a prompt/tool input (counts only)
    //   approval permission resolution (deny/gate/fail toast; allow/ask quiet)
    // Legacy/fallback: the corresponding "[jev-…]" synthetic rows on hosts
    // without the event surface. Subscriptions are re-established on
    // `server.connected` because ctx.client changes when the server restarts.
    const shownConfig = context.storage.store<{ message: string }>("jev-config-fault-shown", {
      initial: { message: "" },
    })
    // One config toast per fault message, across live events, the startup RPC
    // replay, and legacy rows.
    const showConfigFault = (message: unknown): void => {
      const text = typeof message === "string" ? message.trim() : ""
      if (!text) return
      try {
        if (shownConfig[0]?.message === text) return
        shownConfig[1]((draft: { message: string }) => {
          draft.message = text
        })
      } catch {}
      context.ui.toast.show({
        title: "jev config",
        message: text,
        variant: "error",
        duration: 20_000,
      })
    }

    // Screening history + toasts. The panel is a pure renderer of this store;
    // subscriptions live here so a panel module can never fail to load on a
    // stale/unavailable ./rpc export.
    const screenStore = context.storage.store<{ items: ScreenVerdictItem[] }>("jev-screen-verdicts", {
      initial: { items: [] },
    })
    const recordScreen = (item: ScreenVerdictItem): void => {
      try {
        screenStore[1]((draft: { items: ScreenVerdictItem[] }) => {
          draft.items.push(item)
          if (draft.items.length > SCREEN_VERDICT_CAP) {
            draft.items.splice(0, draft.items.length - SCREEN_VERDICT_CAP)
          }
        })
      } catch {}
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

    const statusHandlers: Record<string, (data: any) => void> = {
      screen: (data) => {
        const item = screenEventItemOf(data)
        if (item) recordScreen(item)
      },
      error: (data) => {
        const message = typeof data?.message === "string" ? data.message : ""
        if (!message) return
        context.ui.toast.show({
          title: "jev",
          message,
          variant: "error",
          duration: 10_000,
          ...(typeof data?.sessionID === "string" ? { sessionID: data.sessionID } : {}),
        })
      },
      config: (data) => showConfigFault(data?.message),
      scrub: (data) => {
        const hits = typeof data?.hits === "number" ? data.hits : 0
        if (hits <= 0) return
        const where = data.kind === "prompt" ? "the prompt" : (data.tool ?? "a tool input")
        context.ui.toast.show({
          title: "jev scrub",
          message: `removed ${hits} secret-like token(s) from ${where}`,
          variant: "warning",
          duration: 8_000,
          ...(typeof data?.sessionID === "string" ? { sessionID: data.sessionID } : {}),
        })
      },
      approval: (data) => {
        const outcome = typeof data?.outcome === "string" ? data.outcome : ""
        // Auto-allow/ask are the quiet, delegated path; refusals and
        // judgment failures are the ones a human needs to see.
        if (outcome !== "deny" && outcome !== "gate" && outcome !== "fail") return
        const action = typeof data.action === "string" ? data.action : "permission"
        const resource = typeof data.resource === "string" && data.resource ? ` ${data.resource}` : ""
        context.ui.toast.show({
          title: "jev approval",
          message: `${outcome === "fail" ? "judgment failed" : outcome === "gate" ? "gated" : "denied"}: ${action}${resource}`,
          variant: outcome === "fail" ? "warning" : "error",
          duration: 10_000,
          ...(typeof data?.sessionID === "string" ? { sessionID: data.sessionID } : {}),
        })
      },
    }

    let rpcEventsActive = false
    let stopStatusEvents: (() => void) | undefined
    // Late-subscriber replay: the init fault is persisted server-side; this
    // also covers a TUI that started after the live config event.
    const refreshConfigFault = async (): Promise<void> => {
      try {
        const jev = await jevRpcClientOf(context)
        const status = await jev?.configFault?.({})
        if (status?.fault?.message) showConfigFault(status.fault.message)
      } catch {}
    }
    const connectStatus = async (): Promise<void> => {
      stopStatusEvents?.()
      const sub = await subscribeJevEvents(context, statusHandlers)
      stopStatusEvents = sub.dispose
      rpcEventsActive = sub.active
      await refreshConfigFault()
    }
    await connectStatus()
    cleanups.push(() => stopStatusEvents?.())
    // A server restart gives the TUI a new ctx.client; old subscriptions are
    // stale. Re-attach on the reconnect event and replay the config fault.
    try {
      const stopServer = context.data.on("server.connected", () => {
        void connectStatus()
      })
      cleanups.push(stopServer)
    } catch {}

    const unlisten = context.data.on("session.synthetic", (event) => {
      const text = typeof event?.text === "string" ? event.text : ""
      if (text.startsWith(JEV_CONFIG_ERROR_MARK)) {
        // Dedupe against the event/RPC replay: one config toast per message.
        showConfigFault(text.slice(JEV_CONFIG_ERROR_MARK.length))
        return
      }
      if (text.startsWith(SCREEN_NOTICE_MARK)) {
        // Legacy rows only; the event channel carries this on current hosts.
        if (rpcEventsActive) return
        const item = parseScreenNotice(text)
        if (item) recordScreen(item)
        return
      }
      if (!text.startsWith(JEVS_ERROR_MARK)) return
      // The event already toasted this failure on hosts that emit it.
      if (rpcEventsActive) return
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
    let panelError = ""
    try {
      const panelCleanup = await screenPanel.setup(context)
      cleanups.push(panelCleanup)
      panelLoaded = true
    } catch (err) {
      panelError = String((err as Error)?.message ?? err)
      console.log(`[jev] tui: screen panel unavailable: ${panelError}`)
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
                message: panelError
                  ? `screen panel unavailable: ${panelError}`
                  : "screen panel unavailable - check the TUI log for the load error",
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
      const markerCleanup = await footerMarker.setup(context)
      cleanups.push(markerCleanup)
    } catch (err) {
      console.log(`[jev] tui: footer marker unavailable: ${String((err as Error)?.message ?? err)}`)
    }
    // Also the picker's current-session source: the footer slot carries the
    // session id of the session on screen, which command runs do not receive.
    let lastSessionHolder: { current?: string } | undefined = sessionHolder
    try {
      const modelCleanup = await footerModel.setup(context)
      cleanups.push(modelCleanup)
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
