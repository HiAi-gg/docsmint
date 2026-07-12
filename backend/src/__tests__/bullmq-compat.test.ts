import { describe, expect, test } from "bun:test";
import { Queue, QueueEvents, Worker } from "bullmq";

const redisUrl = process.env.BULLMQ_SMOKE_REDIS_URL;
const liveTest = redisUrl ? test : test.skip;

describe("BullMQ Bun compatibility", () => {
	liveTest(
		"supports retry, delay, QueueEvents, and graceful close",
		async () => {
			const endpoint = new URL(redisUrl as string);
			const connection = {
				host: endpoint.hostname,
				port: Number(endpoint.port || 6379),
				maxRetriesPerRequest: null,
			};
			const queueName = `hiai-docs-bullmq-smoke-${crypto.randomUUID()}`;
			const queue = new Queue<{ value: number }, number, string>(queueName, {
				connection,
			});
			const events = new QueueEvents(queueName, { connection });
			let attempts = 0;
			const worker = new Worker<{ value: number }, number, string>(
				queueName,
				async (job) => {
					attempts += 1;
					if (attempts === 1) throw new Error("transient smoke failure");
					return job.data.value * 2;
				},
				{ connection },
			);

			try {
				await events.waitUntilReady();
				await worker.waitUntilReady();
				const job = await queue.add(
					"compatibility",
					{ value: 21 },
					{ attempts: 2, backoff: { type: "fixed", delay: 100 }, delay: 50 },
				);
				const result = await job.waitUntilFinished(events, 10_000);
				expect(result).toBe(42);
				expect(attempts).toBe(2);
				expect(await job.getState()).toBe("completed");
			} finally {
				await worker.close();
				await events.close();
				await queue.obliterate({ force: true });
				await queue.close();
			}
		},
		15_000,
	);
});
