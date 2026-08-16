import {
	MAX_IMAGE_ATTACHMENT_COUNT,
	type PastedImage,
} from "../../shared/protocol.js";

const SUPPORTED_CLIPBOARD_IMAGE_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
]);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 12 * 1024 * 1024;

export interface ImagePasteDependencies {
	attachedImageCount: () => number;
	onImages: (images: PastedImage[]) => void;
	onError: (message: string) => void;
	readFile?: (file: File) => Promise<string>;
}

/** Validates and converts clipboard images as one atomic attachment batch. */
export async function handleImagePaste(
	event: ClipboardEvent,
	dependencies: ImagePasteDependencies,
): Promise<void> {
	const clipboard = event.clipboardData;
	if (!clipboard) return;
	const files = [...clipboard.items]
		.filter((item) => item.kind === "file" && item.type.startsWith("image/"))
		.map((item) => item.getAsFile())
		.filter((file): file is File => Boolean(file));
	if (files.length === 0) return;
	event.preventDefault();

	if (
		dependencies.attachedImageCount() + files.length >
		MAX_IMAGE_ATTACHMENT_COUNT
	) {
		dependencies.onError(
			`Attach at most ${MAX_IMAGE_ATTACHMENT_COUNT} images per message`,
		);
		return;
	}

	let totalBytes = 0;
	for (const file of files) {
		if (!SUPPORTED_CLIPBOARD_IMAGE_TYPES.has(file.type.toLowerCase())) {
			dependencies.onError("Paste PNG, JPEG, GIF, or WebP images");
			return;
		}
		if (file.size > MAX_IMAGE_BYTES) {
			dependencies.onError(
				`${file.name || "Clipboard image"} exceeds the 10 MB limit`,
			);
			return;
		}
		totalBytes += file.size;
	}
	if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
		dependencies.onError("Pasted images exceed the 12 MB total limit");
		return;
	}

	const readFile = dependencies.readFile ?? readFileAsBase64;
	try {
		const images: PastedImage[] = await Promise.all(
			files.map(async (file, index) => ({
				name: file.name || `Pasted image ${index + 1}`,
				mimeType: file.type.toLowerCase(),
				data: await readFile(file),
			})),
		);
		dependencies.onImages(images);
	} catch (error) {
		dependencies.onError(
			error instanceof Error
				? error.message
				: "Could not read clipboard image",
		);
	}
}

export function readFileAsBase64(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.addEventListener("error", () =>
			reject(new Error("Could not read clipboard image")),
		);
		reader.addEventListener("load", () => {
			if (typeof reader.result !== "string") {
				reject(new Error("Could not read clipboard image"));
				return;
			}
			const separator = reader.result.indexOf(",");
			if (separator < 0) {
				reject(new Error("Invalid clipboard image"));
				return;
			}
			resolve(reader.result.slice(separator + 1));
		});
		reader.readAsDataURL(file);
	});
}
