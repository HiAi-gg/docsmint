const pendingWebpSuffix = ".webp.pending";

export function pendingWebpAttachmentKey(
	prefix: string,
	uploadId: string,
): string {
	return `${prefix}/${uploadId}${pendingWebpSuffix}`;
}

/** The upload contract is carried by its key and survives a flag change. */
export function committedAttachmentKey(sourceKey: string): string {
	return sourceKey.endsWith(pendingWebpSuffix)
		? sourceKey.slice(0, -".pending".length)
		: sourceKey;
}
