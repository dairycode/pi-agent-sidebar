export type NotificationDestination = "error" | "warning" | "log";

/**
 * Keep passive pi notifications out of VS Code's notification center while
 * preserving warnings and errors that may require the user's attention.
 */
export function notificationDestination(
	notifyType: unknown,
): NotificationDestination {
	if (notifyType === "error") return "error";
	if (notifyType === "warning") return "warning";
	return "log";
}
