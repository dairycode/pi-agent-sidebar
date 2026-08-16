export interface PopupPositionOptions {
	container: Pick<HTMLElement, "getBoundingClientRect">;
	popup: Pick<HTMLElement, "offsetWidth" | "style">;
	anchor: Pick<HTMLElement, "getBoundingClientRect">;
	gap?: number;
	minHeight?: number;
	viewportInset?: number;
}

/** Positions a popup above an anchor and clamps it inside its container. */
export function positionPopupAbove({
	container,
	popup,
	anchor,
	gap = 4,
	minHeight = 120,
	viewportInset = 8,
}: PopupPositionOptions): void {
	const containerRect = container.getBoundingClientRect();
	const anchorRect = anchor.getBoundingClientRect();
	popup.style.bottom = `${Math.round(containerRect.bottom - anchorRect.top + gap)}px`;
	popup.style.maxHeight = `${Math.max(
		minHeight,
		Math.round(anchorRect.top - containerRect.top - 12),
	)}px`;
	// Reset before measuring: offsetWidth has to be read at the popup's natural
	// width, not at whatever the previous placement left behind.
	popup.style.left = "0px";
	const left = Math.max(
		viewportInset,
		Math.min(
			Math.round(anchorRect.left - containerRect.left),
			Math.round(containerRect.width - popup.offsetWidth - viewportInset),
		),
	);
	popup.style.left = `${left}px`;
}
