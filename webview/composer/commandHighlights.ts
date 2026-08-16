export interface CommandHighlightRange {
	start: number;
	end: number;
}

/**
 * Finds complete slash commands that pi currently reports as available.
 *
 * Commands are recognized only at the start of a line. The highlighted range
 * ends at the first whitespace, so arguments remain ordinary composer text.
 */
export function commandHighlightRanges(
	text: string,
	commandNames: Iterable<string>,
): CommandHighlightRange[] {
	const available = new Set(commandNames);
	if (text.length === 0 || available.size === 0) return [];

	const ranges: CommandHighlightRange[] = [];
	let lineStart = 0;
	for (const line of text.split("\n")) {
		if (line.startsWith("/")) {
			const token = line.match(/^\/\S*/u)?.[0] ?? "";
			const name = token.slice(1);
			if (available.has(name)) {
				ranges.push({ start: lineStart, end: lineStart + token.length });
			}
		}
		lineStart += line.length + 1;
	}
	return ranges;
}
