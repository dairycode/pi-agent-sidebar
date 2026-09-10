/**
 * Mermaid diagrams in the transcript.
 *
 * The library is a few megabytes of JavaScript and a diagram is rare in a coding
 * conversation, so it ships as its own bundle (`dist/webview/mermaid.js`) that
 * this module injects the first time a diagram appears. A session that never
 * shows one never downloads or parses it.
 *
 * Two properties of the library shape the rest of this module:
 *
 *  - A diagram is built asynchronously, while the transcript rebuilds message
 *    nodes as pi streams and the reader scrolls. Every render therefore re-checks
 *    its block — the state it was queued in, and whether the node is still in the
 *    document — before writing the SVG. A render that finishes late draws nothing
 *    instead of drawing into a node the transcript has already replaced.
 *  - The SVG carries its own `<style>` element and inline style attributes, which
 *    is why the webview's CSP allows inline styles. It is inserted as mermaid
 *    built it, minus anything executable — see `diagramElement` for why the
 *    library's own markup is not re-sanitized.
 */

/** The subset of the mermaid API this module drives. */
export interface MermaidApi {
	initialize(configuration: Record<string, unknown>): void;
	render(id: string, source: string): Promise<{ svg: string }>;
	/**
	 * The merged configuration, read for its per-diagram-type keys.
	 *
	 * Optional: a build without it leaves mermaid's own sizing alone rather than
	 * failing a diagram over a width.
	 */
	mermaidAPI?: { getConfig?: () => Record<string, unknown> };
}

/** Reads a resolved CSS value, typically a `--vscode-*` theme variable. */
export type StyleReader = (property: string) => string | undefined;

/** Reads a theme variable as a colour, falling back when it is not one. */
type ColorReader = (property: string, fallback: string) => string;

const MERMAID_BLOCK_SELECTOR = ".mermaid-block";
const MERMAID_SOURCE_SELECTOR = "code.language-mermaid";
const SOURCE_CONTAINER_SELECTOR = ".code-block";
const PENDING_STATE = "pending";
const QUEUED_STATE = "queued";
const RENDERED_STATE = "rendered";
const FAILED_STATE = "failed";

/**
 * How far outside the viewport a diagram may sit while still rendering.
 *
 * Long conversations hold a dozen diagrams and each one costs a layout pass, so
 * rendering them the moment they mount would stall the frame that mounted them.
 * Starting slightly early keeps the source form from being on screen long enough
 * for the swap to read as a jump.
 */
const VISIBILITY_MARGIN_PX = 200;

/**
 * Values a colour library can parse.
 *
 * mermaid derives shades from several theme colours with khroma, so a
 * `color-mix()` value — or an empty variable, which resolves to the empty
 * string — would turn a derived shade into a rendering failure rather than a
 * slightly off diagram. Anything that does not match falls back instead.
 */
const CSS_COLOR_PATTERN =
	/^(?:#[\da-f]{3,8}|rgba?\(\s*[\d.]+[^)]*\)|hsla?\(\s*[\d.]+[^)]*\))$/iu;

/** VS Code's dark defaults, used only when a theme variable is missing outright. */
const FALLBACK = {
	background: "#1f1f1f",
	surface: "#252526",
	text: "#cccccc",
	border: "#3c3c3c",
	selection: "#264f78",
};

/**
 * The colours a diagram uses to tell categories apart.
 *
 * Nodes are filled by whichever surface colour the theme already uses for panels,
 * which is chosen to sit *next to* the transcript rather than against it — and
 * mermaid derives its series colours from those same two values (`cScale0 =
 * primaryColor`, `pie1 = primaryColor`, …). That is how a pie slice or a timeline
 * band ends up the colour of its own background. VS Code publishes chart colours
 * for exactly this job, so those are read first; each pair below carries the
 * stand-in for a theme that declares none, in mid-tone hues that stay visible on
 * a light and a dark transcript alike.
 */
const SERIES_SOURCES: ReadonlyArray<readonly [name: string, fallback: string]> =
	[
		["blue", "#3f7cc4"],
		["green", "#3f9e6a"],
		["yellow", "#c39a1a"],
		["orange", "#cf7a33"],
		["red", "#c4574f"],
		["purple", "#8f6bc4"],
	];

/** The two labels a series colour can be read against. */
const LIGHT_LABEL = "#ffffff";
const DARK_LABEL = "#1f1f1f";

/**
 * Renders every mermaid fence in `root` that has no diagram yet.
 *
 * Called wherever a message node is built, which covers the three ways a fence
 * reaches the DOM: mounted with its message, promoted from the streaming tail
 * once it can no longer grow, and rebuilt by a transcript refresh while the
 * library was still loading.
 */
export function enhanceMermaidBlocks(root: ParentNode): void {
	for (const block of mermaidBlocksIn(root)) {
		const state = block.dataset.mermaidState;
		if (state !== undefined && state !== PENDING_STATE) continue;
		const source = mermaidSource(block);
		// An empty fence is still being streamed. Leaving it `pending` keeps the
		// next pass interested in it.
		if (source === undefined) continue;
		block.dataset.mermaidState = QUEUED_STATE;
		whenNearViewport(block, () => enqueueDiagramRender(block, source));
	}
}

/**
 * The mermaid blocks in `root`, `root` itself included.
 *
 * `root` is often the block: the transcript hands each node it has just frozen to
 * `enhanceRenderedNodes` one at a time, and a top-level fence's node *is* the
 * wrapper this module queues. A descendant-only scan leaves exactly those fences
 * showing source until the message is rebuilt at the end of the answer, which is
 * the case a reader watches. A message node never matches the selector, so
 * including the root costs nothing where it cannot apply.
 */
function mermaidBlocksIn(root: ParentNode): HTMLElement[] {
	const blocks = [...root.querySelectorAll<HTMLElement>(MERMAID_BLOCK_SELECTOR)];
	if (root instanceof Element && root.matches(MERMAID_BLOCK_SELECTOR)) {
		blocks.unshift(root as HTMLElement);
	}
	return blocks;
}

/**
 * Theme colours for mermaid's `base` theme.
 *
 * Exported for its own test: the mapping is the part of this module with
 * behaviour worth pinning down, and it is pure once the CSS reader is supplied.
 */
export function mermaidThemeVariables(
	readStyle: StyleReader,
	fontFamily?: string,
): Record<string, string> {
	const color: ColorReader = (property, fallback) => {
		const value = readStyle(property)?.trim() ?? "";
		return CSS_COLOR_PATTERN.test(value) ? value : fallback;
	};
	const variables: Record<string, string> = {
		background: color("--vscode-editor-background", FALLBACK.background),
		primaryColor: color("--vscode-editorWidget-background", FALLBACK.surface),
		primaryTextColor: color("--vscode-foreground", FALLBACK.text),
		primaryBorderColor: color("--vscode-panel-border", FALLBACK.border),
		secondaryColor: color(
			"--vscode-editor-inactiveSelectionBackground",
			FALLBACK.selection,
		),
		tertiaryColor: color("--vscode-editor-background", FALLBACK.background),
		lineColor: color("--vscode-foreground", FALLBACK.text),
		textColor: color("--vscode-foreground", FALLBACK.text),
		mainBkg: color("--vscode-editorWidget-background", FALLBACK.surface),
		nodeBorder: color("--vscode-panel-border", FALLBACK.border),
		clusterBkg: color("--vscode-editor-background", FALLBACK.background),
		clusterBorder: color("--vscode-panel-border", FALLBACK.border),
		edgeLabelBackground: color("--vscode-editor-background", FALLBACK.background),
		titleColor: color("--vscode-foreground", FALLBACK.text),
		...seriesThemeVariables(color),
	};
	if (fontFamily) variables.fontFamily = fontFamily;
	return variables;
}

/**
 * Series colours, and the label colour to print on them.
 *
 * The label has to be decided here rather than left to the theme's text colour:
 * that one is chosen against the transcript, and a filled band or slice is not
 * the transcript. One label colour ends up on every slice of a pie, so it is
 * picked against the palette rather than against a single entry.
 */
function seriesThemeVariables(color: ColorReader): Record<string, string> {
	const palette = seriesPalette(color);
	const variables: Record<string, string> = {};
	palette.forEach((value, index) => {
		variables[`pie${index + 1}`] = value;
		variables[`cScale${index}`] = value;
		variables[`cScaleLabel${index}`] = labelColorFor(value);
	});
	const average =
		palette.reduce((sum, value) => sum + (relativeLuminance(value) ?? 0), 0) /
		palette.length;
	variables.pieSectionTextColor = labelForLuminance(average);
	return variables;
}

/**
 * The series colours mermaid is handed, in the order it consumes them.
 *
 * mermaid reads twelve of them and VS Code publishes six, so the list is
 * repeated — explicitly, rather than by a modulo over the index, so that the
 * array is exactly as long as it looks. The repeat keeps a pie's neighbouring
 * slices different colours; padding instead would put two of them side by side.
 */
function seriesPalette(color: ColorReader): string[] {
	return [...SERIES_SOURCES, ...SERIES_SOURCES].map(([name, fallback]) =>
		color(`--vscode-charts-${name}`, fallback),
	);
}

/**
 * The one of two labels that contrasts more with `background`.
 *
 * White and near-black are the candidates a series colour can be read against,
 * and the contrast ratio decides — which keeps a yellow band's label dark and a
 * blue one's light instead of forcing one of them everywhere. A colour that
 * cannot be read returns the light label: guessing is all that is left, and the
 * palette is mid-tone by construction, where white is the safer guess.
 */
function labelColorFor(background: string): string {
	return labelForLuminance(relativeLuminance(background) ?? 0);
}

function labelForLuminance(backgroundLuminance: number): string {
	const light = relativeLuminance(LIGHT_LABEL) ?? 1;
	const dark = relativeLuminance(DARK_LABEL) ?? 0;
	return contrastRatio(backgroundLuminance, dark) >
		contrastRatio(backgroundLuminance, light)
		? DARK_LABEL
		: LIGHT_LABEL;
}

function contrastRatio(first: number, second: number): number {
	const lighter = Math.max(first, second);
	const darker = Math.min(first, second);
	return (lighter + 0.05) / (darker + 0.05);
}

/**
 * WCAG relative luminance, for a colour this module is willing to read.
 *
 * Only the shapes a theme publishes are parsed: hex (with or without an alpha
 * pair) and `rgb()` / `rgba()`. Anything else, `hsl()` included, comes back
 * undefined so the caller keeps its default rather than guessing at a number.
 */
function relativeLuminance(value: string): number | undefined {
	const channels = colorChannels(value);
	if (!channels) return undefined;
	const [red, green, blue] = channels;
	return (
		0.2126 * linearizeChannel(red) +
		0.7152 * linearizeChannel(green) +
		0.0722 * linearizeChannel(blue)
	);
}

function linearizeChannel(channel: number): number {
	const ratio = channel / 255;
	return ratio <= 0.03928 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
}

function colorChannels(value: string): [number, number, number] | undefined {
	const trimmed = value.trim();
	const hex = /^#([\da-f]{3,8})$/iu.exec(trimmed)?.[1];
	if (hex) {
		const digits =
			hex.length <= 4
				? hex.slice(0, 3).replace(/./gu, (digit) => digit + digit)
				: hex.slice(0, 6);
		if (digits.length !== 6) return undefined;
		return [0, 2, 4].map((offset) =>
			Number.parseInt(digits.slice(offset, offset + 2), 16),
		) as [number, number, number];
	}
	const functional = /^rgba?\(([^)]*)\)$/iu.exec(trimmed)?.[1];
	if (!functional) return undefined;
	const parts = functional
		.split(/[\s,/]+/u)
		.filter(Boolean)
		.slice(0, 3)
		.map(Number);
	if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) {
		return undefined;
	}
	return parts as [number, number, number];
}

function mermaidSource(block: HTMLElement): string | undefined {
	const source = block.querySelector(MERMAID_SOURCE_SELECTOR)?.textContent ?? "";
	return source.trim().length > 0 ? source : undefined;
}

const pendingVisibility = new WeakMap<Element, () => void>();
let visibilityObserver: IntersectionObserver | undefined;

function whenNearViewport(element: Element, run: () => void): void {
	if (typeof IntersectionObserver !== "function") {
		run();
		return;
	}
	// One observer for the whole transcript: a diagram per observer would be one
	// callback queue per diagram for no gain, and this one is torn down for each
	// element as soon as it fires.
	visibilityObserver ??= new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				if (!entry.isIntersecting) continue;
				const runWhenVisible = pendingVisibility.get(entry.target);
				pendingVisibility.delete(entry.target);
				visibilityObserver?.unobserve(entry.target);
				runWhenVisible?.();
			}
		},
		{ rootMargin: `${VISIBILITY_MARGIN_PX}px 0px` },
	);
	pendingVisibility.set(element, run);
	visibilityObserver.observe(element);
}

/**
 * Diagrams render one at a time.
 *
 * `mermaid.render` returns a promise but does its layout synchronously, so a
 * transcript with several diagrams would otherwise block the main thread back to
 * back and push a streaming frame past its budget.
 */
let renderQueue: Promise<void> = Promise.resolve();
let diagramCounter = 0;

function enqueueDiagramRender(block: HTMLElement, source: string): void {
	// `renderDiagram` reports its own failures, but a throw from inside that report
	// would leave this promise rejected for good: every later render is chained on
	// it, so one unexpected error would silently stop the rest of the session's
	// diagrams from ever being drawn. The catch is what keeps a queue a queue.
	renderQueue = renderQueue
		.then(() => renderDiagram(block, source))
		.catch(() => {});
}

async function renderDiagram(
	block: HTMLElement,
	source: string,
): Promise<void> {
	try {
		const api = await mermaidApi();
		if (block.dataset.mermaidState !== QUEUED_STATE) return;
		// A message node is enhanced before the transcript places it, so "not
		// connected" here can simply mean "not mounted yet". One turn later the
		// answer is reliable: either it is in the document, or the transcript
		// replaced it and the replacement has queued its own render.
		if (!block.isConnected) {
			await nextTask();
			if (block.dataset.mermaidState !== QUEUED_STATE) return;
			if (!block.isConnected) return;
		}
		const id = `pi-mermaid-${(diagramCounter += 1)}`;
		api.initialize(mermaidConfiguration(api));
		const { svg } = await api.render(id, source);
		if (block.dataset.mermaidState !== QUEUED_STATE) return;
		// Laying a diagram out is the long await, and the transcript replaces nodes
		// wholesale: this one can be gone, with a fresh block that has queued its own
		// render. Drawing into it would be work nobody can see.
		if (!block.isConnected) return;
		mountDiagram(block, svg);
	} catch (error) {
		if (block.dataset.mermaidState !== QUEUED_STATE) return;
		showDiagramError(block, describeError(error));
	}
}

function mermaidConfiguration(api: MermaidApi): Record<string, unknown> {
	const body = getComputedStyle(document.body);
	const readStyle: StyleReader = (property) =>
		body.getPropertyValue(property) || undefined;
	const fontFamily =
		readStyle("--vscode-font-family")?.trim() || body.fontFamily || undefined;
	const configuration: Record<string, unknown> = {
		startOnLoad: false,
		// Labels are sanitized by the library, links stay inert, and clicking
		// inside a diagram cannot run anything.
		securityLevel: "strict",
		// Failures are reported by showDiagramError; mermaid's own error graphic is
		// not something the reader can act on, and it would sit next to the source
		// the reader needs instead.
		suppressErrorRendering: true,
		theme: "base",
		themeVariables: mermaidThemeVariables(readStyle, fontFamily),
	};
	return { ...configuration, ...nativeWidthConfiguration(api) };
}

/**
 * Per-diagram-type config that keeps an SVG at the size it was drawn at.
 *
 * mermaid's default is to fit a diagram into its container, which in a narrow
 * sidebar renders a 900px flowchart's 12px labels illegibly small; the frame
 * scrolls instead. Which types accept `useMaxWidth` is the library's own
 * business and grows with it, so the keys are read off the loaded config: this
 * was a hand-written list of twenty type names, and nine of them (kanban,
 * ishikawa, venn, …) were missing one release later, scaling silently.
 */
function nativeWidthConfiguration(api: MermaidApi): Record<string, unknown> {
	nativeWidth ??= readNativeWidthConfiguration(api);
	return nativeWidth;
}

let nativeWidth: Record<string, unknown> | undefined;

/**
 * Exported for its own test: pure once the config reader is supplied.
 *
 * A reader that is missing or throws leaves every diagram at the library's own
 * sizing. Sizing is a preference here and drawing is not, so this one failure is
 * absorbed rather than turned into one message per diagram.
 */
export function readNativeWidthConfiguration(
	api: MermaidApi,
): Record<string, unknown> {
	const configuration: Record<string, unknown> = {};
	let config: Record<string, unknown>;
	try {
		config = api.mermaidAPI?.getConfig?.() ?? {};
	} catch {
		return configuration;
	}
	for (const [key, value] of Object.entries(config)) {
		if (typeof value === "object" && value !== null && "useMaxWidth" in value) {
			configuration[key] = { useMaxWidth: false };
		}
	}
	return configuration;
}

function mountDiagram(block: HTMLElement, svg: string): void {
	const element = diagramElement(svg);
	if (!element) {
		showDiagramError(block, "the rendered diagram was empty");
		return;
	}
	const diagram = document.createElement("div");
	diagram.className = "mermaid-diagram";
	diagram.setAttribute("role", "img");
	diagram.setAttribute("aria-label", "Mermaid diagram");
	diagram.append(element);
	block.append(diagram, diagramSourceDisclosure(block));
	block.dataset.mermaidState = RENDERED_STATE;
}

/**
 * Turns mermaid's SVG markup into a node the transcript can hold.
 *
 * The markup is mermaid's own, inserted after removing everything executable
 * from it (see `stripExecutableContent`) rather than run through DOMPurify whole.
 * Its two profiles cannot both hold: the HTML profile has no SVG, and the SVG
 * profile drops `foreignObject` — the element mermaid puts node labels in — or
 * keeps the box and strips its contents, which renders every node blank.
 * Rebuilding the diagram instead of forwarding it is the one thing this module
 * must not do: the library owns what a diagram looks like.
 *
 * DOM APIs rather than `innerHTML`, so the tree that is checked is the tree that
 * is inserted — no re-parse in between for markup to become something else in.
 */
function diagramElement(svg: string): SVGElement | undefined {
	const parsed = new DOMParser().parseFromString(svg, "text/html");
	const element = parsed.body.querySelector("svg");
	if (!element) return undefined;
	const imported = document.importNode(element, true) as SVGElement;
	stripExecutableContent(imported);
	return imported;
}

/**
 * Removes what could run, from a tree mermaid has already sanitized.
 *
 * Not this module's outermost layer, and not even the outermost inside mermaid:
 * under `securityLevel: "strict"` the library runs the whole serialized SVG
 * through DOMPurify on the way out, with its own allowance for the
 * `foreignObject` labels. So nothing here is the reason a diagram is safe. What
 * this pass covers is the gap between that output and a document: `<script>`,
 * every `on*` handler, and the URLs that make a click or a load executable —
 * `javascript:`, a `data:text/html` document, a data-URL SVG, none of which the
 * SVG's own sanitizing promises to be free of in every version.
 *
 * Two things are deliberately left to their own layers. `<iframe>`, `<object>`
 * and `<embed>` are not removed, because the document's `default-src 'none'`
 * gives them nothing to load and the library's own pass drops them anyway. And
 * what actually stops code is the CSP, not this pass: a probe against the real
 * document shows an inline `<script>` without the document's nonce, an `onerror`
 * attribute, and a `javascript:` link each failing with a `script-src`
 * violation.
 *
 * Exported for its own test: whether a script or a handler can survive the pass
 * is worth pinning down without a browser.
 */
export function stripExecutableContent(root: Element): void {
	for (const script of root.querySelectorAll("script")) script.remove();
	for (const element of [root, ...root.querySelectorAll("*")]) {
		for (const attribute of [...element.attributes]) {
			const name = attribute.name.toLowerCase();
			if (name.startsWith("on")) {
				element.removeAttribute(attribute.name);
			} else if (
				(URL_ATTRIBUTES.has(name) || name.endsWith(":href")) &&
				isExecutableUrl(attribute.value)
			) {
				element.removeAttribute(attribute.name);
			}
		}
	}
}

/**
 * The attributes a URL can hide in, checked by name rather than by scheme.
 *
 * `data` is the attribute `<object>` loads from, not the `data-*` family a
 * diagram's own bookkeeping uses — those names differ by more than this lookup.
 */
const URL_ATTRIBUTES = new Set(["href", "src", "data"]);

/** Control characters and whitespace are how `java\nscript:` hides from a filter. */
function isExecutableUrl(value: string): boolean {
	const url = value.replace(/[\s\u0000-\u001f]+/gu, "").toLowerCase();
	return (
		url.startsWith("javascript:") ||
		url.startsWith("data:text/html") ||
		url.startsWith("data:image/svg")
	);
}

/**
 * Folds the fence out of the way once a diagram stands in for it.
 *
 * The source stays in the document rather than being dropped: a diagram renders
 * at its own scale, so the text is the accessible and copyable form of the same
 * content — and the copy button the code block already carries keeps working.
 */
function diagramSourceDisclosure(block: HTMLElement): HTMLDetailsElement {
	const source =
		block.querySelector<HTMLElement>(SOURCE_CONTAINER_SELECTOR) ??
		block.querySelector<HTMLElement>("pre");
	const details = document.createElement("details");
	details.className = "mermaid-source";
	const summary = document.createElement("summary");
	summary.textContent = "Diagram source";
	details.append(summary);
	if (source) details.append(source);
	return details;
}

function showDiagramError(block: HTMLElement, message: string): void {
	const notice = document.createElement("p");
	notice.className = "mermaid-error";
	notice.textContent = `Mermaid could not render this diagram: ${message}`;
	// Above the fence: the reader sees why the source did not become a diagram
	// before they see the source itself.
	block.prepend(notice);
	block.dataset.mermaidState = FAILED_STATE;
}

/**
 * mermaid reports a parse failure as a multi-line dump that repeats the source.
 * The first line is the part that says what is wrong.
 */
function describeError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const firstLine = message.split("\n", 1)[0]?.trim() ?? "";
	return firstLine.length > 0 ? firstLine.slice(0, 200) : "unknown error";
}

let apiPromise: Promise<MermaidApi> | undefined;

function mermaidApi(): Promise<MermaidApi> {
	const loaded = window.__piMermaid;
	if (loaded) return Promise.resolve(loaded);
	apiPromise ??= injectMermaidBundle().catch((error: unknown) => {
		// A failed load is not remembered: the next diagram retries instead of
		// leaving every later fence as source for the rest of the session.
		apiPromise = undefined;
		throw error;
	});
	return apiPromise;
}

/**
 * Injects the mermaid bundle, which exposes itself on `window.__piMermaid`.
 *
 * The bundle URL and the CSP nonce both come from the document (see
 * `createWebviewDocument`): the policy only admits scripts carrying the nonce,
 * so an injected script without it is dropped silently.
 */
function injectMermaidBundle(): Promise<MermaidApi> {
	const source = document.body.dataset.mermaidScript;
	if (!source) {
		return Promise.reject(new Error("this webview has no mermaid bundle"));
	}
	return new Promise<MermaidApi>((resolve, reject) => {
		const script = document.createElement("script");
		const nonce = document.body.dataset.cspNonce;
		if (nonce) script.setAttribute("nonce", nonce);
		script.src = source;
		script.addEventListener("load", () => {
			const api = window.__piMermaid;
			if (api) resolve(api);
			else reject(new Error("the mermaid bundle did not expose its API"));
		});
		script.addEventListener("error", () =>
			reject(new Error("the mermaid bundle could not be loaded")),
		);
		document.head.append(script);
	});
}

function nextTask(): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, 0);
	});
}

declare global {
	interface Window {
		/** Set by the injected `dist/webview/mermaid.js` bundle. */
		__piMermaid?: MermaidApi;
	}
}
