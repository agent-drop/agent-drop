import { handleEmail } from "./email-handler";
import { handleAPI } from "./api/router";
import { processWebhookBatch } from "./lib/rules";
import { processRelayMessage } from "./lib/relay";
import { serveHostedSite, HOST_PREFIX } from "./lib/hosting";
import { processR2EventBatch, R2_EVENT_QUEUE, type R2EventNotification } from "./lib/r2-events";
import { runScheduled } from "./lib/reaper";
import { HOOK_PREFIX, serveWebhook } from "./lib/webhook-receive";
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

		// Public webhook receivers at {domain}/h/{box}/{slug}[/...]. Scoped to the
		// /h/ prefix (in run_worker_first) for the same reason /f/ is: it stays out
		// of the /api/ namespace, whose invariant is "unknown path answers 401, not
		// 404" -- and a fully public, unauthenticated, body-swallowing endpoint has
		// no business inside that.
		if (url.pathname === `/${HOOK_PREFIX}` || url.pathname.startsWith(`/${HOOK_PREFIX}/`)) {
			return serveWebhook(request, env, url, ctx);
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

	// Hourly sweep for drops stuck in `pending` -- presigns that were never
	// spent, and uploads whose R2 notification was lost. See src/lib/reaper.ts.
	async scheduled(
		_controller: ScheduledController,
		env: Env,
		ctx: ExecutionContext,
	): Promise<void> {
		ctx.waitUntil(
			runScheduled(env).then(
				() => {},
				(err: unknown) => {
					console.error("Reaper error:", err);
				},
			),
		);
	},

	async queue(batch: MessageBatch<QueueMessage | R2EventNotification>, env: Env): Promise<void> {
		// Two queues land here. R2's notification bodies are R2's shape -- no `type`
		// discriminator to switch on -- so the queue name is what separates them.
		if (batch.queue === R2_EVENT_QUEUE) {
			return processR2EventBatch(batch as MessageBatch<R2EventNotification>, env);
		}

		for (const msg of batch.messages as Message<QueueMessage>[]) {
			if (msg.body.type === "relay") {
				await processRelayMessage(msg as any, env);
			} else {
				// Webhook (default, backwards compat for messages without type field)
				await processWebhookBatch({ messages: [msg as any] } as any, env);
			}
		}
	},
};
