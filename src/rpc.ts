// The jev-config RPC: the bridge between the plugin's two halves for
// /jev-models. The server half (src/index.ts) registers the methods over
// `ctx.rpc.register`; the TUI half (src/tui.ts, src/footer-jev-model.tsx)
// calls them through the generated client (`context.client.rpc(definition)`).
// The descriptor is shared so both sides agree on method names and shapes.
//
// `@opencode/plugin/rpc` is imported dynamically: on older hosts the module
// is absent, and the plain structural descriptor still works for
// register()/client.rpc(). Both loaders (server plugin loader and TUI plugin
// loader) resolve the import at runtime, so no build step is needed.
//
// Schema note: the deployment validates every method's OUTPUT with the same
// JSON Schema given below, so each returned object carries exactly the
// declared keys - optional fields are omitted rather than sent undefined.
// "method" property names are local: descriptor ids must not collide across
// plugins, so "jev-config" stays jev-specific.

export const JEV_RPC_ID = "jev-config"

/** What describe(sessionID?) returns: the base chain model, the session's
 * stored pin if any, and the picker's candidate ids with cached faults. */
export interface JevModelsInfo {
  base: string
  models: Array<{ id: string; fault?: string }>
  pick?: string
}

/** What a successful set/reset answer: ok=false carries the fault message
 * the deployment check produced, so the TUI can toast the reason. */
export interface JevSetResult {
  ok: boolean
  message?: string
}

/** One screening verdict, sent server -> TUI over the `screen` event. This is
 * the UI-only channel: it feeds the verdict panel and the flagged/unsafe
 * toasts without writing anything to the session transcript. `error` carries
 * a failed screen (the TUI toasts the diagnostic; the result text stays
 * untouched for local tools). */
export interface JevScreenEvent {
  sessionID?: string
  /** Tool whose output was screened. */
  tool: string
  /** Deprecated display fallback for older TUI halves; `call || tool`. */
  label?: string
  verdict: "pass" | "flagged" | "unsafe" | "error"
  junk?: number
  injection?: number
  secret?: number
  note?: string
  /** The tool call that triggered the screen (command, URL, path), capped and
   * redacted server-side. Never the screened result text. */
  call?: string
  /** Anomaly-only preview of the screened result, redacted and capped. Pass
   * verdicts never carry content. */
  preview?: string
}

const STRING = { type: "string" }
const NUMBER = { type: "number" }

const methods = {
  describe: {
    input: {
      type: "object",
      properties: { sessionID: STRING },
      additionalProperties: false,
    },
    output: {
      type: "object",
      properties: {
        base: STRING,
        pick: STRING,
        models: {
          type: "array",
          items: {
            type: "object",
            properties: { id: STRING, fault: STRING },
            required: ["id"],
            additionalProperties: false,
          },
        },
      },
      required: ["base", "models"],
      additionalProperties: false,
    },
  },
  set: {
    input: {
      type: "object",
      properties: { sessionID: STRING, model: STRING },
      required: ["sessionID", "model"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      properties: { ok: { type: "boolean" }, message: STRING },
      required: ["ok"],
      additionalProperties: false,
    },
  },
  reset: {
    input: {
      type: "object",
      properties: { sessionID: STRING },
      required: ["sessionID"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
      additionalProperties: false,
    },
  },
  configFault: {
    input: { type: "object", properties: {}, additionalProperties: false },
    output: {
      type: "object",
      properties: {
        fault: {
          type: "object",
          properties: { fingerprint: STRING, message: STRING, at: STRING },
          required: ["fingerprint", "message"],
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  },
}

/** Events emitted by the server half. `screen` is the transcript-free UI
 * transport (pass verdicts, panel history, anomalies' toasts); nothing here
 * is a session message. */
const events = {
  screen: {
    schema: {
      type: "object",
      properties: {
        sessionID: STRING,
        label: STRING,
        tool: STRING,
        verdict: { type: "string", enum: ["pass", "flagged", "unsafe", "error"] },
        junk: NUMBER,
        injection: NUMBER,
        secret: NUMBER,
        note: STRING,
        call: STRING,
        preview: STRING,
      },
      required: ["tool", "verdict"],
      additionalProperties: false,
    },
  },
  error: {
    schema: {
      type: "object",
      properties: {
        sessionID: STRING,
        message: STRING,
      },
      required: ["message"],
      additionalProperties: false,
    },
  },
  config: {
    schema: {
      type: "object",
      properties: {
        message: STRING,
        fingerprint: STRING,
      },
      required: ["message"],
      additionalProperties: false,
    },
  },
  scrub: {
    schema: {
      type: "object",
      properties: {
        sessionID: STRING,
        kind: { type: "string", enum: ["tool", "prompt"] },
        tool: STRING,
        hits: NUMBER,
      },
      required: ["kind", "hits"],
      additionalProperties: false,
    },
  },
  approval: {
    schema: {
      type: "object",
      properties: {
        sessionID: STRING,
        action: STRING,
        outcome: { type: "string", enum: ["allow", "ask", "deny", "gate", "fail"] },
        resource: STRING,
        verdict: STRING,
        confidence: NUMBER,
      },
      required: ["action", "outcome"],
      additionalProperties: false,
    },
  },
}

/** Builds the descriptor, with the host's Rpc.define when it resolves (so
 * the runtime owns the shape validation) and the raw structural descriptor
 * otherwise. */
export async function makeJevRpc(): Promise<unknown> {
  let define: ((definition: unknown) => unknown) | undefined = undefined
  try {
    const mod: any = await import("@opencode/plugin/rpc")
    if (mod?.Rpc && typeof mod.Rpc.define === "function") define = mod.Rpc.define
  } catch {
    // older host without the rpc module: the structural descriptor still
    // works for register()/client.rpc()
  }
  const definition = { id: JEV_RPC_ID, methods, events }
  return define ? define(definition) : definition
}

/** TUI half helper: the jev-config subclient over the CLI plugin's generated
 * client, or undefined when the host has no rpc surface. Failures degrade to
 * undefined rather than throw - /jev-models toasts instead. */
export async function jevRpcClientOf(context: any): Promise<any | undefined> {
  try {
    const client: any = context?.client
    if (!client || typeof client.rpc !== "function") return undefined
    const definition = await makeJevRpc()
    if (!definition) return undefined
    return client.rpc(definition)
  } catch {
    return undefined
  }
}

export interface JevEventSubscription {
  /** True when the host exposes the RPC event surface. */
  active: boolean
  dispose: () => void
}

/** TUI/GUI helper: subscribe to the jev-config events. Re-call it after
 * `server.connected` - `ctx.client` changes when the server restarts and the
 * old subscriptions go stale. Handler exceptions are swallowed so one bad
 * payload never tears down the rest. */
export async function subscribeJevEvents(
  context: any,
  handlers: Record<string, (data: any) => void>,
): Promise<JevEventSubscription> {
  const stops: Array<() => void> = []
  try {
    const jev = await jevRpcClientOf(context)
    const on = jev?.events?.on
    if (typeof on !== "function") return { active: false, dispose: () => {} }
    for (const [name, handler] of Object.entries(handlers)) {
      const stop = on.call(jev.events, name, (event: any) => {
        try {
          handler(event?.data)
        } catch {}
      })
      if (typeof stop === "function") stops.push(stop)
    }
    return {
      active: true,
      dispose: () => {
        for (const stop of stops) {
          try {
            stop()
          } catch {}
        }
      },
    }
  } catch {
    for (const stop of stops) {
      try {
        stop()
      } catch {}
    }
    return { active: false, dispose: () => {} }
  }
}

// The TUI reactive store shape behind the footer marker and the picker (the
// label store of the prompt footer status slot): the base chain model plus
// one optional pin per session ("" means "checked, no pin" so an unknown
// session can stay unlabeled until its describe returns).
export interface JevModelStore {
  base?: string
  sessions?: Record<string, string>
}

export const JEV_MODEL_STORE_KEY = "jev-model-label"
