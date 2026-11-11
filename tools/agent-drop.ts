#!/usr/bin/env bun
/**
 * Agent Drop CLI - Manage drop inboxes, targets, and API keys
 *
 * Interacts with an Agent Drop instance (set AGENT_DROP_URL) for receiving
 * emails, web form submissions, and API drops into named inboxes.
 */

import { Command } from "commander";
import { formatOutput, addCommonOptions, createLogger } from "./lib/cli-utils";
import { signRequest } from "./lib/hook-sign";
import { emitEvents } from "./lib/queue-emit";
import { previewRule } from "./lib/rule-preview";
import { lookupSecret, type SecretLookup, setSecretHint } from "./lib/secrets";
import { replayableHeaders } from "../src/lib/webhook-headers";
import chalk from "chalk";
import * as fs from "node:fs";
import * as path from "node:path";
import * as yaml from "yaml";

// ============================================================================
// Config
// ============================================================================

const PROJECT_ROOT = path.resolve(import.meta.dir, "..");
const AGENT_DROP_ENV = path.join(PROJECT_ROOT, ".env");

function loadEnvFile(filePath: string): Record<string, string> {
	if (!fs.existsSync(filePath)) return {};
	const content = fs.readFileSync(filePath, "utf8");
	const vars: Record<string, string> = {};
	for (const line of content.split("\n")) {
		const match = line.match(/^([A-Z_]+)=(.+)$/);
		if (match) vars[match[1]] = match[2].trim();
	}
	return vars;
}

// Load the project .env (the shell env and passage take precedence)
const envVars = loadEnvFile(AGENT_DROP_ENV);

// Shell env var, else passage (`key NAME`, which replaced the ~/.secrets export).
// Memoized: every API call asks, and a passage read is an age decrypt.
const secretLookups = new Map<string, SecretLookup>();
function cliSecret(name: string): SecretLookup {
	let lookup = secretLookups.get(name);
	if (!lookup) {
		lookup = lookupSecret(name);
		secretLookups.set(name, lookup);
	}
	return lookup;
}

function getAdminKey(): string {
	const admin = cliSecret("AGENT_DROP_ADMIN_KEY");
	const key = admin.found ? admin.value : envVars.ADMIN_API_KEY;
	if (!key) {
		console.error(chalk.red("No admin key found."));
		if (!admin.found) console.error(chalk.dim(admin.problem));
		console.error(chalk.dim(setSecretHint("AGENT_DROP_ADMIN_KEY")));
		console.error(chalk.dim("Or add ADMIN_API_KEY to agent-drop/.env"));
		process.exit(1);
	}
	return key;
}

function getApiKey(): string {
	// For inbox/send routes, use the ad_* API key
	const api = cliSecret("AGENT_DROP_API_KEY");
	const key = api.found ? api.value : envVars.API_KEY;
	if (!key) {
		// Fall back to admin key (works for admin-only routes)
		return getAdminKey();
	}
	return key;
}

function getBaseUrl(): string {
	// Precedence: shell env > .env AGENT_DROP_URL > .env DOMAIN (self-configures) > placeholder
	return (
		process.env.AGENT_DROP_URL ||
		envVars.AGENT_DROP_URL ||
		(envVars.DOMAIN ? `https://${envVars.DOMAIN}` : "https://example.com")
	);
}

// Display host of the base URL, used in help text about URLs.
function getDomain(): string {
	try {
		return new URL(getBaseUrl()).host;
	} catch {
		return "example.com";
	}
}

// The domain box addresses live on. Read separately rather than taken from the
// base URL's host: the Worker may be served from a subdomain of the zone it
// sends mail from, in which case the two differ.
function getMailDomain(): string {
	return process.env.MAIL_DOMAIN || envVars.MAIL_DOMAIN || getDomain();
}

// ============================================================================
// API Client
// ============================================================================

async function api(
	path: string,
	options: { method?: string; body?: unknown; admin?: boolean } = {},
): Promise<any> {
	const url = `${getBaseUrl()}${path}`;
	const key = options.admin ? getAdminKey() : getApiKey();

	const res = await fetch(url, {
		method: options.method || "GET",
		headers: {
			Authorization: `Bearer ${key}`,
			"Content-Type": "application/json",
		},
		body: options.body ? JSON.stringify(options.body) : undefined,
	});

	if (!res.ok) {
		const text = await res.text();
		let msg: string;
		try {
			msg = JSON.parse(text).error || text;
		} catch {
			msg = text;
		}
		throw new Error(`API ${res.status}: ${msg}`);
	}

	return res.json();
}

async function apiRaw(path: string): Promise<Response> {
	const url = `${getBaseUrl()}${path}`;
	const key = getApiKey();
	const res = await fetch(url, {
		headers: { Authorization: `Bearer ${key}` },
	});
	if (!res.ok) {
		throw new Error(`API ${res.status}: ${await res.text()}`);
	}
	return res;
}

// ============================================================================
// Time Helpers
// ============================================================================

function relativeTime(epochMs: number): string {
	const diff = Date.now() - epochMs;
	if (diff < 0) return "in the future";
	if (diff < 60_000) return "just now";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
	if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`;
	return new Date(epochMs).toISOString().slice(0, 10);
}

function parseDuration(dur: string): number {
	const match = dur.match(/^(\d+)(s|m|h|d|w)$/);
	if (!match) throw new Error(`Invalid duration: ${dur} (use e.g. 1h, 24h, 7d)`);
	const n = parseInt(match[1], 10);
	const unit = match[2];
	const multipliers: Record<string, number> = {
		s: 1000,
		m: 60_000,
		h: 3_600_000,
		d: 86_400_000,
		w: 604_800_000,
	};
	return n * multipliers[unit];
}

function isoDate(epochMs: number): string {
	return new Date(epochMs).toISOString().replace("T", " ").slice(0, 19);
}

// ============================================================================
// Table Formatting
// ============================================================================

function padRight(str: string, len: number): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC is the point -- this strips ANSI SGR codes so chalk-coloured cells pad to their visible width.
	const stripped = str.replace(/\x1b\[\d+m/g, "");
	const pad = Math.max(0, len - stripped.length);
	return str + " ".repeat(pad);
}

function padLeft(str: string, len: number): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: see padRight.
	const stripped = str.replace(/\x1b\[\d+m/g, "");
	const pad = Math.max(0, len - stripped.length);
	return " ".repeat(pad) + str;
}

function truncate(str: string, len: number): string {
	if (str.length <= len) return str;
	return `${str.slice(0, len - 1)}\u2026`;
}

// ============================================================================
// Drop Formatters
// ============================================================================

function formatDropRow(drop: any): string {
	const time = relativeTime(drop.created_at);
	const inbox = chalk.cyan(drop.inbox);
	const channel = chalk.dim(drop.channel);
	const subject = drop.subject ? truncate(drop.subject, 50) : chalk.dim("(no subject)");
	const from = drop.from_addr ? chalk.dim(truncate(drop.from_addr, 30)) : "";
	const unread = drop.read_at ? " " : chalk.yellow("*");
	const files = drop.attachment_count > 0 ? chalk.dim(` [${drop.attachment_count} files]`) : "";

	return `${unread} ${padRight(time, 10)} ${padRight(inbox, 14)} ${padRight(channel, 5)} ${subject}${files} ${from}`;
}

// ============================================================================
// Commands
// ============================================================================

async function cmdDrops(options: any) {
	const log = createLogger(options.quiet);
	const params = new URLSearchParams();

	if (options.limit) params.set("limit", options.limit);

	if (options.since) {
		const ms = parseDuration(options.since);
		params.set("since", String(Date.now() - ms));
	}

	if (options.channel) params.set("channel", options.channel);

	let url = "/api/drops";
	// If --box is set, use the inbox endpoint instead
	if (options.box) {
		url = `/api/inbox/${encodeURIComponent(options.box)}`;
	}

	const qs = params.toString();
	if (qs) url += `?${qs}`;

	// /api/drops needs admin auth, /api/inbox/* uses API key
	const useAdmin = !options.box;
	const data = await api(url, { admin: useAdmin });
	const drops = data.drops || [];

	if (options.format === "json") {
		formatOutput(data, options);
		return;
	}

	if (drops.length === 0) {
		log.info("No drops found");
		return;
	}

	console.log(chalk.bold(`\n  Drops (${drops.length}):\n`));
	console.log(
		chalk.dim(
			`  ${padRight("", 2)}${padRight("WHEN", 10)} ${padRight("INBOX", 14)} ${padRight("CH", 5)} SUBJECT`,
		),
	);
	for (const drop of drops) {
		console.log(`  ${formatDropRow(drop)}`);
	}
	console.log("");
}

async function cmdBoxes(options: any) {
	const data = await api("/api/boxes", { admin: true });
	const boxes = data.boxes || [];

	if (options.format === "json") {
		formatOutput(data, options);
		return;
	}

	if (boxes.length === 0) {
		console.log(chalk.dim("No boxes found"));
		return;
	}

	console.log(chalk.bold(`\n  Boxes (${boxes.length}):\n`));
	console.log(
		chalk.dim(
			`  ${padRight("NAME", 18)} ${padLeft("TOTAL", 6)} ${padLeft("UNREAD", 7)} ${padLeft("FILES", 6)} ${padRight("CHANNELS", 14)} ${padRight("LAST DROP", 12)} TOKENS`,
		),
	);

	for (const box of boxes) {
		const unread = box.unread > 0 ? chalk.yellow(String(box.unread)) : chalk.dim("0");
		const lastDrop = box.last_drop_at ? relativeTime(box.last_drop_at) : chalk.dim("never");
		const tokens = box.active_tokens > 0 ? chalk.green(String(box.active_tokens)) : chalk.dim("0");

		console.log(
			`  ${padRight(chalk.cyan(box.inbox), 18)} ` +
				`${padLeft(String(box.total_drops), 6)} ` +
				`${padLeft(unread, 7)} ` +
				`${padLeft(String(box.total_files || 0), 6)} ` +
				`${padRight(box.channels || "", 14)} ` +
				`${padRight(lastDrop, 12)} ` +
				`${tokens}`,
		);
	}
	console.log("");
}

async function cmdInbox(name: string, options: any) {
	const params = new URLSearchParams();
	if (options.limit) params.set("limit", options.limit);
	if (options.unread) params.set("unread", "true");
	if (options.topic) params.set("topic", options.topic);

	const qs = params.toString();
	const url = `/api/inbox/${encodeURIComponent(name)}${qs ? `?${qs}` : ""}`;

	const data = await api(url);
	const drops = data.drops || [];

	if (options.format === "json") {
		formatOutput(data, options);
		return;
	}

	if (drops.length === 0) {
		console.log(chalk.dim(`No drops in inbox "${name}"`));
		return;
	}

	console.log(chalk.bold(`\n  Inbox: ${chalk.cyan(name)} (${drops.length} drops)\n`));
	console.log(
		chalk.dim(`  ${padRight("", 2)}${padRight("WHEN", 10)} ${padRight("CH", 5)} SUBJECT`),
	);

	for (const drop of drops) {
		const time = relativeTime(drop.created_at);
		const channel = chalk.dim(drop.channel);
		const subject = drop.subject ? truncate(drop.subject, 60) : chalk.dim("(no subject)");
		const unread = drop.read_at ? " " : chalk.yellow("*");
		const files = drop.attachment_count > 0 ? chalk.dim(` [${drop.attachment_count} files]`) : "";
		const from = drop.from_addr ? chalk.dim(` <${truncate(drop.from_addr, 25)}>`) : "";

		console.log(
			`  ${unread} ${padRight(time, 10)} ${padRight(channel, 5)} ${subject}${files}${from}`,
		);
	}
	console.log("");
}

async function cmdTarget(name: string, options: any) {
	const ttl = parseInt(options.ttl || "2", 10);

	const data = await api("/api/targets", {
		method: "POST",
		body: { inbox: name, ttl_hours: ttl },
		admin: true,
	});

	if (options.format === "json") {
		formatOutput(data, options);
		return;
	}

	console.log(chalk.bold(`\n  Drop target created\n`));
	console.log(`  Inbox:     ${chalk.cyan(data.inbox)}`);
	console.log(`  URL:       ${chalk.green(data.url)}`);
	console.log(`  Token:     ${chalk.dim(data.token)}`);
	console.log(`  Expires:   ${isoDate(data.expires_at)} (${data.expires_in})`);
	console.log("");
}

async function cmdTargets(options: any) {
	const data = await api("/api/targets", { admin: true });
	const targets = data.targets || [];

	if (options.format === "json") {
		formatOutput(data, options);
		return;
	}

	if (targets.length === 0) {
		console.log(chalk.dim("No active drop targets"));
		return;
	}

	console.log(chalk.bold(`\n  Active targets (${targets.length}):\n`));
	console.log(
		chalk.dim(
			`  ${padRight("ID", 38)} ${padRight("INBOX", 18)} ${padRight("EXPIRES", 12)} CREATED BY`,
		),
	);

	for (const t of targets) {
		const remaining = t.expires_at - Date.now();
		const expiresStr =
			remaining > 0 ? chalk.green(`in ${Math.ceil(remaining / 3_600_000)}h`) : chalk.red("expired");

		console.log(
			`  ${padRight(chalk.dim(t.id), 38)} ` +
				`${padRight(chalk.cyan(t.inbox), 18)} ` +
				`${padRight(expiresStr, 12)} ` +
				`${t.created_by || chalk.dim("-")}`,
		);
	}
	console.log("");
}

async function cmdPoll(options: any) {
	const log = createLogger(options.quiet);
	const interval = parseInt(options.interval || "5", 10) * 1000;
	const continuous = options.continuous || false;
	const periodMs = continuous ? Infinity : parseDuration(options.period || "10m");
	const startTime = Date.now();
	let lastSeen = Date.now();

	const boxFilter = options.box ? `/${encodeURIComponent(options.box)}` : "";
	const endpoint = options.box ? `/api/inbox${boxFilter}` : "/api/drops";

	log.info(
		`Polling ${options.box || "all boxes"} every ${interval / 1000}s${continuous ? " (continuous)" : ` for ${options.period || "10m"}`}...`,
	);

	while (true) {
		const elapsed = Date.now() - startTime;
		if (!continuous && elapsed >= periodMs) {
			log.info("Poll period ended");
			break;
		}

		try {
			const data = await api(`${endpoint}?since=${lastSeen}&limit=50`, { admin: !options.box });
			const drops = data.drops || [];

			if (drops.length > 0) {
				for (const drop of drops.reverse()) {
					if (drop.created_at > lastSeen) lastSeen = drop.created_at;

					if (options.format === "json") {
						console.log(JSON.stringify(drop));
					} else {
						const time = new Date(drop.created_at).toISOString().slice(11, 19);
						const inbox = chalk.cyan(drop.inbox || options.box);
						const subject = drop.subject || "(no subject)";
						const from = drop.from_addr ? chalk.dim(` <${drop.from_addr}>`) : "";
						console.log(`  ${chalk.dim(time)} ${inbox} [${drop.channel}] ${subject}${from}`);
					}
				}
			}
		} catch (err: any) {
			log.error(`Poll error: ${err.message}`);
		}

		await new Promise((resolve) => setTimeout(resolve, interval));
	}
}

async function cmdKeys(options: any) {
	const data = await api("/api/keys", { admin: true });
	const keys = data.keys || [];

	if (options.format === "json") {
		formatOutput(data, options);
		return;
	}

	if (keys.length === 0) {
		console.log(chalk.dim("No API keys"));
		return;
	}

	console.log(chalk.bold(`\n  API Keys (${keys.length}):\n`));
	console.log(
		chalk.dim(
			`  ${padRight("ID", 38)} ${padRight("NAME", 20)} ${padRight("PERMS", 8)} ${padRight("SCOPE", 14)} ${padRight("CREATED", 12)} LAST USED`,
		),
	);

	for (const k of keys) {
		const created = relativeTime(k.created_at);
		const lastUsed = k.last_used_at ? relativeTime(k.last_used_at) : chalk.dim("never");
		const permsColor =
			k.permissions === "admin"
				? chalk.red
				: k.permissions === "write"
					? chalk.yellow
					: chalk.green;

		console.log(
			`  ${padRight(chalk.dim(k.id), 38)} ` +
				`${padRight(k.name, 20)} ` +
				`${padRight(permsColor(k.permissions), 8)} ` +
				`${padRight(k.inbox_scope || chalk.dim("*"), 14)} ` +
				`${padRight(created, 12)} ` +
				`${lastUsed}`,
		);
	}
	console.log("");
}

async function cmdKeyCreate(name: string, options: any) {
	const body: any = {
		name,
		permissions: options.permissions || "read",
	};
	if (options.inbox) body.inbox_scope = options.inbox;

	const data = await api("/api/keys", { method: "POST", body, admin: true });

	if (options.format === "json") {
		formatOutput(data, options);
		return;
	}

	console.log(chalk.bold(`\n  API key created\n`));
	console.log(`  Name:        ${chalk.cyan(data.name)}`);
	console.log(`  Key:         ${chalk.green(data.key)}`);
	console.log(`  Permissions: ${options.permissions || "read"}`);
	if (options.inbox) console.log(`  Scope:       ${options.inbox}`);
	console.log("");
	console.log(chalk.yellow("  Save this key now - it cannot be retrieved later."));
	console.log("");
}

// ============================================================================
// send-email
// ============================================================================

const UPLOAD_THRESHOLD = 1_000_000; // 1MB: above this, local files go via R2

const CONTENT_TYPES: Record<string, string> = {
	".pdf": "application/pdf",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".avif": "image/avif",
	".ico": "image/x-icon",
	".svg": "image/svg+xml",
	".txt": "text/plain",
	".html": "text/html",
	".htm": "text/html",
	".csv": "text/csv",
	".json": "application/json",
	".css": "text/css",
	".js": "text/javascript",
	".mjs": "text/javascript",
	".xml": "application/xml",
	".wasm": "application/wasm",
	".map": "application/json",
	".webmanifest": "application/manifest+json",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".otf": "font/otf",
	".zip": "application/zip",
	".md": "text/markdown",
	".mp3": "audio/mpeg",
	".mp4": "video/mp4",
	".webm": "video/webm",
	".doc": "application/msword",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".xls": "application/vnd.ms-excel",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function fmtBytes(n: number): string {
	if (n < 1024) return `${n}B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`;
	return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function guessContentType(filename: string): string {
	return CONTENT_TYPES[path.extname(filename).toLowerCase()] || "application/octet-stream";
}

function isUrl(s: string): boolean {
	return /^https?:\/\//i.test(s);
}

// A value that may be an inline string OR a path to a file to read
// Body value resolution: a leading "@" means "read from this file" (curl-style),
// "@-" means stdin. Anything else is a literal string. Explicit, no magic guessing.
function resolveBody(val: string): string {
	if (val === "@-") return fs.readFileSync(0, "utf8"); // stdin
	if (val.startsWith("@")) {
		const file = path.resolve(val.slice(1));
		if (!fs.existsSync(file)) throw new Error(`body file not found: ${val.slice(1)}`);
		return fs.readFileSync(file, "utf8");
	}
	return val;
}

// Parse "cid:source" / "source". A leading url scheme (http/https/file) is NOT a cid.
function parseAttachSpec(spec: string): { cid?: string; source: string } {
	const idx = spec.indexOf(":");
	if (idx > 0) {
		const left = spec.slice(0, idx);
		if (left === "http" || left === "https" || left === "file") return { source: spec };
		return { cid: left, source: spec.slice(idx + 1) };
	}
	return { source: spec };
}

// commander collector for repeatable options
function collectArg(val: string, prev: string[]): string[] {
	return [...prev, val];
}

function toArray(v: any): string[] {
	if (v == null) return [];
	return (Array.isArray(v) ? v : [v]).map(String);
}

async function cmdSendEmail(opts: any) {
	// Load template (flags override its values)
	let tpl: any = {};
	if (opts.template) {
		tpl = yaml.parse(fs.readFileSync(path.resolve(opts.template), "utf8")) || {};
	}

	const drop = opts.drop || tpl.drop || tpl.from;
	if (!drop) throw new Error("--drop (sending box) is required");

	const to = opts.to?.length ? opts.to : toArray(tpl.to);
	const cc = opts.cc?.length ? opts.cc : toArray(tpl.cc);
	const bcc = opts.bcc?.length ? opts.bcc : toArray(tpl.bcc);
	const replyTo = opts.replyTo ?? tpl.replyTo;
	const fromName = opts.fromName ?? tpl.fromName;
	const subject = opts.subject ?? tpl.subject;
	const topic = opts.topic ?? tpl.topic;
	const inReplyTo = opts.inReplyTo ?? tpl.inReplyTo;

	const bodyVal = opts.body ?? tpl.body;
	const htmlVal = opts.bodyHtml ?? tpl.bodyHtml;
	const mdVal = opts.bodyMd ?? tpl.markdown ?? tpl.bodyMd;
	const text = bodyVal != null ? resolveBody(String(bodyVal)) : undefined;
	const html = htmlVal != null ? resolveBody(String(htmlVal)) : undefined;
	const markdown = mdVal != null ? resolveBody(String(mdVal)) : undefined;

	// The worker rejects this too; catching it here saves a round trip and says
	// which two flags collided rather than which two JSON fields did.
	if (markdown != null && html != null) {
		throw new Error("--body-md and --body-html are mutually exclusive (markdown renders the html)");
	}

	if (to.length === 0 && cc.length === 0 && bcc.length === 0) {
		throw new Error("at least one --to / --cc / --bcc is required");
	}
	if (!subject) throw new Error("--subject is required");

	const specs: string[] = opts.attach?.length
		? opts.attach
		: toArray(tpl.attach ?? tpl.attachments);

	// Resolve each attachment: URL -> reference, small local -> base64, big/forced -> R2
	const attachments: any[] = [];
	for (const raw of specs) {
		const { cid, source } = parseAttachSpec(String(raw));
		const inline = !!cid;

		if (isUrl(source)) {
			attachments.push({ url: source, cid, inline });
			continue;
		}

		const filePath = path.resolve(source);
		if (!fs.existsSync(filePath)) throw new Error(`attachment not found: ${source}`);
		const size = fs.statSync(filePath).size;
		const filename = path.basename(filePath);
		const contentType = guessContentType(filename);

		if (opts.upload || size > UPLOAD_THRESHOLD) {
			const pre = await api(`/api/send/presign/${encodeURIComponent(drop)}`, {
				method: "POST",
				body: { fileName: filename, contentType },
			});
			const put = await fetch(pre.uploadUrl, {
				method: "PUT",
				headers: { "Content-Type": contentType },
				body: fs.readFileSync(filePath),
			});
			if (!put.ok) throw new Error(`R2 upload failed (${put.status}) for ${filename}`);
			attachments.push({ r2Key: pre.r2Key, filename, contentType, cid, inline });
		} else {
			attachments.push({
				dataBase64: fs.readFileSync(filePath).toString("base64"),
				filename,
				contentType,
				cid,
				inline,
			});
		}
	}

	const payload: any = { to, cc, bcc, subject };
	if (replyTo) payload.replyTo = replyTo;
	if (fromName) payload.fromName = fromName;
	if (topic) payload.topic = topic;
	if (inReplyTo) payload.inReplyTo = inReplyTo;
	if (text != null) payload.text = text;
	if (html != null) payload.html = html;
	if (markdown != null) payload.markdown = markdown;
	if (attachments.length) payload.attachments = attachments;
	if (opts.deleteAfterSend) payload.deleteAfterSend = true;

	// --dry-run / --compose: hit /api/compose, which assembles the EXACT same MIME
	// as /api/send but returns the raw RFC822 .eml and never calls SES. Nothing is sent.
	if (opts.dryRun || opts.compose) {
		const res = await fetch(`${getBaseUrl()}/api/compose/${encodeURIComponent(drop)}`, {
			method: "POST",
			headers: { Authorization: `Bearer ${getApiKey()}`, "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});
		if (!res.ok) {
			let msg = await res.text();
			try {
				msg = JSON.parse(msg).error || msg;
			} catch {}
			throw new Error(`API ${res.status}: ${msg}`);
		}
		const eml = await res.text();
		if (opts.out) {
			fs.writeFileSync(path.resolve(opts.out), eml);
			console.error(
				chalk.yellow(`\n  Composed (NOT sent)`) +
					chalk.dim(` -> ${opts.out} (${eml.length} bytes)\n`),
			);
		} else {
			process.stdout.write(eml);
		}
		return;
	}

	const data = await api(`/api/send/${encodeURIComponent(drop)}`, {
		method: "POST",
		body: payload,
	});

	if (opts.format === "json") {
		formatOutput(data, opts);
		return;
	}

	console.log(chalk.bold(`\n  Email sent\n`));
	console.log(
		`  From:      ${chalk.cyan(`${drop}${topic ? `+${topic}` : ""}@${getMailDomain()}`)}`,
	);
	console.log(`  To:        ${data.recipients.to.join(", ") || chalk.dim("(none)")}`);
	if (data.recipients.cc?.length) console.log(`  Cc:        ${data.recipients.cc.join(", ")}`);
	if (data.recipients.bcc?.length) console.log(`  Bcc:       ${data.recipients.bcc.join(", ")}`);
	console.log(`  Subject:   ${subject}`);
	if (attachments.length) console.log(`  Files:     ${attachments.length}`);
	console.log(`  MessageId: ${chalk.green(data.messageId)}`);
	console.log("");
}

// ============================================================================
// CLI Setup
// ============================================================================

const program = new Command()
	.name("agent-drop")
	.description("Agent Drop - manage drop inboxes, targets, and API keys")
	.version("1.0.0");

addCommonOptions(program);

program.addHelpText(
	"after",
	`
DESCRIPTION
  CLI for an Agent Drop instance (set AGENT_DROP_URL). Manage inboxes that receive
  emails, web form submissions, and API drops. List drops, create temporary
  drop targets, manage API keys, and poll for new messages. Also compose and
  send real outbound email on behalf of a box (send-email, with --dry-run /
  --compose to assemble the raw .eml without sending), and host static sites.

AUTHENTICATION
  Two keys are used, each taken from the first place that has it:
    - Admin key, for drops, boxes, keys, targets:
        AGENT_DROP_ADMIN_KEY env var, else passage (\`key AGENT_DROP_ADMIN_KEY\`),
        else ADMIN_API_KEY in agent-drop/.env
    - API key, for inbox reads and sends:
        AGENT_DROP_API_KEY env var, else passage (\`key AGENT_DROP_API_KEY\`),
        else API_KEY in agent-drop/.env, else the admin key

  Store a key in passage with: key-set AGENT_DROP_ADMIN_KEY / key-set AGENT_DROP_API_KEY

ENVIRONMENT
  AGENT_DROP_URL        API base URL (default https://frst.dev via DOMAIN in .env).
                        If unset you get the "Example Domain" 404 page.
  AGENT_DROP_ADMIN_KEY  Admin API key (overrides passage and .env)
  AGENT_DROP_API_KEY    API key for inbox/send routes (overrides passage and .env)

EXAMPLES
  # List recent drops across all inboxes
  bun tools/agent-drop.ts drops

  # List drops from a specific box, last 24h
  bun tools/agent-drop.ts drops --box contact --since 24h

  # Show all boxes with stats
  bun tools/agent-drop.ts boxes

  # View inbox contents (unread only)
  bun tools/agent-drop.ts inbox contact --unread

  # Create a temporary drop target (2h TTL)
  bun tools/agent-drop.ts target feedback --ttl 4

  # Poll for new drops
  bun tools/agent-drop.ts poll --box contact --continuous

  # Manage API keys
  bun tools/agent-drop.ts keys
  bun tools/agent-drop.ts key-create "webhook-bot" --permissions write --inbox alerts

  # Send an email on behalf of a box (From: lisa@example.com)
  bun tools/agent-drop.ts send-email --drop lisa --to bob@example.com \\
    --subject "Hi" --body "see attached" --attach ./report.pdf

  # Multiple recipients, HTML + inline image, preview only
  bun tools/agent-drop.ts send-email --drop lisa \\
    --to '"Bob" <bob@x.com>' --cc team@x.com \\
    --subject Report --body-html ./mail.html --attach logo:./logo.png --dry-run

  # Markdown report -- server renders the HTML, raw markdown is the text part
  bun tools/agent-drop.ts send-email --drop lisa --to bob@x.com \\
    --subject "Retrospect" --body-md @./retro.md

  # JSON output for piping
  bun tools/agent-drop.ts drops --format json | jq '.drops[].subject'
`,
);

// drops - list all drops
program
	.command("drops")
	.description("List all drops across all boxes, chronologically")
	.option("-l, --limit <n>", "Max results", "20")
	.option("-b, --box <name>", "Filter by box/inbox name")
	.option("-c, --channel <channel>", "Filter by channel (email, web, api)")
	.option("-s, --since <duration>", "Only drops since duration (e.g. 1h, 24h, 7d)")
	.action(async (opts) => {
		const merged = { ...program.opts(), ...opts };
		try {
			await cmdDrops(merged);
		} catch (err: any) {
			console.error(chalk.red(err.message));
			process.exit(3);
		}
	});

// boxes - list all inboxes with stats
program
	.command("boxes")
	.description("List all boxes with stats")
	.action(async (opts) => {
		const merged = { ...program.opts(), ...opts };
		try {
			await cmdBoxes(merged);
		} catch (err: any) {
			console.error(chalk.red(err.message));
			process.exit(3);
		}
	});

// inbox - list drops in a specific box
program
	.command("inbox <name>")
	.description("List drops in a specific inbox")
	.option("-l, --limit <n>", "Max results", "20")
	.option("-u, --unread", "Only unread drops")
	.option("-t, --topic <topic>", "Filter by topic")
	.action(async (name, opts) => {
		const merged = { ...program.opts(), ...opts };
		try {
			await cmdInbox(name, merged);
		} catch (err: any) {
			console.error(chalk.red(err.message));
			process.exit(3);
		}
	});

// target - create a temporary drop target
program
	.command("target <name>")
	.description("Create a temporary drop target URL")
	.option("--ttl <hours>", "Time to live in hours", "2")
	.action(async (name, opts) => {
		const merged = { ...program.opts(), ...opts };
		try {
			await cmdTarget(name, merged);
		} catch (err: any) {
			console.error(chalk.red(err.message));
			process.exit(3);
		}
	});

// targets - list active drop targets
program
	.command("targets")
	.description("List active drop targets")
	.action(async (opts) => {
		const merged = { ...program.opts(), ...opts };
		try {
			await cmdTargets(merged);
		} catch (err: any) {
			console.error(chalk.red(err.message));
			process.exit(3);
		}
	});

// poll - watch for new drops
program
	.command("poll")
	.description("Watch for new drops in real-time")
	.option("-b, --box <name>", "Filter by box")
	.option("-p, --period <duration>", "How long to poll (e.g. 10m, 1h)", "10m")
	.option("-i, --interval <seconds>", "Poll interval in seconds", "5")
	.option("--continuous", "Run until killed (ignore --period)")
	.action(async (opts) => {
		const merged = { ...program.opts(), ...opts };
		try {
			await cmdPoll(merged);
		} catch (err: any) {
			console.error(chalk.red(err.message));
			process.exit(3);
		}
	});

// keys - list API keys
program
	.command("keys")
	.description("List API keys")
	.action(async (opts) => {
		const merged = { ...program.opts(), ...opts };
		try {
			await cmdKeys(merged);
		} catch (err: any) {
			console.error(chalk.red(err.message));
			process.exit(3);
		}
	});

// key-create - create an API key
program
	.command("key-create <name>")
	.description("Create a new API key")
	.option("-p, --permissions <level>", "Permission level: read, write, admin", "read")
	.option("-i, --inbox <name>", "Scope key to specific inbox")
	.action(async (name, opts) => {
		const merged = { ...program.opts(), ...opts };
		try {
			await cmdKeyCreate(name, merged);
		} catch (err: any) {
			console.error(chalk.red(err.message));
			process.exit(3);
		}
	});

// users - list allowed users
program
	.command("users")
	.description("List allowed Google sign-in users")
	.action(async () => {
		const merged = program.opts();
		try {
			const data = await api("/api/users", { admin: true });
			if (merged.format === "json") {
				console.log(JSON.stringify(data, null, 2));
				return;
			}
			const users = data.users || [];
			if (users.length === 0) {
				console.log(chalk.dim("\n  No allowed users\n"));
				return;
			}
			console.log(`\n${chalk.bold(`  Allowed Users (${users.length}):`)}`);
			console.log();
			console.log(chalk.dim("  EMAIL                              NAME             ADDED"));
			for (const u of users) {
				console.log(
					`  ${chalk.cyan(u.email.padEnd(36))} ${(u.name || "").padEnd(16)} ${relativeTime(u.created_at)}`,
				);
			}
			console.log();
		} catch (err: any) {
			console.error(chalk.red(err.message));
			process.exit(3);
		}
	});

// user-add - add allowed user
program
	.command("user-add <email>")
	.description("Add a Google sign-in user to the allowlist")
	.option("-n, --name <name>", "Display name")
	.action(async (email, opts) => {
		try {
			const data = await api("/api/users", {
				method: "POST",
				body: { email, name: opts.name },
				admin: true,
			});
			console.log(chalk.green(`\n  Added: ${data.added}\n`));
		} catch (err: any) {
			console.error(chalk.red(err.message));
			process.exit(3);
		}
	});

// user-remove - remove allowed user
program
	.command("user-remove <email>")
	.description("Remove a user from the allowlist")
	.action(async (email) => {
		try {
			const data = await api(`/api/users/${encodeURIComponent(email)}`, {
				method: "DELETE",
				admin: true,
			});
			console.log(chalk.yellow(`\n  Removed: ${data.deleted}\n`));
		} catch (err: any) {
			console.error(chalk.red(err.message));
			process.exit(3);
		}
	});

// invite - add user, create target, send invitation email
program
	.command("invite <email>")
	.description("Invite someone to drop files via email + web link")
	.requiredOption("-t, --target <inbox>", "Drop inbox name")
	.option("--ttl <hours>", "Link TTL in hours", "48")
	.option("-n, --name <name>", "Display name for the user")
	.action(async (email, opts) => {
		const merged = { ...program.opts(), ...opts };
		try {
			// 1. Add user to allowlist
			let userStatus: string;
			try {
				const userData = await api("/api/users", {
					method: "POST",
					body: { email, name: opts.name },
					admin: true,
				});
				userStatus = userData.added ? "added" : "already exists";
			} catch (err: any) {
				if (err.message.includes("409") || err.message.includes("already")) {
					userStatus = "already exists";
				} else {
					throw err;
				}
			}

			// 2. Create temporary drop target
			const ttl = parseInt(opts.ttl, 10);
			const targetData = await api("/api/targets", {
				method: "POST",
				body: { inbox: opts.target, ttl_hours: ttl },
				admin: true,
			});

			const dropUrl = targetData.url;

			// 3. Send invitation email
			const greeting = opts.name ? `Hi ${opts.name}` : "Hi";
			const emailBody = [
				`${greeting},`,
				"",
				"You've been invited to drop files.",
				"",
				`Upload here: ${dropUrl}`,
				"",
				"You can also just reply to this email with attachments.",
				"",
				`This link expires ${targetData.expires_in}.`,
			].join("\n");

			await api(`/api/send/${encodeURIComponent(opts.target)}`, {
				method: "POST",
				body: {
					to: email,
					subject: "You've been invited to drop files",
					text: emailBody,
				},
			});

			if (merged.format === "json") {
				formatOutput(
					{
						user: { email, name: opts.name, status: userStatus },
						target: {
							inbox: opts.target,
							url: dropUrl,
							expires_at: targetData.expires_at,
							expires_in: targetData.expires_in,
						},
						email: { sent: true, to: email },
					},
					merged,
				);
				return;
			}

			console.log(chalk.bold(`\n  Invitation sent\n`));
			console.log(`  User:      ${chalk.cyan(email)} (${userStatus})`);
			console.log(`  Inbox:     ${chalk.cyan(opts.target)}`);
			console.log(`  URL:       ${chalk.green(dropUrl)}`);
			console.log(`  Expires:   ${isoDate(targetData.expires_at)} (${targetData.expires_in})`);
			console.log(`  Email:     ${chalk.green("sent")} to ${email}`);
			console.log("");
		} catch (err: any) {
			console.error(chalk.red(err.message));
			process.exit(3);
		}
	});

// get - get a specific drop with full details + metadata
program
	.command("get <dropId>")
	.description(
		"Get full details of a drop (body, metadata, files). Use --format json for complete body text.",
	)
	.action(async (dropId, opts) => {
		const merged = { ...program.opts(), ...opts };
		try {
			// Find which inbox this drop belongs to via admin list
			const data = await api(`/api/drops?limit=200`, { admin: true });
			const summary = data.drops?.find((d: any) => d.id === dropId);
			if (!summary) {
				console.error(chalk.red(`Drop ${dropId} not found`));
				process.exit(1);
			}

			// Fetch full drop (with body) from the inbox endpoint
			const drop = await api(`/api/inbox/${summary.inbox}/${dropId}`);

			if (merged.format === "json") {
				if (drop.metadata && typeof drop.metadata === "string") {
					drop.metadata = JSON.parse(drop.metadata);
				}
				console.log(JSON.stringify(drop, null, 2));
				return;
			}

			const meta = drop.metadata
				? typeof drop.metadata === "string"
					? JSON.parse(drop.metadata)
					: drop.metadata
				: {};

			console.log(chalk.bold(`\n  Drop: ${chalk.cyan(drop.id)}\n`));
			console.log(`  Inbox:       ${chalk.cyan(drop.inbox)}`);
			console.log(`  Channel:     ${drop.channel}`);
			console.log(
				`  Status:      ${drop.status === "completed" ? chalk.green(drop.status) : chalk.yellow(drop.status)}`,
			);
			console.log(`  Subject:     ${drop.subject || chalk.dim("(none)")}`);
			if (drop.topic) console.log(`  Topic:       ${chalk.cyan(drop.topic)}`);
			if (drop.from_addr) console.log(`  From:        ${chalk.yellow(drop.from_addr)}`);
			console.log(
				`  Created:     ${relativeTime(drop.created_at)} (${new Date(drop.created_at).toISOString()})`,
			);
			console.log(
				`  Read:        ${drop.read_at ? relativeTime(drop.read_at) : chalk.dim("unread")}`,
			);
			console.log(`  Attachments: ${drop.attachment_count}`);
			if (drop.body_text) {
				const bodyLen = drop.body_text.length;
				const truncated = bodyLen > 200;
				console.log(chalk.bold(`\n  Body:`) + chalk.dim(` (${bodyLen} chars)`));
				console.log(`  ${drop.body_text.slice(0, 200).replace(/\n/g, "\n  ")}`);
				if (truncated) {
					console.log(chalk.dim(`  ... (${bodyLen - 200} more chars)`));
					console.log(
						chalk.dim(`  Tip: use --format json for full body, or: body ${drop.inbox} ${drop.id}`),
					);
				}
			} else {
				console.log(chalk.dim(`\n  Body: (none)`));
			}

			if (Object.keys(meta).length > 0) {
				console.log(chalk.bold(`\n  Metadata:`));
				if (meta.auth_method) console.log(`    Auth:      ${meta.auth_method}`);
				if (meta.auth_key_name) console.log(`    Key:       ${chalk.cyan(meta.auth_key_name)}`);
				if (meta.remote_ip) console.log(`    IP:        ${meta.remote_ip}`);
				if (meta.country)
					console.log(`    Country:   ${meta.country}${meta.city ? ` (${meta.city})` : ""}`);
				if (meta.user_agent)
					console.log(`    UA:        ${chalk.dim(meta.user_agent.slice(0, 80))}`);
			}

			// List files
			try {
				const files = await api(`/api/inbox/${drop.inbox}/${drop.id}/attachments`);
				if (files.files?.length > 0) {
					console.log(chalk.bold(`\n  Files:`));
					for (const f of files.files) {
						const size =
							f.size < 1024
								? `${f.size}B`
								: f.size < 1024 * 1024
									? `${(f.size / 1024).toFixed(0)}KB`
									: `${(f.size / (1024 * 1024)).toFixed(1)}MB`;
						console.log(`    ${chalk.cyan(f.filename)}  ${chalk.dim(size)}`);
					}
				}
			} catch {}

			console.log("");
		} catch (err: any) {
			console.error(chalk.red(err.message));
			process.exit(3);
		}
	});

// body - print the full body text of a drop (no truncation)
program
	.command("body <inbox> [dropId]")
	.description("Print full body text of a drop (default: latest). Use for piping/processing.")
	.option("--html", "Output HTML body instead of plain text")
	.action(async (inbox, dropId, opts) => {
		try {
			let drop: any;
			if (dropId) {
				drop = await api(`/api/inbox/${inbox}/${dropId}`);
			} else {
				drop = await api(`/api/inbox/${inbox}/latest`);
			}

			const content = opts.html ? drop.body_html : drop.body_text;
			if (!content) {
				console.error(chalk.dim("(no body content)"));
				process.exit(0);
			}
			process.stdout.write(`${content}\n`);
		} catch (err: any) {
			console.error(chalk.red(err.message));
			process.exit(3);
		}
	});

// files - list files/attachments in a drop
program
	.command("files <inbox> [dropId]")
	.description("List files in a drop (default: latest drop in inbox)")
	.action(async (inbox, dropId, opts) => {
		const merged = { ...program.opts(), ...opts };
		try {
			// If no dropId, get the latest
			if (!dropId) {
				const latest = await api(`/api/inbox/${inbox}/latest`);
				dropId = latest.id;
				if (!dropId) {
					console.error(chalk.red("No drops in this inbox"));
					process.exit(1);
				}
			}

			const data = await api(`/api/inbox/${inbox}/${dropId}/attachments`);
			const files = data.files || [];

			if (merged.format === "json") {
				console.log(JSON.stringify({ dropId, files }, null, 2));
				return;
			}

			if (files.length === 0) {
				console.log(chalk.dim(`\n  No files in drop ${dropId}\n`));
				return;
			}

			console.log(chalk.bold(`\n  Files in ${chalk.cyan(dropId)}:\n`));
			for (const f of files) {
				const size =
					f.size < 1024
						? `${f.size}B`
						: f.size < 1024 * 1024
							? `${(f.size / 1024).toFixed(0)}KB`
							: `${(f.size / (1024 * 1024)).toFixed(1)}MB`;
				console.log(
					`  ${chalk.cyan(f.filename.padEnd(40))} ${chalk.dim(size.padStart(8))}  ${chalk.dim(f.uploaded)}`,
				);
			}
			console.log("");
		} catch (err: any) {
			console.error(chalk.red(err.message));
			process.exit(3);
		}
	});

// download - download a file from a drop
program
	.command("download <inbox> <dropId> <filename>")
	.description("Download a file from a drop to current directory")
	.option("-o, --output <path>", "Output path (default: ./<filename>)")
	.action(async (inbox, dropId, filename, opts) => {
		try {
			const res = await apiRaw(
				`/api/inbox/${inbox}/${dropId}/file/${encodeURIComponent(filename)}`,
			);
			const outPath = opts.output || `./${filename}`;
			const buffer = await res.arrayBuffer();
			await Bun.write(outPath, buffer);
			const size =
				buffer.byteLength < 1024
					? `${buffer.byteLength}B`
					: buffer.byteLength < 1024 * 1024
						? `${(buffer.byteLength / 1024).toFixed(0)}KB`
						: `${(buffer.byteLength / (1024 * 1024)).toFixed(1)}MB`;
			console.log(chalk.green(`\n  Downloaded: ${outPath} (${size})\n`));
		} catch (err: any) {
			console.error(chalk.red(err.message));
			process.exit(3);
		}
	});

// raw - download the raw .eml file for an email drop
program
	.command("raw <inbox> <dropId>")
	.description(
		"Download the original .eml file (email drops only, contains full unstripped content)",
	)
	.option("-o, --output <path>", "Output path (default: ./<dropId>.eml)")
	.action(async (inbox, dropId, opts) => {
		try {
			const drop = await api(`/api/inbox/${inbox}/${dropId}`);
			if (!drop.raw_r2_key) {
				console.error(chalk.red("No raw .eml for this drop (not an email)"));
				process.exit(1);
			}

			const res = await apiRaw(`/api/inbox/${inbox}/${dropId}/raw`);
			const outPath = opts.output || `./${dropId}.eml`;
			const buffer = await res.arrayBuffer();
			await Bun.write(outPath, buffer);
			const size =
				buffer.byteLength < 1024
					? `${buffer.byteLength}B`
					: buffer.byteLength < 1024 * 1024
						? `${(buffer.byteLength / 1024).toFixed(0)}KB`
						: `${(buffer.byteLength / (1024 * 1024)).toFixed(1)}MB`;
			console.log(chalk.green(`\n  Downloaded: ${outPath} (${size})\n`));
		} catch (err: any) {
			console.error(chalk.red(err.message));
			process.exit(3);
		}
	});

// url - generate a presigned download URL for a file
program
	.command("url <inbox> <dropId> <filename>")
	.description("Generate a presigned download URL (default 1h, shareable)")
	.option("--ttl <seconds>", "URL validity in seconds", "3600")
	.action(async (inbox, dropId, filename, opts) => {
		const merged = { ...program.opts(), ...opts };
		try {
			const data = await api(
				`/api/inbox/${inbox}/${dropId}/url/${encodeURIComponent(filename)}?ttl=${opts.ttl}`,
			);

			if (merged.format === "json") {
				console.log(JSON.stringify(data, null, 2));
				return;
			}

			console.log(chalk.bold(`\n  Presigned Download URL\n`));
			console.log(
				`  File:      ${chalk.cyan(data.filename)} (${data.size < 1024 * 1024 ? `${(data.size / 1024).toFixed(0)}KB` : `${(data.size / (1024 * 1024)).toFixed(1)}MB`})`,
			);
			console.log(`  Expires:   ${data.expires_in}`);
			console.log(`  URL:       ${chalk.green(data.url)}`);
			console.log("");
		} catch (err: any) {
			console.error(chalk.red(err.message));
			process.exit(3);
		}
	});

// rules - list drop rules
program
	.command("rules")
	.description("List all drop rules (forwards + webhooks)")
	.action(async () => {
		const merged = program.opts();
		try {
			const data = await api("/api/rules", { admin: true });
			if (merged.format === "json") {
				console.log(JSON.stringify(data, null, 2));
				return;
			}
			const rules = data.rules || [];
			if (rules.length === 0) {
				console.log(chalk.dim("\n  No rules configured\n"));
				return;
			}
			console.log(chalk.bold(`\n  Rules (${rules.length}):\n`));
			console.log(chalk.dim("  PATTERN          TYPE       SCOPES    TARGET"));
			for (const r of rules) {
				const pattern = chalk.cyan(r.pattern.padEnd(16));
				const type = (r.type === "forward" ? chalk.yellow(r.type) : chalk.magenta(r.type)).padEnd(
					18,
				);
				const scopes = chalk.dim(r.scopes.padEnd(9));
				const target = r.target;
				const enabled = r.enabled ? "" : chalk.red(" [disabled]");
				// Only shown when it is not the default -- a column of "envelope" would
				// be noise on every line that has nothing to say.
				const mode = r.payload_mode === "passthrough" ? chalk.dim(" [passthrough]") : "";
				console.log(`  ${pattern} ${type} ${scopes} ${target}${mode}${enabled}`);
			}
			console.log("");
		} catch (err: any) {
			console.error(chalk.red(err.message));
			process.exit(3);
		}
	});

// rule-add - create a rule
program
	.command("rule-add <pattern>")
	.description("Add a drop rule. Pattern: 'lisa', '*', 'shop-*'")
	.option(
		"--forward <email>",
		"Forward to this address (repeatable, or comma-separated; supports {inbox}, {name}, {topic})",
		collectArg,
		[],
	)
	.option("--webhook <url>", "POST webhook to this URL on drops")
	.option("--scope <scopes>", "Comma-separated: email,web,api,hook,all", "all")
	.option("--header <kv...>", "Webhook headers as Key:Value pairs")
	.option("--priority <n>", "Priority (higher fires first)", "0")
	.option(
		"--payload-mode <mode>",
		"envelope (our JSON wrapper) or passthrough (the provider's original bytes and headers, hook events only)",
		"envelope",
	)
	.action(async (pattern, opts) => {
		try {
			const forwards: string[] = (opts.forward || [])
				.flatMap((f: string) => f.split(","))
				.map((s: string) => s.trim())
				.filter(Boolean);
			if (forwards.length === 0 && !opts.webhook) {
				console.error(chalk.red("Specify --forward <email> (repeatable) or --webhook <url>"));
				process.exit(1);
			}

			const type = forwards.length > 0 ? "forward" : "webhook";
			const target = forwards.length > 0 ? forwards.join(",") : opts.webhook;

			let headers: Record<string, string> | undefined;
			if (opts.header) {
				headers = {};
				for (const h of opts.header) {
					const [k, ...v] = h.split(":");
					headers[k.trim()] = v.join(":").trim();
				}
			}

			if (opts.payloadMode !== "envelope" && opts.payloadMode !== "passthrough") {
				console.error(chalk.red("--payload-mode must be 'envelope' or 'passthrough'"));
				process.exit(1);
			}

			await api("/api/rules", {
				method: "POST",
				body: {
					pattern,
					type,
					scopes: opts.scope,
					target,
					headers,
					priority: parseInt(opts.priority, 10),
					payloadMode: opts.payloadMode,
				},
				admin: true,
			});

			console.log(chalk.green(`\n  Rule created: ${chalk.cyan(pattern)} -> ${type} -> ${target}`));
			if (opts.payloadMode === "passthrough") {
				console.log(
					chalk.dim("  passthrough: the provider's original bytes and headers, verbatim."),
				);
				console.log(
					chalk.dim(
						"  Applies to hook events; a drop has no original request and gets the envelope.",
					),
				);
			}
			console.log("");
		} catch (err: any) {
			console.error(chalk.red(err.message));
			process.exit(3);
		}
	});

// rule-enable / rule-disable
program
	.command("rule-enable <id>")
	.description("Enable a drop rule")
	.action(async (id) => {
		try {
			await api(`/api/rules/${id}`, { method: "PATCH", body: { enabled: true }, admin: true });
			console.log(chalk.green(`\n  Rule ${id} enabled\n`));
		} catch (err: any) {
			console.error(chalk.red(err.message));
			process.exit(3);
		}
	});

program
	.command("rule-disable <id>")
	.description("Disable a drop rule (keeps it, stops firing)")
	.action(async (id) => {
		try {
			await api(`/api/rules/${id}`, { method: "PATCH", body: { enabled: false }, admin: true });
			console.log(chalk.yellow(`\n  Rule ${id} disabled\n`));
		} catch (err: any) {
			console.error(chalk.red(err.message));
			process.exit(3);
		}
	});

// rule-update
program
	.command("rule-update <id>")
	.description("Update a drop rule")
	.option("--target <target>", "New target (email or URL)")
	.option("--scope <scopes>", "New scopes (comma-separated)")
	.option("--priority <n>", "New priority")
	.option("--header <kv...>", "New webhook headers as Key:Value pairs")
	.option("--payload-mode <mode>", "envelope or passthrough")
	.action(async (id, opts) => {
		try {
			const body: Record<string, unknown> = {};
			if (opts.target) body.target = opts.target;
			if (opts.scope) body.scopes = opts.scope;
			if (opts.priority) body.priority = parseInt(opts.priority, 10);
			if (opts.payloadMode) body.payloadMode = opts.payloadMode;
			if (opts.header) {
				const headers: Record<string, string> = {};
				for (const h of opts.header) {
					const [k, ...v] = h.split(":");
					headers[k.trim()] = v.join(":").trim();
				}
				body.headers = headers;
			}
			if (Object.keys(body).length === 0) {
				console.error(
					chalk.red(
						"Nothing to update. Use --target, --scope, --priority, --header or --payload-mode",
					),
				);
				process.exit(1);
			}
			await api(`/api/rules/${id}`, { method: "PATCH", body, admin: true });
			console.log(chalk.green(`\n  Rule ${id} updated\n`));
		} catch (err: any) {
			console.error(chalk.red(err.message));
			process.exit(3);
		}
	});

// rule-remove - delete a rule
program
	.command("rule-remove <id>")
	.description("Remove a drop rule by ID")
	.action(async (id) => {
		try {
			await api(`/api/rules/${id}`, { method: "DELETE", admin: true });
			console.log(chalk.yellow(`\n  Rule removed: ${id}\n`));
		} catch (err: any) {
			console.error(chalk.red(err.message));
			process.exit(3);
		}
	});

// rule-test - dry-run: show what rules would fire
program
	.command("rule-test <inbox>")
	.description("Test which rules would fire for an inbox (dry run)")
	.option("--channel <ch>", "Channel to simulate: email, web, api, hook", "email")
	.option("--slug <slug>", "Receiver slug to simulate, for {slug} on --channel hook")
	.option("--event-type <type>", "Event type to simulate, for {event_type}")
	.option("--routing-key <key>", "Routing key to simulate, for {routing_key}")
	.action(async (inbox, opts) => {
		try {
			const data = await api("/api/rules", { admin: true });
			const rules = data.rules || [];

			// Strip dots for normalization (same as server)
			const normalized = inbox
				.toLowerCase()
				.replace(/\./g, "")
				.replace(/_/g, "-")
				.replace(/[^a-z0-9-]/g, "");

			console.log(
				chalk.bold(`\n  Rule test: ${chalk.cyan(normalized)} (channel: ${opts.channel})\n`),
			);

			const hook = opts.channel === "hook";
			const vars: Record<string, string> = {
				inbox: normalized,
				topic: "",
				// A hook event has no sender and no subject; substituting a plausible
				// email into a hook dry run would show a target that never resolves.
				from: hook ? "" : "test@example.com",
				subject: hook ? "" : "(test)",
				drop_id: "test-dry-run",
				channel: opts.channel,
				slug: opts.slug || (hook ? "test-receiver" : ""),
				event_type: opts.eventType || (hook ? "test.event" : ""),
				routing_key: opts.routingKey || "",
			};

			let matchCount = 0;
			for (const rule of rules) {
				const verdict = previewRule(rule, normalized, opts.channel, vars);
				if (!verdict) continue;

				if (!verdict.fires) {
					console.log(chalk.dim(`  ~ ${rule.pattern} -> pattern matches but ${verdict.reason}`));
					continue;
				}

				matchCount++;
				const typeColor = rule.type === "forward" ? chalk.yellow : chalk.magenta;
				const mode = rule.payload_mode === "passthrough" ? chalk.dim(" [passthrough]") : "";
				console.log(
					`  ${chalk.green(">")} ${chalk.cyan(rule.pattern)} -> ${typeColor(rule.type)} -> ${verdict.target}${mode}`,
				);

				if (Object.keys(verdict.captures).length > 0) {
					console.log(
						chalk.dim(
							`    captures: ${Object.entries(verdict.captures)
								.map(([k, v]) => `{${k}}=${v}`)
								.join(", ")}`,
						),
					);
				}
			}

			if (matchCount === 0) {
				console.log(chalk.dim("  No rules would fire"));
			} else {
				console.log(chalk.dim(`\n  ${matchCount} rule(s) would fire`));
			}
			console.log("");
		} catch (err: any) {
			console.error(chalk.red(err.message));
			process.exit(3);
		}
	});

// deliveries - view delivery log
program
	.command("deliveries")
	.description("View forward/webhook delivery log")
	.option("--drop <id>", "Filter by drop ID")
	.option("--status <status>", "Filter: pending, success, failed, retrying")
	.option("-l, --limit <n>", "Max results", "20")
	.action(async (opts) => {
		const merged = { ...program.opts(), ...opts };
		try {
			let path = `/api/deliveries?limit=${opts.limit}`;
			if (opts.drop) path += `&drop_id=${opts.drop}`;
			if (opts.status) path += `&status=${opts.status}`;

			const data = await api(path, { admin: true });
			if (merged.format === "json") {
				console.log(JSON.stringify(data, null, 2));
				return;
			}

			const deliveries = data.deliveries || [];
			if (deliveries.length === 0) {
				console.log(chalk.dim("\n  No deliveries\n"));
				return;
			}

			console.log(chalk.bold(`\n  Deliveries (${deliveries.length}):\n`));
			console.log(chalk.dim("  WHEN          TYPE       STATUS     TARGET"));
			for (const d of deliveries) {
				const when = relativeTime(d.created_at).padEnd(13);
				const type = d.type.padEnd(10);
				const statusColor =
					d.status === "success"
						? chalk.green
						: d.status === "failed"
							? chalk.red
							: d.status === "retrying"
								? chalk.yellow
								: chalk.dim;
				const status = statusColor(d.status.padEnd(10));
				const target = d.target.length > 50 ? `${d.target.slice(0, 50)}...` : d.target;
				console.log(`  ${when} ${type} ${status} ${target}`);
				if (d.error)
					console.log(chalk.dim(`                                      ${d.error.slice(0, 60)}`));
			}
			console.log("");
		} catch (err: any) {
			console.error(chalk.red(err.message));
			process.exit(3);
		}
	});

// masks - list email masks
program
	.command("masks")
	.description("List email relay masks")
	.option("--all", "Include disabled masks")
	.action(async (opts) => {
		const merged = program.opts();
		try {
			const q = opts.all ? "?all=true" : "";
			const data = await api(`/api/masks${q}`, { admin: true });
			if (merged.format === "json") {
				console.log(JSON.stringify(data, null, 2));
				return;
			}
			const masks = data.masks || [];
			if (masks.length === 0) {
				console.log(chalk.dim("\n  No masks\n"));
				return;
			}
			console.log(chalk.bold(`\n  Masks (${masks.length}):\n`));
			console.log(
				chalk.dim("  ID                EMAIL                              LABEL            STATUS"),
			);
			for (const m of masks) {
				const status = m.active ? chalk.green("active") : chalk.red("disabled");
				console.log(
					`  ${chalk.cyan(m.id.padEnd(18))} ${m.email.padEnd(34)} ${(m.label || "").padEnd(16)} ${status}`,
				);
			}
			console.log("");
		} catch (err: any) {
			console.error(chalk.red(err.message));
			process.exit(3);
		}
	});

// mask-create
program
	.command("mask-create")
	.description("Create an email relay mask")
	.option("--prefix <prefix>", "Auto-generate with this prefix (e.g. 'j')")
	.option("--id <id>", "Explicit mask ID (e.g. 'j-shopping')")
	.option("--label <label>", "Human label")
	.action(async (opts) => {
		try {
			if (!opts.prefix && !opts.id) {
				console.error(chalk.red("Specify --prefix or --id"));
				process.exit(1);
			}
			const body: Record<string, string> = {};
			if (opts.id) body.id = opts.id;
			if (opts.prefix) body.prefix = opts.prefix;
			if (opts.label) body.label = opts.label;

			const data = await api("/api/masks", { method: "POST", body, admin: true });
			console.log(chalk.bold(`\n  Mask created\n`));
			console.log(`  ID:    ${chalk.cyan(data.id)}`);
			console.log(`  Email: ${chalk.green(data.email)}`);
			if (data.label) console.log(`  Label: ${data.label}`);
			console.log("");
		} catch (err: any) {
			console.error(chalk.red(err.message));
			process.exit(3);
		}
	});

// mask-disable / mask-enable
program
	.command("mask-disable <id>")
	.description("Disable a mask (emails will bounce)")
	.action(async (id) => {
		try {
			await api(`/api/masks/${id}`, { method: "PATCH", body: { active: false }, admin: true });
			console.log(chalk.yellow(`\n  Mask ${id} disabled\n`));
		} catch (err: any) {
			console.error(chalk.red(err.message));
			process.exit(3);
		}
	});

program
	.command("mask-enable <id>")
	.description("Re-enable a disabled mask")
	.action(async (id) => {
		try {
			await api(`/api/masks/${id}`, { method: "PATCH", body: { active: true }, admin: true });
			console.log(chalk.green(`\n  Mask ${id} enabled\n`));
		} catch (err: any) {
			console.error(chalk.red(err.message));
			process.exit(3);
		}
	});

// mask-remove
program
	.command("mask-remove <id>")
	.description("Permanently delete a mask")
	.action(async (id) => {
		try {
			await api(`/api/masks/${id}`, { method: "DELETE", admin: true });
			console.log(chalk.yellow(`\n  Mask ${id} removed\n`));
		} catch (err: any) {
			console.error(chalk.red(err.message));
			process.exit(3);
		}
	});

// send-email - send an email on behalf of a drop box
program
	.command("send-email")
	.description(`Send an email on behalf of a drop box (From: {drop}@${getMailDomain()})`)
	.option("-d, --drop <box>", `Sending box (From: {box}@${getMailDomain()})`)
	.option("--to <addr>", `Recipient, repeatable. Accepts '"Name" <a@b.com>'`, collectArg, [])
	.option("--cc <addr>", "Cc recipient (repeatable)", collectArg, [])
	.option("--bcc <addr>", "Bcc recipient (repeatable)", collectArg, [])
	.option("--reply-to <addr>", "Reply-To header")
	.option("--from-name <name>", "Display name for the From address")
	.option("-s, --subject <text>", "Subject line")
	.option(
		"--body <text|@file>",
		"Plain-text body: literal text, or @path to read a file (@- for stdin)",
	)
	.option(
		"--body-html <html|@file>",
		"HTML body: literal text, or @path to read a file (@- for stdin)",
	)
	.option(
		"--body-md <markdown|@file>",
		"Markdown body: rendered server-side to email-safe HTML; the raw markdown becomes the text part",
	)
	.option(
		"--attach <spec>",
		"Attachment: path, URL, or cid:path for inline images (repeatable)",
		collectArg,
		[],
	)
	.option("--topic <topic>", `Send from {box}+{topic}@${getMailDomain()}`)
	.option("--in-reply-to <dropId|msgId>", "Thread as a reply to a received drop")
	.option("--template <file.yml>", "Load fields from a YAML template (flags override)")
	.option("--upload", "Force all local attachments through R2 (default: auto above 1MB)")
	.option(
		"--delete-after-send",
		"Delete R2-uploaded attachments immediately after sending (default: kept, 30d TTL)",
	)
	.option("--dry-run", "Compose the raw .eml (via /api/compose) and print it, without sending")
	.option("--compose", "Alias for --dry-run: return the assembled .eml instead of sending")
	.option("--out <file>", "With --dry-run/--compose, write the .eml to a file instead of stdout")
	.action(async (opts) => {
		const merged = { ...program.opts(), ...opts };
		try {
			await cmdSendEmail(merged);
		} catch (err: any) {
			console.error(chalk.red(err.message));
			process.exit(3);
		}
	});

// ============================================================================
// host - publish static files to {domain}/f/{box}/{site}/
// ============================================================================

function walkFiles(root: string): string[] {
	const stat = fs.statSync(root);
	if (stat.isFile()) return [root];
	const out: string[] = [];
	for (const entry of fs.readdirSync(root)) {
		if (entry === ".DS_Store") continue;
		out.push(...walkFiles(path.join(root, entry)));
	}
	return out;
}

program
	.command("host <box> <site> [paths...]")
	.description(`Publish static files publicly at https://${getDomain()}/f/<box>/<site>/`)
	.option("--ttl <dur>", "Auto-expire after a duration (e.g. 24h, 7d)")
	.option("--base <dir>", "Compute relative paths from this dir (preserves structure)")
	.option("--auth <token>", "Make the site private: require ?auth=<token> to view")
	.action(async (box, site, paths, opts) => {
		try {
			if (!paths || paths.length === 0) {
				console.error(chalk.red("Provide at least one file or directory to host"));
				process.exit(1);
			}

			// Resolve every input into { abs, rel }. A directory contributes its
			// tree relative to itself; a file contributes its basename. --base
			// overrides the relative root for everything.
			const files: { abs: string; rel: string }[] = [];
			for (const p of paths) {
				const abs = path.resolve(p);
				if (!fs.existsSync(abs)) throw new Error(`not found: ${p}`);
				const stat = fs.statSync(abs);
				const baseDir = opts.base
					? path.resolve(opts.base)
					: stat.isDirectory()
						? abs
						: path.dirname(abs);
				for (const f of walkFiles(abs)) {
					const rel = path.relative(baseDir, f).split(path.sep).join("/");
					files.push({ abs: f, rel });
				}
			}
			if (files.length === 0) throw new Error("no files found to upload");

			console.log(
				chalk.bold(`\n  Hosting ${files.length} file(s) -> ${getDomain()}/f/${box}/${site}/\n`),
			);
			// Byte total is not tracked client-side -- `finalize` derives fileCount
			// and totalBytes from R2 and returns them (printed below).
			for (const { abs, rel } of files) {
				const ct = guessContentType(rel);
				const data = fs.readFileSync(abs);
				const pre = await api(`/api/host/presign/${encodeURIComponent(box)}`, {
					method: "POST",
					body: { site, path: rel, contentType: ct },
				});
				const put = await fetch(pre.uploadUrl, {
					method: "PUT",
					headers: { "Content-Type": ct },
					body: data,
				});
				if (!put.ok) throw new Error(`R2 upload failed (${put.status}) for ${rel}`);
				console.log(
					`  ${chalk.green("↑")} ${pre.path} ${chalk.dim(`(${fmtBytes(data.byteLength)})`)}`,
				);
			}

			const ttlHours = opts.ttl ? parseDuration(opts.ttl) / 3_600_000 : undefined;
			const fin = await api(`/api/host/finalize/${encodeURIComponent(box)}`, {
				method: "POST",
				body: { site, ttlHours, authToken: opts.auth || null },
			});

			console.log(chalk.bold(`\n  Live: ${chalk.green(fin.url)}`));
			console.log(
				`  ${fin.fileCount} files, ${fmtBytes(fin.totalBytes)}${fin.private ? chalk.yellow("  [private]") : ""}`,
			);
			if (fin.expiresAt) console.log(chalk.dim(`  Expires: ${isoDate(fin.expiresAt)}`));
			if (opts.auth) console.log(chalk.dim(`  View with: ${fin.url}?auth=${opts.auth}`));
			console.log("");
		} catch (err: any) {
			console.error(chalk.red(err.message));
			process.exit(3);
		}
	});

// sites - list hosted sites for a box
program
	.command("sites <box>")
	.description("List hosted sites for a box")
	.action(async (box) => {
		const merged = program.opts();
		try {
			const data = await api(`/api/host/sites/${encodeURIComponent(box)}`);
			if (merged.format === "json") {
				console.log(JSON.stringify(data, null, 2));
				return;
			}
			const sites = data.sites || [];
			if (sites.length === 0) {
				console.log(chalk.dim(`\n  No hosted sites for ${box}\n`));
				return;
			}
			console.log(chalk.bold(`\n  Hosted sites for ${box} (${sites.length}):\n`));
			console.log(chalk.dim("  SITE                FILES   SIZE      EXPIRES        URL"));
			for (const s of sites) {
				const site = chalk.cyan(String(s.site).padEnd(18));
				const files = String(s.file_count).padStart(5);
				const size = fmtBytes(s.total_bytes).padEnd(8);
				const expires = (s.expires_at ? isoDate(s.expires_at).slice(0, 10) : "never").padEnd(13);
				const priv = s.private ? chalk.yellow(" [private]") : "";
				console.log(`  ${site} ${files}   ${size}  ${chalk.dim(expires)}  ${s.url}${priv}`);
			}
			console.log("");
		} catch (err: any) {
			console.error(chalk.red(err.message));
			process.exit(3);
		}
	});

// unhost - delete a hosted site
program
	.command("unhost <box> <site>")
	.description("Delete a hosted site (removes all its files from R2 - irreversible)")
	.action(async (box, site) => {
		try {
			const data = await api(
				`/api/host/sites/${encodeURIComponent(box)}/${encodeURIComponent(site)}`,
				{
					method: "DELETE",
				},
			);
			console.log(
				chalk.green(`\n  Deleted site '${data.site}' (${data.deleted} file(s) removed)\n`),
			);
		} catch (err: any) {
			console.error(chalk.red(err.message));
			process.exit(3);
		}
	});

// ============================================================================
// Webhook receivers (hook-*) and the messages in them (queue-*)
// ============================================================================

// A receiver reference is either its id or the `box/slug` pair you remember.
// Both are one path segment group, so neither is encoded here.
function hookPath(ref: string): string {
	return `/api/hooks/receivers/${ref.replace(/^\/+|\/+$/g, "")}`;
}

/** `lisa/01hxyz` or `lisa 01hxyz` -- the box is the authorization boundary. */
function splitEventRef(box: string, id?: string): { box: string; id: string } {
	if (id) return { box, id };
	const slash = box.indexOf("/");
	if (slash === -1) {
		throw new Error("Need a box and an event id, e.g. `queue-body lisa EVENT_ID`");
	}
	return { box: box.slice(0, slash), id: box.slice(slash + 1) };
}

/**
 * `verified` is three-valued and an agent's trust decision hangs on which one it
 * got, so none of the three is allowed to render as nothing. `unverified` is not
 * a failure -- it means the receiver asked for no signature, so the URL is the
 * only credential and the event is exactly as trustworthy as that URL is secret.
 */
function verdictLabel(verified: number | null): string {
	if (verified === 1) return chalk.green("verified");
	if (verified === 0) return chalk.red("SIGNATURE FAILED");
	return chalk.dim("unverified");
}

/**
 * The `auth_config` blob. A secret alone is enough for the named presets, which
 * know their own header, but `hmac`, `digest`, `header` and `query` are
 * configurable by definition and are unusable without these.
 */
function authConfigFromOpts(opts: any): Record<string, unknown> | undefined {
	const config: Record<string, unknown> = {};
	if (opts.secret) config.secret = opts.secret;
	if (opts.authHeader) config.header = opts.authHeader;
	if (opts.authTemplate) config.template = opts.authTemplate;
	if (opts.authParam) config.param = opts.authParam;
	if (opts.authEncoding) config.encoding = opts.authEncoding;
	if (opts.authTimestampHeader) config.timestampHeader = opts.authTimestampHeader;
	if (opts.authTolerance !== undefined) config.toleranceSeconds = parseInt(opts.authTolerance, 10);
	return Object.keys(config).length ? config : undefined;
}

/** Shared by hook-create and hook-update, so the two cannot drift apart. */
function withAuthOptions(command: Command): Command {
	return command
		.option("--secret <secret>", "Provider secret for --auth")
		.option("--auth-header <name>", "Header carrying the signature (hmac, digest, header)")
		.option("--auth-template <tpl>", "Signed string, e.g. '{body}/{secret}' (hmac, digest)")
		.option("--auth-param <name>", "Query parameter carrying the token (query mode)")
		.option("--auth-encoding <enc>", "hex | base64 (hmac, digest)")
		.option("--auth-timestamp-header <name>", "Header carrying the signed timestamp")
		.option("--auth-tolerance <seconds>", "Replay window; 0 turns it off");
}

/**
 * The setup handshake is configured separately from the signature, because it is
 * a separate secret: Meta's verify token and Zoom's secret token are not the
 * thing that signs later deliveries, and a receiver commonly needs both.
 */
function handshakeConfigFromOpts(opts: any): Record<string, unknown> | undefined {
	const config: Record<string, unknown> = {};
	if (opts.handshakeSecret) config.secret = opts.handshakeSecret;
	if (opts.handshakeToken) config.token = opts.handshakeToken;
	if (opts.handshakeStatus) config.status = parseInt(opts.handshakeStatus, 10);
	if (opts.handshakeBody) config.body = opts.handshakeBody;
	if (opts.handshakeWhen) {
		try {
			config.when = JSON.parse(opts.handshakeWhen);
		} catch {
			throw new Error(`--handshake-when must be JSON, e.g. '{"method":"GET","subpath":"setup"}'`);
		}
	}
	return Object.keys(config).length ? config : undefined;
}

function withHandshakeOptions(command: Command): Command {
	return command
		.option("--handshake <mode>", "Setup handshake: meta | slack | zoom | echo | static")
		.option("--handshake-secret <secret>", "Zoom's secret token (or Meta's verify token)")
		.option("--handshake-token <token>", "Meta's hub.verify_token")
		.option("--handshake-when <json>", "static: JSON predicate, e.g. {method:GET} as JSON")
		.option("--handshake-body <text>", "static: the fixed body to answer with")
		.option("--handshake-status <code>", "static: the fixed status to answer with");
}

function extractFromOpts(opts: any): Record<string, unknown> | undefined {
	const extract: Record<string, unknown> = {};
	if (opts.routingKey) extract.routingKeyPath = opts.routingKey;
	if (opts.eventPath) extract.eventTypePath = opts.eventPath;
	if (opts.dedupe) extract.dedupe = opts.dedupe;
	if (opts.dedupeHeader) extract.dedupeHeader = opts.dedupeHeader;
	if (opts.dedupePath) extract.dedupePath = opts.dedupePath;
	if (opts.dedupeWindow) extract.dedupeWindowMs = parseDuration(opts.dedupeWindow);
	return Object.keys(extract).length ? extract : undefined;
}

withHandshakeOptions(
	withAuthOptions(
		program
			.command("hook-create <box> [name]")
			.description("Register a webhook receiver; prints the URL to paste into the provider")
			.option("--slug <slug>", "Exact slug (no random suffix -- you are on your own for entropy)")
			.option("--label <text>", "Human note")
			.option(
				"--auth <mode>",
				"standard | github | stripe | slack | shopify | hmac | digest | bearer | basic | header | query",
			),
	),
)
	.option("--preset <name>", "Extraction preset: github, stripe, standard, slack, shopify")
	.option("--routing-key <path>", "Dotted body path to index as the correlation key")
	.option("--event-path <path>", "Dotted body path holding the event type")
	.option("--dedupe <mode>", "none | header | path | body-hash")
	.option("--dedupe-header <name>", "Header carrying the provider's message id")
	.option("--dedupe-path <path>", "Body path carrying the provider's message id")
	.option("--dedupe-window <dur>", "body-hash window, e.g. 65m (must exceed retry spacing)")
	.option("--methods <list>", "Comma-separated methods to accept", "POST")
	.option("--max-body <bytes>", "Reject bodies over this size")
	.option("--retention <days>", "Days to keep events", "120")
	.option("--daily-cap <n>", "Refuse with 429 past this many stored events in 24h")
	.option("--expires <dur>", "Auto-expire the receiver, e.g. 30d (410 after)")
	.option("--mirror", "Also write each accepted event into drops (off by default)")
	.action(async (box, name, opts) => {
		try {
			const body: Record<string, unknown> = {
				inbox: box,
				name: name || undefined,
				slug: opts.slug,
				label: opts.label,
				authMode: opts.auth,
				authConfig: authConfigFromOpts(opts),
				handshakeMode: opts.handshake,
				handshakeConfig: handshakeConfigFromOpts(opts),
				preset: opts.preset,
				extract: extractFromOpts(opts),
				methods: opts.methods,
				maxBodyBytes: opts.maxBody ? parseInt(opts.maxBody, 10) : undefined,
				retentionDays: parseInt(opts.retention, 10),
				dailyCap: opts.dailyCap ? parseInt(opts.dailyCap, 10) : undefined,
				expiresAt: opts.expires ? Date.now() + parseDuration(opts.expires) : undefined,
				mirrorToDrops: opts.mirror ? true : undefined,
			};
			const hook = await api("/api/hooks/receivers", { method: "POST", body, admin: true });

			console.log(chalk.green(`\n  Receiver created: ${chalk.cyan(hook.inbox)}/${hook.slug}`));
			console.log(`  ${chalk.bold(hook.url)}`);
			console.log(
				chalk.dim(`  id ${hook.id}  ${hook.allowed_methods}  keeps ${hook.retention_days}d`),
			);
			if (hook.handshake_mode && hook.handshake_mode !== "none") {
				// Meta verifies over GET, so the method list was widened for it. Say so
				// rather than letting it look like the flag was ignored.
				const widened = hook.handshake_mode === "meta" ? ", GET added for it" : "";
				console.log(chalk.dim(`  handshake ${hook.handshake_mode}${widened}`));
			}
			if (hook.mirror_to_drops) {
				console.log(chalk.dim("  mirrored into drops as well as the queue"));
			}
			if (!hook.secret_set) {
				// The URL is the credential when nothing is signed. Say so out loud
				// rather than letting an operator discover it later.
				console.log(
					chalk.yellow(
						"\n  No signature configured: this URL IS the credential.\n" +
							"  Anyone who learns it can write to this box's queue. Keep it out of\n" +
							"  tickets and chat logs, and rotate with `hook-rotate` if it leaks.",
					),
				);
			}
			console.log("");
		} catch (err: any) {
			console.error(chalk.red(err.message));
			process.exit(3);
		}
	});

for (const verb of ["hooks", "hook-list"]) {
	program
		.command(`${verb} [box]`)
		.description("List webhook receivers, all boxes or one")
		.action(async (box) => {
			const merged = program.opts();
			try {
				const data = await api(box ? hookPath(box) : "/api/hooks/receivers", { admin: true });
				if (merged.format === "json") {
					console.log(JSON.stringify(data, null, 2));
					return;
				}
				const hooks = data.receivers || [];
				if (hooks.length === 0) {
					console.log(chalk.dim(`\n  No receivers${box ? ` for ${box}` : ""}\n`));
					return;
				}
				console.log(chalk.bold(`\n  Receivers (${hooks.length}):\n`));
				console.log(
					chalk.dim("  BOX          SLUG                 AUTH      EVENTS  LAST         URL"),
				);
				for (const h of hooks) {
					const last = h.last_event_at ? relativeTime(h.last_event_at) : "never";
					const auth = h.secret_set ? h.auth_mode : chalk.yellow(h.auth_mode);
					console.log(
						`  ${padRight(chalk.cyan(h.inbox), 12)} ${padRight(h.slug, 20)} ${padRight(auth, 9)} ` +
							`${padLeft(String(h.event_count), 6)}  ${padRight(chalk.dim(last), 11)}  ${h.url}` +
							(h.enabled ? "" : chalk.red(" [disabled]")),
					);
				}
				console.log("");
			} catch (err: any) {
				console.error(chalk.red(err.message));
				process.exit(3);
			}
		});
}

program
	.command("hook-get <ref>")
	.description("Show one receiver in full. REF is its id or box/slug")
	.action(async (ref) => {
		const merged = program.opts();
		try {
			const h = await api(hookPath(ref), { admin: true });
			if (merged.format === "json") {
				console.log(JSON.stringify(h, null, 2));
				return;
			}
			console.log(chalk.bold(`\n  ${h.inbox}/${h.slug}`));
			console.log(`  ${chalk.bold(h.url)}\n`);
			const rows: [string, string][] = [
				["id", h.id],
				["label", h.label || chalk.dim("(none)")],
				["enabled", h.enabled ? chalk.green("yes") : chalk.red("no")],
				["auth", `${h.auth_mode}${h.secret_set ? chalk.dim(" (secret set)") : ""}`],
				[
					"handshake",
					`${h.handshake_mode}${h.handshake_secret_set ? chalk.dim(" (secret set)") : ""}`,
				],
				["preset", h.preset || chalk.dim("(none)")],
				["extract", h.extract_config ? JSON.stringify(h.extract_config) : chalk.dim("(none)")],
				["methods", h.allowed_methods],
				["max body", fmtBytes(h.max_body_bytes)],
				["retention", `${h.retention_days}d`],
				["daily cap", h.daily_cap ? String(h.daily_cap) : chalk.dim("(none)")],
				[
					"events",
					`${h.event_count}${h.last_event_at ? `, last ${relativeTime(h.last_event_at)}` : ""}`,
				],
				["expires", h.expires_at ? isoDate(h.expires_at) : chalk.dim("never")],
				["created", isoDate(h.created_at)],
			];
			if (h.previous_slug) {
				rows.push([
					"old slug",
					`${h.previous_slug} ${chalk.dim(`until ${isoDate(h.previous_slug_expires_at)}`)}`,
				]);
			}
			for (const [key, value] of rows) console.log(`  ${chalk.dim(padRight(key, 11))} ${value}`);
			console.log("");
		} catch (err: any) {
			console.error(chalk.red(err.message));
			process.exit(3);
		}
	});

program
	.command("hook-url <ref>")
	.description("Print just the receiver URL, for piping into a clipboard")
	.action(async (ref) => {
		try {
			console.log((await api(hookPath(ref), { admin: true })).url);
		} catch (err: any) {
			console.error(chalk.red(err.message));
			process.exit(3);
		}
	});

program
	.command("hook-test <ref>")
	.description("Fire a correctly-signed synthetic request at your own receiver")
	.option("--secret <secret>", "The provider secret -- the API never returns it, so pass it here")
	.option("--body <body>", "Body text, or @path to a file")
	.option("--header <name>", "Signature header, for hmac / digest / header modes")
	.option("--template <tpl>", "Signed-string template, for hmac / digest modes")
	.option("--param <name>", "Query parameter, for query mode")
	.option("--url <origin>", "Send somewhere else, e.g. http://localhost:5173")
	.option("--content-type <type>", "Body content type", "application/json")
	.action(async (ref, opts) => {
		try {
			const hook = await api(hookPath(ref), { admin: true });
			const mode = hook.auth_mode || "none";
			if (mode !== "none" && !opts.secret) {
				throw new Error(
					`${hook.inbox}/${hook.slug} verifies with '${mode}' -- pass --secret so the request can be signed`,
				);
			}

			// A unique id per run, so a receiver with dedupe configured does not answer
			// the second test with `duplicate: true` and store nothing.
			const stamp = Date.now();
			const raw: string =
				opts.body?.[0] === "@"
					? fs.readFileSync(opts.body.slice(1), "utf-8")
					: (opts.body ??
						JSON.stringify({
							id: `evt_hooktest_${stamp}`,
							type: "agent_drop.hook_test",
							created: Math.floor(stamp / 1000),
							data: { tag: "hook-test" },
						}));
			const body = new TextEncoder().encode(raw);

			const signed = await signRequest({
				mode,
				secret: opts.secret ?? "",
				body,
				timestamp: Math.floor(stamp / 1000),
				header: opts.header,
				template: opts.template,
				param: opts.param,
			});

			// The receiver's own URL, optionally re-pointed at a dev origin so the same
			// command exercises localhost and production.
			const target = new URL(hook.url);
			if (opts.url) {
				const override = new URL(opts.url);
				target.protocol = override.protocol;
				target.host = override.host;
			}
			for (const [key, value] of Object.entries(signed.query)) {
				target.searchParams.set(key, value);
			}

			console.log(chalk.dim(`\n  POST ${target}`));
			console.log(chalk.dim(`  auth ${mode}  ${body.byteLength} bytes`));

			const res = await fetch(target, {
				method: "POST",
				headers: { "Content-Type": opts.contentType, ...signed.headers },
				body,
			});
			const text = await res.text();

			const ok = res.status >= 200 && res.status < 300;
			console.log(`  ${ok ? chalk.green(res.status) : chalk.red(res.status)} ${text}\n`);
			if (!ok) {
				// A 401 here is the useful failure: the receiver is reachable and the
				// secret is wrong, which is a different problem from a 404.
				console.error(chalk.red("  Receiver did not accept it.\n"));
				process.exit(4);
			}
		} catch (err: any) {
			console.error(chalk.red(err.message));
			process.exit(3);
		}
	});

withHandshakeOptions(
	withAuthOptions(
		program
			.command("hook-update <ref>")
			.description("Update a receiver. REF is its id or box/slug")
			.option("--enable", "Resume accepting requests")
			.option("--disable", "Stop accepting requests (answers 403, keeps history)")
			.option("--label <text>", "New label")
			.option("--auth <mode>", "Change the signature scheme"),
	),
)
	.option("--preset <name>", "New extraction preset")
	.option("--handshake-clear", "Drop the handshake entirely (back to 'none')")
	.option("--routing-key <path>", "New routing-key path")
	.option("--methods <list>", "New comma-separated method list")
	.option("--max-body <bytes>", "New body size cap")
	.option("--retention <days>", "New retention in days")
	.option("--daily-cap <n>", "New cap on stored events per rolling 24h (0 clears it)")
	.option("--expires <dur>", "Expire the receiver after this long, e.g. 30d")
	.option("--mirror", "Start writing accepted events into drops as well")
	.option("--no-mirror", "Stop mirroring into drops")
	.action(async (ref, opts) => {
		try {
			const body: Record<string, unknown> = {};
			if (opts.enable) body.enabled = true;
			if (opts.disable) body.enabled = false;
			if (opts.label) body.label = opts.label;
			if (opts.auth) body.authMode = opts.auth;
			// Replaced wholesale, which is what rotation is: the old secret stops
			// working the moment the new one lands.
			const authConfig = authConfigFromOpts(opts);
			if (authConfig) body.authConfig = authConfig;
			if (opts.handshake) body.handshakeMode = opts.handshake;
			if (opts.handshakeClear) {
				body.handshakeMode = "none";
				body.handshakeConfig = null;
			}
			const handshakeConfig = handshakeConfigFromOpts(opts);
			if (handshakeConfig) body.handshakeConfig = handshakeConfig;
			if (opts.preset) body.preset = opts.preset;
			if (opts.methods) body.methods = opts.methods;
			if (opts.maxBody) body.maxBodyBytes = parseInt(opts.maxBody, 10);
			if (opts.retention) body.retentionDays = parseInt(opts.retention, 10);
			if (opts.dailyCap) body.dailyCap = parseInt(opts.dailyCap, 10);
			if (opts.expires) body.expiresAt = Date.now() + parseDuration(opts.expires);
			// Undefined when neither --mirror nor --no-mirror was passed, so an
			// unrelated patch never silently flips it either way.
			if (opts.mirror !== undefined) body.mirrorToDrops = opts.mirror;
			const extract = extractFromOpts(opts);
			if (extract) body.extract = extract;
			if (Object.keys(body).length === 0) {
				console.error(chalk.red("Nothing to update. Try --disable, --secret, --retention, ..."));
				process.exit(1);
			}
			const h = await api(hookPath(ref), { method: "PATCH", body, admin: true });
			console.log(chalk.green(`\n  Updated ${h.inbox}/${h.slug}\n`));
		} catch (err: any) {
			console.error(chalk.red(err.message));
			process.exit(3);
		}
	});

program
	.command("hook-rotate <ref>")
	.description("Issue a new slug on the same receiver -- the row, counters and history stay")
	.option("--slug <slug>", "An exact new slug (otherwise the name keeps a fresh suffix)")
	.option("--grace <dur>", "Keep the old URL answering this long, e.g. 24h")
	.action(async (ref, opts) => {
		try {
			const res = await api(`${hookPath(ref)}/rotate`, {
				method: "POST",
				admin: true,
				body: {
					slug: opts.slug,
					graceSeconds: opts.grace ? Math.floor(parseDuration(opts.grace) / 1000) : 0,
				},
			});
			console.log(chalk.green(`\n  Rotated to ${res.inbox}/${res.slug}`));
			console.log(`  ${chalk.bold(res.url)}`);
			if (res.previous_slug) {
				console.log(
					chalk.dim(
						`  ${res.previous_slug} keeps answering until ${isoDate(res.previous_slug_expires_at)}`,
					),
				);
			} else {
				// No grace means the old URL is dead now, which is the right default when
				// the reason for rotating is that it leaked.
				console.log(
					chalk.yellow("  The old URL is dead now -- pass --grace for a cutover window."),
				);
			}
			console.log(chalk.dim("  Every event it already took is still there: they key on the id.\n"));
		} catch (err: any) {
			console.error(chalk.red(err.message));
			process.exit(3);
		}
	});

program
	.command("hook-delete <ref>")
	.description("Delete a receiver. Its events survive unless --purge")
	.option("--purge", "Also destroy every event it received, R2 bodies included")
	.action(async (ref, opts) => {
		try {
			const res = await api(`${hookPath(ref)}${opts.purge ? "?purge=1" : ""}`, {
				method: "DELETE",
				admin: true,
			});
			const purged = res.purged ? chalk.yellow(` (${res.purged} event(s) destroyed)`) : "";
			console.log(chalk.green(`\n  Receiver deleted${purged}\n`));
		} catch (err: any) {
			console.error(chalk.red(err.message));
			process.exit(3);
		}
	});

function queueQuery(opts: any): string {
	const params = new URLSearchParams();
	if (opts.receiver) params.set("receiver", opts.receiver);
	if (opts.status) params.set("status", opts.status);
	if (opts.key) params.set("key", opts.key);
	if (opts.event) params.set("event", opts.event);
	if (opts.since) params.set("since", opts.since);
	if (opts.limit) params.set("limit", String(opts.limit));
	const query = params.toString();
	return query ? `?${query}` : "";
}

function addQueueFilters(cmd: any) {
	return cmd
		.option("--receiver <idOrSlug>", "Only this receiver")
		.option("--status <status>", "queued | leased | acked | rejected | handshake")
		.option("--key <value>", "Only this routing key")
		.option("--event <type>", "Only this event type")
		.option("--since <id>", "Arrival cursor: only events after this id")
		.option("-l, --limit <n>", "Max results", "20");
}

addQueueFilters(
	program.command("queue-list <box>").description("List webhook events in a box"),
).action(async (box: string, opts: any) => {
	const merged = program.opts();
	try {
		const data = await api(`/api/hooks/queue/${encodeURIComponent(box)}${queueQuery(opts)}`);
		if (merged.format === "json") {
			console.log(JSON.stringify(data, null, 2));
			return;
		}
		if (!data.count) {
			console.log(chalk.dim(`\n  No events in ${box}\n`));
			return;
		}
		console.log(chalk.bold(`\n  Events in ${box} (${data.count}):\n`));
		console.log(
			chalk.dim("  WHEN        ID                          RECEIVER    STATUS    TYPE / KEY"),
		);
		for (const e of data.events) {
			const status =
				e.status === "rejected"
					? chalk.red(e.status)
					: e.status === "queued"
						? chalk.green(e.status)
						: e.status;
			const label =
				[e.event_type, e.routing_key].filter(Boolean).join(" / ") || chalk.dim("(none)");
			console.log(
				`  ${padRight(relativeTime(e.created_at), 11)} ${chalk.dim(e.id)} ` +
					`${padRight(chalk.cyan(truncate(e.slug, 11)), 11)} ${padRight(status, 9)} ${label}`,
			);
		}
		console.log("");
	} catch (err: any) {
		console.error(chalk.red(err.message));
		process.exit(3);
	}
});

addQueueFilters(
	program
		.command("queue-peek <box> [eventId]")
		.description("Read events in full WITHOUT taking a lease -- changes nothing"),
).action(async (box: string, eventId: string | undefined, opts: any) => {
	const merged = program.opts();
	try {
		const data = eventId
			? { events: [await api(`/api/hooks/queue/${encodeURIComponent(box)}/${eventId}`)], count: 1 }
			: await api(`/api/hooks/queue/${encodeURIComponent(box)}/peek${queueQuery(opts)}`, {
					method: "POST",
				});
		if (merged.format === "json") {
			// Parse the body when it is JSON, so an agent pipes straight into jq.
			for (const e of data.events) {
				try {
					e.body_json = e.body ? JSON.parse(e.body) : null;
				} catch {
					e.body_json = null;
				}
			}
			console.log(JSON.stringify(data, null, 2));
			return;
		}
		if (!data.count) {
			console.log(chalk.dim(`\n  Nothing to peek in ${box}\n`));
			return;
		}
		for (const e of data.events) {
			console.log(chalk.bold(`\n  ${e.id}`) + chalk.dim(`  ${isoDate(e.created_at)}`));
			console.log(
				`  ${e.method} ${e.inbox}/${e.slug}${e.subpath ? `/${e.subpath}` : ""}  ` +
					`${e.status}  ${verdictLabel(e.verified)}`,
			);
			if (e.leased_until && e.leased_until > Date.now()) {
				console.log(
					chalk.yellow(`  leased for another ${relativeTime(2 * Date.now() - e.leased_until)}`),
				);
			}
			const label = [e.event_type, e.routing_key].filter(Boolean).join(" / ");
			if (label) console.log(`  ${chalk.dim("type/key")} ${label}`);
			console.log(chalk.dim(`  ${fmtBytes(e.body_bytes || 0)}  sha256 ${e.body_sha256}`));
			console.log(chalk.dim("  headers:"));
			for (const [k, v] of Object.entries(e.headers || {})) console.log(`    ${k}: ${v}`);
			if (e.body !== null && e.body !== undefined) {
				console.log(chalk.dim("  body:"));
				console.log(
					e.body
						.split("\n")
						.map((l: string) => `    ${l}`)
						.join("\n"),
				);
			} else if (e.body_available) {
				console.log(chalk.dim("  body: not inline -- use `queue-body` for the raw bytes"));
			}
		}
		console.log("");
	} catch (err: any) {
		console.error(chalk.red(err.message));
		process.exit(3);
	}
});

program
	.command("queue-body <box> [eventId]")
	.description("Write an event's raw bytes to stdout or a file (BOX/ID also works)")
	// `-o, --output` is the program-wide flag; declaring a second `-o` here would
	// be shadowed by it and silently ignored.
	.option("-o, --output <file>", "Write to this file instead of stdout")
	.action(async (box, eventId, opts) => {
		try {
			const ref = splitEventRef(box, eventId);
			const res = await apiRaw(
				`/api/hooks/queue/${encodeURIComponent(ref.box)}/${encodeURIComponent(ref.id)}/body`,
			);
			// Bytes go through untouched: this is the endpoint a consumer verifies
			// the provider's signature against.
			const bytes = new Uint8Array(await res.arrayBuffer());
			const out = opts.output || program.opts().output;
			if (out) {
				fs.writeFileSync(out, bytes);
				console.error(chalk.green(`  Wrote ${fmtBytes(bytes.byteLength)} to ${out}`));
			} else {
				process.stdout.write(bytes);
			}
		} catch (err: any) {
			console.error(chalk.red(err.message));
			process.exit(3);
		}
	});

/**
 * `lisa ID ID` or `lisa/ID`. The box is not decoration: it is the authorization
 * boundary every queue statement filters on, so an id never travels alone.
 */
function eventIds(box: string, ids: string[]): { box: string; ids: string[] } {
	if (ids.length) return { box, ids };
	const slash = box.indexOf("/");
	if (slash === -1) {
		throw new Error("Need a box and at least one event id, e.g. `queue-remove lisa EVENT_ID`");
	}
	return { box: box.slice(0, slash), ids: [box.slice(slash + 1)] };
}

function queuePost(box: string, verb: string, body: unknown): Promise<any> {
	return api(`/api/hooks/queue/${encodeURIComponent(box)}/${verb}`, { method: "POST", body });
}

/** `Key:Value` pairs, repeatable, for --header. */
function headerPairs(values: string[] | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	for (const pair of values ?? []) {
		const colon = pair.indexOf(":");
		if (colon === -1) throw new Error(`--header wants Key:Value, got '${pair}'`);
		out[pair.slice(0, colon).trim()] = pair.slice(colon + 1).trim();
	}
	return out;
}

function queryPairs(values: string[] | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	for (const pair of values ?? []) {
		const eq = pair.indexOf("=");
		if (eq === -1) throw new Error(`--query wants key=value, got '${pair}'`);
		out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
	}
	return out;
}

/** One event, the way `queue-peek` renders it, so pulled and peeked look alike. */
function printEvent(e: any) {
	console.log(chalk.bold(`\n  ${e.id}`) + chalk.dim(`  ${isoDate(e.created_at)}`));
	console.log(
		`  ${e.method} ${e.inbox}/${e.slug}${e.subpath ? `/${e.subpath}` : ""}  ` +
			`${e.status}  ${verdictLabel(e.verified)}`,
	);
	const label = [e.event_type, e.routing_key].filter(Boolean).join(" / ");
	if (label) console.log(`  ${chalk.dim("type/key")} ${label}`);
	console.log(chalk.dim(`  ${fmtBytes(e.body_bytes || 0)}  sha256 ${e.body_sha256}`));
	if (e.body !== null && e.body !== undefined) {
		console.log(
			e.body
				.split("\n")
				.map((l: string) => `    ${l}`)
				.join("\n"),
		);
	} else if (e.body_available) {
		console.log(chalk.dim("  body: not inline -- use `queue-body` for the raw bytes"));
	}
}

program
	.command("queue-get <box>")
	.description("LEASE events off the queue -- they are hidden from other consumers")
	.option("--receiver <idOrSlug>", "Only this receiver")
	.option("-l, --limit <n>", "How many to take", "10")
	.option("--lease <seconds>", "How long to hold them", "60")
	.option("--remove", "Ack at handout -- at-most-once, no lease bookkeeping")
	.option("--delete-on-success", "Destroy each event once its write has returned (see below)")
	.addHelpText(
		"after",
		"\n  --delete-on-success destroys an event after the write of it RETURNED, which\n" +
			"  down a pipe means the OS accepted the bytes, not that the reader processed\n" +
			"  them. A consumer that needs stronger than that should lease, do the work,\n" +
			"  and `queue-remove` when it is genuinely done -- that is the default for a\n" +
			"  reason. What --delete-on-success does guarantee is that a run which dies\n" +
			"  partway leaves the rest LEASED, never destroyed.\n",
	)
	.action(async (box, opts) => {
		const merged = program.opts();
		try {
			if (opts.remove && opts.deleteOnSuccess) {
				throw new Error("--remove and --delete-on-success are two different exits; pick one");
			}
			const data = await queuePost(box, "get", {
				limit: parseInt(opts.limit, 10),
				leaseSeconds: parseInt(opts.lease, 10),
				receiver: opts.receiver,
				remove: Boolean(opts.remove),
			});

			if (!data.count) {
				if (merged.format === "json") console.log(JSON.stringify({ events: [], count: 0 }));
				else console.log(chalk.dim(`\n  Nothing queued in ${box}\n`));
				return;
			}

			// The write happens BEFORE the delete, one event at a time. A pull that dies
			// halfway leaves the remainder leased rather than destroyed -- see
			// tools/lib/queue-emit.ts, which exists so that ordering is testable.
			const result = await emitEvents<any>({
				events: data.events,
				write: (e) => {
					if (merged.format === "json") {
						try {
							e.body_json = e.body ? JSON.parse(e.body) : null;
						} catch {
							e.body_json = null;
						}
						process.stdout.write(`${JSON.stringify(e)}\n`);
					} else {
						printEvent(e);
					}
				},
				finish: opts.deleteOnSuccess
					? async (e) => {
							await api(`/api/hooks/queue/${encodeURIComponent(box)}/${encodeURIComponent(e.id)}`, {
								method: "DELETE",
							});
						}
					: undefined,
			});

			if (merged.format !== "json") {
				console.log("");
				if (data.lease_id) {
					console.log(
						chalk.dim(
							`  lease ${data.lease_id} until ${isoDate(data.leased_until)} -- ` +
								"`queue-remove` when done, `queue-return` to hand back",
						),
					);
				} else if (opts.remove) {
					console.log(chalk.dim("  removed at handout (--remove): nothing is being held"));
				}
				if (opts.deleteOnSuccess) {
					console.log(chalk.dim(`  destroyed ${result.finished.length} after writing`));
				}
				console.log("");
			}

			if (result.error) {
				console.error(chalk.red(`  Output failed: ${result.error}`));
				console.error(
					chalk.dim(`  ${result.remaining.length} event(s) left leased, not destroyed.`),
				);
				process.exit(5);
			}
		} catch (err: any) {
			console.error(chalk.red(err.message));
			process.exit(3);
		}
	});

program
	.command("queue-remove <box> [ids...]")
	.description("Ack: off the queue, row kept and still readable (BOX/ID also works)")
	.action(async (box, list) => {
		try {
			const ref = eventIds(box, list);
			const res = await queuePost(ref.box, "remove", { ids: ref.ids });
			const notes = [
				res.already_removed ? `${res.already_removed} already removed` : "",
				res.skipped_handshake ? chalk.yellow(`${res.skipped_handshake} handshake, kept`) : "",
				res.missing ? chalk.red(`${res.missing} not in ${ref.box}`) : "",
			].filter(Boolean);
			console.log(
				chalk.green(`\n  Removed ${res.removed}`) +
					(notes.length ? chalk.dim(`  (${notes.join(", ")})`) : "") +
					"\n",
			);
		} catch (err: any) {
			console.error(chalk.red(err.message));
			process.exit(3);
		}
	});

program
	.command("queue-return <box> [ids...]")
	.description("Nack: release a lease immediately, back onto the queue")
	.action(async (box, list) => {
		try {
			const ref = eventIds(box, list);
			const res = await queuePost(ref.box, "return", { ids: ref.ids });
			console.log(chalk.green(`\n  Returned ${res.returned} of ${res.requested}\n`));
		} catch (err: any) {
			console.error(chalk.red(err.message));
			process.exit(3);
		}
	});

program
	.command("queue-extend <box> [ids...]")
	.description("Hold a lease longer, mid-work -- ownership does not change")
	.option("--lease <seconds>", "New remaining lease", "300")
	.option("--lease-id <id>", "Only extend if this is still your lease")
	.action(async (box, list, opts) => {
		try {
			const ref = eventIds(box, list);
			const res = await queuePost(ref.box, "extend", {
				ids: ref.ids,
				leaseSeconds: parseInt(opts.lease, 10),
				leaseId: opts.leaseId,
			});
			console.log(
				chalk.green(`\n  Extended ${res.extended} of ${res.requested}`) +
					chalk.dim(` until ${isoDate(res.leased_until)}\n`),
			);
			if (res.extended < res.requested) {
				// An expired lease is back in the pool and may be someone else's now.
				console.log(chalk.dim("  Not extended: already expired, or not your lease.\n"));
			}
		} catch (err: any) {
			console.error(chalk.red(err.message));
			process.exit(3);
		}
	});

program
	.command("queue-requeue <box> [ids...]")
	.description("Put a removed or rejected event back on the queue")
	.action(async (box, list) => {
		try {
			const ref = eventIds(box, list);
			const res = await queuePost(ref.box, "requeue", { ids: ref.ids });
			console.log(chalk.green(`\n  Requeued ${res.requeued} of ${res.requested}\n`));
			if (res.requeued < res.requested) {
				console.log(
					chalk.dim("  Only removed and rejected events requeue. Handshakes never do.\n"),
				);
			}
		} catch (err: any) {
			console.error(chalk.red(err.message));
			process.exit(3);
		}
	});

program
	.command("queue-delete <box> [ids...]")
	.description("DESTROY events and their R2 bodies -- unlike queue-remove, nothing survives")
	.option("--removed", "Bulk: everything already removed (acked)")
	.option("--before <id>", "Bulk: everything that arrived before this id")
	.option("-y, --yes", "Skip the confirmation on a bulk delete")
	.action(async (box, list, opts) => {
		try {
			const bulk = Boolean(opts.removed || opts.before);
			const ref = bulk ? { box, ids: [] } : eventIds(box, list);
			if (bulk && !opts.yes) {
				// Say what it will destroy, then make the operator say it again. A bulk
				// destroy that only prints a count afterwards is a bad afternoon.
				const preview = await api(
					`/api/hooks/queue/${encodeURIComponent(box)}?limit=200` +
						`${opts.removed ? "&status=acked" : ""}`,
				);
				const doomed = opts.before
					? preview.events.filter((e: any) => e.id < opts.before)
					: preview.events;
				console.log(
					chalk.yellow(`\n  About to DESTROY ${doomed.length} event(s) in ${box}:`) +
						chalk.dim(`  (showing up to 200)\n`),
				);
				for (const e of doomed.slice(0, 10)) {
					console.log(`    ${e.id}  ${e.status}  ${chalk.dim(relativeTime(e.created_at))}`);
				}
				if (doomed.length > 10) console.log(chalk.dim(`    ... and ${doomed.length - 10} more`));
				console.log(chalk.dim("\n  Re-run with --yes to destroy them.\n"));
				return;
			}

			const res = await queuePost(ref.box, "delete", {
				ids: ref.ids.length ? ref.ids : undefined,
				removed: opts.removed || undefined,
				before: opts.before,
			});
			console.log(chalk.green(`\n  Destroyed ${res.deleted} event(s), R2 bodies included\n`));
		} catch (err: any) {
			console.error(chalk.red(err.message));
			process.exit(3);
		}
	});

program
	.command("queue-put <box>")
	.description("Inject a message as if a provider had sent it -- same path, same checks")
	.requiredOption("--receiver <idOrSlug>", "Which receiver it arrives on")
	.option("--body <body>", "Body text, or @path to a file (@- for stdin)", "{}")
	.option("--header <kv...>", "Request headers as Key:Value")
	.option("--query <kv...>", "Query parameters as key=value")
	.option("--method <method>", "HTTP method", "POST")
	.option("--subpath <path>", "Anything after /h/{box}/{slug}")
	.option("--content-type <type>", "Body content type", "application/json")
	.action(async (box, opts) => {
		const merged = program.opts();
		try {
			const res = await fetch(`${getBaseUrl()}/api/hooks/queue/${encodeURIComponent(box)}/put`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${getApiKey()}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					receiver: opts.receiver,
					method: opts.method,
					subpath: opts.subpath,
					headers: headerPairs(opts.header),
					query: queryPairs(opts.query),
					body: resolveBody(opts.body),
					contentType: opts.contentType,
				}),
			});
			const data: any = await res.json();
			if (merged.format === "json") {
				console.log(JSON.stringify(data, null, 2));
			} else if (data.injected) {
				const dup = data.duplicate ? chalk.yellow(" (duplicate -- nothing stored)") : "";
				console.log(chalk.green(`\n  Injected ${data.id}${dup}`));
				console.log(chalk.dim(`  receiver answered ${data.receiver_status}\n`));
			} else {
				// The receive path is not lenient because the caller is authenticated: a
				// receiver that verifies signatures rejects an unsigned injection, and the
				// row is stored `rejected` exactly as a real one would be.
				console.log(chalk.red(`\n  Receiver rejected it: ${data.error || data.receiver_status}`));
				if (data.id) console.log(chalk.dim(`  stored as ${data.id} (${data.event_status})`));
				console.log("");
			}
			if (!data.injected) process.exit(4);
		} catch (err: any) {
			console.error(chalk.red(err.message));
			process.exit(3);
		}
	});

program
	.command("queue-stats [box]")
	.description("Counts by status, bytes and last arrival. No box = every box (needs admin)")
	.action(async (box) => {
		const merged = program.opts();
		try {
			let boxes: string[];
			if (box) {
				boxes = [box];
			} else {
				const data = await api("/api/hooks/receivers", { admin: true });
				const names: string[] = (data.receivers || []).map((r: any) => String(r.inbox));
				boxes = [...new Set(names)].sort();
			}
			const all = [];
			for (const name of boxes) {
				all.push(await api(`/api/hooks/queue/${encodeURIComponent(name)}/stats`));
			}
			if (merged.format === "json") {
				console.log(JSON.stringify(box ? all[0] : { boxes: all }, null, 2));
				return;
			}
			if (!all.length) {
				console.log(chalk.dim("\n  No receivers yet\n"));
				return;
			}
			console.log(chalk.bold("\n  Queue:\n"));
			console.log(
				chalk.dim("  BOX          TOTAL  QUEUED  LEASED  ACKED  REJECTED  HANDSHAKE  SIZE   LAST"),
			);
			for (const s of all) {
				const by = s.by_status || {};
				console.log(
					`  ${padRight(chalk.cyan(s.inbox), 12)} ${padLeft(String(s.total), 5)}  ` +
						`${padLeft(String(by.queued || 0), 6)}  ${padLeft(String(s.leased_now || 0), 6)}  ` +
						`${padLeft(String(by.acked || 0), 5)}  ${padLeft(String(by.rejected || 0), 8)}  ` +
						`${padLeft(String(by.handshake || 0), 9)}  ${padRight(fmtBytes(s.bytes || 0), 6)} ` +
						chalk.dim(s.last_event_at ? relativeTime(s.last_event_at) : "never"),
				);
			}
			console.log("");
		} catch (err: any) {
			console.error(chalk.red(err.message));
			process.exit(3);
		}
	});

program
	.command("queue-replay <box> [eventId]")
	.description(
		"CLIENT-side re-delivery: POST a stored event to a URL from here, once. No retries, no delivery log -- use hook-replay for those",
	)
	.requiredOption("--to <url>", "Where to POST it")
	.option("--header <kv...>", "Extra headers as Key:Value (override the stored ones)")
	.action(async (box, eventId, opts) => {
		try {
			const ref = splitEventRef(box, eventId);
			const event = await api(
				`/api/hooks/queue/${encodeURIComponent(ref.box)}/${encodeURIComponent(ref.id)}`,
			);
			const raw = await apiRaw(
				`/api/hooks/queue/${encodeURIComponent(ref.box)}/${encodeURIComponent(ref.id)}/body`,
			);
			const bytes = new Uint8Array(await raw.arrayBuffer());

			// The same filter the server's `passthrough` mode uses, so a client replay
			// and a queued one put the same request on the wire.
			const headers = replayableHeaders(event.headers || null);
			Object.assign(headers, headerPairs(opts.header));

			console.log(chalk.dim(`\n  POST ${opts.to}  ${fmtBytes(bytes.byteLength)}`));
			const res = await fetch(opts.to, { method: "POST", headers, body: bytes });
			const text = (await res.text()).slice(0, 500);
			const ok = res.status >= 200 && res.status < 300;
			console.log(`  ${ok ? chalk.green(res.status) : chalk.red(res.status)} ${text}\n`);
			if (!ok) process.exit(4);
		} catch (err: any) {
			console.error(chalk.red(err.message));
			process.exit(3);
		}
	});

program
	.command("hook-replay <box> [eventId]")
	.description(
		"SERVER-side re-delivery: queue a stored event through the retry machinery and delivery log. Use queue-replay for a one-shot POST from here",
	)
	.option("--to <url>", "Deliver to this URL. Omit to re-fire whatever rules match")
	.option("--mode <mode>", "envelope (default) or passthrough (the provider's original request)")
	.option("--header <kv...>", "Extra headers as Key:Value (override the stored ones)")
	.action(async (box, eventId, opts) => {
		try {
			const ref = splitEventRef(box, eventId);
			const body: Record<string, unknown> = {};
			if (opts.to) body.to = opts.to;
			if (opts.mode) body.mode = opts.mode;
			const extra = headerPairs(opts.header);
			if (Object.keys(extra).length) body.headers = extra;

			const res = await api(
				`/api/hooks/queue/${encodeURIComponent(ref.box)}/${encodeURIComponent(ref.id)}/replay`,
				{ method: "POST", body },
			);

			if (res.mode === "rules") {
				const fired = res.deliveries || [];
				console.log(chalk.green(`\n  Replayed ${res.replayed} through the rules engine`));
				if (!fired.length) {
					console.log(chalk.dim("  No rule matched -- nothing was queued.\n"));
					return;
				}
				for (const d of fired) {
					const color = d.status === "failed" ? chalk.red : chalk.dim;
					console.log(`  ${color(padRight(d.status, 9))} ${d.target}`);
				}
				console.log(
					chalk.dim("\n  Watch them with: drop deliveries --drop " + res.replayed + "\n"),
				);
				return;
			}

			console.log(chalk.green(`\n  Queued ${res.replayed} -> ${res.target}`));
			console.log(chalk.dim(`  mode ${res.mode}  delivery ${res.delivery}`));
			console.log(chalk.dim(`  Retries and status: drop deliveries --drop ${res.replayed}\n`));
		} catch (err: any) {
			console.error(chalk.red(err.message));
			process.exit(3);
		}
	});

program.parseAsync();
