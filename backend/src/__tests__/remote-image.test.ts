import { describe, expect, test } from "bun:test";
import {
	fetchRemoteImage,
	isPublicAddress,
	resolvePublicRemoteTarget,
} from "../lib/remote-image";

const PNG_SIGNATURE = Uint8Array.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

describe("remote image SSRF protection", () => {
	test("rejects private and loopback addresses", () => {
		for (const address of [
			"127.0.0.1",
			"10.0.0.1",
			"172.16.0.1",
			"192.168.1.1",
			"169.254.169.254",
			"::1",
			"fd00::1",
		]) {
			expect(isPublicAddress(address)).toBe(false);
		}
		expect(isPublicAddress("93.184.216.34")).toBe(true);
		expect(isPublicAddress("2606:2800:220:1:248:1893:25c8:1946")).toBe(true);
	});

	test("accepts a bounded supported image", async () => {
		let connectedHost = "";
		const result = await fetchRemoteImage(
			"https://93.184.216.34/image",
			async (input) => {
				connectedHost = new URL(String(input)).hostname;
				return new Response(PNG_SIGNATURE, {
					headers: { "content-type": "image/png", "content-length": "8" },
				});
			},
		);
		expect(result.contentType).toBe("image/png");
		expect(result.bytes).toEqual(PNG_SIGNATURE);
		expect(connectedHost).toBe("93.184.216.34");
	});

	test("pins a validated hostname to the resolved connect address", async () => {
		const target = await resolvePublicRemoteTarget(
			new URL("https://example.com/image.png"),
			async () => [{ address: "93.184.216.34", family: 4 as const }],
		);
		expect(target.connectUrl.hostname).not.toBe("example.com");
		expect(target.hostHeader).toBe("example.com");
		expect(target.serverName).toBe("example.com");
	});

	test("rejects redirects to private hosts", async () => {
		await expect(
			fetchRemoteImage(
				"https://93.184.216.34/image",
				async () =>
					new Response(null, {
						status: 302,
						headers: { location: "http://127.0.0.1/secret" },
					}),
			),
		).rejects.toThrow("Private image hosts");
	});

	test("rejects non-image responses", async () => {
		await expect(
			fetchRemoteImage(
				"https://93.184.216.34/image",
				async () =>
					new Response("secret", { headers: { "content-type": "text/plain" } }),
			),
		).rejects.toThrow("Unsupported remote image type");
	});

	test("rejects a spoofed image body", async () => {
		await expect(
			fetchRemoteImage(
				"https://93.184.216.34/image",
				async () =>
					new Response("not png", { headers: { "content-type": "image/png" } }),
			),
		).rejects.toThrow("does not match");
	});
});
