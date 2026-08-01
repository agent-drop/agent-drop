import { handleEmail } from "./email-handler";
import { handleAPI } from "./api/router";
import { processWebhookBatch } from "./lib/rules";
import { processRelayMessage } from "./lib/relay";
import { serveHostedSite, HOST_PREFIX } from "./lib/hosting";
import type { Env, QueueMessage } from "./types";

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname.startsWith("/api/")) {
			return handleAPI(request, env, url, ctx);
		}

		// Public static hosting at {domain}/f/{box}/{site}/... served from R2.
		// Scoped to the /f/ prefix (in run_worker_first) so it never touches the
		// app's own pages or any other route.
		if (url.pathname === `/${HOST_PREFIX}` || url.pathname.startsWith(`/${HOST_PREFIX}/`)) {
			return serveHostedSite(request, env, url);
		}

		return env.ASSETS.fetch(request);
	},

	async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
		try {
			await handleEmail(message, env, ctx);
		} catch (err) {
			console.error("Email handler error:", err);
		}
	},

	async queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
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
