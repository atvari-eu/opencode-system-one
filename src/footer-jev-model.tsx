// TUI prompt-footer marker for the ACTIVE System One judgment model -
// "(jev:1.13-free)" rendered right next to the model text (the same
// "prompt.footer.status" slot family as the "(auto)" footer marker; this
// module registers after it, so the row reads "... (auto) (jev:...)").
//
// Data flow: the server half owns the truth (the chain model plus
// per-session /jev-models pins). This half mirrors it into a reactive
// storage store ("jev-model-label"): the /jev-models picker (src/tui.ts)
// writes the same store on every successful set/reset, and describe() fills
// in what the store lacks - the base chain model once per load, and each
// session's pin the first time that session appears in this TUI process.
// A session that has not been checked yet stays unlabeled instead of
// flashing the chain model over an existing pin.
//
// The slot render also publishes the session id it last saw (sessionHolder)
// - command runs receive no session context of their own, so the
// /jev-models picker takes the session on screen from here.
//
// No solid import: the runtime provides the reactive scope (same shape as
// screen-panel.tsx / footer-marker.tsx; a failure here never hides the
// "(auto)" marker, which loads separately in src/tui.ts).
import type { JSX } from "@opentui/solid"
import { jevModelTag } from "./logic"
import { jevRpcClientOf, JEV_MODEL_STORE_KEY, type JevModelStore } from "./rpc"

/** The session id the footer last rendered for (the current session as far
 * as the prompt is concerned); read by the /jev-models picker. */
export const sessionHolder: { current?: string } = { current: undefined }

export default {
  id: "atvari.jev.tui.footer-model",
  async setup(context: any) {
    // Docs shape (see screen-panel.tsx): [value, updater] pair; the
    // { initial } wrap keeps hosts that treat the second argument as
    // options from dropping the default.
    const store = context.storage.store(JEV_MODEL_STORE_KEY, {
      initial: { sessions: {} } as JevModelStore,
    })

    // The jev-config subclient, built lazily once - describe is optional
    // (a host without the rpc surface leaves the marker on the picker
    // writes alone, which cover its own set/reset).
    let rpcClient: Promise<any | undefined> | undefined
    const rpc = (): Promise<any | undefined> => {
      rpcClient ??= jevRpcClientOf(context)
      return rpcClient
    }

    // describe() per session, exactly once per process unless the store says
    // otherwise (picker writes land in the same store, so the label never
    // re-fetches after a local pick).
    const fetchedSessions = new Set<string>()
    const describeSession = (sessionID: string): void => {
      if (fetchedSessions.has(sessionID)) return
      fetchedSessions.add(sessionID)
      void (async () => {
        const jev = await rpc()
        if (!jev?.describe) return
        try {
          const info = await jev.describe({ sessionID })
          const base = typeof info?.base === "string" && info.base.trim() !== "" ? info.base.trim() : ""
          store[1]((draft: JevModelStore) => {
            if (base) draft.base = base
            // A picker write that landed while this fetch was inflight owns
            // the label; describe only fills sessions nobody wrote for yet.
            if (draft.sessions?.[sessionID] !== undefined) return
            const pick = typeof info?.pick === "string" && info.pick.trim() !== "" ? info.pick.trim() : ""
            draft.sessions = { ...(draft.sessions ?? {}), [sessionID]: pick }
          })
        } catch {}
      })()
    }

    // The chain model once per load, so pinless sessions still show what
    // their judgments actually ride. A failed or missing describe leaves
    // the marker empty rather than guessing.
    void (async () => {
      const jev = await rpc()
      if (!jev?.describe) return
      try {
        const info = await jev.describe({})
        if (typeof info?.base === "string" && info.base.trim() !== "") {
          store[1]((draft: JevModelStore) => {
            draft.base = info.base
          })
        }
      } catch {}
    })()

    const unslot = context.ui.slot({
      append: "prompt.footer.status",
      render: (input: { sessionID?: string }): JSX.Element => {
        const sessionID = typeof input?.sessionID === "string" ? input.sessionID : ""
        if (!sessionID) return <text>{""}</text>
        sessionHolder.current = sessionID
        // Store semantics for sessions[sid]: undefined = not checked yet
        // (fetch, render nothing), "" = checked, no pin (render the chain
        // model), "<id>" = pinned (render the pin).
        const known = store[0]?.sessions?.[sessionID]
        if (known === undefined) {
          describeSession(sessionID)
          return <text>{""}</text>
        }
        const effective = known || store[0]?.base || ""
        return <text>{effective ? ` ${jevModelTag(effective)}` : ""}</text>
      },
    })

    return async () => {
      unslot()
    }
  },
}
