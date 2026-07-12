import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const REMOTE_IMAGE_MAX_BYTES = 25 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const ALLOWED_IMAGE_TYPES = new Set([
	"image/jpeg",
	"image/png",
	"image/gif",
	"image/bmp",
]);

function isBlockedIpv4(address: string): boolean {
	const octets = address.split(".").map(Number);
	const [a, b] = octets;
	if (octets.length !== 4 || a === undefined || b === undefined) return true;
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		a >= 224 ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 100 && b >= 64 && b <= 127)
	);
}

export function isPublicAddress(address: string): boolean {
	const version = isIP(address);
	if (version === 4) return !isBlockedIpv4(address);
	if (version !== 6) return false;
	const normalized = address.toLowerCase();
	if (normalized.startsWith("::ffff:")) {
		return !isBlockedIpv4(normalized.slice(7));
	}
	return !(
		normalized === "::" ||
		normalized === "::1" ||
		normalized.startsWith("fc") ||
		normalized.startsWith("fd") ||
		normalized.startsWith("fe8") ||
		normalized.startsWith("fe9") ||
		normalized.startsWith("fea") ||
		normalized.startsWith("feb")
	);
}

type DnsLookup = (
	hostname: string,
	options: { all: true; verbatim: true },
) => Promise<Array<{ address: string; family: number }>>;

export async function resolvePublicRemoteTarget(
	url: URL,
	lookupImpl: DnsLookup = async (hostname, options) =>
		lookup(hostname, options),
): Promise<{
	connectUrl: URL;
	hostHeader: string;
	serverName: string;
}> {
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Only HTTP image URLs are supported");
	}
	if (url.username || url.password || url.port) {
		throw new Error("Remote image URL contains unsupported authority data");
	}
	const hostname = url.hostname.toLowerCase();
	if (hostname === "localhost" || hostname.endsWith(".local")) {
		throw new Error("Private image hosts are not allowed");
	}
	if (isIP(hostname)) {
		if (!isPublicAddress(hostname))
			throw new Error("Private image hosts are not allowed");
		return { connectUrl: url, hostHeader: hostname, serverName: hostname };
	}
	const addresses = await lookupImpl(hostname, { all: true, verbatim: true });
	if (
		addresses.length === 0 ||
		addresses.some(({ address }) => !isPublicAddress(address))
	) {
		throw new Error("Private image hosts are not allowed");
	}
	const address = addresses[0]?.address;
	if (!address) throw new Error("Remote image host could not be resolved");
	const connectUrl = new URL(url);
	connectUrl.hostname = address.includes(":") ? `[${address}]` : address;
	return { connectUrl, hostHeader: hostname, serverName: hostname };
}

export interface RemoteImageResult {
	bytes: Uint8Array;
	contentType: string;
}

type RemoteFetch = (
	input: RequestInfo | URL,
	init?: RequestInit & { tls?: { serverName?: string } },
) => Promise<Response>;

async function readBoundedBody(response: Response): Promise<Uint8Array> {
	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;
		total += value.byteLength;
		if (total > REMOTE_IMAGE_MAX_BYTES) {
			await reader.cancel();
			throw new Error("Remote image is too large");
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

function hasExpectedSignature(bytes: Uint8Array, contentType: string): boolean {
	if (contentType === "image/jpeg")
		return bytes.byteLength >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8;
	if (contentType === "image/png")
		return (
			bytes.byteLength >= 8 &&
			bytes
				.slice(0, 8)
				.every(
					(byte, index) =>
						byte === [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][index],
				)
		);
	if (contentType === "image/gif") {
		if (bytes.byteLength < 6) return false;
		const signature = new TextDecoder().decode(bytes.slice(0, 6));
		return signature === "GIF87a" || signature === "GIF89a";
	}
	if (contentType === "image/bmp")
		return bytes.byteLength >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d;
	return false;
}

export async function fetchRemoteImage(
	source: string,
	fetchImpl: RemoteFetch = fetch,
): Promise<RemoteImageResult> {
	let url = new URL(source);
	for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
		const target = await resolvePublicRemoteTarget(url);
		const response = await fetchImpl(target.connectUrl, {
			redirect: "manual",
			signal: AbortSignal.timeout(10_000),
			headers: {
				Accept: "image/jpeg,image/png,image/gif,image/bmp",
				Host: target.hostHeader,
			},
			...(url.protocol === "https:"
				? { tls: { serverName: target.serverName } }
				: {}),
		});
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("location");
			if (!location || redirect === MAX_REDIRECTS)
				throw new Error("Too many image redirects");
			url = new URL(location, url);
			continue;
		}
		if (!response.ok)
			throw new Error(`Remote image returned ${response.status}`);
		const contentType = (
			(response.headers.get("content-type") ?? "").split(";", 1)[0] ?? ""
		)
			.trim()
			.toLowerCase();
		if (!ALLOWED_IMAGE_TYPES.has(contentType))
			throw new Error("Unsupported remote image type");
		const length = Number(response.headers.get("content-length"));
		if (Number.isFinite(length) && length > REMOTE_IMAGE_MAX_BYTES)
			throw new Error("Remote image is too large");
		const bytes = await readBoundedBody(response);
		if (bytes.byteLength === 0 || !hasExpectedSignature(bytes, contentType))
			throw new Error("Remote image content does not match its declared type");
		return { bytes, contentType };
	}
	throw new Error("Remote image could not be fetched");
}
