import * as vscode from "vscode";
import type { JsonRecord } from "../../shared/protocol.js";
import { notificationDestination } from "./notificationPolicy.js";
import type { PiRpcClient } from "../rpc/piRpcClient.js";

export interface ExtensionUiControllerOptions {
	output: vscode.OutputChannel;
	isCurrentClient(client: PiRpcClient): boolean;
	post(message: JsonRecord): Promise<void>;
	notify(client: PiRpcClient, response: JsonRecord): Promise<void>;
	setTitle(title: string): void;
}

/** Handles pi extension UI requests without coupling them to the webview provider. */
export class ExtensionUiController {
	public constructor(private readonly options: ExtensionUiControllerOptions) {}

	public async handle(client: PiRpcClient, event: JsonRecord): Promise<void> {
		const id = typeof event.id === "string" ? event.id : undefined;
		const method = typeof event.method === "string" ? event.method : "";
		if (!id || !this.options.isCurrentClient(client)) return;

		try {
			if (method === "notify") {
				this.handleNotification(event);
				return;
			}
			if (method === "set_editor_text" && typeof event.text === "string") {
				if (this.options.isCurrentClient(client)) {
					await this.options.post({ type: "setComposerText", text: event.text });
				}
				return;
			}
			if (method === "setTitle" && typeof event.title === "string") {
				if (this.options.isCurrentClient(client)) this.options.setTitle(event.title);
				return;
			}
			// setStatus is intentionally not forwarded: the webview owns transient status.
			if (method === "setStatus") return;
			if (method === "setWidget") {
				if (this.options.isCurrentClient(client)) {
					await this.options.post({ type: "rpcEvent", event });
				}
				return;
			}

			if (method === "select") {
				const options = Array.isArray(event.options)
					? event.options.filter((item): item is string => typeof item === "string")
					: [];
				const value = await vscode.window.showQuickPick(options, {
					title: typeof event.title === "string" ? event.title : "Pi",
					ignoreFocusOut: true,
				});
				await this.options.notify(client, valueResponse(id, value));
				return;
			}
			if (method === "confirm") {
				const accepted = await vscode.window.showInformationMessage(
					typeof event.message === "string" ? event.message : "Continue?",
					{
						modal: true,
						detail: typeof event.title === "string" ? event.title : undefined,
					},
					"Confirm",
				);
				await this.options.notify(client, {
					type: "extension_ui_response",
					id,
					confirmed: accepted === "Confirm",
				});
				return;
			}
			if (method === "input") {
				const value = await vscode.window.showInputBox({
					title: typeof event.title === "string" ? event.title : "Pi input",
					placeHolder:
						typeof event.placeholder === "string" ? event.placeholder : undefined,
					ignoreFocusOut: true,
				});
				await this.options.notify(client, valueResponse(id, value));
				return;
			}
			if (method === "editor") {
				const document = await vscode.workspace.openTextDocument({
					content: typeof event.prefill === "string" ? event.prefill : "",
					language: "markdown",
				});
				await vscode.window.showTextDocument(document, { preview: true });
				const choice = await vscode.window.showInformationMessage(
					typeof event.title === "string" ? event.title : "Edit the pi response",
					{
						detail: "Edit the opened document, then submit or cancel this request.",
					},
					"Submit",
					"Cancel",
				);
				await this.options.notify(
					client,
					valueResponse(id, choice === "Submit" ? document.getText() : undefined),
				);
				return;
			}
			await this.options.notify(client, cancelledResponse(id));
		} catch (error) {
			this.options.output.appendLine(`[extension-ui] ${toErrorMessage(error)}`);
			try {
				await this.options.notify(client, cancelledResponse(id));
			} catch (responseError) {
				this.options.output.appendLine(
					`[extension-ui] Failed to cancel request: ${toErrorMessage(responseError)}`,
				);
			}
		}
	}

	private handleNotification(event: JsonRecord): void {
		const message =
			typeof event.message === "string" ? event.message : "Pi notification";
		const destination = notificationDestination(event.notifyType);
		if (destination === "error") void vscode.window.showErrorMessage(message);
		else if (destination === "warning") void vscode.window.showWarningMessage(message);
		else this.options.output.appendLine(`[pi notification] ${message}`);
	}
}

function valueResponse(id: string, value: string | undefined): JsonRecord {
	return value === undefined
		? cancelledResponse(id)
		: { type: "extension_ui_response", id, value };
}

function cancelledResponse(id: string): JsonRecord {
	return { type: "extension_ui_response", id, cancelled: true };
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
