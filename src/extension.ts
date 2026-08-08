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

class PiFixCodeActionProvider implements vscode.CodeActionProvider {
	public static readonly metadata: vscode.CodeActionProviderMetadata = {
		providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
	};

	public provideCodeActions(
		_document: vscode.TextDocument,
		_range: vscode.Range | vscode.Selection,
		context: vscode.CodeActionContext,
	): vscode.CodeAction[] {
		const relevant = context.diagnostics.filter(
			(diagnostic) =>
				diagnostic.severity === vscode.DiagnosticSeverity.Error ||
				diagnostic.severity === vscode.DiagnosticSeverity.Warning,
		);
		if (relevant.length === 0) return [];
		const action = new vscode.CodeAction(
			"Fix with Pi",
			vscode.CodeActionKind.QuickFix,
		);
		action.diagnostics = relevant;
		action.command = {
			command: "piAgentSidebar.explainDiagnostics",
			title: "Fix with Pi",
		};
		return [action];
	}
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
			// Without this the editor tears down the webview whenever the view is
			// collapsed or another sidebar group is shown, so expanding it again
			// rebuilt the page from scratch: the transcript blanked and then popped
			// back in. The conversation cannot be restored quickly enough to hide
			// that — it means re-running the whole RPC snapshot — which is exactly
			// the case this option exists for. The cost is holding the view's DOM in
			// memory while hidden.
			{ webviewOptions: { retainContextWhenHidden: true } },
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
		vscode.languages.registerCodeActionsProvider(
			{ scheme: "file" },
			new PiFixCodeActionProvider(),
			PiFixCodeActionProvider.metadata,
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
