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

const STRING = { type: "string" }

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
  return define ? define({ id: JEV_RPC_ID, methods }) : { id: JEV_RPC_ID, methods }
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

// The TUI reactive store shape behind the footer marker and the picker (the
// label store of the prompt footer status slot): the base chain model plus
// one optional pin per session ("" means "checked, no pin" so an unknown
// session can stay unlabeled until its describe returns).
export interface JevModelStore {
  base?: string
  sessions?: Record<string, string>
}

export const JEV_MODEL_STORE_KEY = "jev-model-label"
