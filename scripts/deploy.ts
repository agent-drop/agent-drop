#!/usr/bin/env bun
/**
 * Deploy wrapper: `.env` is the single source of truth for deployment identity.
 *
 * The committed wrangler.toml carries only placeholders (example.com, your-*-id)
 * so the public repo leaks no real domain/account. `vite build` (via the
 * Cloudflare plugin's `config` hook, see `vite.config.ts`) injects the real
 * values from `.env` into the Worker config it generates in the build output;
 * this script finds that generated config, checks it really carries what `.env`
 * asked for, and deploys it. Bun auto-loads `.env` into process.env.
 *
 * Usage: bun run deploy   (package.json runs `vite build` first)
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
	checkDeployIdentity,
	describeSpawnFailure,
	type IdentityFields,
	readDeployIdentity,
	REQUIRED_IDENTITY_VARS,
} from "./deploy-identity.ts";

/**
 * Where the Vite plugin records the path of the config it generated. Relative
 * to the Vite root (`web/`), which is why this is not the repo root.
 */
const DEPLOY_REDIRECT = "web/.wrangler/deploy/config.json";

const missing = REQUIRED_IDENTITY_VARS.filter((key) => !process.env[key]);
if (missing.length) {
	console.error(`Missing required .env vars: ${missing.join(", ")}`);
	console.error("Copy .env.example to .env and fill in real values.");
	process.exit(1);
}

if (!existsSync(DEPLOY_REDIRECT)) {
	console.error(`No build output found at ${DEPLOY_REDIRECT}.`);
	console.error("Run `vite build` first (`bun run deploy` does this for you).");
	process.exit(1);
}

const redirect = JSON.parse(readFileSync(DEPLOY_REDIRECT, "utf8")) as { configPath: string };
const configPath = path.resolve(path.dirname(DEPLOY_REDIRECT), redirect.configPath);
if (!existsSync(configPath)) {
	console.error(`Build output references a missing Worker config: ${configPath}`);
	process.exit(1);
}

// Guard the thing that would otherwise fail silently: a build that ran without
// `.env` produces a placeholder config, and deploying it would point the Worker
// at the wrong account, domain and database.
const identity = readDeployIdentity(process.env);
const generated = JSON.parse(readFileSync(configPath, "utf8")) as IdentityFields;
const problems = checkDeployIdentity(generated, identity);
if (problems.length) {
	console.error(`Built Worker config (${configPath}) does not match .env:`);
	for (const problem of problems) console.error(`  - ${problem}`);
	console.error("Re-run `vite build` with .env present.");
	process.exit(1);
}

// Through `bunx`, not bare `wrangler`: wrangler is a devDependency, so a bare
// spawn only resolves when node_modules/.bin happens to be on PATH. It is when
// this runs under `bun run deploy`, and it is NOT when something invokes the
// script directly -- which is exactly how CI ran it, and why the dry-run there
// failed without printing a word.
const res = spawnSync("bunx", ["wrangler", "deploy", "-c", configPath, ...process.argv.slice(2)], {
	stdio: "inherit",
});

const spawnFailure = describeSpawnFailure(res);
if (spawnFailure) console.error(spawnFailure);
process.exitCode = res.status ?? 1;
