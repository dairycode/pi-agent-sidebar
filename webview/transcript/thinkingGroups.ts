import type { PiContentBlock } from "../../shared/protocol.js";

/**
 * One rendered reasoning section: a run of thinking blocks shown as a single
 * expandable block.
 *
 * Some models report reasoning as a series of summary parts, and pi passes each
 * part through as its own `thinking` content block. Drawn one-to-one, a single
 * answer's reasoning became a stack of collapsed "Thinking" rows — one per part,
 * each only a few lines of headline — and the reader's expand/collapse choice
 * was scattered across all of them. The blocks themselves stay untouched; this
 * only says which of them the transcript draws as one section.
 */
export interface ThinkingGroup {
	/** Content index of the run's first block; also its section's `thinking-N` key index. */
	readonly startIndex: number;
	/** Content index one past the run's last thinking block. */
	readonly endIndex: number;
	/** The run's thinking blocks, in message order. */
	readonly blocks: readonly PiContentBlock[];
	/** Non-empty parts joined by a blank line when the section is expanded. */
	readonly text: string;
}

/**
 * Groups a message's blocks into reasoning sections.
 *
 * Only blank text blocks may sit inside a run: pi sometimes emits one between
 * reasoning and prose, and a block that renders as nothing must not split a
 * section the reader sees as one. Anything visible — prose, a tool call, an
 * image — ends the run, since the sections between them are what keeps the
 * activity timeline in order.
 */
export function thinkingGroups(
	blocks: readonly PiContentBlock[],
): ThinkingGroup[] {
	const groups: ThinkingGroup[] = [];
	let run: PiContentBlock[] = [];
	let startIndex = 0;
	let endIndex = 0;
	const endRun = (): void => {
		if (run.length === 0) return;
		const groupBlocks = run;
		let text: string | undefined;
		groups.push({
			startIndex,
			endIndex,
			blocks: groupBlocks,
			get text() {
				if (text === undefined) text = thinkingGroupText(groupBlocks);
				return text;
			},
		});
		run = [];
	};
	for (const [index, block] of blocks.entries()) {
		if (block.type === "thinking") {
			if (run.length === 0) startIndex = index;
			run.push(block);
			endIndex = index + 1;
			continue;
		}
		if (run.length > 0 && isBlankTextBlock(block)) continue;
		endRun();
	}
	endRun();
	return groups;
}

/**
 * The `thinking-N` index of the section that holds the given thinking block
 * ordinal.
 *
 * The ordinal counts every thinking block, later members of a run included —
 * that is the counting a streaming delta's `contentIndex` accounting sees. All
 * members of a run have to resolve to the same index: the transcript keys one
 * disclosure state per section, and one animation state per section, so a
 * member keyed by its own ordinal would expand or animate on its own inside a
 * section that is drawn as a whole.
 */
// Pi replaces content arrays for each delta, so this structural cache stays valid.
const groupKeyIndices = new WeakMap<
	readonly PiContentBlock[],
	readonly number[]
>();

export function thinkingGroupKeyIndex(
	blocks: readonly PiContentBlock[],
	thinkingIndex: number,
): number {
	let indices = groupKeyIndices.get(blocks);
	if (!indices) {
		const computed: number[] = [];
		let ordinal = 0;
		let groupStart = 0;
		let isInRun = false;
		for (const block of blocks) {
			if (block.type === "thinking") {
				if (!isInRun) groupStart = ordinal;
				computed.push(groupStart);
				ordinal += 1;
				isInRun = true;
			} else if (!isBlankTextBlock(block)) {
				isInRun = false;
			}
		}
		indices = computed;
		groupKeyIndices.set(blocks, indices);
	}
	// The message does not hold that block yet. Keying it by its own ordinal
	// keeps it from sharing a section with a block it never arrived after.
	return indices[thinkingIndex] ?? thinkingIndex;
}

/** Parts are joined with a blank line: each one is already a block of headline. */
const GROUP_SEPARATOR = "\n\n";

/**
 * The text of one section.
 *
 * Empty parts are left out rather than joined in place, which keeps the text
 * append-only while a delta fills the block that is streaming: an empty part
 * contributes no separator, so a part that becomes non-empty extends the text
 * at its end instead of inserting a blank line in the middle of it.
 */
function thinkingGroupText(blocks: readonly PiContentBlock[]): string {
	const parts: string[] = [];
	for (const block of blocks) {
		const text = block.thinking ?? "";
		if (text.trim().length > 0) parts.push(text);
	}
	return parts.join(GROUP_SEPARATOR);
}

function isBlankTextBlock(block: PiContentBlock): boolean {
	return block.type === "text" && (block.text ?? "").trim().length === 0;
}
