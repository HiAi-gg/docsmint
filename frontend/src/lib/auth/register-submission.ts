import {
	type AuthClientFailure,
	authFailureMessage,
} from "./auth-failure-message";

export interface RegistrationInput {
	name: string;
	email: string;
	password: string;
}

interface RegistrationDependencies {
	signUp(input: RegistrationInput): Promise<{
		error?: AuthClientFailure;
	}>;
	navigate(path: string): Promise<void>;
	onLoading(value: boolean): void;
	onError(value: string): void;
	signupError: string;
	networkError: string;
}

export async function submitRegistration(
	input: RegistrationInput,
	dependencies: RegistrationDependencies,
): Promise<void> {
	dependencies.onLoading(true);
	try {
		const result = await dependencies.signUp(input);
		if (result.error) {
			dependencies.onError(
				authFailureMessage(result.error, {
					credentialError: dependencies.signupError,
					networkError: dependencies.networkError,
				}),
			);
			return;
		}
		await dependencies.navigate("/");
	} catch {
		dependencies.onError(dependencies.networkError);
	} finally {
		dependencies.onLoading(false);
	}
}
