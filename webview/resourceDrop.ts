interface ResourceDataTransfer {
	readonly types: readonly string[];
	getData(format: string): string;
}

const RESOURCE_URLS_TYPE = "ResourceURLs";
const CODE_FILES_TYPE = "CodeFiles";
const INTERNAL_URI_LIST_TYPE = "application/vnd.code.uri-list";
const URI_LIST_TYPE = "text/uri-list";
const ResourceTransferTypes = new Set(
	[
		RESOURCE_URLS_TYPE,
		CODE_FILES_TYPE,
		INTERNAL_URI_LIST_TYPE,
		URI_LIST_TYPE,
	].map((type) => type.toLowerCase()),
);

export function containsDroppedResources(
	dataTransfer: ResourceDataTransfer,
): boolean {
	return [...dataTransfer.types].some((type) =>
		ResourceTransferTypes.has(type.toLowerCase()),
	);
}

export function extractDroppedResources(
	dataTransfer: ResourceDataTransfer,
): string[] {
	const candidates = [
		parseJsonStringArray(readTransferData(dataTransfer, RESOURCE_URLS_TYPE)),
		parseUriList(readTransferData(dataTransfer, INTERNAL_URI_LIST_TYPE)),
		parseJsonStringArray(readTransferData(dataTransfer, CODE_FILES_TYPE)),
		parseUriList(readTransferData(dataTransfer, URI_LIST_TYPE)),
	];
	for (const resources of candidates) {
		if (resources.length > 0) return [...new Set(resources)];
	}
	return [];
}

function readTransferData(
	dataTransfer: ResourceDataTransfer,
	type: string,
): string {
	return dataTransfer.getData(type) || dataTransfer.getData(type.toLowerCase());
}

function parseJsonStringArray(value: string): string[] {
	if (!value) return [];
	try {
		const parsed: unknown = JSON.parse(value);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(item): item is string => typeof item === "string" && item.length > 0,
		);
	} catch {
		return [];
	}
}

function parseUriList(value: string): string[] {
	return value
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("#"));
}
