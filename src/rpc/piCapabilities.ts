import type { PiCapabilities } from "../../shared/protocol.js";

export type PiCapabilityName = keyof PiCapabilities;

/**
 * Capabilities start optimistic and are only ever downgraded by a real
 * response. Version numbers are useful for warnings, but the binary on PATH is
 * the authority on what it accepts, so a probe of the actual command is the
 * only trustworthy signal.
 */
const OPTIMISTIC: PiCapabilities = {
	clone: true,
	fork: true,
	forkMessages: true,
	entries: true,
	tree: true,
};

/**
 * Matches pi's reply to a command it does not know.
 *
 * A live 0.84.3 probe answers `{"success": false, "error": "Unknown command:
 * <name>"}`. Anything else — an invalid argument, a refused state — is a real
 * failure of a supported command and must not disable the feature.
 */
export function isUnsupportedCommandError(error: unknown): boolean {
	const message =
		error instanceof Error
			? error.message
			: typeof error === "string"
				? error
				: "";
	if (message.length === 0 || message.length > 16 * 1024) return false;
	return /\b(?:unknown|unsupported|unrecognized)\s+command\b/iu.test(message);
}

export class PiCapabilityTracker {
	private state: PiCapabilities = { ...OPTIMISTIC };

	/** Called when a new pi process starts: the previous binary's answers say nothing about this one. */
	public reset(): void {
		this.state = { ...OPTIMISTIC };
	}

	public snapshot(): PiCapabilities {
		return { ...this.state };
	}

	public isAvailable(name: PiCapabilityName): boolean {
		return this.state[name];
	}

	/**
	 * Records a failed command. Returns true when the failure meant "this pi
	 * cannot do that", in which case the capability is now disabled.
	 */
	public recordFailure(name: PiCapabilityName, error: unknown): boolean {
		if (!isUnsupportedCommandError(error)) return false;
		this.state[name] = false;
		return true;
	}

	/** A successful response re-enables a capability that was disabled by an earlier binary. */
	public recordSuccess(name: PiCapabilityName): void {
		this.state[name] = true;
	}
}
