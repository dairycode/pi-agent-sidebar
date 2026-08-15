import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
	MAX_ATTACHMENT_COUNT,
	MAX_IMAGE_ATTACHMENT_COUNT,
	type AttachmentRef,
	type PastedImage,
} from "./shared/protocol.js";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 12 * 1024 * 1024;

const PASTED_IMAGE_EXTENSIONS = new Map([
	["image/png", ".png"],
	["image/jpeg", ".jpg"],
	["image/gif", ".gif"],
	["image/webp", ".webp"],
]);
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/u;
const INSTANCE_DIRECTORY_PATTERN = /^(\d+)-[0-9a-f-]+$/iu;

export interface ResolvedAttachment {
	summary: AttachmentRef;
	filePath: string;
	temporary: boolean;
	mimeType?: string;
}

export interface SelectedAttachment {
	filePath: string;
	label: string;
	kind: "file" | "image";
	mimeType?: string;
}

export class AttachmentStore {
	private readonly attachments = new Map<string, ResolvedAttachment>();
	private readonly parentDirectory: string;
	private readonly instanceDirectory: string;
	private initializationPromise: Promise<void> | undefined;

	public constructor(storageRoot: string) {
		this.parentDirectory = path.join(storageRoot, "clipboard-images");
		this.instanceDirectory = path.join(
			this.parentDirectory,
			`${process.pid}-${randomUUID()}`,
		);
	}

	public initialize(): Promise<void> {
		if (this.initializationPromise) return this.initializationPromise;
		this.initializationPromise = (async () => {
			await mkdir(this.instanceDirectory, { recursive: true });
			await this.removeAbandonedInstanceDirectories();
		})().catch((error: unknown) => {
			this.initializationPromise = undefined;
			throw error;
		});
		return this.initializationPromise;
	}

	public list(): AttachmentRef[] {
		return [...this.attachments.values()].map(
			(attachment) => attachment.summary,
		);
	}

	public registerSelected(files: SelectedAttachment[]): AttachmentRef[] {
		const knownPaths = new Set(
			[...this.attachments.values()].map((attachment) => attachment.filePath),
		);
		const additions: SelectedAttachment[] = [];
		for (const file of files) {
			if (knownPaths.has(file.filePath)) continue;
			knownPaths.add(file.filePath);
			additions.push(file);
		}
		if (this.attachments.size + additions.length > MAX_ATTACHMENT_COUNT) {
			throw new Error(
				`Attach at most ${MAX_ATTACHMENT_COUNT} files or images per message.`,
			);
		}
		const imageCount = [...this.attachments.values()].filter(
			(attachment) => attachment.summary.kind === "image",
		).length;
		const addedImageCount = additions.filter(
			(attachment) => attachment.kind === "image",
		).length;
		if (imageCount + addedImageCount > MAX_IMAGE_ATTACHMENT_COUNT) {
			throw new Error(
				`Attach at most ${MAX_IMAGE_ATTACHMENT_COUNT} images per message.`,
			);
		}
		for (const file of additions) {
			const id = randomUUID();
			this.attachments.set(id, {
				summary: {
					id,
					path: file.filePath,
					label: file.label,
					kind: file.kind,
				},
				filePath: file.filePath,
				temporary: false,
				mimeType: file.mimeType,
			});
		}
		return this.list();
	}

	public async storePastedImages(images: unknown): Promise<AttachmentRef[]> {
		if (!Array.isArray(images) || images.length === 0) {
			throw new Error("No clipboard image was provided.");
		}
		if (images.length > MAX_IMAGE_ATTACHMENT_COUNT) {
			throw new Error(
				`Paste at most ${MAX_IMAGE_ATTACHMENT_COUNT} images at once.`,
			);
		}
		const currentImageCount = [...this.attachments.values()].filter(
			(attachment) => attachment.summary.kind === "image",
		).length;
		if (currentImageCount + images.length > MAX_IMAGE_ATTACHMENT_COUNT) {
			throw new Error(
				`Attach at most ${MAX_IMAGE_ATTACHMENT_COUNT} images per message.`,
			);
		}
		if (this.attachments.size + images.length > MAX_ATTACHMENT_COUNT) {
			throw new Error(
				`Attach at most ${MAX_ATTACHMENT_COUNT} files or images per message.`,
			);
		}

		let totalBytes = 0;
		const decoded = images.map((value, index) => {
			if (!value || typeof value !== "object") {
				throw new Error("Invalid clipboard image data.");
			}
			const image = value as Partial<PastedImage>;
			if (
				typeof image.name !== "string" ||
				typeof image.mimeType !== "string" ||
				typeof image.data !== "string"
			) {
				throw new Error("Invalid clipboard image data.");
			}
			const mimeType = image.mimeType.toLowerCase();
			const extension = PASTED_IMAGE_EXTENSIONS.get(mimeType);
			if (!extension) {
				throw new Error("Clipboard images must be PNG, JPEG, GIF, or WebP.");
			}
			if (
				image.data.length === 0 ||
				image.data.length % 4 !== 0 ||
				!BASE64_PATTERN.test(image.data)
			) {
				throw new Error("Invalid clipboard image encoding.");
			}
			const bytes = Buffer.from(image.data, "base64");
			if (bytes.toString("base64") !== image.data) {
				throw new Error("Invalid clipboard image encoding.");
			}
			if (bytes.byteLength > MAX_IMAGE_BYTES) {
				throw new Error(
					`Clipboard image ${index + 1} exceeds the 10 MB limit.`,
				);
			}
			if (!matchesImageMime(bytes, mimeType)) {
				throw new Error(`Clipboard image ${index + 1} has invalid contents.`);
			}
			totalBytes += bytes.byteLength;
			if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
				throw new Error("Clipboard images exceed the 12 MB total limit.");
			}
			return { image: image as PastedImage, extension, mimeType, bytes };
		});

		await this.initialize();
		const written: string[] = [];
		const created: ResolvedAttachment[] = [];
		try {
			for (const [index, item] of decoded.entries()) {
				const filePath = path.join(
					this.instanceDirectory,
					`${randomUUID()}${item.extension}`,
				);
				await writeFile(filePath, item.bytes, { flag: "wx" });
				written.push(filePath);
				const id = randomUUID();
				const sourceLabel = path.basename(item.image.name.trim()).slice(0, 120);
				created.push({
					summary: {
						id,
						path: filePath,
						label: sourceLabel || `Pasted image ${index + 1}${item.extension}`,
						kind: "image",
					},
					filePath,
					temporary: true,
					mimeType: item.mimeType,
				});
			}
		} catch (error) {
			await Promise.allSettled(written.map((filePath) => unlink(filePath)));
			throw error;
		}
		for (const attachment of created) {
			this.attachments.set(attachment.summary.id, attachment);
		}
		return this.list();
	}

	public resolve(ids: unknown): ResolvedAttachment[] {
		if (!Array.isArray(ids)) throw new Error("Invalid attachment list.");
		if (ids.length > MAX_ATTACHMENT_COUNT) {
			throw new Error(
				`Attach at most ${MAX_ATTACHMENT_COUNT} files or images per message.`,
			);
		}
		const resolved: ResolvedAttachment[] = [];
		const seen = new Set<string>();
		for (const id of ids) {
			if (typeof id !== "string" || id.length === 0 || id.length > 128) {
				throw new Error("Invalid attachment ID.");
			}
			if (seen.has(id)) continue;
			seen.add(id);
			const attachment = this.attachments.get(id);
			if (!attachment) throw new Error("An attachment is no longer available.");
			resolved.push(attachment);
		}
		return resolved;
	}

	public async validateRegularFile(
		attachment: ResolvedAttachment,
	): Promise<void> {
		const handle = await open(attachment.filePath, "r");
		try {
			const fileStat = await handle.stat();
			if (!fileStat.isFile()) {
				throw new Error("Attachment is not a regular file.");
			}
		} finally {
			await handle.close();
		}
	}

	public async readImage(
		attachment: ResolvedAttachment,
	): Promise<{ data: Buffer; mimeType: string }> {
		if (attachment.summary.kind !== "image" || !attachment.mimeType) {
			throw new Error("Attachment is not a supported image.");
		}
		const handle = await open(attachment.filePath, "r");
		try {
			const fileStat = await handle.stat();
			if (!fileStat.isFile()) throw new Error("Image is not a regular file.");
			if (fileStat.size > MAX_IMAGE_BYTES) {
				throw new Error(`${attachment.summary.label} exceeds the 10 MB limit.`);
			}
			const data = await handle.readFile();
			if (data.byteLength > MAX_IMAGE_BYTES) {
				throw new Error(`${attachment.summary.label} exceeds the 10 MB limit.`);
			}
			if (!matchesImageMime(data, attachment.mimeType)) {
				throw new Error(`${attachment.summary.label} is not a valid image.`);
			}
			return { data, mimeType: attachment.mimeType };
		} finally {
			await handle.close();
		}
	}

	public async remove(id: unknown): Promise<void> {
		if (typeof id !== "string") return;
		const attachment = this.attachments.get(id);
		if (!attachment) return;
		this.attachments.delete(id);
		await this.removeTemporaryFile(attachment);
	}

	public async removeResolved(
		attachments: ResolvedAttachment[],
	): Promise<void> {
		const removed: ResolvedAttachment[] = [];
		for (const attachment of attachments) {
			if (this.attachments.get(attachment.summary.id) !== attachment) continue;
			this.attachments.delete(attachment.summary.id);
			removed.push(attachment);
		}
		await Promise.all(
			removed.map((attachment) => this.removeTemporaryFile(attachment)),
		);
	}

	public async clear(): Promise<void> {
		const attachments = [...this.attachments.values()];
		this.attachments.clear();
		await Promise.all(
			attachments.map((attachment) => this.removeTemporaryFile(attachment)),
		);
	}

	public async dispose(): Promise<void> {
		await this.initializationPromise?.catch(() => undefined);
		await this.clear();
		await rm(this.instanceDirectory, { recursive: true, force: true });
	}

	private async removeTemporaryFile(
		attachment: ResolvedAttachment,
	): Promise<void> {
		if (!attachment.temporary) return;
		try {
			await unlink(attachment.filePath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}

	private async removeAbandonedInstanceDirectories(): Promise<void> {
		let entries;
		try {
			entries = await readdir(this.parentDirectory, { withFileTypes: true });
		} catch {
			return;
		}
		await Promise.allSettled(
			entries.map((entry) => {
				if (
					!entry.isDirectory() ||
					entry.name === path.basename(this.instanceDirectory)
				) {
					return undefined;
				}
				const match = entry.name.match(INSTANCE_DIRECTORY_PATTERN);
				if (!match) return undefined;
				const pid = Number(match[1]);
				if (Number.isSafeInteger(pid) && isProcessAlive(pid)) return undefined;
				return rm(path.join(this.parentDirectory, entry.name), {
					recursive: true,
					force: true,
				});
			}),
		);
	}
}

export function imageMimeTypeFromPath(filePath: string): string | undefined {
	const extension = path.extname(filePath).toLowerCase();
	if (extension === ".png") return "image/png";
	if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
	if (extension === ".gif") return "image/gif";
	if (extension === ".webp") return "image/webp";
	return undefined;
}

export function matchesImageMime(data: Uint8Array, mimeType: string): boolean {
	if (mimeType === "image/png") {
		return (
			data.length >= 8 &&
			data[0] === 0x89 &&
			data[1] === 0x50 &&
			data[2] === 0x4e &&
			data[3] === 0x47 &&
			data[4] === 0x0d &&
			data[5] === 0x0a &&
			data[6] === 0x1a &&
			data[7] === 0x0a
		);
	}
	if (mimeType === "image/jpeg") {
		return (
			data.length >= 3 &&
			data[0] === 0xff &&
			data[1] === 0xd8 &&
			data[2] === 0xff
		);
	}
	if (mimeType === "image/gif") {
		const signature = Buffer.from(data.subarray(0, 6)).toString("ascii");
		return signature === "GIF87a" || signature === "GIF89a";
	}
	if (mimeType === "image/webp") {
		return (
			data.length >= 12 &&
			Buffer.from(data.subarray(0, 4)).toString("ascii") === "RIFF" &&
			Buffer.from(data.subarray(8, 12)).toString("ascii") === "WEBP"
		);
	}
	return false;
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}
