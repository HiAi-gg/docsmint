export interface DuplicateAttachmentSource {
	id: string;
	filename: string;
	mimeType: string;
	size: number;
	storageKey: string;
}

export interface DuplicateAttachmentPlan extends DuplicateAttachmentSource {
	sourceId: string;
	sourceStorageKey: string;
}

function fileExtension(filename: string): string {
	const extension = filename.split(".").at(-1)?.trim().toLowerCase();
	return extension && /^[a-z0-9]+$/.test(extension) ? extension : "bin";
}

export function planDuplicateAttachments(
	sources: DuplicateAttachmentSource[],
	ownerId: string,
	documentId: string,
	idFactory: () => string = () => crypto.randomUUID(),
): DuplicateAttachmentPlan[] {
	return sources.map((source) => {
		const id = idFactory();
		return {
			...source,
			id,
			sourceId: source.id,
			sourceStorageKey: source.storageKey,
			storageKey: `${ownerId}/${documentId}/${id}.${fileExtension(source.filename)}`,
		};
	});
}

/** Rewrite protected attachment URLs in Markdown and ProseMirror JSON. */
export function rewriteDuplicateAttachmentReferences<T>(
	value: T,
	plans: DuplicateAttachmentPlan[],
): T {
	const replacements = new Map(
		plans.map((plan) => [
			`/api/attachments/${plan.sourceId}/raw`,
			`/api/attachments/${plan.id}/raw`,
		]),
	);
	const visit = (current: unknown): unknown => {
		if (typeof current === "string") {
			let rewritten = current;
			for (const [source, target] of replacements) {
				rewritten = rewritten.replaceAll(source, target);
			}
			return rewritten;
		}
		if (Array.isArray(current)) return current.map(visit);
		if (current && typeof current === "object") {
			return Object.fromEntries(
				Object.entries(current).map(([key, nested]) => [key, visit(nested)]),
			);
		}
		return current;
	};
	return visit(value) as T;
}

export function encodeS3CopySource(bucket: string, key: string): string {
	return `${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
}
