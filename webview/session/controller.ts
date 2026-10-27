import type { HostToWebviewMessage, PiMessage } from "../../shared/protocol.js";
import type { UiState } from "../app/state.js";
import type { TranscriptController } from "../transcript/controller.js";
import type { StreamingUsageTracker } from "../streamUsage.js";

export interface SessionControllerOptions {
 state: UiState;
 transcript: Pick<TranscriptController, "adoptSnapshot" | "reconcileSnapshot" | "interrupt">;
 usage: Pick<StreamingUsageTracker, "reset">;
 clearUnansweredSubmit(messages: readonly PiMessage[]): void;
 cancelFollow(): void;
 clearExtensionUi(): void;
 scheduleRender(): void;
 announce(message: string): void;
 now(): number;
}

/** Applies authoritative snapshots and connection transitions, without owning DOM rendering. */
export class SessionController {
 constructor(private readonly options: SessionControllerOptions) {}

 applySnapshot(message: Extract<HostToWebviewMessage, { type: "snapshot" }>): void {
  const { state, transcript } = this.options;
  const sessionChanged = Boolean(state.state.sessionId && state.state.sessionId !== message.state.sessionId);
  state.state = message.state;
  state.omittedMessageCount = message.omittedMessageCount ?? 0;
  state.titleSeed = message.titleSeed ?? "";
  // Identity must be adopted against the old array, before installing the snapshot.
  transcript.adoptSnapshot(message.messages);
  state.stats = message.stats;
  this.options.usage.reset();
  state.models = message.models;
  state.thinkingLevels = message.thinkingLevels;
  state.commands = message.commands;
  state.workspaceName = message.workspaceName;
  if (message.capabilities) state.capabilities = message.capabilities;
  if (message.timeContext) {
   state.timeContext = message.timeContext;
   state.clockSkewMs = message.timeContext.hostNowMs - this.options.now();
  }
  state.busy = Boolean(message.state.isStreaming || message.state.isCompacting);
  this.options.clearUnansweredSubmit(message.messages);
  transcript.reconcileSnapshot(sessionChanged, Boolean(message.state.isStreaming));
  if (sessionChanged) {
   this.options.cancelFollow();
   this.options.clearExtensionUi();
  }
  this.options.scheduleRender();
 }

 applyConnection(phase: "starting" | "ready" | "disconnected" | "error", detail?: string): void {
  const { state } = this.options;
  state.connection = phase;
  state.connectionDetail = phase === "ready" ? "" : (detail ?? "");
  if (phase === "starting") this.options.clearExtensionUi();
  if (phase === "disconnected" || phase === "error") {
   this.options.cancelFollow();
   state.busy = false;
   this.options.transcript.interrupt(detail);
   this.options.clearExtensionUi();
  }
  this.options.announce(phase === "ready" ? "Pi is ready" : detail || `Pi is ${phase}`);
  this.options.scheduleRender();
 }
}
