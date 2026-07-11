import { Queue, QueueEvents } from "bullmq";
import { createBullMqConnection } from "./connection";
import type { PipelineJob, PipelineStage } from "./contracts";
import { DEFAULT_JOB_OPTIONS, QUEUE_NAMES } from "./names";

const queues = new Map<PipelineStage, Queue<PipelineJob>>();
const queueEvents = new Map<PipelineStage, QueueEvents>();

export function getPipelineQueue(
	stage: PipelineStage,
	redisUrl: string,
): Queue<PipelineJob> {
	const existing = queues.get(stage);
	if (existing) return existing;
	const queue = new Queue<PipelineJob>(QUEUE_NAMES[stage], {
		connection: createBullMqConnection(redisUrl),
		defaultJobOptions: DEFAULT_JOB_OPTIONS,
	});
	queues.set(stage, queue);
	return queue;
}

export function getPipelineQueueEvents(
	stage: PipelineStage,
	redisUrl: string,
): QueueEvents {
	const existing = queueEvents.get(stage);
	if (existing) return existing;
	const events = new QueueEvents(QUEUE_NAMES[stage], {
		connection: createBullMqConnection(redisUrl),
	});
	queueEvents.set(stage, events);
	return events;
}

export async function closePipelineQueues(): Promise<void> {
	await Promise.all([
		...[...queueEvents.values()].map((events) => events.close()),
		...[...queues.values()].map((queue) => queue.close()),
	]);
	queueEvents.clear();
	queues.clear();
}
