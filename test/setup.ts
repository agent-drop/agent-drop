import { plugin } from "bun";

// `cloudflare:email` only resolves inside the Workers runtime, so importing
// anything that reaches src/lib/relay.ts explodes under `bun test`. Register a
// virtual module for it so the worker's own code can be imported as-is.
plugin({
	name: "cloudflare-runtime-stubs",
	setup(build) {
		build.module("cloudflare:email", () => ({
			loader: "object",
			exports: {
				EmailMessage: class EmailMessage {
					constructor(
						public readonly from: string,
						public readonly to: string,
						public readonly raw: string,
					) {}
				},
			},
		}));
	},
});
