import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const THEME_CSS = "webview/styles/pi-theme.css";

/**
 * Splits the stylesheet into `selector -> declaration text` pairs.
 *
 * The file is flat by construction (no nesting, no at-rules), so a brace scan is
 * enough and avoids pulling in a CSS parser for three rule blocks.
 */
function readRuleBlocks(css) {
	const blocks = [];
	const pattern = /([^{}]+)\{([^}]*)\}/gu;
	let match = pattern.exec(css);
	while (match) {
		blocks.push({
			selector: match[1].replaceAll(/\/\*[\s\S]*?\*\//gu, "").trim(),
			body: match[2],
		});
		match = pattern.exec(css);
	}
	return blocks;
}

function declaredTokens(body) {
	return new Set(
		[...body.matchAll(/(--pi-theme-[a-z0-9-]+)\s*:/gu)].map((match) => match[1]),
	);
}

function blocksFor(blocks, predicate) {
	return blocks.filter((block) => predicate(block.selector));
}

function unionTokens(blocks) {
	const tokens = new Set();
	for (const block of blocks) {
		for (const token of declaredTokens(block.body)) tokens.add(token);
	}
	return tokens;
}

async function loadTheme() {
	const css = await readFile(THEME_CSS, "utf8");
	const blocks = readRuleBlocks(css);
	const rootBlocks = blocksFor(blocks, (selector) => selector === ":root");
	const lightBlocks = blocksFor(blocks, (selector) =>
		selector.includes("vscode-light"),
	);
	return { css, blocks, rootBlocks, lightBlocks };
}

test("pi theme declares a light value for every palette token", async () => {
	const { rootBlocks, lightBlocks } = await loadTheme();
	assert.ok(rootBlocks.length > 0, "expected at least one :root block");
	assert.equal(lightBlocks.length, 1, "expected exactly one light override");

	// The light block overrides the palette only; tokens that derive from
	// VS Code variables or from other tokens are theme-independent by design and
	// live in the trailing :root block. Parity is therefore checked against the
	// block that actually carries hex literals.
	const paletteBlock = rootBlocks.find((block) =>
		declaredTokens(block.body).has("--pi-theme-accent"),
	);
	assert.ok(paletteBlock, "expected a :root block defining --pi-theme-accent");

	const darkTokens = declaredTokens(paletteBlock.body);
	const lightTokens = declaredTokens(lightBlocks[0].body);
	const missing = [...darkTokens].filter((token) => !lightTokens.has(token));
	const extra = [...lightTokens].filter((token) => !darkTokens.has(token));

	// A token present in the dark palette but absent from the light override does
	// not fail loudly: it silently keeps the dark value, so a dark-theme colour
	// ends up on a light background. Only a test catches that.
	assert.deepEqual(missing, [], "tokens missing a light value");
	assert.deepEqual(extra, [], "light-only tokens with no dark counterpart");
});

test("pi theme resolves every referenced token to a declaration", async () => {
	const { css, blocks } = await loadTheme();
	const declared = unionTokens(blocks);
	const referenced = new Set(
		[...css.matchAll(/var\(\s*(--pi-theme-[a-z0-9-]+)/gu)].map(
			(match) => match[1],
		),
	);
	const dangling = [...referenced].filter((token) => !declared.has(token));
	assert.deepEqual(dangling, [], "var() references with no declaration");
});

test("pi theme keeps the three tool state backgrounds independently tunable", async () => {
	const { blocks } = await loadTheme();
	const declared = unionTokens(blocks);
	for (const state of ["pending", "success", "error"]) {
		assert.ok(
			declared.has(`--pi-theme-tool-${state}-bg`),
			`expected --pi-theme-tool-${state}-bg to be declared`,
		);
	}
});

test("pi theme surfaces stay translucent so they composite over the sidebar", async () => {
	const { css } = await loadTheme();
	// Opaque surfaces would defeat the whole reason these are mixes: a nested
	// tool box inside a hovered row has to read as both.
	for (const state of ["pending", "success", "error"]) {
		const declaration = new RegExp(
			`--pi-theme-tool-${state}-bg:\\s*color-mix\\([^;]*transparent`,
			"u",
		);
		assert.match(
			css,
			declaration,
			`expected --pi-theme-tool-${state}-bg to mix toward transparent`,
		);
	}
});

test("pi theme is wired into the stylesheet entry ahead of base", async () => {
	const entry = await readFile("webview/main.css", "utf8");
	const themeIndex = entry.indexOf("styles/pi-theme.css");
	const baseIndex = entry.indexOf("styles/base.css");
	assert.ok(themeIndex >= 0, "expected main.css to import pi-theme.css");
	// Ordering matters for the eventual consumers: base.css will read these
	// tokens, and a later import cannot be referenced by an earlier one.
	assert.ok(
		themeIndex < baseIndex,
		"expected pi-theme.css to be imported before base.css",
	);
});
