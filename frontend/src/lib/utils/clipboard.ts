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
	// Modern API — works in secure contexts (HTTPS, localhost)
	if (navigator.clipboard?.writeText) {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			// Fall through to legacy method
		}
	}

	// Legacy fallback — works on HTTP (insecure contexts)
	try {
		const textarea = document.createElement("textarea");
		textarea.value = text;
		textarea.style.cssText =
			"position:fixed;left:-9999px;top:-9999px;opacity:0;";
		document.body.appendChild(textarea);
		textarea.select();
		const ok = document.execCommand("copy");
		document.body.removeChild(textarea);
		return ok;
	} catch {
		return false;
	}
}
