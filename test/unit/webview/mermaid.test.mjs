import assert from "node:assert/strict";
import test from "node:test";
import { loadBundledModule } from "../../helpers/load-bundled-module.mjs";

async function loadMermaid() {
	return loadBundledModule({
		entry: "webview/transcript/mermaid.ts",
		name: "mermaid",
		platform: "browser",
	});
}

async function loadHighlight() {
	return loadBundledModule({
		entry: "webview/transcript/highlight.ts",
		name: "highlight",
		platform: "browser",
	});
}

/**
 * The elements the sanitizer and the enhancement pass walk, as much of them as
 * they touch.
 *
 * A real DOM is not available to these tests and the code under test needs only
 * a few operations from one, so the fake implements exactly those and fails
 * loudly on anything else: a selector the fake does not know is either a selector
 * the test is not covering, or one the implementation quietly grew.
 */
class FakeElement {
	constructor(tagName, attributes = []) {
		this.tagName = tagName;
		this.attributes = attributes.map(([name, value]) => ({ name, value }));
		this.children = [];
		this.parent = undefined;
		this.dataset = {};
		this.textContent = "";
		this.isConnected = true;
	}

	append(...nodes) {
		for (const node of nodes) {
			node.parent = this;
			this.children.push(node);
		}
		return this;
	}

	removeAttribute(name) {
		this.attributes = this.attributes.filter((a) => a.name !== name);
	}

	remove() {
		if (this.parent) {
			this.parent.children = this.parent.children.filter((c) => c !== this);
			this.parent = undefined;
		}
	}

	attributeValue(name) {
		return this.attributes.find((a) => a.name === name)?.value;
	}

	descendants() {
		return this.children.flatMap((child) => [child, ...child.descendants()]);
	}

	matchesSelector(selector) {
		const [tag = "", ...classes] = selector.split(".");
		// A selector that starts with a dot is a "*" with classes on it.
		const selectorTag = tag === "" ? "*" : tag;
		const isPlain = (name) => /^[\w*-]+$/u.test(name);
		if (!isPlain(selectorTag) || !classes.every(isPlain)) {
			throw new Error(`FakeElement does not implement selector ${selector}`);
		}
		if (selectorTag !== "*" && this.tagName !== selectorTag) return false;
		const list = (this.attributeValue("class") ?? "").split(/\s+/u);
		return classes.every((name) => list.includes(name));
	}

	matches(selector) {
		return this.matchesSelector(selector);
	}

	querySelector(selector) {
		return this.querySelectorAll(selector)[0];
	}

	querySelectorAll(selector) {
		return this.descendants().filter((node) => node.matchesSelector(selector));
	}
}

/** `mermaidBlocksIn` narrows the root with `instanceof`, which needs the global. */
function withElementGlobal(run) {
	const previous = globalThis.Element;
	globalThis.Element = FakeElement;
	try {
		return run();
	} finally {
		globalThis.Element = previous;
	}
}

function fakeMermaidBlock(source) {
	const block = new FakeElement("div", [["class", "mermaid-block"]]);
	block.dataset = { mermaidState: "pending" };
	const code = new FakeElement("code", [["class", "hljs language-mermaid"]]);
	code.textContent = source;
	block.append(code);
	return block;
}

test("theme variables map the editor palette onto mermaid's base theme", async () => {
	const loaded = await loadMermaid();
	try {
		const palette = {
			"--vscode-editor-background": "#1e1e1e",
			"--vscode-editorWidget-background": "#252526",
			"--vscode-foreground": "#d4d4d4",
			"--vscode-panel-border": "#3c3c3c",
			"--vscode-editor-inactiveSelectionBackground": "#3a3d41",
		};
		const variables = loaded.module.mermaidThemeVariables(
			(property) => palette[property],
			"Consolas, monospace",
		);

		assert.equal(variables.background, "#1e1e1e");
		assert.equal(variables.primaryColor, "#252526");
		assert.equal(variables.primaryTextColor, "#d4d4d4");
		assert.equal(variables.lineColor, "#d4d4d4");
		assert.equal(variables.nodeBorder, "#3c3c3c");
		assert.equal(variables.secondaryColor, "#3a3d41");
		assert.equal(variables.fontFamily, "Consolas, monospace");
	} finally {
		await loaded.dispose();
	}
});

test("a block handed in as its own root is still queued", async () => {
	const loaded = await loadMermaid();
	try {
		// How the streaming path calls this: one node at a time, and a top-level
		// fence's node is the wrapper itself. Scanning only descendants would leave
		// that fence showing source until the message was rebuilt at the end.
		withElementGlobal(() => {
			const block = fakeMermaidBlock("flowchart TD\n  A --> B");
			loaded.module.enhanceMermaidBlocks(block);
			assert.equal(block.dataset.mermaidState, "queued");
		});
	} finally {
		await loaded.dispose();
	}
});

test("unusable theme values fall back instead of reaching the colour library", async () => {
	const loaded = await loadMermaid();
	try {
		// `color-mix()` is what a theme variable holds when VS Code computes it, and
		// an unset variable reads as the empty string; khroma parses neither, and a
		// throw there fails the whole diagram rather than one shade.
		const unusable = {
			"--vscode-editor-background": "color-mix(in srgb, #1e1e1e 50%, black)",
			"--vscode-editorWidget-background": "",
			"--vscode-foreground": undefined,
			"--vscode-panel-border": "var(--vscode-contrastBorder)",
		};
		const variables = loaded.module.mermaidThemeVariables(
			(property) => unusable[property],
		);

		for (const value of Object.values(variables)) {
			assert.match(value, /^(?:#[\da-f]{3,8}|rgba?\(|hsla?\()/iu);
		}
		assert.equal(variables.fontFamily, undefined);
		assert.equal(
			Object.hasOwn(variables, "fontFamily"),
			false,
			"fontFamily is omitted rather than set to an empty string, which mermaid would apply as no font at all",
		);
	} finally {
		await loaded.dispose();
	}
});

test("series colours come from the theme's chart palette, not from its surfaces", async () => {
	const loaded = await loadMermaid();
	try {
		const chartColors = {
			"--vscode-charts-blue": "#59a4f9",
			"--vscode-charts-green": "#89d185",
			"--vscode-charts-yellow": "#cca700",
			"--vscode-charts-orange": "#ea5c0055",
			"--vscode-charts-red": "#f14c4c",
			"--vscode-charts-purple": "#b180d7",
		};
		const variables = loaded.module.mermaidThemeVariables(
			(property) => chartColors[property],
		);

		// mermaid derives the pie and timeline palettes from `primaryColor` when
		// these are missing, and `primaryColor` is a panel surface — the colour of
		// the background a slice is drawn on.
		assert.equal(variables.pie1, "#59a4f9");
		assert.equal(variables.pie2, "#89d185");
		assert.equal(variables.cScale0, "#59a4f9");
		assert.equal(variables.cScale5, "#b180d7");
		assert.notEqual(variables.pie1, variables.primaryColor);

		// Twelve slots, six published colours: the repeat is interleaved so that no
		// two neighbours in a pie share a colour.
		assert.equal(variables.pie7, "#59a4f9");
		assert.equal(variables.pie12, "#b180d7");
		assert.equal(
			new Set([
				variables.pie1,
				variables.pie2,
				variables.pie3,
				variables.pie4,
				variables.pie5,
				variables.pie6,
			]).size,
			6,
		);
	} finally {
		await loaded.dispose();
	}
});

test("series labels are picked against the colour they sit on", async () => {
	const loaded = await loadMermaid();
	try {
		const variables = loaded.module.mermaidThemeVariables(
			(property) =>
				({
					"--vscode-charts-blue": "#0063d3",
					"--vscode-charts-green": "#f0f0f0",
				})[property],
		);

		// A theme text colour is chosen against the transcript; a band or slice is
		// not the transcript, so each series colour gets its own readable label —
		// light on the dark blue, dark on the near-white green. (The green is a
		// stand-in for whatever a theme publishes; the point is which side wins.)
		assert.equal(variables.cScaleLabel0, "#ffffff");
		assert.equal(variables.cScaleLabel1, "#1f1f1f");
		assert.match(variables.pieSectionTextColor, /^#(?:1f1f1f|ffffff)$/u);
	} finally {
		await loaded.dispose();
	}
});

test("a theme without chart colours still gets a visible palette", async () => {
	const loaded = await loadMermaid();
	try {
		const variables = loaded.module.mermaidThemeVariables(() => undefined);
		const firstSix = [
			variables.pie1,
			variables.pie2,
			variables.pie3,
			variables.pie4,
			variables.pie5,
			variables.pie6,
		];

		assert.equal(new Set(firstSix).size, 6);
		for (const value of firstSix) {
			assert.match(value, /^#[\da-f]{6}$/u);
			assert.notEqual(value, variables.background);
			assert.notEqual(value, variables.primaryColor);
		}
	} finally {
		await loaded.dispose();
	}
});

test("mermaid fences are recognised case- and whitespace-insensitively", async () => {
	const loaded = await loadHighlight();
	try {
		const { isMermaidFence } = loaded.module;
		for (const language of ["mermaid", " Mermaid ", "MERMAID", "mErMaId"]) {
			assert.equal(isMermaidFence(language), true, language);
		}
		for (const language of ["", "mmd", "mermaid.js", "javascript"]) {
			assert.equal(isMermaidFence(language), false, language);
		}
	} finally {
		await loaded.dispose();
	}
});

test("every diagram type that can keep its natural width is discovered", async () => {
	const loaded = await loadMermaid();
	try {
		const { readNativeWidthConfiguration } = loaded.module;
		const configuration = readNativeWidthConfiguration({
			mermaidAPI: {
				getConfig: () => ({
					// Two of the nine types a hand-written list of names had missed.
					kanban: { useMaxWidth: true, padding: 8 },
					ishikawa: { useMaxWidth: true },
					flowchart: { useMaxWidth: true },
					theme: { background: "#1e1e1e" },
					extension: { name: "not a diagram" },
				}),
			},
		});

		assert.deepEqual(Object.keys(configuration).sort(), [
			"flowchart",
			"ishikawa",
			"kanban",
		]);
		assert.deepEqual(configuration.kanban, { useMaxWidth: false });
	} finally {
		await loaded.dispose();
	}
});

test("a library that will not hand over its config still draws", async () => {
	const loaded = await loadMermaid();
	try {
		const { readNativeWidthConfiguration } = loaded.module;

		// Sizing is a preference and drawing is not, so neither a missing reader nor
		// one that throws may take the diagram down with it.
		assert.deepEqual(readNativeWidthConfiguration({}), {});
		assert.deepEqual(
			readNativeWidthConfiguration({
				mermaidAPI: {
					getConfig: () => {
						throw new Error("no config here");
					},
				},
			}),
			{},
		);
	} finally {
		await loaded.dispose();
	}
});

test("scripts and event handlers are removed from a rendered diagram", async () => {
	const loaded = await loadMermaid();
	try {
		const root = new FakeElement("svg", [["class", "mermaid"]]);
		const group = new FakeElement("g", []);
		const node = new FakeElement("rect", [
			["class", "node"],
			["onclick", "steal()"],
			["onmouseover", "steal()"],
			["onload", "steal()"],
			["width", "40"],
		]);
		const script = new FakeElement("script", []);
		const link = new FakeElement("a", [
			["href", "java\nscript:steal()"],
			["xlink:href", "jav\tascript:steal()"],
		]);
		const safeLink = new FakeElement("a", [
			["href", "https://example.com"],
			["xlink:href", "#node-1"],
		]);
		// `src` and `data` load, rather than navigate, but a URL is a URL: the data
		// attribute of `<object>` is included, the `data-*` family is not.
		const image = new FakeElement("image", [["src", "javascript:steal()"]]);
		const object = new FakeElement("object", [
			["data", "data:text/html,<script>steal()</script>"],
		]);
		const safeImage = new FakeElement("image", [
			["src", "data:image/png;base64,AAAA"],
			["data-mermaid-state", "rendered"],
		]);
		root.append(
			group.append(node, script, link, safeLink, image, object, safeImage),
			new FakeElement("text", [["text-anchor", "middle"]]),
		);

		loaded.module.stripExecutableContent(root);

		assert.deepEqual(node.attributes, [
			{ name: "class", value: "node" },
			{ name: "width", value: "40" },
		]);
		assert.equal(script.parent, undefined, "the script element is detached");
		assert.equal(group.children.includes(script), false);
		assert.equal(link.attributeValue("href"), undefined);
		assert.equal(link.attributeValue("xlink:href"), undefined);
		assert.equal(safeLink.attributeValue("href"), "https://example.com");
		assert.equal(safeLink.attributeValue("xlink:href"), "#node-1");
		assert.equal(image.attributeValue("src"), undefined);
		assert.equal(object.attributeValue("data"), undefined);
		assert.equal(safeImage.attributeValue("src"), "data:image/png;base64,AAAA");
		assert.equal(safeImage.attributeValue("data-mermaid-state"), "rendered");
		assert.equal(root.attributeValue("class"), "mermaid");
	} finally {
		await loaded.dispose();
	}
});

test("a script nested in an html label is removed too", async () => {
	const loaded = await loadMermaid();
	try {
		const root = new FakeElement("svg", []);
		const foreignObject = new FakeElement("foreignObject", []);
		const script = new FakeElement("script", []);
		const label = new FakeElement("div", [["onerror", "steal()"]]);
		root.append(foreignObject.append(label, script));

		loaded.module.stripExecutableContent(root);

		assert.deepEqual(root.querySelectorAll("script"), []);
		assert.deepEqual(label.attributes, []);
		assert.equal(foreignObject.children.includes(label), true);
	} finally {
		await loaded.dispose();
	}
});
