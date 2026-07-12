const VERSION = "v1";
const AAD = new TextEncoder().encode("hiai-docs:category-api-key:v1");

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
	const binary = atob(value);
	const bytes = new Uint8Array(new ArrayBuffer(binary.length));
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

async function importEncryptionKey(secret: string): Promise<CryptoKey> {
	if (secret.length < 32) {
		throw new Error("API_KEY_ENCRYPTION_SECRET must be at least 32 characters");
	}
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(secret),
	);
	return crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
		"encrypt",
		"decrypt",
	]);
}

export async function encryptApiKey(
	rawKey: string,
	secret: string,
): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const key = await importEncryptionKey(secret);
	const ciphertext = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv, additionalData: AAD },
		key,
		new TextEncoder().encode(rawKey),
	);
	return `${VERSION}.${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(ciphertext))}`;
}

export async function decryptApiKey(
	payload: string,
	secret: string,
): Promise<string> {
	const [version, encodedIv, encodedCiphertext] = payload.split(".");
	if (version !== VERSION || !encodedIv || !encodedCiphertext) {
		throw new Error("Unsupported encrypted API key payload");
	}
	const key = await importEncryptionKey(secret);
	const plaintext = await crypto.subtle.decrypt(
		{
			name: "AES-GCM",
			iv: base64ToBytes(encodedIv),
			additionalData: AAD,
		},
		key,
		base64ToBytes(encodedCiphertext),
	);
	return new TextDecoder().decode(plaintext);
}
