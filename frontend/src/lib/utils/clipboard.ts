/**
 * Copy `text` to the system clipboard via the async Clipboard API.
 *
 * Returns `true` if the copy succeeded and `false` if it was rejected or
 * the API is unavailable (e.g. older browsers, insecure contexts, missing
 * permissions). Callers should treat `false` as a soft failure — show
 * feedback or fall back to a manual selection prompt rather than
 * throwing.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		return false;
	}
}
