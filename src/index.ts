import { handleEmail } from "./email-handler";
import { handleAPI } from "./api/router";
import { processWebhookBatch } from "./lib/rules";
import { processRelayMessage } from "./lib/relay";
import { serveHostedSite, HOST_PREFIX } from "./lib/hosting";
import { processR2EventBatch, R2_EVENT_QUEUE, type R2EventNotification } from "./lib/r2-events";
import { runSweeps } from "./lib/reaper";
import { HOOK_PREFIX, serveWebhook } from "./lib/webhook-receive";
import type { Env, QueueMessage } from "./types";

function isHostedPath(pathname: string): boolean {
	return pathname === `/${HOST_PREFIX}` || pathname.startsWith(`/${HOST_PREFIX}/`);
}

function notFound(): Response {
	return new Response("Not found", {
		status: 404,
		headers: { "Content-Type": "text/plain; charset=utf-8" },
	});
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const hostedPath = isHostedPath(url.pathname);
		const appDomain = env.DOMAIN?.toLowerCase();
		const hostDomain = env.HOST_DOMAIN?.toLowerCase();

		// The deploy wrapper rejects this configuration too, but keep the runtime
		// boundary fail-closed if somebody bypasses that wrapper or an old binding
		// survives a manual deployment.
		if (!hostDomain || hostDomain === appDomain) {
			return new Response("Hosting origin misconfigured", { status: 503 });
		}

		// Untrusted hosted HTML gets an origin with no application, API, webhook,
		// or asset surface. This check must run before every other route.
		if (url.hostname.toLowerCase() === hostDomain) {
			if (hostedPath && (request.method === "GET" || request.method === "HEAD")) {
				return serveHostedSite(request, env, url);
			}
			return notFound();
		}

		if (url.pathname.startsWith("/api/")) {
			return handleAPI(request, env, url, ctx);
		}

		// Existing links keep working, but the application origin never serves the
		// uploaded bytes. Preserve private-site tokens and all other query params.
		if (hostedPath) {
			if (request.method !== "GET" && request.method !== "HEAD") return notFound();
			return new Response(null, {
				status: 301,
				headers: {
					Location: `https://${env.HOST_DOMAIN}${url.pathname}${url.search}`,
					"Cache-Control": "no-store",
					"Referrer-Policy": "no-referrer",
				},
			});
		}

		// Public webhook receivers at {domain}/h/{box}/{slug}[/...]. It stays out
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

	// The hourly cron: drops stuck in `pending` (presigns never spent, uploads
	// whose R2 notification was lost) and webhook events past their retention.
	// Both live in src/lib/reaper.ts; neither can cancel the other.
	async scheduled(
		_controller: ScheduledController,
		env: Env,
		ctx: ExecutionContext,
	): Promise<void> {
		ctx.waitUntil(
			runSweeps(env).then(
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
