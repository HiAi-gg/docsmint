import { config } from "../lib/config";
import { closePipelineQueues } from "../queue/queues";
import {
	createBullMqRecoveryWriter,
	postgresRecoveryStore,
	recoverStalledPipeline,
} from "../queue/recovery";

const result = await recoverStalledPipeline(
	postgresRecoveryStore,
	createBullMqRecoveryWriter(config.REDIS_URL),
);
console.log(JSON.stringify(result));
await closePipelineQueues();
