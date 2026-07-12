import { describe, expect, test } from "bun:test";
import { migrateLegacyEmbeddingEntries } from "../queue/legacy-bridge";
import {
	createPipelineWorkerFactories,
	type ManagedPipelineWorker,
	type PipelineStageDependencies,
	startPipelineWorkers,
} from "../queue/start";

function worker(events: string[], stage: string): ManagedPipelineWorker {
	return {
		async waitUntilReady() {
			events.push(`${stage}:ready`);
		},
		async pause(doNotWaitActive) {
			events.push(`${stage}:pause:${String(doNotWaitActive)}`);
		},
		async close(force) {
			events.push(`${stage}:close:${String(force)}`);
		},
	};
}

describe("pipeline worker lifecycle", () => {
	test("migrates raw and retry-envelope legacy queue entries before startup", async () => {
		const entries = [
			"11111111-1111-4111-8111-111111111111",
			JSON.stringify({
				documentId: "22222222-2222-4222-8222-222222222222",
				attempt: 2,
			}),
		];
		const enqueued: string[] = [];
		const result = await migrateLegacyEmbeddingEntries(
			async () => entries.shift() ?? null,
			async (documentId) => {
				enqueued.push(documentId);
				return true;
			},
		);
		expect(result).toEqual({ migrated: 2, failed: 0 });
		expect(enqueued).toEqual([
			"11111111-1111-4111-8111-111111111111",
			"22222222-2222-4222-8222-222222222222",
		]);
	});

	test("registers every concrete stage factory from injected adapters", () => {
		const dependencies = {
			prepare: {},
			embed: {},
			graph: {},
			summarize: {},
			finalize: {},
		} as PipelineStageDependencies;
		const factories = createPipelineWorkerFactories(
			"redis://127.0.0.1:6379",
			dependencies,
		);
		expect(Object.keys(factories)).toEqual([
			"prepare",
			"embed",
			"graph",
			"summarize",
			"finalize",
		]);
	});

	test("runs recovery before factories accept jobs and registers stages independently", async () => {
		const events: string[] = [];
		const runtime = await startPipelineWorkers({
			async recover() {
				events.push("recover");
			},
			workerFactories: {
				prepare: () => {
					events.push("prepare:factory");
					return worker(events, "prepare");
				},
				embed: () => {
					events.push("embed:factory");
					return worker(events, "embed");
				},
			},
			queues: {
				prepare: {
					async pause() {},
					async resume() {
						events.push("prepare:resume");
					},
				},
				embed: {
					async pause() {},
					async resume() {
						events.push("embed:resume");
					},
				},
			},
			async closeQueues() {
				events.push("queues:close");
			},
		});
		expect(events).toEqual([
			"recover",
			"prepare:resume",
			"embed:resume",
			"prepare:factory",
			"prepare:ready",
			"embed:factory",
			"embed:ready",
		]);
		expect([...runtime.workers.keys()]).toEqual(["prepare", "embed"]);
		await runtime.close();
	});

	test("pauses intake, grants active work a grace period, and closes resources in order", async () => {
		const events: string[] = [];
		const runtime = await startPipelineWorkers({
			async recover() {},
			workerFactories: { embed: () => worker(events, "embed") },
			queues: {
				embed: {
					async resume() {
						events.push("queue:resume");
					},
					async pause() {
						events.push("queue:pause");
					},
				},
			},
			async closeQueues() {
				events.push("queues:close");
			},
			async closeConnections() {
				events.push("connections:close");
			},
		});
		expect(events).toContain("queue:resume");
		events.length = 0;
		await runtime.close();
		expect(events).toEqual([
			"queue:pause",
			"embed:pause:true",
			"embed:close:false",
			"queues:close",
			"connections:close",
		]);
	});

	test("forces worker closure after the grace deadline and close is idempotent", async () => {
		const events: string[] = [];
		let resolveGraceful: (() => void) | undefined;
		const slowWorker: ManagedPipelineWorker = {
			async close(force) {
				events.push(`close:${String(force)}`);
				if (!force)
					await new Promise<void>((resolve) => (resolveGraceful = resolve));
			},
		};
		const runtime = await startPipelineWorkers({
			async recover() {},
			workerFactories: { graph: () => slowWorker },
			async closeQueues() {
				events.push("queues:close");
			},
			shutdownGraceMs: 1,
			sleep: async () => {},
		});
		const first = runtime.close();
		const second = runtime.close();
		expect(first).toBe(second);
		await first;
		resolveGraceful?.();
		expect(events).toEqual(["close:false", "close:true", "queues:close"]);
	});

	test("cleans already-started workers when a later factory fails", async () => {
		const events: string[] = [];
		await expect(
			startPipelineWorkers({
				async recover() {},
				workerFactories: {
					prepare: () => worker(events, "prepare"),
					embed: () => {
						throw new Error("embed startup failed");
					},
				},
				async closeQueues() {
					events.push("queues:close");
				},
			}),
		).rejects.toThrow("embed startup failed");
		expect(events).toContain("prepare:close:true");
		expect(events).toContain("queues:close");
	});
});
