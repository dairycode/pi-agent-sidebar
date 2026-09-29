export interface PopupPositionOptions {
	container: Pick<HTMLElement, "getBoundingClientRect">;
	popup: Pick<HTMLElement, "offsetWidth" | "style">;
	anchor: Pick<HTMLElement, "getBoundingClientRect">;
	gap?: number;
	minHeight?: number;
	viewportInset?: number;
}

/** Which edge of the anchor a popup hangs off. */
type PopupEdge = "above" | "below";

function placePopup(options: PopupPositionOptions, edge: PopupEdge): void {
	const {
		container,
		popup,
		anchor,
		gap = 4,
		minHeight = 120,
		viewportInset = 8,
	} = options;
	const containerRect = container.getBoundingClientRect();
	const anchorRect = anchor.getBoundingClientRect();
	// Whichever side the popup opens on, it gets the room on that side and
	// scrolls past `minHeight` rather than collapsing into a sliver.
	if (edge === "above") {
		popup.style.bottom = `${Math.round(containerRect.bottom - anchorRect.top + gap)}px`;
		popup.style.maxHeight = `${Math.max(
			minHeight,
			Math.round(anchorRect.top - containerRect.top - 12),
		)}px`;
	} else {
		popup.style.top = `${Math.round(anchorRect.bottom - containerRect.top + gap)}px`;
		popup.style.maxHeight = `${Math.max(
			minHeight,
			Math.round(containerRect.bottom - anchorRect.bottom - 12),
		)}px`;
	}
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

/** Positions a popup above an anchor and clamps it inside its container. */
export function positionPopupAbove(options: PopupPositionOptions): void {
	placePopup(options, "above");
}

/** Positions a popup below an anchor and clamps it inside its container. */
export function positionPopupBelow(options: PopupPositionOptions): void {
	placePopup(options, "below");
}
