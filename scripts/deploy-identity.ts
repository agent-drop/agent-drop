/**
 * Deployment identity: the bridge between `.env` and the Worker config.
 *
 * The committed `wrangler.toml` carries ONLY placeholders, so the public repo
 * leaks no real domain, account or database id. The real values live in `.env`
 * and are injected into the Worker config at build time by the Cloudflare Vite
 * plugin's `config` hook (see `vite.config.ts`), which writes them into the
 * generated `dist/<worker>/wrangler.json` that `scripts/deploy.ts` deploys.
 *
 * Injection is STRUCTURAL, not a whole-file string replace: only the four
 * fields that actually carry a placeholder are touched, so a placeholder token
 * appearing incidentally elsewhere (an absolute path, a comment) is left alone.
 */

/** The literal placeholder tokens committed to `wrangler.toml`. */
export const PLACEHOLDERS = {
	domain: "example.com",
	accountId: "your-cloudflare-account-id",
	d1DatabaseId: "your-d1-database-id",
	googleClientId: "your-google-client-id",
	brand: "Agent Drop",
} as const;

/** The `.env` variable backing each placeholder. */
export const IDENTITY_VARS = {
	domain: "DOMAIN",
	brand: "BRAND",
	accountId: "CLOUDFLARE_ACCOUNT_ID",
	d1DatabaseId: "D1_DATABASE_ID",
	googleClientId: "GOOGLE_CLIENT_ID",
} as const;

export interface DeployIdentity {
	domain: string;
	brand: string;
	accountId: string;
	d1DatabaseId: string;
	googleClientId: string;
}

/**
 * The shape of the Worker config this module mutates. Deliberately structural
 * and minimal so it stays assignable from the plugin's full `WorkerConfig` and
 * constructible in tests without dragging that type in.
 */
export interface IdentityFields {
	account_id?: string;
	routes?: unknown[];
	d1_databases?: { database_id?: string }[];
	vars?: Record<string, unknown>;
}

/**
 * Read the identity out of an environment, falling back to the committed
 * placeholder for anything unset -- a bare `vite build` with no `.env` must
 * still produce a config, it just produces the placeholder one.
 */
export function readDeployIdentity(env: Record<string, string | undefined>): DeployIdentity {
	return {
		domain: env[IDENTITY_VARS.domain] || PLACEHOLDERS.domain,
		brand: env[IDENTITY_VARS.brand] || PLACEHOLDERS.brand,
		accountId: env[IDENTITY_VARS.accountId] || PLACEHOLDERS.accountId,
		d1DatabaseId: env[IDENTITY_VARS.d1DatabaseId] || PLACEHOLDERS.d1DatabaseId,
		googleClientId: env[IDENTITY_VARS.googleClientId] || PLACEHOLDERS.googleClientId,
	};
}

function substitute(value: string, identity: DeployIdentity): string {
	return value
		.replaceAll(PLACEHOLDERS.accountId, identity.accountId)
		.replaceAll(PLACEHOLDERS.d1DatabaseId, identity.d1DatabaseId)
		.replaceAll(PLACEHOLDERS.googleClientId, identity.googleClientId)
		.replaceAll(PLACEHOLDERS.domain, identity.domain);
}

function substituteRoute(route: unknown, identity: DeployIdentity): unknown {
	if (typeof route === "string") return substitute(route, identity);
	if (!route || typeof route !== "object") return route;
	const next = { ...(route as Record<string, unknown>) };
	for (const key of ["pattern", "zone_name", "custom_domain"]) {
		const value = next[key];
		if (typeof value === "string") next[key] = substitute(value, identity);
	}
	return next;
}

/** Mutate a Worker config in place, replacing every placeholder with the real value. */
export function applyDeployIdentity(config: IdentityFields, identity: DeployIdentity): void {
	if (typeof config.account_id === "string") {
		config.account_id = substitute(config.account_id, identity);
	}
	if (Array.isArray(config.routes)) {
		config.routes = config.routes.map((route) => substituteRoute(route, identity));
	}
	if (Array.isArray(config.d1_databases)) {
		for (const database of config.d1_databases) {
			if (typeof database.database_id === "string") {
				database.database_id = substitute(database.database_id, identity);
			}
		}
	}
	if (config.vars) {
		for (const [key, value] of Object.entries(config.vars)) {
			if (typeof value === "string") config.vars[key] = substitute(value, identity);
		}
		// BRAND is a free-text display name, not a token, so it is set rather than
		// substituted -- the committed value doubles as the default.
		if (typeof config.vars.BRAND === "string") config.vars.BRAND = identity.brand;
	}
}

/** The part of a `spawnSync` result that says whether the child ever ran. */
export interface SpawnOutcome {
	status: number | null;
	signal?: NodeJS.Signals | string | null;
	error?: Error & { code?: string };
}

/**
 * Explain a wrangler that never ran, or null if it ran (whatever it exited with).
 *
 * `spawnSync` reports a child that could not be started as `status: null` plus
 * an `error` -- and with `stdio: "inherit"` there is nothing on the terminal to
 * see, so the deploy wrapper exited 1 in total silence. For a script whose
 * entire job is to stop a silent wrong deploy, failing silently is the worst
 * available behaviour.
 *
 * A non-zero exit from a wrangler that DID run is not this function's business:
 * wrangler already printed its own error, and restating it adds noise.
 */
export function describeSpawnFailure(res: SpawnOutcome): string | null {
	if (res.status !== null) return null;
	if (res.signal) return `wrangler was killed by ${res.signal} before it could finish.`;
	const detail = res.error?.code ? `${res.error.code}: ${res.error.message}` : res.error?.message;
	return (
		`Could not run wrangler (${detail ?? "spawn failed"}).\n` +
		"It is a devDependency, so it only resolves when node_modules/.bin is on\n" +
		"PATH -- run this through `bun run deploy`, or invoke it with `bunx`."
	);
}

/** Substitute the `%BRAND%` / `%DOMAIN%` tokens the SPA's index.html carries. */
export function renderBrandTokens(html: string, identity: DeployIdentity): string {
	return html.replaceAll("%BRAND%", identity.brand).replaceAll("%DOMAIN%", identity.domain);
}

/**
 * Check that a built Worker config carries the identity `.env` asked for.
 *
 * This is the deploy-time guard that the build actually injected: comparing
 * against `.env` rather than scanning for leftover placeholder text, because a
 * placeholder-valued `.env` (CI, which copies `.env.example`) is legitimate and
 * must still pass.
 */
export function checkDeployIdentity(config: IdentityFields, identity: DeployIdentity): string[] {
	const problems: string[] = [];
	if (config.account_id !== identity.accountId) {
		problems.push(`account_id is "${config.account_id}", expected "${identity.accountId}"`);
	}
	const databaseId = config.d1_databases?.[0]?.database_id;
	if (databaseId !== identity.d1DatabaseId) {
		problems.push(`d1 database_id is "${databaseId}", expected "${identity.d1DatabaseId}"`);
	}
	if (config.vars?.DOMAIN !== identity.domain) {
		problems.push(`vars.DOMAIN is "${config.vars?.DOMAIN}", expected "${identity.domain}"`);
	}
	if (config.vars?.BRAND !== identity.brand) {
		problems.push(`vars.BRAND is "${config.vars?.BRAND}", expected "${identity.brand}"`);
	}
	if (config.vars?.GOOGLE_CLIENT_ID_PUBLIC !== identity.googleClientId) {
		problems.push(
			`vars.GOOGLE_CLIENT_ID_PUBLIC is "${config.vars?.GOOGLE_CLIENT_ID_PUBLIC}", expected "${identity.googleClientId}"`,
		);
	}
	const routes = (config.routes ?? []).map((route) =>
		typeof route === "string" ? route : (route as { pattern?: string })?.pattern,
	);
	if (!routes.some((pattern) => pattern?.includes(identity.domain))) {
		problems.push(`no route matches domain "${identity.domain}" (routes: ${routes.join(", ")})`);
	}
	return problems;
}
