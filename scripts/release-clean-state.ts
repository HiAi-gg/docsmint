import { resolve } from "node:path";

import { assertCleanRepository } from "./release-gate.ts";

const root = resolve(import.meta.dir, "..");
await assertCleanRepository(root);
console.log("Release candidate clean-state check passed");
