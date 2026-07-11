import { db } from "@hiai-docs/db";
import { accounts, sessions, users, verifications } from "@hiai-docs/db/schema";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { config } from "./config";
import { logger } from "./logger";

async function sendEmailVerification(data: {
	user: { email: string };
	newEmail?: string;
	url: string;
}): Promise<void> {
	// hiai-docs does not bundle an SMTP/provider integration. Keep the callback
	// explicit: local operators can complete the flow from the URL, while a
	// production deployment must provide a real mail adapter before enabling it.
	if (config.NODE_ENV === "production") {
		logger.error(
			{ email: data.user.email },
			"Email verification delivery is not configured for production",
		);
		throw new Error("Email verification delivery is not configured");
	}
	logger.warn(
		{
			email: data.user.email,
			newEmail: data.newEmail,
			verificationUrl: data.url,
		},
		"Email verification URL generated for local development",
	);
}

export const auth = betterAuth({
	database: drizzleAdapter(db, {
		provider: "pg",
		schema: {
			user: users,
			session: sessions,
			account: accounts,
			verification: verifications,
		},
	}),
	secret: config.BETTER_AUTH_SECRET,
	baseURL: config.BETTER_AUTH_URL,
	trustedOrigins: process.env.TRUSTED_ORIGINS
		? process.env.TRUSTED_ORIGINS.split(",").map((s) => s.trim())
		: ["http://localhost:50701", "http://127.0.0.1:50701"],
	emailAndPassword: {
		enabled: true,
	},
	emailVerification: {
		sendVerificationEmail: async ({ user, url }) => {
			await sendEmailVerification({ user, url });
		},
	},
	user: {
		changeEmail: {
			enabled: true,
			updateEmailWithoutVerification: false,
			sendChangeEmailConfirmation: async ({ user, newEmail, url }) => {
				await sendEmailVerification({ user, newEmail, url });
			},
		},
	},
	session: {
		expiresIn: 60 * 60 * 24 * 7, // 7 days
		updateAge: 60 * 60 * 24, // 1 day
	},
	advanced: {
		database: {
			generateId: false,
		},
		disableCSRFCheck: true,
	},
});
