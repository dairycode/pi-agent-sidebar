import path from "node:path";
import * as vscode from "vscode";

interface WorkspaceReferencePath {
	workspaceFolderName: string;
	relativePath: string;
}

export function splitWorkspaceReferencePath(
	displayPath: string,
	workspaceFolderNames: readonly string[],
): WorkspaceReferencePath | undefined {
	for (const workspaceFolderName of workspaceFolderNames) {
		const prefix = `${workspaceFolderName}/`;
		if (displayPath.startsWith(prefix) && displayPath.length > prefix.length) {
			return {
				workspaceFolderName,
				relativePath: displayPath.slice(prefix.length),
			};
		}
	}
	return undefined;
}

export function parseDroppedResource(resource: string): vscode.Uri {
	if (path.isAbsolute(resource)) return vscode.Uri.file(resource);
	try {
		return vscode.Uri.parse(resource, true);
	} catch {
		throw new Error("A dropped resource is not a valid file URI.");
	}
}

export class WorkspaceResources {
	public constructor(
		private readonly selectWorkspaceFolder: () => Promise<
			vscode.WorkspaceFolder | undefined
		>,
	) {}

	public async requireWorkspaceFolder(): Promise<vscode.WorkspaceFolder> {
		const folder = await this.selectWorkspaceFolder();
		if (!folder) throw new Error("Open a workspace folder first.");
		return folder;
	}

	public async validateFiles(
		uris: readonly vscode.Uri[],
	): Promise<vscode.Uri[]> {
		await this.requireWorkspaceFolder();
		const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
		const uniqueUris = [
			...new Map(
				uris.map((sourceUri) => {
					const uri = sourceUri.with({ query: "", fragment: "" });
					return [uri.toString(), uri] as const;
				}),
			).values(),
		];
		return Promise.all(
			uniqueUris.map(async (uri) => {
				const supported =
					uri.scheme === "file" ||
					workspaceFolders.some(
						(folder) =>
							folder.uri.scheme === uri.scheme &&
							folder.uri.authority === uri.authority,
					);
				if (!supported || !uri.fsPath) {
					throw new Error(
						"Only files available to this VS Code workspace can be added.",
					);
				}

				const label = path.basename(uri.fsPath) || uri.fsPath;
				let fileStat: vscode.FileStat;
				try {
					fileStat = await vscode.workspace.fs.stat(uri);
				} catch (error) {
					throw new Error(`Unable to add ${label}: ${toErrorMessage(error)}`);
				}
				if ((fileStat.type & vscode.FileType.File) === 0) {
					throw new Error(`${label} is not a regular file.`);
				}

				return uri;
			}),
		);
	}

	public async openResource(uriValue: string, line?: number): Promise<void> {
		let resource: vscode.Uri;
		try {
			resource = vscode.Uri.parse(uriValue, true);
		} catch {
			void vscode.window.showWarningMessage(
				"Unable to open an invalid reference URI.",
			);
			return;
		}
		if (
			resource.scheme === "untitled"
				? !vscode.workspace.textDocuments.some(
						(document) => document.uri.toString() === resource.toString(),
					)
				: !vscode.workspace.getWorkspaceFolder(resource)
		) {
			void vscode.window.showWarningMessage(
				"Unable to open a reference outside the current workspace.",
			);
			return;
		}
		try {
			await this.showTextResource(resource, line);
		} catch {
			void vscode.window.showWarningMessage(
				`Unable to open ${resource.toString(true)}.`,
			);
		}
	}

	public async openWorkspacePath(
		relativePath: string,
		line?: number,
	): Promise<void> {
		const normalized = relativePath.replace(/^[./]+/u, "").replace(/\\/gu, "/");
		if (!normalized || normalized.includes("..")) return;

		const folders = vscode.workspace.workspaceFolders ?? [];
		const qualified = splitWorkspaceReferencePath(
			normalized,
			folders.map((folder) => folder.name),
		);
		const folder = qualified
			? folders.find(
					(candidate) => candidate.name === qualified.workspaceFolderName,
				)
			: await this.selectWorkspaceFolder();
		if (!folder) return;
		const pathWithinFolder = qualified?.relativePath ?? normalized;
		const target = vscode.Uri.joinPath(folder.uri, pathWithinFolder);
		const relativeToFolder = path
			.relative(folder.uri.fsPath, target.fsPath)
			.split(path.sep)
			.join("/");
		if (
			relativeToFolder.startsWith("..") ||
			path.isAbsolute(relativeToFolder)
		) {
			return;
		}
		try {
			await this.showTextResource(target, line);
		} catch {
			void vscode.window.showWarningMessage(`Unable to open ${normalized}.`);
		}
	}

	private async showTextResource(
		resource: vscode.Uri,
		line?: number,
	): Promise<void> {
		const document = await vscode.workspace.openTextDocument(resource);
		const editor = await vscode.window.showTextDocument(document, {
			preview: true,
		});
		if (typeof line !== "number" || line < 1) return;
		const position = new vscode.Position(
			Math.min(line - 1, Math.max(0, document.lineCount - 1)),
			0,
		);
		editor.selection = new vscode.Selection(position, position);
		editor.revealRange(
			new vscode.Range(position, position),
			vscode.TextEditorRevealType.InCenterIfOutsideViewport,
		);
	}
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
