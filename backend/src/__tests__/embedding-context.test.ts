import { expect, test } from "bun:test";
import * as queueAdapters from "../queue/adapters";
import * as prepareWorker from "../queue/workers/prepare.worker";

type BuildEmbeddingPreparation = (input: {
	title: string;
	content: string;
	metadata: {
		folderName?: string;
		categoryName?: string;
		tagNames?: string[];
	};
	providerIdentity: string;
}) => {
	contextHash: string;
	metadataPreamble: string;
	chunks: Array<{ storedChunkText: string; providerText: string }>;
};

type PlanEmbeddingReuse = (input: {
	refreshMode: "incremental" | "full";
	contextHash: string;
	activeContextHash: string | null;
	provider: { model: string; profile: string; dimensions: number };
	chunks: Array<{
		index: number;
		hash: string;
		storedChunkText: string;
		charStart: number;
		charEnd: number;
	}>;
	activeRows: Array<{
		chunkIndex: number;
		chunkHash: string | null;
		embedding: number[] | null;
		embeddingModel: string;
		embeddingProfile: string;
		embeddingDimensions: number;
		isValid: boolean;
	}>;
}) => {
	refreshMode: "incremental" | "full";
	providerChunkIndexes: number[];
	reusableChunkIndexes: number[];
};

test("embedding preparation is stable across tag row order and separates stored from provider text", () => {
	const buildEmbeddingPreparation = Reflect.get(
		prepareWorker,
		"buildEmbeddingPreparation",
	) as BuildEmbeddingPreparation | undefined;
	expect(buildEmbeddingPreparation).toBeFunction();
	if (!buildEmbeddingPreparation) return;

	const sourceChunk = "Title\n\nSource body";
	const first = buildEmbeddingPreparation({
		title: "Title",
		content: "Source body",
		metadata: {
			folderName: "Guides",
			categoryName: "Engineering",
			tagNames: ["release", "alpha"],
		},
		providerIdentity: "primary|model-a|1024|v1",
	});
	const second = buildEmbeddingPreparation({
		title: "Title",
		content: "Source body",
		metadata: {
			folderName: "Guides",
			categoryName: "Engineering",
			tagNames: ["alpha", "release"],
		},
		providerIdentity: "primary|model-a|1024|v1",
	});

	expect(first.contextHash).toBe(second.contextHash);
	expect(first.metadataPreamble).toBe(
		"Folder: Guides\nTags: alpha, release\nCategory: Engineering",
	);
	expect(first.chunks[0]?.storedChunkText).toBe(sourceChunk);
	expect(first.chunks[0]?.providerText).toBe(
		`${first.metadataPreamble}\n\n${sourceChunk}`,
	);
	expect(
		buildEmbeddingPreparation({
			...first,
			title: "Title",
			content: "Source body",
			metadata: {
				folderName: "Guides",
				categoryName: "Engineering",
				tagNames: ["alpha", "release"],
			},
			providerIdentity: "fallback|model-a|1024|v1",
		}).contextHash,
	).not.toBe(first.contextHash);
});

test("ready recovery selects the persisted fallback candidate profile", () => {
	const selectProfile = Reflect.get(
		queueAdapters,
		"_selectCandidateProfileForTests",
	) as
		| ((
				ready: boolean,
				configured: { model: string; profile: string; dimensions: number },
				candidate?: { model: string; profile: string; dimensions: number },
		  ) => { model: string; profile: string; dimensions: number })
		| undefined;
	expect(selectProfile).toBeFunction();
	if (!selectProfile) return;
	expect(
		selectProfile(
			true,
			{ model: "primary", profile: "primary:1024:v1", dimensions: 1024 },
			{ model: "fallback", profile: "fallback:1024:v1", dimensions: 1024 },
		),
	).toEqual({
		model: "fallback",
		profile: "fallback:1024:v1",
		dimensions: 1024,
	});
});

test("workspace metadata uses workspace scope instead of actor ownership", () => {
	const metadataTenant = Reflect.get(
		queueAdapters,
		"_metadataTenantContextForTests",
	) as
		| ((job: { ownerId: string; workspaceId?: string }) => {
				userId: string;
				source: "personal" | "external";
				workspaceId?: string;
		  })
		| undefined;
	expect(metadataTenant).toBeFunction();
	if (!metadataTenant) return;
	expect(
		metadataTenant({ ownerId: "actor", workspaceId: "workspace" }),
	).toEqual(
		expect.objectContaining({
			userId: "actor",
			source: "external",
			workspaceId: "workspace",
		}),
	);
});

test("reuse planning refreshes a changed chunk and its immediate neighbors", () => {
	const planEmbeddingReuse = Reflect.get(prepareWorker, "planEmbeddingReuse") as
		| PlanEmbeddingReuse
		| undefined;
	expect(planEmbeddingReuse).toBeFunction();
	if (!planEmbeddingReuse) return;

	const chunks = Array.from({ length: 5 }, (_, index) => ({
		index,
		hash: `hash-${index}`,
		storedChunkText: `chunk-${index}`,
		charStart: index * 10,
		charEnd: index * 10 + 7,
	}));
	const activeRows = chunks.map((chunk) => ({
		chunkIndex: chunk.index,
		chunkHash: chunk.index === 2 ? "old-hash" : chunk.hash,
		embedding: Array.from({ length: 1024 }, () => 1),
		embeddingModel: "model-a",
		embeddingProfile: "model-a:1024:v1",
		embeddingDimensions: 1024,
		isValid: true,
	}));
	const plan = planEmbeddingReuse({
		refreshMode: "incremental",
		contextHash: "context-a",
		activeContextHash: "context-a",
		provider: {
			model: "model-a",
			profile: "model-a:1024:v1",
			dimensions: 1024,
		},
		chunks,
		activeRows,
	});

	expect(plan.refreshMode).toBe("incremental");
	expect(plan.providerChunkIndexes).toEqual([1, 2, 3]);
	expect(plan.reusableChunkIndexes).toEqual([0, 4]);
});

test("reuse planning isolates an invalid row and its immediate neighbors", () => {
	const planEmbeddingReuse = Reflect.get(prepareWorker, "planEmbeddingReuse") as
		| PlanEmbeddingReuse
		| undefined;
	expect(planEmbeddingReuse).toBeFunction();
	if (!planEmbeddingReuse) return;
	const chunks = Array.from({ length: 5 }, (_, index) => ({
		index,
		hash: `hash-${index}`,
		storedChunkText: `chunk-${index}`,
		charStart: index * 10,
		charEnd: index * 10 + 7,
	}));
	const activeRows = chunks.map((chunk) => ({
		chunkIndex: chunk.index,
		chunkHash: chunk.hash,
		embedding: Array.from({ length: 1024 }, () => 1),
		embeddingModel: "model-a",
		embeddingProfile: "model-a:1024:v1",
		embeddingDimensions: 1024,
		isValid: chunk.index !== 2,
	}));
	const plan = planEmbeddingReuse({
		refreshMode: "incremental",
		contextHash: "context-a",
		activeContextHash: "context-a",
		provider: {
			model: "model-a",
			profile: "model-a:1024:v1",
			dimensions: 1024,
		},
		chunks,
		activeRows,
	});

	expect(plan.refreshMode).toBe("incremental");
	expect(plan.providerChunkIndexes).toEqual([1, 2, 3]);
	expect(plan.reusableChunkIndexes).toEqual([0, 4]);
});

test.each([
	["forced full refresh", "full", "context-a", "model-a"],
	["metadata context changed", "incremental", "context-b", "model-a"],
	["legacy null context", "incremental", null, "model-a"],
	["provider model changed", "incremental", "context-a", "model-b"],
] as const)("%s reuses zero rows", (_label, refreshMode, activeContextHash, activeModel) => {
	const planEmbeddingReuse = Reflect.get(prepareWorker, "planEmbeddingReuse") as
		| PlanEmbeddingReuse
		| undefined;
	expect(planEmbeddingReuse).toBeFunction();
	if (!planEmbeddingReuse) return;
	const plan = planEmbeddingReuse({
		refreshMode,
		contextHash: "context-a",
		activeContextHash,
		provider: {
			model: "model-a",
			profile: "model-a:1024:v1",
			dimensions: 1024,
		},
		chunks: [
			{
				index: 0,
				hash: "hash-0",
				storedChunkText: "chunk-0",
				charStart: 0,
				charEnd: 7,
			},
		],
		activeRows: [
			{
				chunkIndex: 0,
				chunkHash: "hash-0",
				embedding: Array.from({ length: 1024 }, () => 1),
				embeddingModel: activeModel,
				embeddingProfile: `${activeModel}:1024:v1`,
				embeddingDimensions: 1024,
				isValid: true,
			},
		],
	});
	expect(plan.refreshMode).toBe("full");
	expect(plan.providerChunkIndexes).toEqual([0]);
	expect(plan.reusableChunkIndexes).toEqual([]);
});
