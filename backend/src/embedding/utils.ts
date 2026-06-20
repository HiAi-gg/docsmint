/**
 * Shared embedding utilities.
 */

export const EMBEDDING_DIMENSIONS = 1024;

/**
 * Pad or truncate a vector to exactly `dims` dimensions.
 */
export function normalizeDimensions(vec: number[], dims: number): number[] {
	if (vec.length === dims) return vec;
	if (vec.length > dims) return vec.slice(0, dims);
	// Pad with zeros
	return [...vec, ...new Array(dims - vec.length).fill(0)];
}
