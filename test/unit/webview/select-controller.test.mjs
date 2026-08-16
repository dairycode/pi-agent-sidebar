import assert from "node:assert/strict";
import test from "node:test";
import { loadBundledModule } from "../../helpers/load-bundled-module.mjs";


async function loadSelectController() {
	return loadBundledModule({
		entry: "webview/ui/selectController.ts",
		name: "select-controller",
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
		this.parent = undefined;
		this.listeners = new Map();
		this.attributes = new Map();
		this.dataset = {};
		this.className = "";
		this.classList = new FakeClassList(this);
		this.hidden = true;
		this.disabled = false;
		this.tabIndex = 0;
		this.textContent = "";
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
		for (const child of children) child.parent = this;
		this.children.push(...children);
	}

	replaceChildren(...children) {
		for (const child of children) child.parent = this;
		this.children = [...children];
	}

	setAttribute(name, value) {
		this.attributes.set(name, value);
	}

	getAttribute(name) {
		return this.attributes.get(name) ?? null;
	}

	focus() {
		this.document.activeElement = this;
	}

	scrollIntoView() {
		this.scrolled = true;
	}

	closest(selector) {
		let current = this;
		while (current) {
			if (matches(current, selector)) return current;
			current = current.parent;
		}
		return null;
	}

	querySelector(selector) {
		return this.querySelectorAll(selector)[0] ?? null;
	}

	querySelectorAll(selector) {
		const result = [];
		const visit = (element) => {
			for (const child of element.children) {
				if (matches(child, selector)) result.push(child);
				visit(child);
			}
		};
		visit(this);
		return result;
	}
}

function matches(element, selector) {
	return selector.startsWith(".")
		? element.classList.contains(selector.slice(1))
		: element.tagName.toLowerCase() === selector.toLowerCase();
}

class FakeDocument {
	constructor() {
		this.activeElement = null;
	}

	createElement(tagName) {
		return new FakeElement(tagName, this);
	}
}

function createHarness(SelectController) {
	const document = new FakeDocument();
	globalThis.HTMLElement = FakeElement;
	const popup = document.createElement("div");
	const triggers = {
		model: document.createElement("button"),
		thinking: document.createElement("button"),
	};
	const selected = { model: "anthropic/claude", thinking: "medium" };
	const options = {
		model: [
			{ value: "anthropic/claude", label: "Claude" },
			{ value: "openai/family/gpt", label: "GPT" },
		],
		thinking: [
			{ value: "off", label: "off" },
			{ value: "medium", label: "medium" },
		],
	};
	const commits = [];
	const events = [];
	const controller = new SelectController({
		popup,
		triggers,
		getOptions: (kind) => options[kind],
		getSelectedValue: (kind) => selected[kind],
		onCommit: (kind, value) => commits.push({ kind, value }),
		beforeOpen: () => events.push("beforeOpen"),
		position: (trigger, positionedPopup) =>
			events.push({ trigger, popup: positionedPopup }),
		document,
	});
	return {
		controller,
		document,
		popup,
		triggers,
		selected,
		options,
		commits,
		events,
	};
}

function cleanup() {
	delete globalThis.HTMLElement;
}

test("opening selects the current row and closing restores trigger focus", async () => {
	const loaded = await loadSelectController();
	try {
		const state = createHarness(loaded.module.SelectController);
		state.triggers.model.dispatch("click");
		const rows = state.popup.querySelectorAll(".select-option");
		assert.equal(state.controller.activeKind, "model");
		assert.equal(state.popup.hidden, false);
		assert.equal(state.triggers.model.getAttribute("aria-expanded"), "true");
		assert.equal(rows.length, 2);
		assert.equal(rows[0].getAttribute("aria-selected"), "true");
		assert.equal(state.document.activeElement, rows[0]);
		assert.equal(rows[0].scrolled, true);
		assert.deepEqual(state.events, [
			"beforeOpen",
			{ trigger: state.triggers.model, popup: state.popup },
		]);

		state.popup.dispatch("click", { target: rows[0].children[1] });
		assert.equal(state.controller.activeKind, undefined);
		assert.equal(state.popup.hidden, true);
		assert.equal(state.triggers.model.getAttribute("aria-expanded"), "false");
		assert.equal(state.document.activeElement, state.triggers.model);
		assert.deepEqual(state.commits, []);
	} finally {
		cleanup();
		await loaded.dispose();
	}
});

test("keyboard navigation commits the exact option value", async () => {
	const loaded = await loadSelectController();
	try {
		const state = createHarness(loaded.module.SelectController);
		state.controller.open("model");
		const rows = state.popup.querySelectorAll(".select-option");
		const end = state.popup.dispatch("keydown", { key: "End" });
		assert.equal(end.prevented, 1);
		assert.equal(state.document.activeElement, rows[1]);
		const enter = state.popup.dispatch("keydown", { key: "Enter" });
		assert.equal(enter.prevented, 1);
		assert.deepEqual(state.commits, [
			{ kind: "model", value: "openai/family/gpt" },
		]);
		assert.equal(state.document.activeElement, state.triggers.model);
	} finally {
		cleanup();
		await loaded.dispose();
	}
});

test("syncSelected updates rows in place without dropping focus", async () => {
	const loaded = await loadSelectController();
	try {
		const state = createHarness(loaded.module.SelectController);
		state.controller.open("thinking");
		const rows = state.popup.querySelectorAll(".select-option");
		const originalRows = [...rows];
		state.selected.thinking = "off";
		state.controller.syncSelected();
		assert.deepEqual(
			state.popup.querySelectorAll(".select-option"),
			originalRows,
		);
		assert.equal(rows[0].getAttribute("aria-selected"), "true");
		assert.equal(rows[1].getAttribute("aria-selected"), "false");
		assert.equal(
			rows[0]
				.querySelector(".select-option-check")
				.classList.contains("is-hidden"),
			false,
		);
		assert.equal(
			rows[1]
				.querySelector(".select-option-check")
				.classList.contains("is-hidden"),
			true,
		);
	} finally {
		cleanup();
		await loaded.dispose();
	}
});

test("disabled or empty selectors stay closed and Escape restores focus", async () => {
	const loaded = await loadSelectController();
	try {
		const state = createHarness(loaded.module.SelectController);
		state.triggers.model.disabled = true;
		state.controller.open("model");
		assert.equal(state.controller.activeKind, undefined);
		state.triggers.model.disabled = false;
		state.options.model.splice(0);
		state.controller.open("model");
		assert.equal(state.controller.activeKind, undefined);

		state.controller.open("thinking");
		assert.equal(state.popup.classList.contains("is-thinking"), true);
		const escape = state.popup.dispatch("keydown", { key: "Escape" });
		assert.equal(escape.prevented, 1);
		assert.equal(state.controller.activeKind, undefined);
		assert.equal(state.document.activeElement, state.triggers.thinking);
	} finally {
		cleanup();
		await loaded.dispose();
	}
});
