import { expect, test } from "bun:test";
import postgres from "postgres";

const databaseUrl = process.env.PIPELINE_RLS_TEST_DATABASE_URL;

test.skipIf(!databaseUrl)(
	"Better Auth registers and signs in the same PostgreSQL account",
	async () => {
		const email = `${crypto.randomUUID()}@auth-compat.invalid`;
		const client = postgres(databaseUrl as string, { max: 1 });
		const script = `
    import { authRoutes } from "./src/api/routes/auth.ts";
    const email = process.env.AUTH_COMPAT_EMAIL;
    async function post(path, body) {
      const response = await authRoutes.handle(new Request(
        "http://localhost:50700/api/auth/" + path, {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://localhost:50701" },
          body: JSON.stringify(body)
        }));
      const data = await response.json();
      return { status: response.status, userId: data.user?.id };
    }
    const signup = await post("sign-up/email", { email, password: "synthetic-compat-password-123", name: "Auth compatibility" });
    const signin = await post("sign-in/email", { email, password: "synthetic-compat-password-123" });
    console.log("AUTH_COMPAT=" + JSON.stringify({ signup, signin }));
    process.exit(0);
  `;
		try {
			const result = Bun.spawnSync({
				cmd: ["bun", "--no-env-file", "-e", script],
				cwd: import.meta.dir.replace(/\/src\/__tests__$/, ""),
				env: {
					...process.env,
					NODE_ENV: "test",
					DATABASE_URL: databaseUrl,
					BETTER_AUTH_URL: "http://localhost:50700",
					TRUSTED_ORIGINS: "http://localhost:50701",
					AUTH_COMPAT_EMAIL: email,
				},
				stdout: "pipe",
				stderr: "pipe",
				timeout: 20_000,
			});
			expect(result.exitCode, result.stderr.toString()).toBe(0);
			const line = result.stdout
				.toString()
				.split("\n")
				.find((entry) => entry.startsWith("AUTH_COMPAT="));
			expect(line).toBeDefined();
			const outcome = JSON.parse(
				line?.slice("AUTH_COMPAT=".length) ?? "{}",
			) as {
				signup: { status: number; userId: string };
				signin: { status: number; userId: string };
			};
			expect(outcome.signup.status).toBe(200);
			expect(outcome.signin.status).toBe(200);
			expect(outcome.signin.userId).toBe(outcome.signup.userId);
			const [account] =
				await client`SELECT a.user_id, a.issuer FROM public.accounts a
      JOIN public.users u ON u.id = a.user_id WHERE u.email = ${email}`;
			expect(account).toEqual({
				user_id: outcome.signup.userId,
				issuer: "local:credential",
			});
		} finally {
			await client`DELETE FROM public.users WHERE email = ${email}`;
			await client.end();
		}
	},
	30_000,
);
