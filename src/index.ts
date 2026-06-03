import { handleEmail } from "./email-handler";
import { handleAPI } from "./api/router";
import { processWebhookBatch } from "./lib/rules";
import { processRelayMessage } from "./lib/relay";
import { serveHostedSite } from "./lib/hosting";
import type { Env, QueueMessage } from "./types";

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		const url = new URL(request.url);

		// Public static hosting: {box}.example.com/{site}/... served from R2.
		// Returns null for the apex domain (and reserved labels) so the app/API
		// take over below. run_worker_first=true guarantees we see every request.
		const hosted = await serveHostedSite(request, env, url);
		if (hosted) return hosted;

		if (url.pathname.startsWith("/api/")) {
			return handleAPI(request, env, url, ctx);
		}

		return env.ASSETS.fetch(request);
	},

	async email(
		message: ForwardableEmailMessage,
		env: Env,
		ctx: ExecutionContext,
	): Promise<void> {
		try {
			await handleEmail(message, env, ctx);
		} catch (err) {
			console.error("Email handler error:", err);
		}
	},

	async queue(
		batch: MessageBatch<QueueMessage>,
		env: Env,
	): Promise<void> {
		for (const msg of batch.messages) {
			if (msg.body.type === "relay") {
				await processRelayMessage(msg as any, env);
			} else {
				// Webhook (default, backwards compat for messages without type field)
				await processWebhookBatch({ messages: [msg as any] } as any, env);
			}
		}
	},
};
