import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const validator = resolve(import.meta.dir, "contract-evidence-validator.ts");
const temporaryDirectories: string[] = [];

type EvidenceStatus =
	| "proven"
	| "pending_publish"
	| "not_applicable_oss"
	| "partial"
	| "gap";

function manifest(
	overrides: {
		question?: Partial<{
			id: number;
			status: EvidenceStatus;
			evidence: string[];
			explanation: string;
		}>;
		requiresSaasMigration?: unknown;
	} = {},
) {
	const questions = Array.from({ length: 89 }, (_, index) => {
		const id = index + 1;
		return {
			id,
			question: `Checklist question ${id}`,
			status: id <= 5 ? "pending_publish" : "proven",
			evidence: [`test:evidence-${id}`],
			explanation:
				id <= 5 ? "Release-origin evidence is captured after publication." : undefined,
		};
	});
	if (overrides.question) {
		const id = overrides.question.id ?? 6;
		questions[id - 1] = {
			...questions[id - 1],
			...overrides.question,
			id,
		};
	}
	return {
		schemaVersion: 1,
		release: "0.7.0",
		requiresSaasMigration:
			overrides.requiresSaasMigration ?? {
				status: "pending_task_3",
				value: null,
				explanation:
					"Task 3 must set the release declaration to true before the prepublish gate can pass.",
			},
		questions,
	};
}

async function runValidator(
	value: unknown,
	phase: "task2" | "prepublish" | "postpublish" = "task2",
) {
	const directory = await mkdtemp(join(tmpdir(), "docsmint-contract-evidence-"));
	temporaryDirectories.push(directory);
	const path = join(directory, "manifest.json");
	await Bun.write(path, JSON.stringify(value));
	const process = Bun.spawn(
		["bun", "run", validator, "--phase", phase, path],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const [exitCode, stdout, stderr] = await Promise.all([
		process.exited,
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) =>
			rm(directory, { recursive: true, force: true }),
		),
	);
});

describe("0.7.0 contract evidence validator", () => {
	test("accepts exact 1-89 evidence only in the explicit Task 2 transition mode", async () => {
		const task2 = await runValidator(manifest(), "task2");
		expect(task2).toMatchObject({ exitCode: 0 });
		expect(task2.stdout).toContain(
			"Contract evidence valid for task2: 84 proven, 5 pending_publish, 0 not_applicable_oss",
		);

		const prepublish = await runValidator(manifest(), "prepublish");
		expect(prepublish.exitCode).toBe(1);
		expect(prepublish.stderr).toContain(
			"requiresSaasMigration is still pending Task 3",
		);
	});

	test("rejects missing, duplicate, and out-of-order checklist IDs", async () => {
		const missing = manifest();
		missing.questions.pop();
		expect((await runValidator(missing)).stderr).toContain(
			"questions must contain exactly 89 rows",
		);

		const duplicate = manifest();
		duplicate.questions[6] = { ...duplicate.questions[5] };
		expect((await runValidator(duplicate)).stderr).toContain(
			"questions must be ordered exactly from 1 through 89",
		);
	});

	test("rejects gap, partial, and pending_publish outside questions 1-5", async () => {
		for (const status of ["gap", "partial", "pending_publish"] as const) {
			const result = await runValidator(
				manifest({ question: { id: 6, status } }),
			);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain(
				status === "pending_publish"
					? "only questions 1-5 may be pending_publish"
					: `question 6 uses forbidden status ${status}`,
			);
		}
	});

	test("requires evidence and an explanation for OSS-inapplicable rows", async () => {
		const incomplete = await runValidator(
			manifest({
				question: {
					id: 40,
					status: "not_applicable_oss",
					evidence: [],
					explanation: "",
				},
			}),
		);
		expect(incomplete.exitCode).toBe(1);
		expect(incomplete.stderr).toContain(
			"question 40 not_applicable_oss requires an explanation",
		);
		expect(incomplete.stderr).toContain("question 40 requires evidence");
	});

	test("requires a completed true SaaS migration declaration before prepublish", async () => {
		const complete = manifest({
			requiresSaasMigration: {
				status: "complete",
				value: true,
				evidence: ["task3:migration-rehearsal"],
			},
		});
		expect((await runValidator(complete, "prepublish")).exitCode).toBe(0);

		const falseDeclaration = manifest({
			requiresSaasMigration: {
				status: "complete",
				value: false,
				evidence: ["task3:migration-rehearsal"],
			},
		});
		const rejected = await runValidator(falseDeclaration, "prepublish");
		expect(rejected.exitCode).toBe(1);
		expect(rejected.stderr).toContain(
			"requiresSaasMigration must be complete with value true",
		);
	});

	test("postpublish rejects all remaining pending_publish rows", async () => {
		const complete = manifest({
			requiresSaasMigration: {
				status: "complete",
				value: true,
				evidence: ["task3:migration-rehearsal"],
			},
		});
		const result = await runValidator(complete, "postpublish");
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain(
			"postpublish evidence cannot contain pending_publish",
		);
	});
});
