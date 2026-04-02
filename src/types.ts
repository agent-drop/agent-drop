export interface Env {
	DB: D1Database;
	BUCKET: R2Bucket;
	ASSETS: Fetcher;
	DOMAIN: string;
	SES_REGION: string;
	AWS_ACCESS_KEY_ID: string;
	AWS_SECRET_ACCESS_KEY: string;
	ADMIN_API_KEY: string;
	GOOGLE_CLIENT_ID: string;
	GOOGLE_CLIENT_ID_PUBLIC: string;
	R2_ACCESS_KEY_ID: string;
	R2_SECRET_ACCESS_KEY: string;
	WEBHOOK_QUEUE: Queue<WebhookMessage>;
}

export interface WebhookMessage {
	logId: string;
	dropId: string;
	ruleId: string;
	target: string;
	payload: Record<string, unknown>;
	headers: Record<string, string>;
	attempt: number;
	firstAttemptAt: number;
}

export const R2_ACCOUNT_ID = "your-cloudflare-account-id";
export const R2_BUCKET = "agent-drop-storage";
export const R2_S3_ENDPOINT = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;

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

export interface ApiKey {
	id: string;
	key_hash: string;
	name: string;
	inbox_scope: string | null;
	permissions: string;
	created_at: number;
	last_used_at: number | null;
}
