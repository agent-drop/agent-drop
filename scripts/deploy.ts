#!/usr/bin/env bun
/**
 * Deploy wrapper: `.env` is the single source of truth for deployment identity.
 *
 * The committed wrangler.toml carries only placeholders (example.com, your-*-id)
 * so the public repo leaks no real domain/account. This script renders those
 * placeholders from `.env` into a gitignored temp config, then runs
 * `wrangler deploy` against it. Bun auto-loads `.env` into process.env.
 *
 * Usage: bun run deploy   (package.json runs `vite build` first)
 */
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";

const REQUIRED = ["DOMAIN", "BRAND", "CLOUDFLARE_ACCOUNT_ID", "D1_DATABASE_ID", "GOOGLE_CLIENT_ID"];
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length) {
	console.error(`Missing required .env vars: ${missing.join(", ")}`);
	console.error("Copy .env.example to .env and fill in real values.");
	process.exit(1);
}

const domain = process.env.DOMAIN!;
const brand = process.env.BRAND!;
const rendered = readFileSync("wrangler.toml", "utf8")
	.replaceAll("your-cloudflare-account-id", process.env.CLOUDFLARE_ACCOUNT_ID!)
	.replaceAll("your-d1-database-id", process.env.D1_DATABASE_ID!)
	.replaceAll("your-google-client-id", process.env.GOOGLE_CLIENT_ID!)
	.replaceAll("example.com", domain)
	.replace(/BRAND = "Agent Drop"/, `BRAND = ${JSON.stringify(brand)}`);

const tmp = ".wrangler.deploy.toml";
writeFileSync(tmp, rendered);
try {
	const res = spawnSync("wrangler", ["deploy", "-c", tmp, ...process.argv.slice(2)], {
		stdio: "inherit",
	});
	process.exitCode = res.status ?? 1;
} finally {
	try {
		unlinkSync(tmp);
	} catch {}
}
