import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const THEMES = {
	dark: {
		"font-family": "-apple-system, BlinkMacSystemFont, sans-serif",
		"font-size": "13px",
		"editor-font-family": "Menlo, monospace",
		"editor-font-size": "12px",
		foreground: "#cccccc",
		descriptionForeground: "#9d9d9d",
		errorForeground: "#f85149",
		focusBorder: "#0078d4",
		"editor-background": "#1f1f1f",
		"sideBar-background": "#181818",
		"input-background": "#313131",
		"input-foreground": "#cccccc",
		"input-placeholderForeground": "#989898",
		"editorWidget-background": "#202020",
		"widget-shadow": "rgba(0, 0, 0, 0.36)",
		"panel-border": "#2b2b2b",
		"widget-border": "#454545",
		"list-hoverBackground": "#2a2d2e",
		"list-inactiveSelectionForeground": "#cccccc",
		"toolbar-hoverBackground": "#383b3d",
		"textLink-foreground": "#4daafc",
		"textCodeBlock-background": "#2b2b2b",
		"textPreformat-foreground": "#d7ba7d",
		"scrollbarSlider-background": "rgba(121, 121, 121, 0.4)",
		"button-secondaryBackground": "#313131",
		"button-secondaryForeground": "#cccccc",
		"button-secondaryHoverBackground": "#3c3c3c",
		"editorWarning-foreground": "#cca700",
		"notifications-foreground": "#cccccc",
		"testing-iconPassed": "#73c991",
	},
	"one-dark-pro-darker": {
		"font-family": "-apple-system, BlinkMacSystemFont, sans-serif",
		"font-size": "13px",
		"editor-font-family": "Menlo, monospace",
		"editor-font-size": "12px",
		foreground: "#abb2bf",
		descriptionForeground: "#abb2bf",
		errorForeground: "#c24038",
		focusBorder: "#3e4452",
		"editor-background": "#23272e",
		"sideBar-background": "#1e2227",
		"input-background": "#1d1f23",
		"input-foreground": "#abb2bf",
		"input-placeholderForeground": "#7f848e",
		"editorWidget-background": "#1e2227",
		"widget-shadow": "rgba(0, 0, 0, 0.36)",
		"panel-border": "#3e4452",
		// One Dark Pro does not define widget.border. Leaving it unset mirrors
		// VS Code and lets main.css fall back to panel.border.
		"list-hoverBackground": "#2c313a",
		"list-inactiveSelectionForeground": "#d7dae0",
		"toolbar-hoverBackground": "#2c313a",
		"textLink-foreground": "#61afef",
		"textCodeBlock-background": "#2c313c",
		"textPreformat-foreground": "#d19a66",
		"scrollbarSlider-background": "rgba(78, 86, 102, 0.38)",
		"button-secondaryBackground": "#30333d",
		"button-secondaryForeground": "#c0bdbd",
		"button-secondaryHoverBackground": "#404754",
		"editorWarning-foreground": "#d19a66",
		"notifications-foreground": "#abb2bf",
		"testing-iconPassed": "#98c379",
	},
	light: {
		"font-family": "-apple-system, BlinkMacSystemFont, sans-serif",
		"font-size": "13px",
		"editor-font-family": "Menlo, monospace",
		"editor-font-size": "12px",
		foreground: "#3b3b3b",
		descriptionForeground: "#3b3b3b99",
		errorForeground: "#cd3131",
		focusBorder: "#005fb8",
		"editor-background": "#ffffff",
		"sideBar-background": "#f8f8f8",
		"input-background": "#ffffff",
		"input-foreground": "#3b3b3b",
		"input-placeholderForeground": "#767676",
		"editorWidget-background": "#f8f8f8",
		"widget-shadow": "rgba(0, 0, 0, 0.16)",
		"panel-border": "#e5e5e5",
		"widget-border": "#d4d4d4",
		"list-hoverBackground": "#e8e8e8",
		"list-inactiveSelectionForeground": "#3b3b3b",
		"toolbar-hoverBackground": "#dddddd",
		"textLink-foreground": "#005fb8",
		"textCodeBlock-background": "#f2f2f2",
		"textPreformat-foreground": "#a31515",
		"scrollbarSlider-background": "rgba(100, 100, 100, 0.4)",
		"button-secondaryBackground": "#e5e5e5",
		"button-secondaryForeground": "#3b3b3b",
		"button-secondaryHoverBackground": "#cccccc",
		"editorWarning-foreground": "#bf8803",
		"notifications-foreground": "#3b3b3b",
		"testing-iconPassed": "#098658",
	},
};

export const previewThemeKeys = Object.freeze(Object.keys(THEMES));

async function configuredColorTheme() {
	const home = os.homedir();
	const candidates =
		process.platform === "darwin"
			? [
					path.join(
						home,
						"Library/Application Support/Code/User/settings.json",
					),
					path.join(
						home,
						"Library/Application Support/Code - Insiders/User/settings.json",
					),
				]
			: process.platform === "win32"
				? [path.join(process.env.APPDATA ?? "", "Code/User/settings.json")]
				: [path.join(home, ".config/Code/User/settings.json")];

	for (const candidate of candidates) {
		try {
			const settings = await readFile(candidate, "utf8");
			const match = /^\s*"workbench\.colorTheme"\s*:\s*"([^"]+)"/mu.exec(
				settings,
			);
			if (match) return match[1];
		} catch {
			// Try the next VS Code installation.
		}
	}
	return undefined;
}

export async function resolvePreviewTheme(requested) {
	if (requested !== "auto") return { key: requested, warning: undefined };

	const configured = await configuredColorTheme();
	const normalized = configured?.trim().toLowerCase();
	if (normalized === "one dark pro darker") {
		return { key: "one-dark-pro-darker", warning: undefined };
	}
	if (normalized === "dark modern" || normalized === "default dark modern") {
		return { key: "dark", warning: undefined };
	}
	if (normalized === "light modern" || normalized === "default light modern") {
		return { key: "light", warning: undefined };
	}

	const fallback = normalized?.includes("light") ? "light" : "dark";
	return {
		key: fallback,
		warning: configured
			? `No exact preview preset for VS Code theme "${configured}"; using the ${fallback} approximation.`
			: `Could not detect the VS Code color theme; using the ${fallback} approximation.`,
	};
}

export function previewStyle(theme, width) {
	const declarations = Object.entries(THEMES[theme])
		.map(([name, value]) => `  --vscode-${name}: ${value};`)
		.join("\n");
	return `:root {\n${declarations}\n}\n\nhtml, body {\n  width: ${width}px !important;\n  max-width: ${width}px !important;\n  overflow-x: hidden !important;\n}\n`;
}

