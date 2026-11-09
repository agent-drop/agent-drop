/**
 * Secrets for the CLI.
 *
 * A real environment variable wins. When it is not set, the value comes from the
 * passage store through `key NAME` (~/.local/bin/key prints env/NAME). ~/.secrets
 * used to put these into every shell; it is being retired, so the env var is now
 * an override and passage is where the value lives.
 *
 * Nothing here ever prints, logs or returns a value inside an error message.
 */
import { homedir } from "node:os";
import { join } from "node:path";

type Env = Record<string, string | undefined>;

export interface SecretOptions {
	/** Environment to read, and to run `key` in. Defaults to process.env. */
	env?: Env;
	/** The `key` binary. Defaults to `key` on env.PATH, then $HOME/.local/bin/key. */
	keyBin?: string;
}

export type SecretLookup =
	| { found: true; value: string; source: "env" | "passage" }
	| { found: false; problem: string };

function keyBinFor(env: Env): string {
	return (
		Bun.which("key", { PATH: env.PATH ?? "" }) ??
		join(env.HOME ?? homedir(), ".local", "bin", "key")
	);
}

export function lookupSecret(name: string, opts: SecretOptions = {}): SecretLookup {
	const env = opts.env ?? process.env;
	const fromEnv = env[name];
	if (fromEnv) return { found: true, value: fromEnv, source: "env" };

	const bin = opts.keyBin ?? keyBinFor(env);
	let run: ReturnType<typeof Bun.spawnSync>;
	try {
		// The env is passed explicitly: without it Bun spawns with the environment the
		// process STARTED with, not the one this lookup was asked about.
		run = Bun.spawnSync([bin, name], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	} catch {
		return {
			found: false,
			problem: `${name} is not in the environment, and the passage reader \`key\` was not found (${bin})`,
		};
	}
	const value = run.stdout?.toString().trim() ?? "";
	if (run.success && value) return { found: true, value, source: "passage" };

	// Only stderr is quoted: `key` and age write errors there, never the secret.
	const said = run.stderr?.toString().trim().split("\n")[0];
	return {
		found: false,
		problem: `${name} is not in the environment, and \`key ${name}\` ${said ? `failed: ${said}` : "returned nothing"}`,
	};
}

export function readSecret(name: string, opts?: SecretOptions): string | undefined {
	const secret = lookupSecret(name, opts);
	return secret.found ? secret.value : undefined;
}

/** The one-line fix for a missing secret. Names the command, never a value. */
export function setSecretHint(name: string): string {
	return `Store it in passage with: key-set ${name}   (or export ${name} to override for one shell)`;
}
