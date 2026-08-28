export interface TextPromptOptions {
	title: string;
	label: string;
	initialValue: string;
	confirmLabel: string;
	onSubmit: (value: string) => void;
	maxLength?: number;
}

export interface ModalControllerOptions {
	backdrop: HTMLElement;
	inertRoots: readonly HTMLElement[];
	document?: Document;
}

const FOCUSABLE_SELECTOR =
	"button, [href], input, textarea, select, [tabindex]:not([tabindex='-1'])";

/** Owns modal DOM construction, focus trapping, and background inertness. */
export class ModalController {
	private readonly document: Document;
	private returnFocus: HTMLElement | null = null;

	public constructor(private readonly options: ModalControllerOptions) {
		this.document = options.document ?? document;
		options.backdrop.addEventListener("click", (event) => {
			if (event.target === options.backdrop) this.close();
		});
	}

	public get isOpen(): boolean {
		return !this.options.backdrop.hidden;
	}

	public openTextPrompt(options: TextPromptOptions): void {
		const dialog = this.createDialog(options.title);
		const heading = this.document.createElement("h2");
		heading.textContent = options.title;
		const input = this.document.createElement("input");
		input.type = "text";
		input.className = "modal-input";
		if (options.maxLength !== undefined) input.maxLength = options.maxLength;
		input.value = options.initialValue;
		input.setAttribute("aria-label", options.label);
		input.setAttribute("autocomplete", "off");
		const actions = this.document.createElement("div");
		actions.className = "modal-actions";
		const cancel = this.createButton("Cancel", "secondary-button");
		cancel.addEventListener("click", () => this.close());
		const confirm = this.createButton(options.confirmLabel, "primary-button");
		const submit = () => {
			const value = input.value.trim();
			if (!value || confirm.disabled) return;
			this.close();
			options.onSubmit(value);
		};
		const updateConfirm = () => {
			confirm.disabled = input.value.trim().length === 0;
		};
		confirm.addEventListener("click", submit);
		input.addEventListener("input", updateConfirm);
		input.addEventListener("keydown", (event) => {
			if (event.key === "Enter") submit();
		});
		updateConfirm();
		actions.append(cancel, confirm);
		dialog.append(heading, input, actions);
		this.open(dialog, input);
		input.select();
	}

	public close(): void {
		if (!this.isOpen) return;
		this.options.backdrop.hidden = true;
		this.options.backdrop.replaceChildren();
		this.setBackgroundInert(false);
		this.returnFocus?.focus();
		this.returnFocus = null;
	}

	public handleKeydown(event: KeyboardEvent): void {
		if (!this.isOpen) return;
		if (event.key === "Escape") {
			event.preventDefault();
			this.close();
			return;
		}
		if (event.key !== "Tab") return;
		const focusable = [
			...this.options.backdrop.querySelectorAll<HTMLElement>(
				FOCUSABLE_SELECTOR,
			),
		].filter((item) => !item.hasAttribute("disabled"));
		const first = focusable[0];
		const last = focusable.at(-1);
		if (!first || !last) return;
		if (event.shiftKey && this.document.activeElement === first) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && this.document.activeElement === last) {
			event.preventDefault();
			first.focus();
		}
	}

	private createDialog(title: string): HTMLElement {
		const dialog = this.document.createElement("section");
		dialog.className = "modal";
		dialog.setAttribute("role", "dialog");
		dialog.setAttribute("aria-modal", "true");
		dialog.setAttribute("aria-label", title);
		return dialog;
	}

	private createButton(label: string, className: string): HTMLButtonElement {
		const button = this.document.createElement("button");
		button.type = "button";
		button.className = className;
		button.textContent = label;
		return button;
	}

	private open(dialog: HTMLElement, initialFocus: HTMLElement): void {
		const active = this.document.activeElement;
		this.returnFocus = active instanceof HTMLElement ? active : null;
		this.options.backdrop.replaceChildren(dialog);
		this.options.backdrop.hidden = false;
		this.setBackgroundInert(true);
		initialFocus.focus();
	}

	private setBackgroundInert(inert: boolean): void {
		for (const root of this.options.inertRoots) root.inert = inert;
	}
}
