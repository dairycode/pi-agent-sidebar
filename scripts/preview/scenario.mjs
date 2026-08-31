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
 * turn, prose with headings and lists, inline and fenced code, reasoning, and
 * all three tool states, so one screenshot covers the whole surface.
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
			{
				type: "toolCall",
				id: "call-bash",
				name: "bash",
				arguments: { command: "npm run typecheck" },
			},
			{
				type: "text",
				text:
					"## What changed\n\nThe toolbar now shares one control size, so `--pi-control-size` is the only knob:\n\n- pickers and icon buttons resolve to the same box\n- the send button stops setting the row height\n- a narrow sidebar wraps instead of clipping\n\n```css\n.composer-toolbar {\n\tdisplay: flex;\n\talign-items: center;\n\tgap: 4px; /* one grid step */\n}\n```\n\nTypecheck passes; see the failing lint run above for the unrelated `find` call.",
			},
		],
	},
];

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
	document.documentElement.dataset.previewReady = "true";
}, 0), 0);
`;
}
