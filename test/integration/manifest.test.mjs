import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const expectedCommands = [
	"piAgentSidebar.open",
	"piAgentSidebar.focusInput",
	"piAgentSidebar.newSession",
	"piAgentSidebar.restart",
	"piAgentSidebar.showLogs",
	"piAgentSidebar.renameSession",
	"piAgentSidebar.exportHtml",
	"piAgentSidebar.explainSelection",
	"piAgentSidebar.explainFile",
	"piAgentSidebar.refactorSelection",
	"piAgentSidebar.generateTests",
	"piAgentSidebar.explainDiagnostics",
	"piAgentSidebar.addFilesToInput",
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
	assert.deepEqual(manifest.contributes.menus["explorer/context"], [
		{
			command: "piAgentSidebar.addFilesToInput",
			when: "resourceScheme == file || resourceScheme == vscode-remote",
			group: "navigation@100",
		},
	]);
	assert.deepEqual(manifest.contributes.menus.commandPalette, [
		{ command: "piAgentSidebar.addFilesToInput", when: "false" },
	]);
	assert.deepEqual(
		manifest.contributes.menus["piAgentSidebar.editorContext"][0],
		{
			command: "piAgentSidebar.focusInput",
			when: "editorHasSelection",
			group: "1_ask@0",
		},
	);
});

test("inline composer tokens use font color without decoration", async () => {
	const css = await readFile("webview/styles/composer.css", "utf8");
	const match = css.match(
		/\.composer-reference-highlight,\s*\.composer-command-highlight\s*\{([^}]+)\}/u,
	);
	assert.ok(match, "shared composer token highlight rule is missing");
	const rule = match[1];
	assert.match(rule, /color:\s*var\(--vscode-textLink-foreground/iu);
	assert.match(rule, /background:\s*transparent/iu);
	assert.doesNotMatch(
		rule,
		/box-shadow|text-decoration|border(?:-radius)?\s*:/iu,
	);
});
