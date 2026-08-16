import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

export async function loadDocumentFactory(workDir) {
	const stub = path.join(workDir, "vscode-stub.mjs");
	await writeFile(
		stub,
		`export const Uri = {
	joinPath: (base, ...parts) => ({ fsPath: [base.fsPath, ...parts].join("/") }),
	file: (fsPath) => ({ fsPath }),
};
`,
	);
	const outfile = path.join(workDir, "document.mjs");
	await build({
		entryPoints: [path.join(root, "src", "webviewDocument.ts")],
		outfile,
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22",
		logLevel: "silent",
		alias: { vscode: stub },
	});
	const module = await import(pathToFileURL(outfile).href);
	return module.createWebviewDocument;
}

