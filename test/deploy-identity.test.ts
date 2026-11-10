import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import wranglerToml from "../wrangler.toml";
import {
	applyDeployIdentity,
	checkDeployIdentity,
	type DeployIdentity,
	type IdentityFields,
	IDENTITY_VARS,
	PLACEHOLDERS,
	describeSpawnFailure,
	readDeployIdentity,
	renderBrandTokens,
} from "../scripts/deploy-identity.ts";

const REAL: DeployIdentity = {
	domain: "drops.example-real.dev",
	hostDomain: "files.example-real.dev",
	mailDomain: "example-real.dev",
	zoneName: "example-real.dev",
	brand: "FRST",
	accountId: "aaaaaaaabbbbbbbbccccccccdddddddd",
	d1DatabaseId: "11111111-2222-3333-4444-555555555555",
	googleClientId: "9999-abc.apps.googleusercontent.com",
};

/**
 * A fresh copy of the committed wrangler.toml -- the file the public repo
 * carries. Cloned because `applyDeployIdentity` mutates in place and the import
 * is shared across the whole suite.
 */
function committedConfig(): IdentityFields & Record<string, unknown> {
	return structuredClone(wranglerToml) as IdentityFields & Record<string, unknown>;
}

describe("readDeployIdentity", () => {
	test("falls back to the committed placeholders when nothing is set", () => {
		expect(readDeployIdentity({})).toEqual({
			domain: PLACEHOLDERS.domain,
			hostDomain: PLACEHOLDERS.hostDomain,
			mailDomain: PLACEHOLDERS.domain,
			zoneName: PLACEHOLDERS.domain,
			brand: PLACEHOLDERS.brand,
			accountId: PLACEHOLDERS.accountId,
			d1DatabaseId: PLACEHOLDERS.d1DatabaseId,
			googleClientId: PLACEHOLDERS.googleClientId,
		});
	});

	test("reads every field from its documented .env var", () => {
		const identity = readDeployIdentity({
			[IDENTITY_VARS.domain]: REAL.domain,
			[IDENTITY_VARS.hostDomain]: REAL.hostDomain,
			[IDENTITY_VARS.mailDomain]: REAL.mailDomain,
			[IDENTITY_VARS.zoneName]: REAL.zoneName,
			[IDENTITY_VARS.brand]: REAL.brand,
			[IDENTITY_VARS.accountId]: REAL.accountId,
			[IDENTITY_VARS.d1DatabaseId]: REAL.d1DatabaseId,
			[IDENTITY_VARS.googleClientId]: REAL.googleClientId,
		});
		expect(identity).toEqual(REAL);
	});

	// The compatibility guarantee: a deployment whose Worker host, mail domain
	// and zone are all one apex never has to know these two vars exist.
	test("MAIL_DOMAIN and ZONE_NAME fall back to DOMAIN when unset", () => {
		const identity = readDeployIdentity({ [IDENTITY_VARS.domain]: REAL.domain });
		expect(identity.mailDomain).toBe(REAL.domain);
		expect(identity.zoneName).toBe(REAL.domain);
	});

	test("treats an empty string as unset rather than as a real value", () => {
		expect(readDeployIdentity({ [IDENTITY_VARS.domain]: "" }).domain).toBe(PLACEHOLDERS.domain);
	});
});

describe("the committed wrangler.toml", () => {
	// The public-repo guarantee, as a test: this file must never carry a real
	// domain, account or database id. If someone renders values into it by hand,
	// this fails.
	test("carries only placeholders", () => {
		const config = committedConfig();
		expect(config.account_id).toBe(PLACEHOLDERS.accountId);
		expect(config.d1_databases?.[0]?.database_id).toBe(PLACEHOLDERS.d1DatabaseId);
		expect(config.vars?.DOMAIN).toBe(PLACEHOLDERS.domain);
		expect(config.vars?.HOST_DOMAIN).toBe(PLACEHOLDERS.hostDomain);
		expect(config.vars?.MAIL_DOMAIN).toBe(PLACEHOLDERS.domain);
		expect(config.vars?.BRAND).toBe(PLACEHOLDERS.brand);
		expect(config.vars?.R2_ACCOUNT_ID).toBe(PLACEHOLDERS.accountId);
		expect(config.vars?.GOOGLE_CLIENT_ID_PUBLIC).toBe(PLACEHOLDERS.googleClientId);
		expect(config.routes).toEqual([
			{ pattern: `${PLACEHOLDERS.domain}/*`, zone_name: PLACEHOLDERS.domain },
			{ pattern: `${PLACEHOLDERS.hostDomain}/*`, zone_name: PLACEHOLDERS.domain },
		]);
		expect((config.assets as { run_worker_first?: unknown }).run_worker_first).toBe(true);
	});

	// The counterpart guarantee: every placeholder the file carries is one the
	// injector knows how to replace. Add a new placeholder to a field
	// applyDeployIdentity does not visit and this fails.
	test("has no placeholder left anywhere once the identity is applied", () => {
		const config = committedConfig();
		applyDeployIdentity(config, REAL);
		const serialized = JSON.stringify(config);
		for (const token of [
			PLACEHOLDERS.hostDomain,
			PLACEHOLDERS.domain,
			PLACEHOLDERS.accountId,
			PLACEHOLDERS.d1DatabaseId,
			PLACEHOLDERS.googleClientId,
		]) {
			expect(serialized).not.toContain(token);
		}
	});

	test("passes the deploy-time identity check after injection", () => {
		const config = committedConfig();
		applyDeployIdentity(config, REAL);
		expect(checkDeployIdentity(config, REAL)).toEqual([]);
	});
});

describe("applyDeployIdentity", () => {
	test("replaces the account id, route, database id and vars", () => {
		const config: IdentityFields = {
			account_id: PLACEHOLDERS.accountId,
			routes: [
				{ pattern: `${PLACEHOLDERS.domain}/*`, zone_name: PLACEHOLDERS.domain },
				{ pattern: `${PLACEHOLDERS.hostDomain}/*`, zone_name: PLACEHOLDERS.domain },
			],
			d1_databases: [{ database_id: PLACEHOLDERS.d1DatabaseId }],
			vars: {
				DOMAIN: PLACEHOLDERS.domain,
				HOST_DOMAIN: PLACEHOLDERS.hostDomain,
				MAIL_DOMAIN: PLACEHOLDERS.domain,
				BRAND: PLACEHOLDERS.brand,
				R2_ACCOUNT_ID: PLACEHOLDERS.accountId,
				GOOGLE_CLIENT_ID_PUBLIC: PLACEHOLDERS.googleClientId,
				SES_REGION: "eu-central-1",
			},
		};
		applyDeployIdentity(config, REAL);
		expect(config).toEqual({
			account_id: REAL.accountId,
			routes: [
				{ pattern: `${REAL.domain}/*`, zone_name: REAL.zoneName },
				{ pattern: `${REAL.hostDomain}/*`, zone_name: REAL.zoneName },
			],
			d1_databases: [{ database_id: REAL.d1DatabaseId }],
			vars: {
				DOMAIN: REAL.domain,
				HOST_DOMAIN: REAL.hostDomain,
				MAIL_DOMAIN: REAL.mailDomain,
				BRAND: REAL.brand,
				R2_ACCOUNT_ID: REAL.accountId,
				GOOGLE_CLIENT_ID_PUBLIC: REAL.googleClientId,
				SES_REGION: "eu-central-1",
			},
		});
	});

	test("handles the string form of a route", () => {
		const config: IdentityFields = {
			routes: [`${PLACEHOLDERS.domain}/*`, `${PLACEHOLDERS.hostDomain}/*`],
		};
		applyDeployIdentity(config, REAL);
		expect(config.routes).toEqual([`${REAL.domain}/*`, `${REAL.hostDomain}/*`]);
	});

	test("leaves fields that carry no placeholder alone", () => {
		const config = {
			name: "agent-drop",
			main: "src/index.ts",
			r2_buckets: [{ binding: "BUCKET", bucket_name: "agent-drop-storage" }],
			vars: { SES_REGION: "eu-central-1" },
		} as IdentityFields & Record<string, unknown>;
		applyDeployIdentity(config, REAL);
		expect(config.name).toBe("agent-drop");
		expect(config.main).toBe("src/index.ts");
		expect(config.r2_buckets).toEqual([{ binding: "BUCKET", bucket_name: "agent-drop-storage" }]);
		expect(config.vars?.SES_REGION).toBe("eu-central-1");
	});

	test("sets BRAND rather than substituting it, so a brand equal to the default still applies", () => {
		const config: IdentityFields = { vars: { BRAND: PLACEHOLDERS.brand } };
		applyDeployIdentity(config, { ...REAL, brand: "Some Other Brand" });
		expect(config.vars?.BRAND).toBe("Some Other Brand");
	});

	test("is a no-op on a config with none of the identity fields", () => {
		const config: IdentityFields = {};
		applyDeployIdentity(config, REAL);
		expect(config).toEqual({});
	});
});

describe("checkDeployIdentity", () => {
	function injected(): IdentityFields {
		const config = committedConfig();
		applyDeployIdentity(config, REAL);
		return config;
	}

	test("reports a config that was built without .env", () => {
		const config = committedConfig();
		const problems = checkDeployIdentity(config, REAL);
		// Every identity-bearing field is wrong, and neither the route pattern nor
		// its zone_name matches.
		expect(problems.length).toBe(11);
		expect(problems.join("\n")).toContain(PLACEHOLDERS.accountId);
	});

	test("catches a stale account id on its own", () => {
		const config = injected();
		config.account_id = PLACEHOLDERS.accountId;
		expect(checkDeployIdentity(config, REAL)).toEqual([
			`account_id is "${PLACEHOLDERS.accountId}", expected "${REAL.accountId}"`,
		]);
	});

	test("rejects a hosting origin equal to the application origin", () => {
		const identity = { ...REAL, hostDomain: REAL.domain };
		const config = committedConfig();
		applyDeployIdentity(config, identity);
		expect(checkDeployIdentity(config, identity)).toEqual([
			"HOST_DOMAIN must differ from DOMAIN to isolate uploaded content",
		]);
	});

	test("catches a stale database id on its own", () => {
		const config = injected();
		const [database] = config.d1_databases ?? [];
		expect(database).toBeDefined();
		if (database) database.database_id = PLACEHOLDERS.d1DatabaseId;
		expect(checkDeployIdentity(config, REAL)).toHaveLength(1);
	});

	test("catches a route pointing at the wrong domain", () => {
		const config = injected();
		config.routes = [
			{ pattern: "someone-elses.dev/*", zone_name: REAL.zoneName },
			{ pattern: `${REAL.hostDomain}/*`, zone_name: REAL.zoneName },
		];
		expect(checkDeployIdentity(config, REAL)).toHaveLength(1);
	});

	test("catches a missing dedicated-host route", () => {
		const config = injected();
		config.routes = [{ pattern: `${REAL.domain}/*`, zone_name: REAL.zoneName }];
		expect(checkDeployIdentity(config, REAL)).toEqual([
			`no route matches host domain "${REAL.hostDomain}" (routes: ${REAL.domain}/*)`,
		]);
	});

	// The failure this guard exists for: `zone_name` names a Cloudflare zone, so
	// a Worker on a subdomain must not carry its own host there. Left unchecked,
	// wrangler fails at zone lookup with an error that reads like a bad token.
	test("catches a zone_name that copied the Worker host", () => {
		const config = injected();
		config.routes = [
			{ pattern: `${REAL.domain}/*`, zone_name: REAL.domain },
			{ pattern: `${REAL.hostDomain}/*`, zone_name: REAL.zoneName },
		];
		expect(checkDeployIdentity(config, REAL)).toEqual([
			`route zone_name is "${REAL.domain}", expected "${REAL.zoneName}"`,
		]);
	});

	test("accepts a route given as a bare string", () => {
		const config = injected();
		config.routes = [`${REAL.domain}/*`, `${REAL.hostDomain}/*`];
		expect(checkDeployIdentity(config, REAL)).toEqual([]);
	});
});

describe("renderBrandTokens", () => {
	test("substitutes every occurrence of both tokens", () => {
		const html = "<title>%BRAND%</title><meta content='%DOMAIN%'><p>%BRAND% at %DOMAIN%</p>";
		expect(renderBrandTokens(html, REAL)).toBe(
			`<title>FRST</title><meta content='${REAL.domain}'><p>FRST at ${REAL.domain}</p>`,
		);
	});

	test("leaves html with no tokens untouched", () => {
		expect(renderBrandTokens("<p>nothing here</p>", REAL)).toBe("<p>nothing here</p>");
	});

	test("the committed index.html still uses the tokens rather than a hardcoded brand", () => {
		const html = readFileSync(`${import.meta.dir}/../web/index.html`, "utf8");
		expect(html).toContain("%BRAND%");
		expect(renderBrandTokens(html, REAL)).toContain("FRST");
		expect(renderBrandTokens(html, REAL)).not.toContain("%BRAND%");
	});
});

describe("describeSpawnFailure", () => {
	// The deploy wrapper exists to stop a silent wrong deploy. It was doing the
	// silent thing itself: when `wrangler` is not on PATH, spawnSync returns
	// `status: null` with an `error`, `stdio: "inherit"` prints nothing, and the
	// script exited 1 having said nothing at all. That is what turned the CI
	// deploy dry-run red -- it is the one CI step not run through bunx/bun run,
	// so node_modules/.bin is not on its PATH.
	test("explains a spawn that never started", () => {
		const message = describeSpawnFailure({
			status: null,
			error: Object.assign(new Error("spawnSync wrangler ENOENT"), { code: "ENOENT" }),
		});
		expect(message).toContain("wrangler");
		expect(message).toContain("ENOENT");
	});

	test("says nothing when wrangler ran, whatever it exited with", () => {
		// A non-zero wrangler is wrangler's story to tell; it already printed it.
		expect(describeSpawnFailure({ status: 0 })).toBeNull();
		expect(describeSpawnFailure({ status: 1 })).toBeNull();
	});

	test("covers a signal kill, which also leaves status null", () => {
		expect(describeSpawnFailure({ status: null, signal: "SIGKILL" })).toContain("SIGKILL");
	});
});
