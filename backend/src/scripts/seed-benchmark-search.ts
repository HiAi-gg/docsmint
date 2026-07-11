#!/usr/bin/env bun
/**
 * Seed the disposable live-search benchmark fixture.
 *
 * This script is intentionally local-only: it creates two clearly named
 * Better Auth users, scoped user API keys, UUID-backed documents, and valid
 * 1024-dimensional chunk rows. The generated owner/document alias map and
 * credentials are written only to a caller-selected path outside the repo.
 *
 * Usage:
 *   bun run seed:benchmark-search -- --output-dir=/tmp/hiai-docs-benchmark --reset
 */

import {
	apiKeys,
	documentEmbeddings,
	documents,
	users,
} from "@hiai-docs/db/schema";
import {
	adminTenantContext,
	withTenant,
	ZERO_UUID,
} from "@hiai-docs/db/with-tenant";
import { eq } from "drizzle-orm";
import { embeddingProfileId } from "../embedding/validation";
import { config } from "../lib/config";

const FIXTURE_VERSION = "search-relevance-v1";
const OUTPUT_DEFAULT = "/tmp/hiai-docs-benchmark";
const OWNER_ALIASES = ["owner-a", "owner-b"] as const;

type FixtureDoc = {
	id: string;
	title: string;
	content: string;
	ownerId: (typeof OWNER_ALIASES)[number];
};

const FIXTURE_DOCS: FixtureDoc[] = [
	{
		id: "bench-search-en",
		title: "English Language Setup",
		ownerId: "owner-a",
		content:
			"English language setup and multilingual documentation. The English translation of \u0430\u043d\u0433\u043b\u0438\u0439\u0441\u043a\u0438\u0439 is English. Configure locale fallback and language detection for documentation search.",
	},
	{
		id: "bench-search-auth",
		title: "Authentication and Access Control",
		ownerId: "owner-a",
		content:
			"Authentication, authorization, access control, sessions, API keys, and tenant isolation protect every document search request. \u0410\u0432\u0442\u043e\u0440\u0438\u0437\u0430\u0446\u0438\u044f means authentication and authorization in Russian documentation.",
	},
	{
		id: "bench-search-deploy",
		title: "Deployment and Release Operations",
		ownerId: "owner-a",
		content:
			"Deployment and release operations keep a service dependable after release. Run migrations, health checks, rollback procedures, and production readiness checks.",
	},
	{
		id: "bench-search-graph",
		title: "Document Graph Relationships",
		ownerId: "owner-a",
		content:
			"Document graph relationships connect release operations with deployment, health checks, and related operational documents through GraphRAG edges.",
	},
	{
		id: "bench-search-code",
		title: "searchDocuments API Reference",
		ownerId: "owner-a",
		content:
			"The searchDocuments API reference describes query planning, pagination, explanations, and the adaptive multilingual search endpoint.",
	},
	{
		id: "bench-search-theme",
		title: "Reliable Production Operations",
		ownerId: "owner-a",
		content:
			"Reliable production operations keep systems dependable after release with monitoring, backups, incident response, and safe deployment practices.",
	},
	{
		id: "bench-search-private-b",
		title: "Authentication Notes for a Second Owner",
		ownerId: "owner-b",
		content:
			"Authentication notes for a second owner are private tenant material and must never leak into owner-a search results.",
	},
	{
		id: "bench-search-unrelated",
		title: "Gardening Calendar",
		ownerId: "owner-a",
		content:
			"A gardening calendar contains planting dates, watering reminders, and seasonal soil preparation.",
	},
];

interface CliArgs {
	outputDir: string;
	reset: boolean;
	help: boolean;
}

function parseArgs(argv = process.argv.slice(2)): CliArgs {
	const args: CliArgs = {
		outputDir: OUTPUT_DEFAULT,
		reset: false,
		help: false,
	};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i] ?? "";
		const [rawName, inline] = arg.split("=", 2);
		const name = rawName ?? "";
		const value = inline ?? argv[i + 1];
		if (name === "--help") args.help = true;
		else if (name === "--reset") args.reset = true;
		else if (name === "--output-dir" && value) {
			args.outputDir = value;
			if (inline === undefined) i += 1;
		} else if (name.startsWith("--")) throw new Error(`Unknown flag: ${name}`);
	}
	return args;
}

function vectorFor(text: string): number[] {
	const hash = new Bun.CryptoHasher("sha256");
	hash.update(text);
	const bytes = hash.digest();
	const vector = Array.from({ length: 1024 }, (_, index) => {
		const byte = bytes[index % bytes.length] ?? 1;
		return (byte / 255 - 0.5) * 2;
	});
	const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
	return vector.map((value) => value / norm);
}

function printUsage(): void {
	console.log(
		`Usage: bun run seed:benchmark-search -- --output-dir=/tmp/hiai-docs-benchmark --reset\n\nCreates disposable users owner-a/owner-b, UUID-backed benchmark documents/chunks, and 0600 credential/map files outside the repository. --reset is required to replace an existing fixture.`,
	);
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
	await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`);
	await Bun.$`chmod 600 ${path}`;
}

async function main(): Promise<void> {
	const args = parseArgs();
	if (args.help) return printUsage();
	if (!args.reset)
		throw new Error(
			"Refusing to seed without --reset; disposable benchmark data must be explicitly replaceable",
		);
	if (
		!args.outputDir.startsWith("/tmp/") &&
		!args.outputDir.startsWith("/run/")
	) {
		throw new Error("output-dir must be outside the repository (/tmp or /run)");
	}
	await Bun.$`mkdir -p ${args.outputDir}`;

	const ownerIds = new Map<string, string>();
	const credentials: Record<string, { authorization: string }> = {};
	const documentIds: Record<string, string> = {};
	const ownerEmails = new Map<string, string>(
		OWNER_ALIASES.map((alias) => [alias, `benchmark-${alias}@local.invalid`]),
	);

	await withTenant(adminTenantContext(ZERO_UUID), async (tx) => {
		for (const email of ownerEmails.values()) {
			const existing = await tx
				.select({ id: users.id })
				.from(users)
				.where(eq(users.email, email))
				.limit(1);
			if (existing[0])
				await tx.delete(users).where(eq(users.id, existing[0].id));
		}
		for (const alias of OWNER_ALIASES) {
			const [user] = await tx
				.insert(users)
				.values({
					email: ownerEmails.get(alias) as string,
					name: `Benchmark ${alias}`,
				})
				.returning({ id: users.id });
			if (!user) throw new Error(`Failed to create ${alias}`);
			ownerIds.set(alias, user.id);
		}

		for (const alias of OWNER_ALIASES) {
			const rawKey = crypto.randomUUID();
			const keyHash = new Bun.CryptoHasher("sha256");
			keyHash.update(rawKey);
			await tx.insert(apiKeys).values({
				ownerId: ownerIds.get(alias) as string,
				name: `local-${FIXTURE_VERSION}`,
				keyHash: keyHash.digest("hex"),
				prefix: rawKey.slice(0, 8),
				scopes: [],
			});
			credentials[alias] = { authorization: `Bearer ${rawKey}` };
		}

		for (const fixture of FIXTURE_DOCS) {
			const ownerId = ownerIds.get(fixture.ownerId) as string;
			const id = crypto.randomUUID();
			documentIds[fixture.id] = id;
			const generationId = crypto.randomUUID();
			const embedding = vectorFor(
				`${fixture.id}\n${fixture.title}\n${fixture.content}`,
			);
			await tx.insert(documents).values({
				id,
				ownerId,
				title: fixture.title,
				content: fixture.content,
				metadata: {
					benchmarkFixture: FIXTURE_VERSION,
					benchmarkAlias: fixture.id,
				},
				visibility: "private",
				embeddingStatus: "ready",
				activeEmbeddingGeneration: generationId,
				embeddingProfile: embeddingProfileId(
					config.EMBEDDING_MODEL ?? "openai/text-embedding-3-small",
					1024,
					"v1",
				),
				embeddingUpdatedAt: new Date(),
			});
			await tx.insert(documentEmbeddings).values({
				documentId: id,
				generationId,
				chunkIndex: 0,
				chunkText: fixture.content,
				chunkHash: new Bun.CryptoHasher("sha256")
					.update(fixture.content)
					.digest("hex"),
				charStart: 0,
				charEnd: fixture.content.length,
				embedding,
				embeddingModel:
					config.EMBEDDING_MODEL ?? "openai/text-embedding-3-small",
				embeddingDimensions: 1024,
				embeddingProfile: embeddingProfileId(
					config.EMBEDDING_MODEL ?? "openai/text-embedding-3-small",
					1024,
					"v1",
				),
				isValid: true,
			});
		}
	});

	await writePrivateJson(
		`${args.outputDir}/owner-credentials.json`,
		credentials,
	);
	await writePrivateJson(`${args.outputDir}/fixture-map.json`, {
		version: FIXTURE_VERSION,
		owners: Object.fromEntries(ownerIds),
		documents: documentIds,
	});
	console.log(
		JSON.stringify({
			fixtureVersion: FIXTURE_VERSION,
			outputDir: args.outputDir,
			ownerAliases: OWNER_ALIASES,
			documentCount: FIXTURE_DOCS.length,
		}),
	);
}

if (import.meta.main) await main();
