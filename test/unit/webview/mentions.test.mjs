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
	const type = (value, caret = value.length) => {
		editor.value = value;
		editor.selectionStart = caret;
		editor.selectionEnd = caret;
		controller.sync();
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

test("selecting a directory rewrites the token and requests only its next level", async () => {
	const loaded = await loadMentionController();
	try {
		const state = createHarness(loaded.module.MentionController);
		state.type("inspect @");
		state.controller.applyResults(1, "", rootEntries);
		const rows = state.list.querySelectorAll(".mention-row");
		assert.equal(rows[0].classList.contains("is-directory"), true);
		assert.equal(rows[0].children[1].textContent, "src/");
		assert.equal(rows[0].children.length, 3, "folders include a chevron");

		assert.equal(
			state.controller.handleKeydown({ key: "Enter", preventDefault() {} }),
			true,
		);
		assert.equal(state.editor.value, "inspect @src/");
		assert.deepEqual(state.navigations, [
			{ directoryPath: "src", token: { start: 8, end: 9, query: "" } },
		]);
		assert.deepEqual(state.commits, []);
		assert.deepEqual(state.requests, [
			{ requestId: 1, query: "" },
			{ requestId: 2, query: "src/" },
		]);
		assert.deepEqual(state.announcements, ["Browsing src"]);
	} finally {
		await loaded.dispose();
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
