import type { SubmitDelivery } from "../../shared/protocol.js";

/**
 * Maps the webview's delivery choice onto pi's `streamingBehavior`.
 *
 * An omitted choice keeps the historical race guard: steer only when this host
 * knows pi is already streaming, because pi rejects a prompt sent mid-run
 * without the field. Explicit modes are forwarded verbatim; pi ignores
 * streamingBehavior when idle, so they degrade to a plain prompt.
 */
export function streamingBehaviorFor(
 delivery: SubmitDelivery | undefined,
 isStreaming: boolean,
): SubmitDelivery | undefined {
 if (delivery) return delivery;
 return isStreaming ? "steer" : undefined;
}
