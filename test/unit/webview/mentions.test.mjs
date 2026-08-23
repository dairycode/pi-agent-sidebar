import assert from "node:assert/strict";
import test from "node:test";
import { loadBundledModule } from "../../helpers/load-bundled-module.mjs";

async function loadMentionController() {
	return loadBundledModule({
		entry: "webview/composer/mentions.ts",
		name: "mentions",
		platform: "browser",
	});
}

async function loadComposerController() {
	return loadBundledModule({
		entry: "webview/composer/controller.ts",
		name: "mention-composer-controller",
	});
}

class FakeClassList {
	constructor(element) {
		this.element = element;
	}

	toggle(name, force) {
		const values = new Set(
			this.element.className.split(/\s+/u).filter(Boolean),
		);
		const enabled = force === undefined ? !values.has(name) : force;
		if (enabled) values.add(name);
		else values.delete(name);
		this.element.className = [...values].join(" ");
		return enabled;
	}

	contains(name) {
		return this.element.className.split(/\s+/u).includes(name);
	}
}

class FakeElement {
	constructor(tagName, document) {
		this.tagName = tagName.toUpperCase();
		this.document = document;
		this.children = [];
		this.listeners = new Map();
		this.attributes = new Map();
		this.dataset = {};
		this.className = "";
		this.classList = new FakeClassList(this);
		this.hidden = true;
		this.tabIndex = 0;
		this.textContent = "";
		this.title = "";
		this.id = "";
		this.style = {};
		this.scrolled = false;
	}

	addEventListener(type, listener) {
		const listeners = this.listeners.get(type) ?? [];
		listeners.push(listener);
		this.listeners.set(type, listeners);
	}

	dispatch(type, fields = {}) {
		let prevented = 0;
		const event = {
			target: this,
			key: "",
			preventDefault() {
				prevented += 1;
			},
			...fields,
		};
		for (const listener of this.listeners.get(type) ?? []) listener(event);
		return {
			get prevented() {
				return prevented;
			},
		};
	}

	append(...children) {
		this.children.push(...children);
	}

	replaceChildren(...children) {
		this.children = [...children];
	}

	setAttribute(name, value) {
		this.attributes.set(name, value);
	}

	removeAttribute(name) {
		this.attributes.delete(name);
	}

	getAttribute(name) {
		return this.attributes.get(name) ?? null;
	}

	scrollIntoView() {
		this.scrolled = true;
	}

	querySelectorAll(selector) {
		const result = [];
		const visit = (element) => {
			for (const child of element.children) {
				if (child.classList.contains(selector.slice(1))) result.push(child);
				visit(child);
			}
		};
		visit(this);
		return result;
	}
}

class FakeDocument {
	createElement(tagName) {
		return new FakeElement(tagName, this);
	}
}

const files = [
	{
		kind: "file",
		uri: "file:///w/src/main.ts",
		displayPath: "src/main.ts",
	},
	{
		kind: "file",
		uri: "file:///w/src/util.ts",
		displayPath: "src/util.ts",
	},
];

const currentSrcDirectory = {
	kind: "directory",
	displayPath: "src",
	uri: "file:///w/src",
	current: true,
};

const srcEntries = [
	currentSrcDirectory,
	{ kind: "directory", displayPath: "src/provider" },
	...files,
];

const rootEntries = [
	{ kind: "directory", displayPath: "src" },
	{
		kind: "file",
		uri: "file:///w/README.md",
		displayPath: "README.md",
	},
];

function createHarness(MentionController, overrides = {}) {
	const document = new FakeDocument();
	const panel = document.createElement("div");
	const list = document.createElement("div");
	const editor = {
		value: "",
		selectionStart: 0,
		selectionEnd: 0,
		focused: 0,
		attributes: new Map(),
		focus() {
			this.focused += 1;
		},
		setAttribute(name, value) {
			this.attributes.set(name, value);
		},
		removeAttribute(name) {
			this.attributes.delete(name);
		},
	};
	const requests = [];
	const commits = [];
	const navigations = [];
	const announcements = [];
	let positioned = 0;
	const controller = new MentionController({
		panel,
		list,
		editor,
		requestFiles: (requestId, query) => requests.push({ requestId, query }),
		commit: (file, token) => commits.push({ file, token }),
		navigate: (directoryPath, token) => {
			const insertion = `@${directoryPath}/`;
			editor.value = `${editor.value.slice(0, token.start)}${insertion}${editor.value.slice(token.end)}`;
			const caret = token.start + insertion.length;
			editor.selectionStart = caret;
			editor.selectionEnd = caret;
			navigations.push({ directoryPath, token });
		},
		announce: (message) => announcements.push(message),
		isEnabled: () => true,
		position: () => {
			positioned += 1;
		},
		isProtectedOffset: () => false,
		document,
		...overrides,
	});
	const type = (value, caret = value.length, afterInput = false) => {
		editor.value = value;
		editor.selectionStart = caret;
		editor.selectionEnd = caret;
		if (afterInput) controller.syncAfterInput();
		else controller.sync();
	};
	return {
		controller,
		panel,
		list,
		editor,
		requests,
		commits,
		navigations,
		announcements,
		type,
		get positioned() {
			return positioned;
		},
	};
}

test("an at token requests files and results open the popup", async () => {
	const loaded = await loadMentionController();
	try {
		const state = createHarness(loaded.module.MentionController);
		state.type("look at @src");
		assert.deepEqual(state.requests, [{ requestId: 1, query: "src" }]);
		assert.equal(state.controller.isOpen, false);

		state.controller.applyResults(1, "src", files);
		assert.equal(state.controller.isOpen, true);
		assert.equal(state.panel.hidden, false);
		assert.equal(state.positioned, 1);
		const rows = state.list.querySelectorAll(".mention-row");
		assert.deepEqual(
			rows.map((row) => row.children[1].textContent),
			["main.ts", "util.ts"],
		);
		assert.ok(rows.every((row) => row.classList.contains("is-file")));
		assert.deepEqual(
			rows.map((row) => row.children.length),
			[2, 2],
		);
		assert.equal(rows[0].getAttribute("aria-selected"), "true");
		assert.equal(
			state.editor.attributes.get("aria-activedescendant"),
			"mention-row-0",
		);
	} finally {
		await loaded.dispose();
	}
});

test("selecting a directory keeps browsing until whitespace ends the token", async () => {
	const loaded = await loadMentionController();
	try {
		const state = createHarness(loaded.module.MentionController);
		state.type("inspect @");
		state.controller.applyResults(1, "", rootEntries);
		const rootRows = state.list.querySelectorAll(".mention-row");
		assert.equal(rootRows[0].classList.contains("is-directory"), true);
		assert.equal(rootRows[0].children[1].textContent, "src/");
		assert.equal(rootRows[0].children.length, 3, "folders include a chevron");

		assert.equal(
			state.controller.handleKeydown({ key: "Enter", preventDefault() {} }),
			true,
		);
		assert.equal(state.editor.value, "inspect @src/");
		assert.deepEqual(state.navigations, [
			{ directoryPath: "src", token: { start: 8, end: 9, query: "" } },
		]);
		assert.deepEqual(state.requests, [
			{ requestId: 1, query: "" },
			{ requestId: 2, query: "src/" },
		]);

		state.controller.applyResults(2, "src/", srcEntries);
		assert.deepEqual(state.commits, []);
		assert.equal(state.controller.isOpen, true);
		assert.deepEqual(
			state.list
				.querySelectorAll(".mention-row")
				.map((row) => row.children[1].textContent),
			["provider/", "main.ts", "util.ts"],
		);

		state.type("inspect @src/ ", undefined, true);
		assert.deepEqual(state.commits, [
			{
				file: currentSrcDirectory,
				token: { start: 8, end: 13, query: "src/" },
			},
		]);
		assert.equal(state.editor.value, "inspect @src/ ");
		assert.equal(state.controller.isOpen, false);
		assert.deepEqual(state.announcements, ["Browsing src", "Added src"]);
	} finally {
		await loaded.dispose();
	}
});

test("an empty selected directory commits when whitespace ends the token", async () => {
	const loaded = await loadMentionController();
	try {
		const state = createHarness(loaded.module.MentionController);
		state.type("@");
		state.controller.applyResults(1, "", rootEntries);
		state.controller.handleKeydown({ key: "Enter", preventDefault() {} });

		state.controller.applyResults(2, "src/", [currentSrcDirectory]);
		assert.equal(state.controller.isOpen, false);
		assert.deepEqual(state.commits, []);

		state.type("@src/\n", undefined, true);
		assert.deepEqual(state.commits, [
			{
				file: currentSrcDirectory,
				token: { start: 0, end: 5, query: "src/" },
			},
		]);
		assert.equal(state.editor.value, "@src/\n");
		assert.deepEqual(state.announcements, ["Browsing src", "Added src"]);
	} finally {
		await loaded.dispose();
	}
});

test("directory browsing can continue after selecting a folder", async () => {
	const loaded = await loadMentionController();
	try {
		const state = createHarness(loaded.module.MentionController);
		state.type("@");
		state.controller.applyResults(1, "", rootEntries);
		state.controller.handleKeydown({ key: "Enter", preventDefault() {} });
		state.controller.applyResults(2, "src/", srcEntries);

		assert.equal(
			state.controller.handleKeydown({ key: "Enter", preventDefault() {} }),
			true,
		);
		assert.equal(state.editor.value, "@src/provider/");
		assert.deepEqual(state.commits, []);
		assert.deepEqual(
			state.navigations.map(({ directoryPath }) => directoryPath),
			["src", "src/provider"],
		);
		assert.deepEqual(
			state.requests.map(({ query }) => query),
			["", "src/", "src/provider/"],
		);
	} finally {
		await loaded.dispose();
	}
});

test("a manually typed directory path lists its children like Enter does", async () => {
	const loaded = await loadMentionController();
	try {
		const state = createHarness(loaded.module.MentionController);
		state.type("inspect @src/");
		state.controller.applyResults(1, "src/", srcEntries);

		// Reaching `@src/` by typing the slash must show the same rows as reaching
		// it with Enter; only the current-directory row itself stays hidden.
		assert.equal(state.controller.isOpen, true);
		assert.deepEqual(
			state.list
				.querySelectorAll(".mention-row")
				.map((row) => row.children[1].textContent),
			["provider/", "main.ts", "util.ts"],
		);
		assert.deepEqual(state.commits, []);

		// The staged directory is still what whitespace commits.
		state.type("inspect @src/ ", undefined, true);
		assert.deepEqual(state.commits, [
			{
				file: currentSrcDirectory,
				token: { start: 8, end: 13, query: "src/" },
			},
		]);
		assert.equal(state.editor.value, "inspect @src/ ");
	} finally {
		await loaded.dispose();
	}
});

test("a confirmed manually typed directory waits for real whitespace", async () => {
	const loaded = await loadMentionController();
	try {
		const state = createHarness(loaded.module.MentionController);
		state.type("inspect @src/");
		assert.deepEqual(state.requests, [{ requestId: 1, query: "src/" }]);

		state.controller.applyResults(1, "src/", [currentSrcDirectory, ...files]);
		assert.deepEqual(state.commits, []);
		assert.equal(state.editor.value, "inspect @src/");

		state.type("inspect @src/ ", undefined, true);
		assert.deepEqual(state.commits, [
			{
				file: currentSrcDirectory,
				token: { start: 8, end: 13, query: "src/" },
			},
		]);
		assert.equal(state.editor.value, "inspect @src/ ");
		assert.deepEqual(state.navigations, []);
		assert.deepEqual(state.announcements, ["Added src"]);
		assert.equal(state.controller.isOpen, false);
	} finally {
		await loaded.dispose();
	}
});

test("whitespace and following text survive when directory confirmation is late", async () => {
	const loaded = await loadMentionController();
	try {
		const state = createHarness(loaded.module.MentionController);
		state.type("inspect @src/");
		state.type("inspect @src/ ", undefined, true);
		assert.deepEqual(state.requests, [
			{ requestId: 1, query: "src/" },
			{ requestId: 2, query: "src/" },
		]);
		assert.deepEqual(state.commits, []);

		state.type("inspect @src/ keep typing", undefined, true);
		state.controller.applyResults(2, "src/", [currentSrcDirectory, ...files]);
		assert.deepEqual(state.commits, [
			{
				file: currentSrcDirectory,
				token: { start: 8, end: 13, query: "src/" },
			},
		]);
		assert.equal(state.editor.value, "inspect @src/ keep typing");
		assert.deepEqual(state.announcements, ["Added src"]);
	} finally {
		await loaded.dispose();
	}
});

test("the real composer commit chain preserves typed whitespace and following text", async () => {
	const [mentionLoaded, composerLoaded] = await Promise.all([
		loadMentionController(),
		loadComposerController(),
	]);
	try {
		const document = new FakeDocument();
		const editor = {
			value: "inspect @src/",
			selectionStart: "inspect @src/".length,
			selectionEnd: "inspect @src/".length,
			focus() {},
			setSelectionRange(start, end) {
				this.selectionStart = start;
				this.selectionEnd = end;
			},
		};
		const composer = new composerLoaded.module.ComposerController({
			editor,
			persist() {},
			post() {},
			announce() {},
			invalidate() {},
			refreshEditorView() {},
			isEditorActive: () => true,
			pendingActions: () => [],
		});
		const requests = [];
		const mention = new mentionLoaded.module.MentionController({
			panel: document.createElement("div"),
			list: document.createElement("div"),
			editor,
			requestFiles: (requestId, query) => requests.push({ requestId, query }),
			commit: (resource, token) =>
				composer.stageDirectoryReference(
					resource.displayPath,
					token.start,
					token.end,
				),
			navigate() {},
			announce() {},
			isEnabled: () => true,
			position() {},
			isProtectedOffset: (offset) =>
				Boolean(composer.referenceAtOffset(offset)),
			document,
		});

		mention.sync();
		editor.value = "inspect @src/ ";
		editor.setSelectionRange(editor.value.length, editor.value.length);
		composer.handleInput();
		mention.syncAfterInput();
		editor.value += "keep typing";
		editor.setSelectionRange(editor.value.length, editor.value.length);
		composer.handleInput();
		mention.syncAfterInput();

		assert.deepEqual(requests, [
			{ requestId: 1, query: "src/" },
			{ requestId: 2, query: "src/" },
		]);
		mention.applyResults(2, "src/", [currentSrcDirectory]);
		assert.equal(editor.value, "inspect @src/ keep typing");
		assert.equal(editor.selectionStart, editor.value.length);
		assert.equal(composer.managedReferences().length, 1);

		composer.applyIncoming([
			{
				kind: "directory",
				id: "directory-reference",
				revision: 0,
				marker: "@src/",
				displayPath: "src",
			},
		]);
		assert.equal(editor.value, "inspect @src/ keep typing");
		assert.equal(editor.selectionStart, editor.value.length);
		assert.equal(composer.references.length, 1);
	} finally {
		await Promise.all([mentionLoaded.dispose(), composerLoaded.dispose()]);
	}
});

test("prose and email-like text never request files", async () => {
	const loaded = await loadMentionController();
	try {
		const state = createHarness(loaded.module.MentionController);
		state.type("user@example.com");
		state.type("plain prose");
		assert.deepEqual(state.requests, []);

		// A caret outside the token is not a mention either.
		state.type("@src hello", 6);
		assert.deepEqual(state.requests, []);
	} finally {
		await loaded.dispose();
	}
});

test("stale and mismatched responses are ignored", async () => {
	const loaded = await loadMentionController();
	try {
		const state = createHarness(loaded.module.MentionController);
		state.type("@sr");
		state.type("@src");
		assert.deepEqual(
			state.requests.map((request) => request.query),
			["sr", "src"],
		);

		state.controller.applyResults(1, "sr", files);
		assert.equal(state.controller.isOpen, false);
		// The right id but a query the composer has moved past also stays closed.
		state.controller.applyResults(2, "other", files);
		assert.equal(state.controller.isOpen, false);
		state.controller.applyResults(2, "src", []);
		assert.equal(state.controller.isOpen, false);
		state.controller.applyResults(2, "src", files);
		assert.equal(state.controller.isOpen, true);
	} finally {
		await loaded.dispose();
	}
});

test("arrows move the highlight and Enter commits the token span", async () => {
	const loaded = await loadMentionController();
	try {
		const state = createHarness(loaded.module.MentionController);
		state.type("see @src");
		state.controller.applyResults(1, "src", files);

		const down = state.panel.dispatch("keydown", { key: "ArrowDown" });
		assert.equal(down.prevented, 0, "the panel itself binds no keys");
		assert.equal(
			state.controller.handleKeydown({
				key: "ArrowDown",
				preventDefault() {},
			}),
			true,
		);
		let rows = state.list.querySelectorAll(".mention-row");
		assert.equal(rows[1].getAttribute("aria-selected"), "true");

		assert.equal(
			state.controller.handleKeydown({ key: "Enter", preventDefault() {} }),
			true,
		);
		assert.deepEqual(state.commits, [
			{ file: files[1], token: { start: 4, end: 8, query: "src" } },
		]);
		assert.deepEqual(state.announcements, ["Added src/util.ts"]);
		assert.equal(state.controller.isOpen, false);
		assert.equal(state.editor.attributes.has("aria-activedescendant"), false);
		rows = state.list.querySelectorAll(".mention-row");
		assert.equal(rows.length, 0);
	} finally {
		await loaded.dispose();
	}
});

test("clicking a row commits it and closed popups consume no keys", async () => {
	const loaded = await loadMentionController();
	try {
		const state = createHarness(loaded.module.MentionController);
		assert.equal(
			state.controller.handleKeydown({ key: "Enter", preventDefault() {} }),
			false,
		);

		state.type("@util");
		state.controller.applyResults(1, "util", files);
		const rows = state.list.querySelectorAll(".mention-row");
		const mousedown = rows[1].dispatch("mousedown");
		assert.equal(mousedown.prevented, 1);
		assert.deepEqual(state.commits.at(-1)?.file, files[1]);
	} finally {
		await loaded.dispose();
	}
});

test("Escape closes the popup and restores composer focus", async () => {
	const loaded = await loadMentionController();
	try {
		const state = createHarness(loaded.module.MentionController);
		state.type("@src");
		state.controller.applyResults(1, "src", files);
		assert.equal(
			state.controller.handleKeydown({ key: "Escape", preventDefault() {} }),
			true,
		);
		assert.equal(state.controller.isOpen, false);
		assert.equal(state.editor.focused, 1);
	} finally {
		await loaded.dispose();
	}
});

test("existing reference markers and a disabled composer suppress the popup", async () => {
	const loaded = await loadMentionController();
	try {
		const guarded = createHarness(loaded.module.MentionController, {
			isProtectedOffset: () => true,
		});
		guarded.type("@src/main.ts");
		assert.deepEqual(guarded.requests, []);

		const disabled = createHarness(loaded.module.MentionController, {
			isEnabled: () => false,
		});
		disabled.type("@src");
		assert.deepEqual(disabled.requests, []);
	} finally {
		await loaded.dispose();
	}
});

test("moving out of the token dismisses an open popup", async () => {
	const loaded = await loadMentionController();
	try {
		const state = createHarness(loaded.module.MentionController);
		state.type("@src");
		state.controller.applyResults(1, "src", files);
		assert.equal(state.controller.isOpen, true);

		state.type("@src done");
		assert.equal(state.controller.isOpen, false);
		assert.equal(state.panel.hidden, true);
	} finally {
		await loaded.dispose();
	}
});
