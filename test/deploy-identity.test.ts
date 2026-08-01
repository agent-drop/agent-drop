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
	readDeployIdentity,
	renderBrandTokens,
} from "../scripts/deploy-identity.ts";

const REAL: DeployIdentity = {
	domain: "drops.example-real.dev",
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
			brand: PLACEHOLDERS.brand,
			accountId: PLACEHOLDERS.accountId,
			d1DatabaseId: PLACEHOLDERS.d1DatabaseId,
			googleClientId: PLACEHOLDERS.googleClientId,
		});
	});

	test("reads every field from its documented .env var", () => {
		const identity = readDeployIdentity({
			[IDENTITY_VARS.domain]: REAL.domain,
			[IDENTITY_VARS.brand]: REAL.brand,
			[IDENTITY_VARS.accountId]: REAL.accountId,
			[IDENTITY_VARS.d1DatabaseId]: REAL.d1DatabaseId,
			[IDENTITY_VARS.googleClientId]: REAL.googleClientId,
		});
		expect(identity).toEqual(REAL);
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
		expect(config.vars?.BRAND).toBe(PLACEHOLDERS.brand);
		expect(config.vars?.R2_ACCOUNT_ID).toBe(PLACEHOLDERS.accountId);
		expect(config.vars?.GOOGLE_CLIENT_ID_PUBLIC).toBe(PLACEHOLDERS.googleClientId);
		expect(config.routes).toEqual([
			{ pattern: `${PLACEHOLDERS.domain}/*`, zone_name: PLACEHOLDERS.domain },
		]);
	});

	// The counterpart guarantee: every placeholder the file carries is one the
	// injector knows how to replace. Add a new placeholder to a field
	// applyDeployIdentity does not visit and this fails.
	test("has no placeholder left anywhere once the identity is applied", () => {
		const config = committedConfig();
		applyDeployIdentity(config, REAL);
		const serialized = JSON.stringify(config);
		for (const token of [
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
			routes: [{ pattern: `${PLACEHOLDERS.domain}/*`, zone_name: PLACEHOLDERS.domain }],
			d1_databases: [{ database_id: PLACEHOLDERS.d1DatabaseId }],
			vars: {
				DOMAIN: PLACEHOLDERS.domain,
				BRAND: PLACEHOLDERS.brand,
				R2_ACCOUNT_ID: PLACEHOLDERS.accountId,
				GOOGLE_CLIENT_ID_PUBLIC: PLACEHOLDERS.googleClientId,
				SES_REGION: "eu-central-1",
			},
		};
		applyDeployIdentity(config, REAL);
		expect(config).toEqual({
			account_id: REAL.accountId,
			routes: [{ pattern: `${REAL.domain}/*`, zone_name: REAL.domain }],
			d1_databases: [{ database_id: REAL.d1DatabaseId }],
			vars: {
				DOMAIN: REAL.domain,
				BRAND: REAL.brand,
				R2_ACCOUNT_ID: REAL.accountId,
				GOOGLE_CLIENT_ID_PUBLIC: REAL.googleClientId,
				SES_REGION: "eu-central-1",
			},
		});
	});

	test("handles the string form of a route", () => {
		const config: IdentityFields = { routes: [`${PLACEHOLDERS.domain}/*`] };
		applyDeployIdentity(config, REAL);
		expect(config.routes).toEqual([`${REAL.domain}/*`]);
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
		// Every identity-bearing field is wrong, and the route no longer matches.
		expect(problems.length).toBe(6);
		expect(problems.join("\n")).toContain(PLACEHOLDERS.accountId);
	});

	test("catches a stale account id on its own", () => {
		const config = injected();
		config.account_id = PLACEHOLDERS.accountId;
		expect(checkDeployIdentity(config, REAL)).toEqual([
			`account_id is "${PLACEHOLDERS.accountId}", expected "${REAL.accountId}"`,
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
		config.routes = [{ pattern: "someone-elses.dev/*", zone_name: "someone-elses.dev" }];
		expect(checkDeployIdentity(config, REAL)).toHaveLength(1);
	});

	test("accepts a route given as a bare string", () => {
		const config = injected();
		config.routes = [`${REAL.domain}/*`];
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
