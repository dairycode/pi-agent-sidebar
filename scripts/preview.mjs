/**
 * Renders the composer webview in headless Chrome and writes a PNG.
 *
 * This exists so UI changes can be inspected without a manual screenshot from a
 * running VS Code window. The markup comes from the real
 * `createWebviewDocument()` and the built `dist/webview/main.css`, so the preview cannot
 * drift from what ships — only the pieces VS Code owns are stubbed:
 *
 *  - `vscode.Uri` / `webview.asWebviewUri` become plain `file://` paths.
 *  - The ~27 `--vscode-*` theme variables are injected from a preview preset.
 *    The default detects the active VS Code theme when a matching preset exists.
 *  - `acquireVsCodeApi()` is faked, and a snapshot is posted in so the webview
 *    reaches its normal "ready" state instead of the starting placeholder.
 *
 * It is a devtool: not part of `npm test`, not shipped in the VSIX.
 *
 * Usage:
 *   node scripts/preview.mjs                       # default 380px wide
 *   node scripts/preview.mjs --width=200           # narrow sidebar
 *   node scripts/preview.mjs --state=palette       # slash-command panel open
 *   node scripts/preview.mjs --state=reference     # inline file reference
 *   node scripts/preview.mjs --state=drop          # resource drop overlay
 *   node scripts/preview.mjs --theme=light
 *   node scripts/preview.mjs --theme=one-dark-pro-darker
 *   node scripts/preview.mjs --out=/tmp/shot.png
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	findChrome,
	validatePreview,
	capturePreview,
} from "./preview/browser.mjs";
import { parsePreviewArgs } from "./preview/cli.mjs";
import { loadDocumentFactory } from "./preview/document.mjs";
import { bootstrapScript, themeAssertScript } from "./preview/scenario.mjs";
import { previewStyle, resolvePreviewTheme } from "./preview/theme.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

async function main() {
	const options = parsePreviewArgs(process.argv.slice(2));
	const resolvedTheme = await resolvePreviewTheme(options.theme);
	if (resolvedTheme.warning) {
		process.stderr.write(`PREVIEW WARNING: ${resolvedTheme.warning}\n`);
	}
	const chrome = await findChrome();
	const workDir = await mkdtemp(path.join(os.tmpdir(), "pi-sidebar-preview-"));

	try {
		const createWebviewDocument = await loadDocumentFactory(workDir);
		const html = createWebviewDocument(
			{
				cspSource: "file:",
				// The real implementation hands back a webview URI; a file URL is the
				// headless equivalent. It also supports `.with({ query })`, which the
				// document template uses to cache-bust the stylesheet.
				asWebviewUri: (uri) => {
					const url = pathToFileURL(uri.fsPath).href;
					return { toString: () => url, with: () => url };
				},
			},
			{ fsPath: root },
		);

		// The theme has to arrive as a linked stylesheet, not a `<style>` block: the
		// document's CSP sets `style-src` to the webview source with no `unsafe-inline`,
		// so an inline block is silently dropped and every `--vscode-*` variable ends up
		// empty. That is not cosmetic — `body` reads `--vscode-font-size` with no
		// fallback, so text renders at the browser's 16px default, labels measure wider
		// than they ever would in VS Code, and every reflow threshold shifts.
		const themeFile = path.join(workDir, "theme.css");
		await writeFile(themeFile, previewStyle(resolvedTheme.key, options.width));

		const nonce = /nonce-([A-Za-z0-9_-]+)/u.exec(html)?.[1];
		if (!nonce) throw new Error("Could not read the document nonce.");

		// VS Code puts the active theme's kind on the webview body itself
		// (`vscode-light` / `vscode-dark` / …), and pi-theme.css keys its light
		// palette off `body.vscode-light`. Without the class the preview rendered
		// the dark palette over light `--vscode-*` values — a muddier substitute
		// than the real thing, not a preview of it.
		const bodyClass =
			resolvedTheme.key === "light" ? "vscode-light" : "vscode-dark";

		const prepared = html
			.replace(
				"</head>",
				`  <link rel="stylesheet" href="${pathToFileURL(themeFile).href}">\n</head>`,
			)
			.replace(
				"<body>",
				`<body class="${bodyClass}">\n  <script nonce="${nonce}">
window.acquireVsCodeApi = () => ({
	postMessage: (message) => console.log("[webview->host]", JSON.stringify(message)),
	getState: () => undefined,
	setState: () => {},
});
</script>`,
			)
			.replace(
				"</body>",
				`  <script nonce="${nonce}">${themeAssertScript()}${bootstrapScript(options.state)}</script>\n</body>`,
			);

		const page = path.join(workDir, "preview.html");
		await writeFile(page, prepared);

		// #app is 100vh, so the window height sets the layout height. The composer
		// pins to the bottom either way.
		const height = options.height > 0 ? options.height : 520;
		const pageUrl = pathToFileURL(page).href;
		const chromeArgs = [
			"--headless=new",
			"--disable-gpu",
			"--no-sandbox",
			"--hide-scrollbars",
			"--force-device-scale-factor=2",
			"--allow-file-access-from-files",
			`--window-size=${options.width},${height}`,
			"--virtual-time-budget=4000",
		];

		// JavaScript exceptions do not make Chrome's screenshot command fail.
		// Inspect the rendered DOM first so blocked styles and collapsed borders
		// cannot silently produce a plausible but misleading image.
		await validatePreview(chrome, chromeArgs, pageUrl);

		await rm(options.out, { force: true });
		await capturePreview(chrome, chromeArgs, pageUrl, options.out);

		const autoLabel = options.theme === "auto" ? " (auto-detected)" : "";
		process.stdout.write(
			`${options.out}\n  ${options.width}x${height} @2x  theme=${resolvedTheme.key}${autoLabel}  state=${options.state}\n`,
		);
	} finally {
		await rm(workDir, { recursive: true, force: true });
	}
}

await main();
