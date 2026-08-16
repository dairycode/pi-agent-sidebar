import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = process.cwd();

async function loadModalController() {
	const temporaryDirectory = await mkdtemp(
		path.join(os.tmpdir(), "pi-agent-modal-controller-test-"),
	);
	const output = path.join(temporaryDirectory, "bundle", "modal-controller.mjs");
	await mkdir(path.dirname(output), { recursive: true });
	await build({
		entryPoints: [path.join(root, "webview", "ui", "modalController.ts")],
		outfile: output,
		bundle: true,
		platform: "browser",
		format: "esm",
		target: "chrome120",
		logLevel: "silent",
	});
	return {
		module: await import(`${pathToFileURL(output).href}?v=${Date.now()}`),
		dispose: () => rm(temporaryDirectory, { recursive: true, force: true }),
	};
}

class FakeElement {
	constructor(tagName, document) {
		this.tagName = tagName.toUpperCase();
		this.document = document;
		this.children = [];
		this.listeners = new Map();
		this.attributes = new Map();
		this.hidden = false;
		this.inert = false;
		this.disabled = false;
		this.className = "";
		this.textContent = "";
		this.type = "";
		this.value = "";
		this.maxLength = -1;
		this.selected = false;
	}

	addEventListener(type, listener) {
		const listeners = this.listeners.get(type) ?? [];
		listeners.push(listener);
		this.listeners.set(type, listeners);
	}

	dispatch(type, fields = {}) {
		const event = {
			target: this,
			preventDefault() {},
			...fields,
		};
		for (const listener of this.listeners.get(type) ?? []) listener(event);
		return event;
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

	hasAttribute(name) {
		if (name === "disabled") return this.disabled;
		return this.attributes.has(name);
	}

	focus() {
		this.document.activeElement = this;
	}

	select() {
		this.selected = true;
	}

	querySelectorAll() {
		const result = [];
		const visit = (element) => {
			for (const child of element.children) {
				if (
					["BUTTON", "INPUT", "TEXTAREA", "SELECT"].includes(child.tagName) ||
					child.attributes.has("href") ||
					child.attributes.has("tabindex")
				) {
					result.push(child);
				}
				visit(child);
			}
		};
		visit(this);
		return result;
	}
}

class FakeDocument {
	constructor() {
		this.activeElement = null;
	}

	createElement(tagName) {
		return new FakeElement(tagName, this);
	}
}

function descendants(root) {
	const result = [];
	const visit = (element) => {
		for (const child of element.children) {
			result.push(child);
			visit(child);
		}
	};
	visit(root);
	return result;
}

function byText(root, text) {
	return descendants(root).find((element) => element.textContent === text);
}

function keyboardEvent(key, shiftKey = false) {
	let prevented = 0;
	return {
		key,
		shiftKey,
		preventDefault() {
			prevented += 1;
		},
		get prevented() {
			return prevented;
		},
	};
}

function createHarness(ModalController) {
	const document = new FakeDocument();
	globalThis.HTMLElement = FakeElement;
	const backdrop = document.createElement("div");
	backdrop.hidden = true;
	const inertRoots = Array.from({ length: 3 }, () =>
		document.createElement("section"),
	);
	const returnFocus = document.createElement("button");
	returnFocus.focus();
	const controller = new ModalController({ backdrop, inertRoots, document });
	return { controller, document, backdrop, inertRoots, returnFocus };
}

test("confirm modal owns inertness and restores focus before callback", async () => {
	const loaded = await loadModalController();
	try {
		const state = createHarness(loaded.module.ModalController);
		const observations = [];
		state.controller.openConfirm({
			title: "Delete session",
			message: "This cannot be undone.",
			confirmLabel: "Delete",
			destructive: true,
			onConfirm: () =>
				observations.push({
					open: state.controller.isOpen,
					focus: state.document.activeElement,
				}),
		});

		assert.equal(state.controller.isOpen, true);
		assert.ok(state.inertRoots.every((root) => root.inert));
		assert.equal(state.document.activeElement.textContent, "Cancel");
		const confirm = byText(state.backdrop, "Delete");
		assert.equal(confirm.className, "danger-button");
		confirm.dispatch("click");

		assert.equal(state.controller.isOpen, false);
		assert.ok(state.inertRoots.every((root) => !root.inert));
		assert.deepEqual(observations, [
			{ open: false, focus: state.returnFocus },
		]);
	} finally {
		delete globalThis.HTMLElement;
		await loaded.dispose();
	}
});

test("text prompt trims values and disables empty submission", async () => {
	const loaded = await loadModalController();
	try {
		const state = createHarness(loaded.module.ModalController);
		const submitted = [];
		state.controller.openTextPrompt({
			title: "Rename session",
			label: "Session name",
			initialValue: "",
			confirmLabel: "Rename",
			maxLength: 200,
			onSubmit: (value) => submitted.push(value),
		});
		const input = descendants(state.backdrop).find(
			(element) => element.tagName === "INPUT",
		);
		const confirm = byText(state.backdrop, "Rename");
		assert.equal(input.maxLength, 200);
		assert.equal(input.selected, true);
		assert.equal(confirm.disabled, true);

		input.value = "  New session name  ";
		input.dispatch("input");
		assert.equal(confirm.disabled, false);
		input.dispatch("keydown", { key: "Enter" });
		assert.deepEqual(submitted, ["New session name"]);
		assert.equal(state.controller.isOpen, false);
	} finally {
		delete globalThis.HTMLElement;
		await loaded.dispose();
	}
});

test("Escape and backdrop clicks close while inner clicks do not", async () => {
	const loaded = await loadModalController();
	try {
		const state = createHarness(loaded.module.ModalController);
		state.controller.openConfirm({
			title: "Confirm",
			message: "Continue?",
			confirmLabel: "Continue",
			onConfirm() {},
		});
		const dialog = state.backdrop.children[0];
		state.backdrop.dispatch("click", { target: dialog });
		assert.equal(state.controller.isOpen, true);

		const escape = keyboardEvent("Escape");
		state.controller.handleKeydown(escape);
		assert.equal(escape.prevented, 1);
		assert.equal(state.controller.isOpen, false);

		state.controller.openConfirm({
			title: "Confirm",
			message: "Continue?",
			confirmLabel: "Continue",
			onConfirm() {},
		});
		state.backdrop.dispatch("click", { target: state.backdrop });
		assert.equal(state.controller.isOpen, false);
	} finally {
		delete globalThis.HTMLElement;
		await loaded.dispose();
	}
});

test("Tab wraps focus within enabled modal controls", async () => {
	const loaded = await loadModalController();
	try {
		const state = createHarness(loaded.module.ModalController);
		state.controller.openConfirm({
			title: "Confirm",
			message: "Continue?",
			confirmLabel: "Continue",
			onConfirm() {},
		});
		const cancel = byText(state.backdrop, "Cancel");
		const confirm = byText(state.backdrop, "Continue");
		confirm.focus();
		const forward = keyboardEvent("Tab");
		state.controller.handleKeydown(forward);
		assert.equal(forward.prevented, 1);
		assert.equal(state.document.activeElement, cancel);

		const reverse = keyboardEvent("Tab", true);
		state.controller.handleKeydown(reverse);
		assert.equal(reverse.prevented, 1);
		assert.equal(state.document.activeElement, confirm);

		confirm.disabled = true;
		cancel.focus();
		const single = keyboardEvent("Tab");
		state.controller.handleKeydown(single);
		assert.equal(single.prevented, 1);
		assert.equal(state.document.activeElement, cancel);
	} finally {
		delete globalThis.HTMLElement;
		await loaded.dispose();
	}
});
