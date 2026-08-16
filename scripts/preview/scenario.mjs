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
		description:
			"Use subagents to gather context, then ask clarifying questions",
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
	messages: [],
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
	window.__validatePreviewTheme();
	document.documentElement.dataset.previewReady = "true";
}, 0), 0);
`;
}
