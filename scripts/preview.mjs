/**
 * Renders the composer webview in headless Chrome and writes a PNG.
 *
 * This exists so UI changes can be inspected without a manual screenshot from a
 * running VS Code window. The markup comes from the real
 * `createWebviewDocument()` and the real `media/main.css`, so the preview cannot
 * drift from what ships — only the pieces VS Code owns are stubbed:
 *
 *  - `vscode.Uri` / `webview.asWebviewUri` become plain `file://` paths.
 *  - The ~27 `--vscode-*` theme variables are injected with Dark Modern values.
 *  - `acquireVsCodeApi()` is faked, and a snapshot is posted in so the webview
 *    reaches its normal "ready" state instead of the starting placeholder.
 *
 * It is a devtool: not part of `npm test`, not shipped in the VSIX.
 *
 * Usage:
 *   node scripts/preview.mjs                       # default 380px wide
 *   node scripts/preview.mjs --width=200           # narrow sidebar
 *   node scripts/preview.mjs --state=palette       # slash-command panel open
 *   node scripts/preview.mjs --theme=light
 *   node scripts/preview.mjs --out=/tmp/shot.png
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { build } from "esbuild";

const run = promisify(execFile);
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const CHROME_CANDIDATES = [
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/Applications/Chromium.app/Contents/MacOS/Chromium",
	"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
	"/usr/bin/google-chrome",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
];

/** VS Code Dark Modern / Light Modern, limited to the variables this CSS reads. */
const THEMES = {
	dark: {
		"font-family": "-apple-system, BlinkMacSystemFont, sans-serif",
		"font-size": "13px",
		"editor-font-family": "Menlo, monospace",
		"editor-font-size": "12px",
		foreground: "#cccccc",
		descriptionForeground: "#9d9d9d",
		errorForeground: "#f85149",
		focusBorder: "#0078d4",
		"editor-background": "#1f1f1f",
		"sideBar-background": "#181818",
		"input-background": "#313131",
		"input-foreground": "#cccccc",
		"input-placeholderForeground": "#989898",
		"editorWidget-background": "#202020",
		"widget-shadow": "rgba(0, 0, 0, 0.36)",
		"panel-border": "#2b2b2b",
		"widget-border": "#313131",
		"list-hoverBackground": "#2a2d2e",
		"list-inactiveSelectionForeground": "#cccccc",
		"toolbar-hoverBackground": "#383b3d",
		"textLink-foreground": "#4daafc",
		"textCodeBlock-background": "#2b2b2b",
		"textPreformat-foreground": "#d7ba7d",
		"scrollbarSlider-background": "rgba(121, 121, 121, 0.4)",
		"button-secondaryBackground": "#313131",
		"button-secondaryForeground": "#cccccc",
		"button-secondaryHoverBackground": "#3c3c3c",
		"editorWarning-foreground": "#cca700",
		"notifications-foreground": "#cccccc",
		"testing-iconPassed": "#73c991",
	},
	light: {
		"font-family": "-apple-system, BlinkMacSystemFont, sans-serif",
		"font-size": "13px",
		"editor-font-family": "Menlo, monospace",
		"editor-font-size": "12px",
		foreground: "#3b3b3b",
		descriptionForeground: "#3b3b3b99",
		errorForeground: "#cd3131",
		focusBorder: "#005fb8",
		"editor-background": "#ffffff",
		"sideBar-background": "#f8f8f8",
		"input-background": "#ffffff",
		"input-foreground": "#3b3b3b",
		"input-placeholderForeground": "#767676",
		"editorWidget-background": "#f8f8f8",
		"widget-shadow": "rgba(0, 0, 0, 0.16)",
		"panel-border": "#e5e5e5",
		"widget-border": "#d4d4d4",
		"list-hoverBackground": "#e8e8e8",
		"list-inactiveSelectionForeground": "#3b3b3b",
		"toolbar-hoverBackground": "#dddddd",
		"textLink-foreground": "#005fb8",
		"textCodeBlock-background": "#f2f2f2",
		"textPreformat-foreground": "#a31515",
		"scrollbarSlider-background": "rgba(100, 100, 100, 0.4)",
		"button-secondaryBackground": "#e5e5e5",
		"button-secondaryForeground": "#3b3b3b",
		"button-secondaryHoverBackground": "#cccccc",
		"editorWarning-foreground": "#bf8803",
		"notifications-foreground": "#3b3b3b",
		"testing-iconPassed": "#098658",
	},
};

/** Mirrors a real `get_commands` response closely enough to exercise grouping. */
const SAMPLE_COMMANDS = [
	{
		name: "websearch",
		description: "Open web search curator",
		source: "extension",
	},
	{
		name: "curator",
		description: "Toggle or configure the search curator workflow",
		source: "extension",
	},
	{
		name: "subagents",
		description: "Administer subagents: inspect metadata and update models",
		source: "extension",
	},
	{
		name: "run",
		description: "Run a subagent directly: /run agent[output=file] [task]",
		source: "extension",
	},
	{
		name: "lens-tdi",
		description: "Show Technical Debt Index (TDI) and project health trend",
		source: "extension",
	},
	{
		name: "parallel-cleanup",
		description: "Parallel cleanup review",
		source: "prompt",
		location: "project",
	},
	{
		name: "gather-context-and-clarify",
		description:
			"Use subagents to gather context, then ask clarifying questions",
		source: "prompt",
		location: "user",
	},
	{
		name: "skill:brave-search",
		description: "Web search via Brave API",
		source: "skill",
		location: "user",
	},
];

function parseArgs(argv) {
	const options = {
		width: 380,
		height: 0,
		theme: "dark",
		state: "idle",
		out: path.join(os.tmpdir(), "pi-sidebar-preview.png"),
	};
	for (const arg of argv) {
		const match = /^--([a-z]+)=(.*)$/u.exec(arg);
		if (!match) continue;
		const [, key, value] = match;
		if (key === "width" || key === "height") options[key] = Number(value);
		else if (key in options) options[key] = value;
	}
	if (!Number.isFinite(options.width) || options.width < 120) {
		throw new Error("--width must be a number >= 120");
	}
	if (!THEMES[options.theme]) {
		throw new Error(
			`--theme must be one of: ${Object.keys(THEMES).join(", ")}`,
		);
	}
	return options;
}

async function findChrome() {
	for (const candidate of CHROME_CANDIDATES) {
		try {
			await run(candidate, ["--version"], { timeout: 15_000 });
			return candidate;
		} catch {
			// Try the next candidate.
		}
	}
	throw new Error(
		`No Chrome/Chromium found. Looked in:\n  ${CHROME_CANDIDATES.join("\n  ")}`,
	);
}

/**
 * Bundles `createWebviewDocument()` with a `vscode` stub so the preview uses the
 * shipping markup rather than a hand-copied duplicate.
 */
async function loadDocumentFactory(workDir) {
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

/**
 * Builds the injected stylesheet: theme variables plus a hard width clamp.
 *
 * The clamp is not cosmetic. Headless Chrome refuses to lay out below roughly
 * 500px regardless of `--window-size`, which only resizes the capture canvas. A
 * narrower request therefore produced a 500px-wide layout photographed through a
 * narrower window — the composer's right-hand side, send button included, was
 * simply cropped off, and the shot looked plausible because the left half was
 * intact. Pinning `html`/`body` forces the layout itself to the requested width.
 */
function previewStyle(theme, width) {
	const declarations = Object.entries(THEMES[theme])
		.map(([name, value]) => `  --vscode-${name}: ${value};`)
		.join("\n");
	return `:root {\n${declarations}\n}\n\nhtml, body {\n  width: ${width}px !important;\n  max-width: ${width}px !important;\n  overflow-x: hidden !important;\n}\n`;
}

/**
 * Drives the webview to its ready state.
 *
 * The webview only renders its real composer after a `snapshot` plus a ready
 * `connection`, so the preview posts both. Without them every shot would show
 * the "Starting pi..." placeholder.
 */
/**
 * Verifies the theme actually applied before trusting the shot.
 *
 * A blocked stylesheet is invisible in a screenshot — `main.css` carries hardcoded
 * fallbacks for most variables, so the result still looks plausible while the
 * metrics are wrong. This fails loudly instead.
 */
function themeAssertScript() {
	return `
const applied = getComputedStyle(document.documentElement)
	.getPropertyValue("--vscode-font-size").trim();
if (!applied) {
	document.title = "PREVIEW_THEME_BLOCKED";
	throw new Error("Theme stylesheet did not apply; preview metrics would be wrong.");
}
`;
}

function bootstrapScript(state) {
	return `
const snapshot = {
	type: "snapshot",
	state: {
		model: { id: "claude-opus-5", name: "Claude Opus 5", provider: "anthropic" },
		thinkingLevel: "xhigh",
		sessionName: "Preview session",
		sessionId: "preview",
		isStreaming: false,
	},
	messages: [],
	stats: { cost: 0.482, contextUsage: { percent: 32 } },
	models: [{ id: "claude-opus-5", name: "Claude Opus 5", provider: "anthropic" }],
	thinkingLevels: ["off", "low", "medium", "high", "xhigh"],
	commands: ${JSON.stringify(SAMPLE_COMMANDS)},
	workspaceName: "pi-agent-sidebar",
};
const post = (message) => window.postMessage(message, "*");
post(snapshot);
post({ type: "connection", phase: "ready" });

// Rendering is queued through requestAnimationFrame, so interactions wait for it.
requestAnimationFrame(() => requestAnimationFrame(() => {
	const state = ${JSON.stringify(state)};
	if (state === "palette") document.querySelector("#command-button").click();
	if (state === "typing") {
		const input = document.querySelector("#prompt-input");
		input.value = "Refactor the composer toolbar so the controls line up";
		input.dispatchEvent(new Event("input", { bubbles: true }));
	}
	document.documentElement.dataset.previewReady = "true";
}));
`;
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const chrome = await findChrome();
	const workDir = await mkdtemp(path.join(os.tmpdir(), "pi-sidebar-preview-"));

	try {
		const createWebviewDocument = await loadDocumentFactory(workDir);
		const mediaRoot = pathToFileURL(path.join(root, "media")).href;
		const html = createWebviewDocument(
			{
				cspSource: "file:",
				// The real implementation hands back a webview URI; a file URL is the
				// headless equivalent and keeps every asset path relative to media/.
				asWebviewUri: (uri) =>
					`${mediaRoot}/${uri.fsPath.split("/media/").pop()}`,
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
		await writeFile(themeFile, previewStyle(options.theme, options.width));

		const nonce = /nonce-([A-Za-z0-9_-]+)/u.exec(html)?.[1];
		if (!nonce) throw new Error("Could not read the document nonce.");

		const prepared = html
			.replace(
				"</head>",
				`  <link rel="stylesheet" href="${pathToFileURL(themeFile).href}">\n</head>`,
			)
			.replace(
				"<body>",
				`<body>\n  <script nonce="${nonce}">
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
		await run(
			chrome,
			[
				"--headless=new",
				"--disable-gpu",
				"--no-sandbox",
				"--hide-scrollbars",
				"--force-device-scale-factor=2",
				"--allow-file-access-from-files",
				`--window-size=${options.width},${height}`,
				"--virtual-time-budget=4000",
				`--screenshot=${options.out}`,
				pathToFileURL(page).href,
			],
			{ timeout: 60_000 },
		).catch((error) => {
			// Chrome writes benign allocator warnings to stderr and still exits 0 on
			// some builds; only a missing output file is a real failure.
			if (!error.stdout && !error.stderr) throw error;
		});

		process.stdout.write(
			`${options.out}\n  ${options.width}x${height} @2x  theme=${options.theme}  state=${options.state}\n`,
		);
	} finally {
		await rm(workDir, { recursive: true, force: true });
	}
}

await main();
