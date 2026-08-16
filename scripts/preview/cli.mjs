import os from "node:os";
import path from "node:path";
import { previewThemeKeys } from "./theme.mjs";

export function parsePreviewArgs(argv) {
	const options = {
		width: 380,
		height: 0,
		theme: "auto",
		state: "idle",
		out: path.join(os.tmpdir(), "pi-sidebar-preview.png"),
	};
	for (const arg of argv) {
		const match = /^--([a-z]+)=(.*)$/u.exec(arg);
		if (!match) continue;
		const [, key, value] = match;
		if (key === "width" || key === "height") options[key] = Number(value);
		else if (key in options) options[key] = value;
	}
	if (!Number.isFinite(options.width) || options.width < 120) {
		throw new Error("--width must be a number >= 120");
	}
	if (options.theme !== "auto" && !previewThemeKeys.includes(options.theme)) {
		throw new Error(
			`--theme must be one of: auto, ${previewThemeKeys.join(", ")}`,
		);
	}
	return options;
}
