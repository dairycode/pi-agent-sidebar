import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { loadBundledModule } from "../../helpers/load-bundled-module.mjs";
const ONE_PIXEL_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nMsAAAAASUVORK5CYII=";

async function loadAttachmentStore() {
	return loadBundledModule({
		entry: "src/services/attachmentStore.ts",
		name: "attachment-store",
	});
}

test("attachment IDs are host-owned and temporary images are removed immediately", async () => {
	const loaded = await loadAttachmentStore();
	try {
		const storage = path.join(loaded.temporaryDirectory, "storage");
		const store = new loaded.module.AttachmentStore(storage);
		const summaries = await store.storePastedImages([
			{
				name: "pixel.png",
				mimeType: "image/png",
				data: ONE_PIXEL_PNG,
			},
		]);
		assert.equal(summaries.length, 1);
		const attachment = store.resolve([summaries[0].id])[0];
		assert.equal(attachment.summary.kind, "image");
		await access(attachment.filePath);
		await assert.rejects(
			async () => store.resolve(["forged-id"]),
			/attachment is no longer available/iu,
		);
		await store.remove(summaries[0].id);
		await assert.rejects(access(attachment.filePath));
		assert.deepEqual(store.list(), []);
		await store.dispose();
	} finally {
		await loaded.dispose();
	}
});

test("file attachments and image limits are tracked independently", async () => {
	const loaded = await loadAttachmentStore();
	try {
		const storage = path.join(loaded.temporaryDirectory, "storage");
		const store = new loaded.module.AttachmentStore(storage);
		await assert.rejects(
			store.storePastedImages([
				{
					name: "fake.png",
					mimeType: "image/png",
					data: Buffer.from("not a png").toString("base64"),
				},
			]),
			/invalid contents/iu,
		);
		const files = Array.from({ length: 16 }, (_, index) => ({
			filePath: path.join(loaded.temporaryDirectory, `file-${index}.ts`),
			label: `file-${index}.ts`,
			kind: "file",
		}));
		const images = Array.from({ length: 4 }, (_, index) => ({
			filePath: path.join(loaded.temporaryDirectory, `image-${index}.png`),
			label: `image-${index}.png`,
			kind: "image",
			mimeType: "image/png",
		}));
		store.registerSelected([...files, ...images]);
		assert.equal(
			store.list().filter((item) => item.kind === "file").length,
			16,
		);
		assert.equal(
			store.list().filter((item) => item.kind === "image").length,
			4,
		);
		assert.throws(
			() =>
				store.registerSelected([
					{
						filePath: path.join(loaded.temporaryDirectory, "extra.png"),
						label: "extra.png",
						kind: "image",
						mimeType: "image/png",
					},
				]),
			/at most 20|at most 4/iu,
		);
		await store.dispose();
	} finally {
		await loaded.dispose();
	}
});

test("provider directories are isolated during cleanup", async () => {
	const loaded = await loadAttachmentStore();
	try {
		const storage = path.join(loaded.temporaryDirectory, "storage");
		const first = new loaded.module.AttachmentStore(storage);
		const second = new loaded.module.AttachmentStore(storage);
		const firstSummary = (
			await first.storePastedImages([
				{ name: "first.png", mimeType: "image/png", data: ONE_PIXEL_PNG },
			])
		)[0];
		const secondSummary = (
			await second.storePastedImages([
				{ name: "second.png", mimeType: "image/png", data: ONE_PIXEL_PNG },
			])
		)[0];
		const firstPath = first.resolve([firstSummary.id])[0].filePath;
		const secondPath = second.resolve([secondSummary.id])[0].filePath;
		await first.dispose();
		await assert.rejects(access(firstPath));
		await access(secondPath);
		await second.dispose();
	} finally {
		await loaded.dispose();
	}
});
