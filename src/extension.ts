import * as vscode from "vscode";
import { PiViewProvider, type PresetPromptKind } from "./piViewProvider.js";

let activeProvider: PiViewProvider | undefined;

function registerPreset(
	provider: PiViewProvider,
	command: string,
	kind: PresetPromptKind,
): vscode.Disposable {
	return vscode.commands.registerCommand(command, () =>
		provider.runPresetPrompt(kind, vscode.window.activeTextEditor),
	);
}

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel("Pi Agent", { log: true });
	const provider = new PiViewProvider(context, output);
	activeProvider = provider;

	const statusBarItem = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Left,
		100,
	);
	statusBarItem.command = "piAgentSidebar.open";
	provider.bindStatusBar(statusBarItem);

	context.subscriptions.push(
		output,
		provider,
		statusBarItem,
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
		vscode.commands.registerCommand("piAgentSidebar.renameSession", () =>
			provider.renameSession().catch((error: unknown) => {
				void vscode.window.showWarningMessage(
					error instanceof Error ? error.message : String(error),
				);
			}),
		),
		vscode.commands.registerCommand("piAgentSidebar.exportHtml", () =>
			provider.exportSessionHtml().catch((error: unknown) => {
				void vscode.window.showWarningMessage(
					error instanceof Error ? error.message : String(error),
				);
			}),
		),
		registerPreset(
			provider,
			"piAgentSidebar.explainSelection",
			"explainSelection",
		),
		registerPreset(provider, "piAgentSidebar.explainFile", "explainFile"),
		registerPreset(
			provider,
			"piAgentSidebar.refactorSelection",
			"refactorSelection",
		),
		registerPreset(provider, "piAgentSidebar.generateTests", "generateTests"),
		registerPreset(
			provider,
			"piAgentSidebar.explainDiagnostics",
			"explainDiagnostics",
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
