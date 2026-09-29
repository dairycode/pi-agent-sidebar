import type { PiContentBlock } from "./protocol.js";

/**
 * The text of a message's content, with non-text blocks (thinking, images, tool
 * calls) left out.
 *
 * Text blocks are joined with a newline: pi sends one block per paragraph-sized
 * unit, and every reader of this string — the transcript renderer, the submit
 * echo matcher, the session title — needs pi's own line structure rather than a
 * concatenation that would glue two blocks into one line.
 *
 * Shared rather than webview-local because the extension host reads it too: the
 * windowed snapshot derives the session title's seed from the first user message
 * (`parseMessagesWindow`), and a second copy of this rule would drift.
 */
export function contentText(content: unknown): string {
 if (typeof content === "string") return content;
 if (!Array.isArray(content)) return "";
 const parts: string[] = [];
 for (const value of content) {
  if (!value || typeof value !== "object") continue;
  const block = value as PiContentBlock;
  if (block.type === "text" && block.text) parts.push(block.text);
 }
 return parts.join("\n");
}
