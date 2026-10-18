// TUI footer marker for jev auto-routing: renders "(auto)" at prompt.footer.status
// while the session rests on the opencode-system-one/auto entry or after the
// plugin's last auto grab. The decision is pure (footerAutoMarker in logic.ts);
// this half only sources the inputs: ui.model.current() for the current
// selection, and the newest native model-switched message of the session for
// the placement that went auto-entry -> real model. Reads happen inline so
// they track in Solid's reactive scope; message-list changes outside the
// model read refresh on the next render tick.
import type { JSX } from "@opentui/solid"
import { footerAutoMarker } from "./logic"

export default {
  id: "atvari.jev.tui.footer",
  async setup(context: any) {
    const unslot = context.ui.slot({
      append: "prompt.footer.status",
      render: (input: { sessionID?: string }) => {
        const current = context.ui.model.current()
        const rows = input?.sessionID ? context.data.session.message.list(input.sessionID) : undefined
        let lastSwitched: { model: any; previous?: any } | undefined
        if (Array.isArray(rows)) {
          for (const row of rows) {
            const message = row?.info ?? row
            if (message?.type === "model-switched") lastSwitched = message
          }
        }
        const auto = footerAutoMarker(current, lastSwitched) ? "(auto)" : ""
        return <text>{auto}</text>
      },
    })
    return async () => {
      unslot()
    }
  },
}
