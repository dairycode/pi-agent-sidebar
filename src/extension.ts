import * as vscode from "vscode";
import { PiViewProvider } from "./piViewProvider.js";

let activeProvider: PiViewProvider | undefined;

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel("Pi Agent", { log: true });
	const provider = new PiViewProvider(context, output);
	activeProvider = provider;

	context.subscriptions.push(
		output,
		provider,
		vscode.window.registerWebviewViewProvider(
			PiViewProvider.viewType,
			provider,
		),
		vscode.commands.registerCommand("piAgentSidebar.open", () =>
			provider.reveal(),
		),
		vscode.commands.registerCommand("piAgentSidebar.focusInput", () =>
			provider.focusInputWithSelection(vscode.window.activeTextEditor),
		),
		vscode.commands.registerCommand("piAgentSidebar.newSession", async () => {
			await provider.reveal();
			if (!(await provider.createNewSession(true))) {
				void vscode.window.showInformationMessage(
					"The pi session was not changed.",
				);
			}
		}),
		vscode.commands.registerCommand("piAgentSidebar.restart", () =>
			provider.restart(),
		),
		vscode.commands.registerCommand("piAgentSidebar.showLogs", () =>
			output.show(true),
		),
		vscode.workspace.onDidChangeWorkspaceFolders(() => {
			void provider.handleWorkspaceFoldersChanged().catch((error: unknown) => {
				output.appendLine(
					`[workspace] ${error instanceof Error ? error.message : String(error)}`,
				);
			});
		}),
	);
}

export async function deactivate(): Promise<void> {
	const provider = activeProvider;
	activeProvider = undefined;
	if (provider) await provider.shutdown();
}
