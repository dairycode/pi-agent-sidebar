export type SelectKind = "model" | "thinking";

export interface SelectOption {
	value: string;
	label: string;
}

export interface SelectControllerOptions {
	popup: HTMLElement;
	triggers: Record<SelectKind, HTMLButtonElement>;
	getOptions: (kind: SelectKind) => readonly SelectOption[];
	getSelectedValue: (kind: SelectKind) => string;
	onCommit: (kind: SelectKind, value: string) => void;
	beforeOpen: () => void;
	position: (trigger: HTMLElement, popup: HTMLElement) => void;
	document?: Document;
}

/** Owns the model/thinking listbox lifecycle, focus, and keyboard navigation. */
export class SelectController {
	private readonly document: Document;
	private currentKind: SelectKind | undefined;

	public constructor(private readonly options: SelectControllerOptions) {
		this.document = options.document ?? document;
		for (const kind of ["model", "thinking"] as const) {
			const trigger = options.triggers[kind];
			trigger.addEventListener("click", () => this.toggle(kind));
			trigger.addEventListener("keydown", (event) => {
				if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
				event.preventDefault();
				if (this.currentKind !== kind) this.open(kind);
			});
		}
		options.popup.addEventListener("click", (event) => {
			if (!this.currentKind || !(event.target instanceof HTMLElement)) return;
			const value =
				event.target.closest<HTMLElement>(".select-option")?.dataset.value;
			if (value !== undefined) this.commit(this.currentKind, value);
		});
		options.popup.addEventListener("keydown", (event) =>
			this.handlePopupKeydown(event),
		);
	}

	public get activeKind(): SelectKind | undefined {
		return this.currentKind;
	}

	public trigger(kind: SelectKind): HTMLButtonElement {
		return this.options.triggers[kind];
	}

	public toggle(kind: SelectKind): void {
		if (this.currentKind === kind) this.close(true);
		else this.open(kind);
	}

	public open(kind: SelectKind): void {
		const trigger = this.trigger(kind);
		if (trigger.disabled) return;
		const options = this.options.getOptions(kind);
		if (options.length === 0) return;
		if (this.currentKind) this.close(false);
		this.options.beforeOpen();
		this.currentKind = kind;

		const current = this.options.getSelectedValue(kind);
		const rows = options.map((option) => {
			const row = this.document.createElement("div");
			row.className = "select-option";
			row.setAttribute("role", "option");
			row.tabIndex = -1;
			row.dataset.value = option.value;
			const selected = option.value === current;
			row.setAttribute("aria-selected", String(selected));
			const check = this.document.createElement("i");
			check.className = `codicon codicon-check select-option-check${
				selected ? "" : " is-hidden"
			}`;
			check.setAttribute("aria-hidden", "true");
			const label = this.document.createElement("span");
			label.className = "select-option-label";
			label.textContent = option.label;
			row.append(check, label);
			return row;
		});

		this.options.popup.replaceChildren(...rows);
		this.options.popup.classList.toggle("is-thinking", kind === "thinking");
		this.options.popup.hidden = false;
		trigger.setAttribute("aria-expanded", "true");
		this.reposition();
		this.focusOption(
			rows.find((row) => row.getAttribute("aria-selected") === "true") ??
				rows[0],
		);
	}

	public close(restoreFocus: boolean): void {
		const kind = this.currentKind;
		this.currentKind = undefined;
		this.options.popup.hidden = true;
		this.options.popup.replaceChildren();
		if (!kind) return;
		const trigger = this.trigger(kind);
		trigger.setAttribute("aria-expanded", "false");
		if (restoreFocus) trigger.focus();
	}

	public syncSelected(): void {
		const kind = this.currentKind;
		if (!kind) return;
		const current = this.options.getSelectedValue(kind);
		for (const row of this.options.popup.querySelectorAll<HTMLElement>(
			".select-option",
		)) {
			const selected = row.dataset.value === current;
			row.setAttribute("aria-selected", String(selected));
			row
				.querySelector(".select-option-check")
				?.classList.toggle("is-hidden", !selected);
		}
	}

	public reposition(): void {
		const kind = this.currentKind;
		if (!kind) return;
		this.options.position(this.trigger(kind), this.options.popup);
	}

	private commit(kind: SelectKind, value: string): void {
		const unchanged = value === this.options.getSelectedValue(kind);
		this.close(true);
		if (!unchanged) this.options.onCommit(kind, value);
	}

	private focusOption(row: HTMLElement | undefined): void {
		if (!row) return;
		row.focus();
		row.scrollIntoView({ block: "nearest" });
	}

	private handlePopupKeydown(event: KeyboardEvent): void {
		const kind = this.currentKind;
		if (!kind) return;
		const rows = [
			...this.options.popup.querySelectorAll<HTMLElement>(".select-option"),
		];
		if (rows.length === 0) return;
		const index = rows.findIndex((row) => row === this.document.activeElement);
		if (event.key === "Escape" || event.key === "Tab") {
			event.preventDefault();
			this.close(true);
			return;
		}
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			const value = rows[index]?.dataset.value;
			if (value !== undefined) this.commit(kind, value);
			return;
		}
		let next = -1;
		if (event.key === "ArrowDown") next = Math.min(rows.length - 1, index + 1);
		else if (event.key === "ArrowUp") next = Math.max(0, index - 1);
		else if (event.key === "Home") next = 0;
		else if (event.key === "End") next = rows.length - 1;
		if (next < 0) return;
		event.preventDefault();
		this.focusOption(rows[next]);
	}
}
