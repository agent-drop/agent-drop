import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, loadEnv } from "vite";
import {
	applyDeployIdentity,
	readDeployIdentity,
	renderBrandTokens,
} from "./scripts/deploy-identity.ts";

// Brand + domain come from `.env` (single source of truth, gitignored).
// Committed defaults are generic placeholders so the repo carries no real domain.
export default defineConfig(({ mode }) => {
	const env = loadEnv(mode, process.cwd(), "");
	const identity = readDeployIdentity(env);

	return {
		root: "web",
		plugins: [
			tailwindcss(),
			// Runs the real Workers runtime (D1/R2/Queues/assets) behind `vite dev`,
			// and emits a deployable `wrangler.json` alongside the client build.
			cloudflare({
				configPath: "../wrangler.toml",
				// The committed wrangler.toml carries only placeholders; the real
				// deployment identity is injected here, from `.env`, at build time.
				config: (config) => applyDeployIdentity(config, identity),
			}),
			{
				// Substitute %BRAND% / %DOMAIN% tokens in index.html at build time.
				name: "brand-html",
				transformIndexHtml(html: string) {
					return renderBrandTokens(html, identity);
				},
			},
		],
		define: {
			__BRAND__: JSON.stringify(identity.brand),
			__DOMAIN__: JSON.stringify(identity.domain),
			__MAIL_DOMAIN__: JSON.stringify(identity.mailDomain),
		},
		build: {
			outDir: "dist",
			emptyOutDir: true,
		},
	};
});
