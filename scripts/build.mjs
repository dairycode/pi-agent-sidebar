import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import * as esbuild from "esbuild";

const root = process.cwd();
const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");
const cleanOnly = process.argv.includes("--clean");
const outDirArgument = process.argv.find((arg) => arg.startsWith("--out-dir="));
const outDir = outDirArgument
	? path.resolve(root, outDirArgument.slice("--out-dir=".length))
	: root;

await Promise.all([
	rm(path.join(outDir, "dist"), { recursive: true, force: true }),
	// Remove generated artifacts from the pre-dist/webview layout.
	rm(path.join(outDir, "media"), { recursive: true, force: true }),
]);

if (cleanOnly) {
	process.exit(0);
}

const webviewOutDir = path.join(outDir, "dist", "webview");
await mkdir(webviewOutDir, { recursive: true });
await mkdir(path.join(webviewOutDir, "codicons"), { recursive: true });

await Promise.all([
	copyFile(
		path.join(
			root,
			"node_modules",
			"@vscode",
			"codicons",
			"dist",
			"codicon.css",
		),
		path.join(webviewOutDir, "codicons", "codicon.css"),
	),
	copyFile(
		path.join(
			root,
			"node_modules",
			"@vscode",
			"codicons",
			"dist",
			"codicon.ttf",
		),
		path.join(webviewOutDir, "codicons", "codicon.ttf"),
	),
]);

const shared = {
	bundle: true,
	minify: production,
	sourcemap: production ? false : "inline",
	logLevel: "info",
};

const extensionOptions = {
	...shared,
	entryPoints: [path.join(root, "src", "extension.ts")],
	outfile: path.join(outDir, "dist", "extension.js"),
	platform: "node",
	format: "cjs",
	target: "node22",
	external: ["vscode"],
};

const webviewOptions = {
	...shared,
	entryPoints: [path.join(root, "webview", "main.ts")],
	outfile: path.join(webviewOutDir, "main.js"),
	platform: "browser",
	format: "iife",
	target: ["chrome120"],
};

const webviewStyleOptions = {
	...shared,
	entryPoints: [path.join(root, "webview", "main.css")],
	outfile: path.join(webviewOutDir, "main.css"),
	target: ["chrome120"],
};

const buildOptions = [extensionOptions, webviewOptions, webviewStyleOptions];

if (watch) {
	const contexts = await Promise.all(
		buildOptions.map((options) => esbuild.context(options)),
	);
	await Promise.all(contexts.map((context) => context.watch()));
	console.log("Watching extension, Webview bundle, and stylesheet...");
} else {
	await Promise.all(buildOptions.map((options) => esbuild.build(options)));
}
