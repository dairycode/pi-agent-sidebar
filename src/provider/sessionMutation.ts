export interface SessionMutationGuardContext {
	clientIsRunning: boolean;
	clientMatches: boolean;
	workspaceGenerationMatches: boolean;
	isStreaming: boolean;
	isCompacting: boolean;
}

/**
 * Returns a user-facing reason when a session operation must not run.
 * Session replacement operations use the default `requireIdle` mode; metadata
 * operations such as deleting an inactive history file can opt out of the busy
 * check while retaining client and workspace identity checks.
 */
export function sessionMutationBlockReason(
	context: SessionMutationGuardContext,
	requireIdle = true,
): string | undefined {
	if (!context.workspaceGenerationMatches)
		return "Workspace changed before the session operation completed.";
	if (!context.clientMatches)
		return "Pi restarted before the session operation completed.";
	if (!context.clientIsRunning) return "Pi RPC process is not running.";
	if (requireIdle && context.isCompacting)
		return "Wait for pi to finish compacting before changing sessions.";
	if (requireIdle && context.isStreaming)
		return "Wait for pi to finish before changing sessions.";
	return undefined;
}

export function assertSessionMutationAllowed(
	context: SessionMutationGuardContext,
	requireIdle = true,
): void {
	const reason = sessionMutationBlockReason(context, requireIdle);
	if (reason) throw new Error(reason);
}

export function assertSessionMutationIdle(
	isStreaming: boolean,
	isCompacting: boolean,
): void {
	if (isCompacting)
		throw new Error(
			"Wait for pi to finish compacting before changing sessions.",
		);
	if (isStreaming)
		throw new Error("Wait for pi to finish before changing sessions.");
}
