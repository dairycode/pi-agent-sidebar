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
		description: "Use subagents to gather context, then ask clarifying questions",
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

/**
 * A transcript exercising every rendered block type at once.
 *
 * The `--state=idle` default posts an empty message list, which is right for
 * inspecting the composer but shows none of the transcript: reviewing spacing,
 * fonts, or tool colours against it is impossible. This sample carries a user
 * turn, prose with headings and lists, inline and fenced code, reasoning, two
 * tool states plus an unsettled call, a skill card and an extension custom
 * message, so one screenshot covers the whole surface.
 *
 * Timestamps are fixed rather than derived from `Date.now()` so repeated runs
 * produce comparable images.
 */
const SAMPLE_MESSAGES = [
	{
		role: "user",
		timestamp: 1_756_000_000_000,
		content: [
			{
				type: "text",
				text: "Line up the composer toolbar controls and tell me what changed.",
			},
		],
	},
	// The `<skill>` payload pi inlines for a `/skill:name` invocation, plus the
	// arguments typed after it. Both cards in the customMessage family (this and
	// the extension message below) are border-carrying surfaces, so the preview
	// only covers the transcript's full shape if it renders one of each.
	{
		role: "user",
		timestamp: 1_756_000_010_000,
		content: [
			{
				type: "text",
				text: [
					'<skill name="brave-search" location="~/.pi/skills/brave-search/SKILL.md">',
					"# brave-search",
					"",
					"Search the web through the Brave Search API.",
					"",
					"## Usage",
					"",
					'Run `node scripts/search.mjs "<query>"` and cite the URLs it returns.',
					"</skill>",
					"",
					"What landed in pi-lens this week?",
				].join("\n"),
			},
		],
	},
	{
		role: "assistant",
		timestamp: 1_756_000_030_000,
		content: [
			{
				type: "thinking",
				thinking:
					"The toolbar mixes fixed and intrinsic widths, so the send button never lands on the same baseline as the pickers.",
			},
			{
				type: "toolCall",
				id: "call-read",
				name: "read",
				arguments: { path: "webview/styles/composer.css" },
			},
			{
				type: "toolCall",
				id: "call-edit",
				name: "edit",
				arguments: { path: "webview/styles/composer.css" },
			},
			// Long enough to overrun one line. A settled, expandable call this size is
			// the only coverage the collapsed one-line clip gets in the preview — and
			// the only place the pinned hint and spill of the clipped header can be
			// seen to share a line.
			{
				type: "toolCall",
				id: "call-bash",
				name: "bash",
				arguments: {
					command: 'npm run typecheck 2>&1 | grep -E "error TS" | head -20',
				},
			},
			// Deliberately without a matching result below: a call that has not
			// settled wears the same green as a settled one — the spinner is what
			// says it is still running — and it is the base `.tool-call` rule
			// rather than a modifier class. Its header overruns the line too, which
			// is the point: a collapsed box clips from its first frame, before there
			// is anything to expand, so the preview holds a one-line box whose
			// clipped command lives only in its `title` and in the DOM.
			{
				type: "toolCall",
				id: "call-grep",
				name: "grep",
				arguments: { pattern: "inputPadding|control-size|send-button" },
			},
			{
				type: "text",
				text:
					"## What changed\n\nThe toolbar now shares one control size, so `--pi-control-size` is the only knob:\n\n- pickers and icon buttons resolve to the same box\n- the send button stops setting the row height\n- a narrow sidebar wraps instead of clipping\n\n```css\n.composer-toolbar {\n\tdisplay: flex;\n\talign-items: center;\n\tgap: 4px; /* one grid step */\n}\n```\n\nTypecheck passes; see the failing lint run above for the unrelated `find` call.",
			},
		],
	},
	// Every preview run renders one diagram: the mermaid bundle is a separate
	// script behind a CSP nonce, so a change that breaks the injection, the
	// sanitizer, or the diagram's own styling has to fail here rather than only in
	// a real sidebar.
	{
		role: "assistant",
		timestamp: 1_756_000_034_000,
		content: [
			{
				type: "text",
				text:
					"## Diagram\n\nA mermaid fence renders as a diagram, with the source kept one click away:\n\n```mermaid\nflowchart LR\n  prompt[Ask a question with a label long enough to wrap] --> runtime{pi}\n  runtime -->|edits| files[(files)]\n  runtime -->|answers| transcript[first line<br/>second line]\n```\n\nA diagram keeps its natural width and the frame scrolls, because a 900px flowchart scaled into a 300px column is unreadable at any zoom.",
			},
		],
	},
	// A `role: "custom"` entry, which is what an extension's own output reaches
	// the transcript as. Shares the skill card's surface and border.
	{
		role: "custom",
		timestamp: 1_756_000_040_000,
		content: [
			{
				type: "text",
				text:
					"**pi-lens** re-indexed 214 files in 0.8s.\n\n3 rules skipped: `no-floating-promises` is not configured for this workspace.",
			},
		],
	},
];

// Every preview run carries one diagram, so this sample is the preview's only
// coverage of the feature. A fence that goes missing here would leave the
// browser-side check with nothing to check, and the browser side cannot report
// that: it may run before the transcript renders at all.
if (!JSON.stringify(SAMPLE_MESSAGES).includes("```mermaid")) {
	throw new Error(
		"The preview sample lost its mermaid fence, so no preview run renders a diagram.",
	);
}

const SAMPLE_TOOL_RESULTS = [
	{
		role: "toolResult",
		toolCallId: "call-read",
		timestamp: 1_756_000_031_000,
		content: [{ type: "text", text: "560 lines read from composer.css" }],
	},
	{
		role: "toolResult",
		toolCallId: "call-edit",
		timestamp: 1_756_000_032_000,
		content: [{ type: "text", text: "Applied 1 edit" }],
		details: {
			diff:
				"@@ -12,6 +12,7 @@\n .composer-toolbar {\n \tdisplay: flex;\n+\talign-items: center;\n-\tgap: 6px;\n+\tgap: 4px;\n }",
		},
	},
	{
		role: "toolResult",
		toolCallId: "call-bash",
		timestamp: 1_756_000_033_000,
		isError: true,
		content: [
			{
				type: "text",
				text:
					"webview/main.ts(214,9): error TS2554: Expected 2 arguments, but got 1.",
			},
		],
	},
];

export function themeAssertScript() {
	return `
window.__validatePreviewTheme = () => {
	const root = document.documentElement;
	const applied = getComputedStyle(root)
		.getPropertyValue("--vscode-font-size").trim();
	const parseColor = (value) => {
		const numbers = value.match(/[0-9.]+/gu)?.map(Number) ?? [];
		if (value.startsWith("color(srgb") && numbers.length >= 3) {
			return [numbers[0] * 255, numbers[1] * 255, numbers[2] * 255, numbers[3] ?? 1];
		}
		if (value.startsWith("rgb") && numbers.length >= 3) {
			return [numbers[0], numbers[1], numbers[2], numbers[3] ?? 1];
		}
		return undefined;
	};
	const control = document.querySelector("#attach-button");
	const composer = document.querySelector("#composer");
	const controlStyle = getComputedStyle(control);
	const borderText = controlStyle.borderTopColor;
	const backgroundText = getComputedStyle(composer).backgroundColor;
	root.dataset.previewControlBorder = borderText;
	root.dataset.previewComposerBackground = backgroundText;

	if (!applied) {
		root.dataset.previewError = "Theme stylesheet did not apply";
		return;
	}
	const border = parseColor(borderText);
	const background = parseColor(backgroundText);
	if (!border || !background) {
		root.dataset.previewError = "Could not validate preview colors";
		return;
	}
	const blended = border.slice(0, 3).map(
		(channel, index) => channel * border[3] + background[index] * (1 - border[3]),
	);
	const channelDelta = Math.max(
		...blended.map((channel, index) => Math.abs(channel - background[index])),
	);
	if (
		controlStyle.borderTopStyle === "none" ||
		Number.parseFloat(controlStyle.borderTopWidth) === 0 ||
		channelDelta < 6
	) {
		root.dataset.previewError = "Toolbar border is indistinguishable from its background";
	}
};
`;
}

export function bootstrapScript(state) {
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
	messages: ${JSON.stringify([...SAMPLE_MESSAGES, ...SAMPLE_TOOL_RESULTS])},
	stats: { cost: 0.482, contextUsage: { percent: 32 } },
	models: [{ id: "claude-opus-5", name: "Claude Opus 5", provider: "anthropic" }],
	thinkingLevels: ["off", "low", "medium", "high", "xhigh"],
	commands: ${JSON.stringify(SAMPLE_COMMANDS)},
	workspaceName: "pi-agent-sidebar",
};
const post = (message) => window.postMessage(message, "*");
post(snapshot);
post({ type: "connection", phase: "ready" });

// A throwing check aborts the deferred body before it can mark the document
// ready, which on its own tells the caller only that nothing rendered. The
// harness reads data-preview-error before the ready flag, so recording the
// message here is what turns a failed check into a readable one.
window.addEventListener("error", (event) => {
	document.documentElement.dataset.previewError = String(event.message);
});

// Rendering is queued through requestAnimationFrame, so interactions wait
// for it. dump-dom with virtual-time-budget does not reliably advance rAF
// frames (virtual time only moves while tasks are pending, so the second
// frame of a double rAF often never runs), but setTimeout is deterministic
// under virtual time — chain two zero timers instead.
setTimeout(() => setTimeout(() => {
	const state = ${JSON.stringify(state)};
	if (state === "history") {
		document.querySelector("#history-button").click();
		// Host→webview messages are delivered synchronously here: a plain
		// window.postMessage task may never run inside Chrome's virtual-time
		// budget. Delivered after the click, which is what puts the list's
		// "Loading..." placeholder in place — exactly the reply order of the
		// real host.
		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					type: "sessionList",
					sessions: [
						{
							path: "/tmp/active",
							title: "Line up the composer toolbar controls",
							excerpt: "justify-content — aligned it and...",
							createdAt: "2026-01-08T14:00:00.000Z",
							lastActivityAt: "2026-01-08T14:06:30.000Z",
							active: true,
						},
						{
							path: "/tmp/older",
							title: "Session 11 — rename list actions",
							excerpt: "found the grid column bug...",
							createdAt: "2026-01-08T14:00:00.000Z",
							lastActivityAt: "2026-01-08T14:06:30.000Z",
							active: false,
						},
						{
							path: "/tmp/oldest",
							title: "Session 5 — theme check",
							excerpt: "light mode contrast...",
							createdAt: "2026-01-01T10:00:00.000Z",
							lastActivityAt: "2026-01-01T10:30:00.000Z",
							active: false,
						},
					],
				},
			}),
		);
	}
	if (state === "palette") document.querySelector("#command-button").click();
	if (state === "menu") {
		const trigger = document.querySelector("#session-menu-button");
		const menu = document.querySelector("#session-menu");
		const items = () => Array.from(menu.querySelectorAll(".menu-item"));
		const press = (target, key) =>
			target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

		trigger.click();
		if (menu.hidden) throw new Error("The session menu did not open");
		if (trigger.getAttribute("aria-expanded") !== "true") {
			throw new Error("The session menu trigger did not report its state");
		}
		if (items().length !== 2) {
			throw new Error(
				"Expected the session menu to hold 2 items, got " + items().length,
			);
		}
		if (document.activeElement !== items()[0]) {
			throw new Error("Opening the session menu did not focus its first item");
		}
		// Arrow keys walk the items: the pattern a role="menu" promises.
		press(items()[0], "ArrowDown");
		if (document.activeElement !== items()[1]) {
			throw new Error("ArrowDown did not move to the second item");
		}
		press(items()[1], "ArrowUp");
		if (document.activeElement !== items()[0]) {
			throw new Error("ArrowUp did not move back to the first item");
		}
		// Home and End jump rather than step: the other half of what the role="menu"
		// pattern promises, and what the composer's pickers already answer.
		press(items()[0], "End");
		if (document.activeElement !== items().at(-1)) {
			throw new Error("End did not jump to the last session menu item");
		}
		press(items().at(-1), "Home");
		if (document.activeElement !== items()[0]) {
			throw new Error("Home did not jump back to the first session menu item");
		}
		// Escape closes the menu and hands focus back to the trigger, because an item
		// lives inside a popup that is about to disappear.
		press(items()[0], "Escape");
		if (!menu.hidden || document.activeElement !== trigger) {
			throw new Error("Escape did not close the session menu onto its trigger");
		}
		// The picker the fork item opens outlives the menu, and its own Escape has to
		// land somewhere real: the item it came from is hidden by then.
		trigger.click();
		items()[1].click();
		const panel = document.querySelector("#fork-panel");
		if (panel.hidden) throw new Error("The fork item did not open the picker");
		if (menu.hidden === false) {
			throw new Error("The session menu stayed open under the fork picker");
		}
		press(document.querySelector("#fork-search"), "Escape");
		if (!panel.hidden || document.activeElement !== trigger) {
			throw new Error(
				"Closing the fork picker did not return focus to the menu trigger",
			);
		}
		// Committing to a row is the picker's other exit, and it owes the same
		// handover: the picker is gone by the time the fork is sent, and the item it
		// was opened from went with the menu.
		trigger.click();
		items()[1].click();
		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					type: "forkCandidates",
					candidates: [
						{
							entryId: "entry-toolbar",
							text: "Line up the composer toolbar controls",
							timestamp: 1767880800000,
						},
					],
				},
			}),
		);
		const forkRow = document.querySelector("#fork-list .fork-row");
		if (!forkRow) {
			throw new Error("The fork picker did not render the candidates it was sent");
		}
		forkRow.click();
		if (!panel.hidden) throw new Error("Picking a fork entry left the picker open");
		if (document.activeElement !== trigger) {
			throw new Error("Submitting a fork did not return focus to the menu trigger");
		}
		// Reopened, which is the state this screenshot is for.
		trigger.click();
		// The one popup anchored near the top of the sidebar, so it is the one that
		// has to open downwards and stay on screen: an above-placement would clamp to
		// the space over the header and hang the menu off the top edge.
		const triggerBox = trigger.getBoundingClientRect();
		const menuBox = menu.getBoundingClientRect();
		if (
			menuBox.top < triggerBox.bottom ||
			menuBox.bottom > window.innerHeight ||
			menuBox.right > window.innerWidth
		) {
			throw new Error("The session menu did not open below its trigger");
		}
	}
	if (state === "select") {
		// The picker the header menu now shares its surface with: if the shared
		// popup-surface class stopped reaching it, the panel would lose its
		// placement and its frame at once, and every composer turn would show it.
		document.querySelector("#model-select").click();
		const popup = document.querySelector("#select-popup");
		if (popup.hidden) throw new Error("The model picker did not open");
		const style = getComputedStyle(popup);
		if (style.position !== "absolute" || style.backgroundColor === "rgba(0, 0, 0, 0)") {
			throw new Error("The model picker lost its popup surface");
		}
	}
	if (state === "typing") {
		const input = document.querySelector("#prompt-input");
		input.value = "Refactor the composer toolbar so the controls line up";
		input.dispatchEvent(new Event("input", { bubbles: true }));
	}
	if (state === "reference") {
		post({
			type: "composerReferences",
			references: [{
				kind: "file",
				id: "preview-file",
				revision: 0,
				marker: "@src/provider/piViewProvider.ts",
				displayPath: "src/provider/piViewProvider.ts",
			}],
		});
	}
	if (state === "drop") {
		const transfer = new DataTransfer();
		transfer.setData(
			"ResourceURLs",
			JSON.stringify(["file:///workspace/src/provider/piViewProvider.ts"]),
		);
		document.querySelector("#session-header").dispatchEvent(
			new DragEvent("dragenter", {
				bubbles: true,
				dataTransfer: transfer,
			}),
		);
		if (document.querySelector("#resource-drop-overlay").hidden) {
			throw new Error("Full-sidebar resource drag did not activate the overlay");
		}
	}
	// Enter means "send" when pi is idle and "steer" mid-run, so both hover
	// states are previewable: the labels differ between them.
	if (state === "send-hint" || state === "send-hint-busy") {
		const busy = state === "send-hint-busy";
		if (busy) {
			// Delivered synchronously for the same reason as the session list above:
			// a queued postMessage task may never run inside the virtual-time budget.
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "rpcEvent", event: { type: "agent_start" } },
				}),
			);
		}
		document.querySelector("#send-button").dispatchEvent(
			new PointerEvent("pointerenter", { bubbles: false }),
		);
		const hint = document.querySelector("#send-hint");
		if (hint.hidden) throw new Error("Hovering the send button did not open the hint");
		const text = hint.textContent;
		if (!text.includes("follow-up")) {
			throw new Error("Send hint does not name the follow-up shortcut");
		}
		// A plain Enter steers mid-run and sends outright when idle; the hint must
		// name one and not the other.
		const expected = busy ? "steer" : "send";
		const forbidden = busy ? "send" : "steer";
		if (!text.includes(expected) || text.includes(forbidden)) {
			throw new Error(
				"Send hint should say '" + expected + "' and not '" + forbidden + "', got: " + text,
			);
		}
	}
	window.__validatePreviewTheme();
	// A diagram is deliberately not asserted here. It needs a frame (the render
	// starts when the block is near the viewport) and then a fetch of the mermaid
	// bundle, and a virtual-time run produces neither — the screenshot would show
	// source whether or not the feature works. What is synchronous, and what this
	// harness can hold to, is that the fence was recognised: a fence left in the
	// transcript outside a diagram block is a rendering bug the screenshot alone
	// would not distinguish from "the diagram is still loading".
	const mermaidFences = document.querySelectorAll("code.language-mermaid").length;
	// Counted and conditional. The transcript is rendered through
	// requestAnimationFrame, which a virtual-time run does not reliably advance, so
	// this callback can find no messages at all — and a check that demands a fence
	// would then fail for a reason that has nothing to do with diagrams. What is
	// true either way: a fence that did reach the DOM belongs inside a diagram
	// block. That the sample still has a fence is asserted in Node, where the sample
	// is data rather than a race.
	const unwrapped = Array.from(
		document.querySelectorAll("code.language-mermaid"),
	).filter((fence) => !fence.closest(".mermaid-block")).length;
	if (unwrapped > 0) {
		document.documentElement.dataset.previewError =
			"A mermaid fence stayed in the transcript (" + unwrapped + " of " + mermaidFences + ")";
	} else if (document.querySelector(".mermaid-diagram svg")) {
		document.documentElement.dataset.previewMermaid = "rendered";
	}
	document.documentElement.dataset.previewReady = "true";
}, 0), 0);
`;
}
