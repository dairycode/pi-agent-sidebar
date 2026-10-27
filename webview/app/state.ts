import type { AttachmentRef, PiCapabilities, PiCommand, PiMessage, PiModel, PiState, PiStats, PiTimeContext, SessionSummary } from "../../shared/protocol.js";
import type { TranscriptState } from "../transcript/controller.js";

/** Shared view model; session transitions belong to SessionController, RPC deltas to RpcEventReducer. */
export interface UiState extends TranscriptState {
 connection: "starting" | "ready" | "disconnected" | "error" | "no-workspace";
 connectionDetail: string;
 workspaceName: string;
 state: PiState;
 stats?: PiStats;
 messages: PiMessage[];
 titleSeed: string;
 models: PiModel[];
 thinkingLevels: string[];
 commands: PiCommand[];
 attachments: AttachmentRef[];
 sessions: SessionSummary[];
 capabilities: PiCapabilities;
 timeContext: PiTimeContext;
 clockSkewMs: number;
 queue: { steering: string[]; followUp: string[] };
 busy: boolean;
}

export function createUiState(): UiState {
 return {
  connection: "starting", connectionDetail: "Starting pi...", workspaceName: "",
  state: {}, messages: [], omittedMessageCount: 0, titleSeed: "", streamingIndex: 0,
  models: [], thinkingLevels: ["off"], commands: [], attachments: [], sessions: [],
  capabilities: { clone: true, fork: true, forkMessages: true },
  timeContext: { locale: "", hostNowMs: 0 }, clockSkewMs: 0,
  queue: { steering: [], followUp: [] }, busy: false,
 };
}
