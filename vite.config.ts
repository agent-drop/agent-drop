import { defineConfig, loadEnv } from "vite";
import tailwindcss from "@tailwindcss/vite";

// Brand + domain come from `.env` (single source of truth, gitignored).
// Committed defaults are generic placeholders so the repo carries no real domain.
export default defineConfig(({ mode }) => {
	const env = loadEnv(mode, process.cwd(), "");
	const BRAND = env.BRAND || "Agent Drop";
	const DOMAIN = env.DOMAIN || "example.com";

	return {
		root: "web",
		plugins: [
			tailwindcss(),
			{
				// Substitute %BRAND% / %DOMAIN% tokens in index.html at build time.
				name: "brand-html",
				transformIndexHtml(html: string) {
					return html.replaceAll("%BRAND%", BRAND).replaceAll("%DOMAIN%", DOMAIN);
				},
			},
		],
		define: {
			__BRAND__: JSON.stringify(BRAND),
			__DOMAIN__: JSON.stringify(DOMAIN),
		},
		build: {
			outDir: "dist",
			emptyOutDir: true,
		},
		server: {
			proxy: {
				"/api": "http://localhost:8787",
			},
		},
	};
});
