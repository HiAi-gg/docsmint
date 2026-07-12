const MAX_FOLDER_NAME_LENGTH = 255;

/** Pick the first available sibling name while keeping the requested name intact. */
export function nextAvailableFolderName(
	requestedName: string,
	existingNames: Iterable<string>,
): string {
	const occupied = new Set(existingNames);
	if (!occupied.has(requestedName)) return requestedName;

	for (let sequence = 2; ; sequence += 1) {
		const suffix = ` ${sequence}`;
		const base = requestedName.slice(0, MAX_FOLDER_NAME_LENGTH - suffix.length);
		const candidate = `${base}${suffix}`;
		if (!occupied.has(candidate)) return candidate;
	}
}
