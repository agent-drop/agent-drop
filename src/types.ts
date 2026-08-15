export interface Env {
	DB: D1Database;
	BUCKET: R2Bucket;
	ASSETS: Fetcher;
	DOMAIN: string;
	BRAND: string;
	R2_ACCOUNT_ID: string;
	SES_REGION: string;
	AWS_ACCESS_KEY_ID: string;
	AWS_SECRET_ACCESS_KEY: string;
	ADMIN_API_KEY: string;
	GOOGLE_CLIENT_ID: string;
	GOOGLE_CLIENT_ID_PUBLIC: string;
	R2_ACCESS_KEY_ID: string;
	R2_SECRET_ACCESS_KEY: string;
	WEBHOOK_QUEUE: Queue<QueueMessage>;
	EMAIL: SendEmail;
	// Optional on purpose: the bindings do not exist in a `wrangler dev` session
	// that has no `[[ratelimits]]` configured, and src/lib/ratelimit.ts fails open
	// rather than letting a throttle become an outage.
	AUTH_RATE_LIMIT?: RateLimit;
	UPLOAD_RATE_LIMIT?: RateLimit;
}

export type QueueMessage = WebhookQueueMessage | RelayQueueMessage;

export interface WebhookQueueMessage {
	type: "webhook";
	logId: string;
	dropId: string;
	ruleId: string;
	target: string;
	payload: Record<string, unknown>;
	headers: Record<string, string>;
	attempt: number;
	firstAttemptAt: number;
}

export interface RelayQueueMessage {
	type: "relay";
	logId: string;
	maskId: string;
	direction: "inbound" | "reply";
	rawEmail: string;
	from: string;
	to: string;
	subject: string;
	attempt: number;
	firstAttemptAt: number;
}

export const R2_BUCKET = "agent-drop-storage";
// R2 S3-compatible object URL, built from the account id in env (env.R2_ACCOUNT_ID).
export const r2ObjectUrl = (env: Env, key: string) =>
	`https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET}/${key}`;

export interface Drop {
	id: string;
	inbox: string;
	topic: string | null;
	channel: "email" | "web" | "api";
	from_addr: string | null;
	from_user: string | null;
	subject: string | null;
	body_text: string | null;
	body_html: string | null;
	has_attachments: number;
	attachment_count: number;
	r2_prefix: string | null;
	raw_r2_key: string | null;
	metadata: string | null;
	created_at: number;
	read_at: number | null;
}

/** A registered webhook endpoint: one public URL at {domain}/h/{inbox}/{slug}. */
export interface WebhookReceiver {
	id: string;
	inbox: string;
	slug: string;
	label: string | null;
	auth_mode: string;
	auth_config: string | null;
	handshake_mode: string;
	handshake_config: string | null;
	preset: string | null;
	extract_config: string | null;
	response_status: number | null;
	response_body: string | null;
	response_content_type: string | null;
	allowed_methods: string | null;
	max_body_bytes: number | null;
	retention_days: number | null;
	daily_cap: number | null;
	mirror_to_drops: number;
	enabled: number;
	previous_slug: string | null;
	previous_slug_expires_at: number | null;
	expires_at: number | null;
	created_at: number;
	last_event_at: number | null;
	event_count: number;
}

/** One request that reached a receiver -- stored whatever we thought of it. */
export interface WebhookEvent {
	id: string;
	receiver_id: string;
	inbox: string;
	slug: string;
	subpath: string | null;
	method: string;
	event_type: string | null;
	routing_key: string | null;
	dedupe_key: string | null;
	headers: string | null;
	query: string | null;
	content_type: string | null;
	body_text: string | null;
	body_r2_key: string | null;
	body_bytes: number | null;
	body_sha256: string | null;
	verified: number | null;
	remote_ip: string | null;
	country: string | null;
	user_agent: string | null;
	status: "queued" | "leased" | "acked" | "rejected" | "handshake";
	lease_id: string | null;
	leased_until: number | null;
	lease_count: number;
	acked_at: number | null;
	created_at: number;
	expires_at: number;
}

export interface ApiKey {
	id: string;
	key_hash: string;
	name: string;
	inbox_scope: string | null;
	permissions: string;
	created_at: number;
	last_used_at: number | null;
}
