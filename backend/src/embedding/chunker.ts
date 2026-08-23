/**
 * Text chunking for embedding pipeline.
 * Strategy: split by paragraphs, then merge into ~500 token chunks with 50 token overlap.
 * Token estimation: 1 token ≈ 4 chars (rough heuristic).
 */

import { chunkHash } from "../lib/chunk-hash";
import { config } from "../lib/config";

const CHARS_PER_TOKEN = 4;
const TARGET_TOKENS = config.CHUNK_TARGET_TOKENS;
const OVERLAP_TOKENS = config.CHUNK_OVERLAP_TOKENS;

const TARGET_CHARS = TARGET_TOKENS * CHARS_PER_TOKEN; // 2000
const OVERLAP_CHARS = OVERLAP_TOKENS * CHARS_PER_TOKEN; // 200

const INLINE_DATA_MARKER = "[inline binary asset omitted]";

/**
 * Remove inline data URL payloads before CPU-heavy NLP work. Imported HTML and
 * Markdown can contain multi-megabyte base64 images; those bytes have no
 * semantic value and must never be fed to the chunker or embedding provider.
 *
 * This is deliberately a scanner rather than a regular expression. A single
 * punctuation-free base64 payload can be several megabytes long, and regex
 * backtracking on that input previously blocked Bun's event loop long enough
 * for every API request and BullMQ lock renewal to time out.
 */
export function sanitizeEmbeddingText(text: string): string {
	let cursor = 0;
	const output: string[] = [];
	while (cursor < text.length) {
		const start = text.indexOf("data:", cursor);
		if (start === -1) {
			output.push(text.slice(cursor));
			break;
		}
		let comma = -1;
		const headerLimit = Math.min(text.length, start + 5 + 513);
		for (let index = start + 5; index < headerLimit; index += 1) {
			if (text.charCodeAt(index) === 44) {
				comma = index;
				break;
			}
		}
		// A valid data URL has a short media-type/parameter header. Avoid
		// treating arbitrary prose beginning with "data:" as an inline asset.
		let validHeader = comma !== -1 && comma - start <= 512;
		if (validHeader) {
			for (let index = start + 5; index < comma; index += 1) {
				const code = text.charCodeAt(index);
				if (code === 9 || code === 10 || code === 13 || code === 32) {
					validHeader = false;
					break;
				}
			}
		}
		if (!validHeader || comma === -1) {
			output.push(text.slice(cursor, start + 5));
			cursor = start + 5;
			continue;
		}
		let end = comma + 1;
		while (end < text.length) {
			const code = text.charCodeAt(end);
			if (
				code === 9 ||
				code === 10 ||
				code === 13 ||
				code === 32 ||
				code === 34 ||
				code === 39 ||
				code === 41 ||
				code === 62
			) {
				break;
			}
			end += 1;
		}
		output.push(text.slice(cursor, start), INLINE_DATA_MARKER);
		cursor = end;
	}
	return output.join("");
}

interface SourceUnit {
	text: string;
	charStart: number;
	separatorBefore: string;
}

function splitOversizedParagraph(paragraph: SourceUnit): SourceUnit[] {
	if (paragraph.text.length <= TARGET_CHARS) return [paragraph];
	const parts: SourceUnit[] = [];
	let start = 0;
	let lastSentenceEnd = -1;
	for (let cursor = 0; cursor < paragraph.text.length; cursor += 1) {
		const char = paragraph.text.charCodeAt(cursor);
		if (char === 33 || char === 46 || char === 63) {
			lastSentenceEnd = cursor + 1;
		}
		if (cursor + 1 - start < TARGET_CHARS) continue;
		const end = lastSentenceEnd > start ? lastSentenceEnd : cursor + 1;
		const text = paragraph.text.slice(start, end);
		if (text.trim()) {
			parts.push({
				text,
				charStart: paragraph.charStart + start,
				separatorBefore: parts.length === 0 ? paragraph.separatorBefore : "",
			});
		}
		start = end;
		lastSentenceEnd = -1;
	}
	const text = paragraph.text.slice(start);
	if (text.trim()) {
		parts.push({
			text,
			charStart: paragraph.charStart + start,
			separatorBefore: parts.length === 0 ? paragraph.separatorBefore : "",
		});
	}
	return parts;
}

function sourceUnits(text: string): SourceUnit[] {
	const units: SourceUnit[] = [];
	const separator = /\n\s*\n/g;
	let cursor = 0;
	let separatorBefore = "";
	for (const match of text.matchAll(separator)) {
		const textBefore = text.slice(cursor, match.index);
		if (textBefore.trim()) {
			units.push({ text: textBefore, charStart: cursor, separatorBefore });
		}
		separatorBefore = match[0];
		cursor = (match.index ?? 0) + match[0].length;
	}
	const remainder = text.slice(cursor);
	if (remainder.trim()) {
		units.push({ text: remainder, charStart: cursor, separatorBefore });
	}
	return units;
}

/**
 * Result of chunking: a chunk's text paired with its SHA-256 hash.
 *
 * The hash lets the worker decide whether a chunk changed between embeddings
 * without re-comparing the full text byte-by-byte. Stored alongside the
 * embedding so future re-embeds can skip unchanged chunks entirely.
 */
export interface ChunkResult {
	text: string;
	hash: string;
	charStart: number;
	charEnd: number;
}

/**
 * Split text into chunks suitable for embedding.
 * Each chunk is approximately 500 tokens (~2000 characters).
 * Adjacent chunks overlap by ~50 tokens (~200 characters).
 */
export function chunkText(text: string): ChunkResult[] {
	if (!text || text.trim().length === 0) {
		return [];
	}
	const semanticText = sanitizeEmbeddingText(text);

	const paragraphs = sourceUnits(semanticText);
	if (paragraphs.length === 0) {
		return [];
	}

	// Split oversized paragraphs with a bounded linear scanner. Every emitted
	// unit is capped even when the input contains no sentence punctuation.
	const normalizedParagraphs: SourceUnit[] = [];
	for (const para of paragraphs) {
		normalizedParagraphs.push(...splitOversizedParagraph(para));
	}

	const chunks: Array<{ text: string; charStart: number; charEnd: number }> =
		[];
	let currentChunk = "";
	let currentChunkStart = 0;
	let currentChunkEnd = 0;

	for (const paragraph of normalizedParagraphs) {
		const prefix = currentChunk ? paragraph.separatorBefore : "";
		const candidate = currentChunk
			? `${currentChunk}${prefix}${paragraph.text}`
			: paragraph.text;

		if (
			candidate.length <= TARGET_CHARS &&
			(!currentChunk || currentChunkEnd + prefix.length === paragraph.charStart)
		) {
			if (currentChunk.length === 0) {
				currentChunkStart = paragraph.charStart;
			}
			currentChunk = candidate;
			currentChunkEnd = paragraph.charStart + paragraph.text.length;
		} else {
			// Flush current chunk if non-empty
			if (currentChunk.length > 0) {
				chunks.push({
					text: currentChunk,
					charStart: currentChunkStart,
					charEnd: currentChunkEnd,
				});
			}
			// Start new chunk with overlap from end of previous chunk
			if (OVERLAP_CHARS > 0 && currentChunk.length > 0) {
				const overlapStart = Math.max(
					currentChunkEnd - OVERLAP_CHARS,
					currentChunkStart,
				);
				const overlapCandidate = `${semanticText.slice(overlapStart, currentChunkEnd)}${prefix}${paragraph.text}`;
				if (overlapCandidate.length <= TARGET_CHARS) {
					currentChunkStart = overlapStart;
					currentChunk = overlapCandidate;
				} else {
					currentChunkStart = paragraph.charStart;
					currentChunk = paragraph.text;
				}
			} else {
				currentChunk = paragraph.text;
				currentChunkStart = paragraph.charStart;
			}
			currentChunkEnd = paragraph.charStart + paragraph.text.length;
		}
	}

	// Flush remaining chunk
	if (currentChunk.trim().length > 0) {
		chunks.push({
			text: currentChunk,
			charStart: currentChunkStart,
			charEnd: currentChunkEnd,
		});
	}

	return chunks.map(({ text, charStart, charEnd }) => {
		return {
			text,
			hash: chunkHash(text),
			charStart,
			charEnd,
		};
	});
}
