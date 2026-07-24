import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const expectedCommands = [
	"piAgentSidebar.open",
	"piAgentSidebar.focusInput",
	"piAgentSidebar.newSession",
	"piAgentSidebar.restart",
	"piAgentSidebar.showLogs",
];

test("manifest preserves public command IDs and selection keybindings", async () => {
	const manifest = JSON.parse(await readFile("package.json", "utf8"));
	assert.deepEqual(
		manifest.contributes.commands.map((command) => command.command),
		expectedCommands,
	);
	const keybinding = manifest.contributes.keybindings.find(
		(item) => item.command === "piAgentSidebar.focusInput",
	);
	assert.deepEqual(keybinding, {
		command: "piAgentSidebar.focusInput",
		key: "ctrl+escape",
		mac: "cmd+escape",
		when: "editorTextFocus",
	});
});

test("inline code references use font color without decoration", async () => {
	const css = await readFile("media/main.css", "utf8");
	const match = css.match(/\.code-reference-highlight\s*\{([^}]+)\}/u);
	assert.ok(match, "code-reference-highlight rule is missing");
	const rule = match[1];
	assert.match(rule, /color:\s*var\(--vscode-textLink-foreground/iu);
	assert.match(rule, /background:\s*transparent/iu);
	assert.doesNotMatch(
		rule,
		/box-shadow|text-decoration|border(?:-radius)?\s*:/iu,
	);
});
