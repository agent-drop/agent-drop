#!/usr/bin/env bun
/**
 * Agent Drop CLI - Manage drop inboxes, targets, and API keys
 *
 * Interacts with the agent-drop system at example.com for receiving
 * emails, web form submissions, and API drops into named inboxes.
 */

import { Command } from "commander"
import { formatOutput, addCommonOptions, createLogger } from "./lib/cli-utils"
import chalk from "chalk"
import * as fs from "fs"
import * as path from "path"
import * as yaml from "yaml"

// ============================================================================
// Config
// ============================================================================

const PROJECT_ROOT = path.resolve(import.meta.dir, "..")
const AGENT_DROP_ENV = path.join(PROJECT_ROOT, ".env")

function loadEnvFile(filePath: string): Record<string, string> {
	if (!fs.existsSync(filePath)) return {}
	const content = fs.readFileSync(filePath, "utf8")
	const vars: Record<string, string> = {}
	for (const line of content.split("\n")) {
		const match = line.match(/^([A-Z_]+)=(.+)$/)
		if (match) vars[match[1]] = match[2].trim()
	}
	return vars
}

// Load the project .env (env vars from the shell / ~/.secrets take precedence)
const envVars = loadEnvFile(AGENT_DROP_ENV)

function getAdminKey(): string {
	const key = process.env.AGENT_DROP_ADMIN_KEY || envVars.ADMIN_API_KEY
	if (!key) {
		console.error(chalk.red("No admin key found. Set AGENT_DROP_ADMIN_KEY or add ADMIN_API_KEY to agent-drop/.env"))
		process.exit(1)
	}
	return key
}

function getApiKey(): string {
	// For inbox/send routes, use the ad_* API key
	const key = process.env.AGENT_DROP_API_KEY || envVars.API_KEY
	if (!key) {
		// Fall back to admin key (works for admin-only routes)
		return getAdminKey()
	}
	return key
}

function getBaseUrl(): string {
	return process.env.AGENT_DROP_URL || "https://example.com"
}

// ============================================================================
// API Client
// ============================================================================

async function api(path: string, options: { method?: string; body?: unknown; admin?: boolean } = {}): Promise<any> {
	const url = `${getBaseUrl()}${path}`
	const key = options.admin ? getAdminKey() : getApiKey()

	const res = await fetch(url, {
		method: options.method || "GET",
		headers: {
			"Authorization": `Bearer ${key}`,
			"Content-Type": "application/json",
		},
		body: options.body ? JSON.stringify(options.body) : undefined,
	})

	if (!res.ok) {
		const text = await res.text()
		let msg: string
		try {
			msg = JSON.parse(text).error || text
		} catch {
			msg = text
		}
		throw new Error(`API ${res.status}: ${msg}`)
	}

	return res.json()
}

async function apiRaw(path: string): Promise<Response> {
	const url = `${getBaseUrl()}${path}`
	const key = getApiKey()
	const res = await fetch(url, {
		headers: { "Authorization": `Bearer ${key}` },
	})
	if (!res.ok) {
		throw new Error(`API ${res.status}: ${await res.text()}`)
	}
	return res
}

// ============================================================================
// Time Helpers
// ============================================================================

function relativeTime(epochMs: number): string {
	const diff = Date.now() - epochMs
	if (diff < 0) return "in the future"
	if (diff < 60_000) return "just now"
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
	if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`
	return new Date(epochMs).toISOString().slice(0, 10)
}

function parseDuration(dur: string): number {
	const match = dur.match(/^(\d+)(s|m|h|d|w)$/)
	if (!match) throw new Error(`Invalid duration: ${dur} (use e.g. 1h, 24h, 7d)`)
	const n = parseInt(match[1])
	const unit = match[2]
	const multipliers: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }
	return n * multipliers[unit]
}

function isoDate(epochMs: number): string {
	return new Date(epochMs).toISOString().replace("T", " ").slice(0, 19)
}

// ============================================================================
// Table Formatting
// ============================================================================

function padRight(str: string, len: number): string {
	const stripped = str.replace(/\x1b\[\d+m/g, "")
	const pad = Math.max(0, len - stripped.length)
	return str + " ".repeat(pad)
}

function padLeft(str: string, len: number): string {
	const stripped = str.replace(/\x1b\[\d+m/g, "")
	const pad = Math.max(0, len - stripped.length)
	return " ".repeat(pad) + str
}

function truncate(str: string, len: number): string {
	if (str.length <= len) return str
	return str.slice(0, len - 1) + "\u2026"
}

// ============================================================================
// Drop Formatters
// ============================================================================

function formatDropRow(drop: any): string {
	const time = relativeTime(drop.created_at)
	const inbox = chalk.cyan(drop.inbox)
	const channel = chalk.dim(drop.channel)
	const subject = drop.subject ? truncate(drop.subject, 50) : chalk.dim("(no subject)")
	const from = drop.from_addr ? chalk.dim(truncate(drop.from_addr, 30)) : ""
	const unread = drop.read_at ? " " : chalk.yellow("*")
	const files = drop.attachment_count > 0 ? chalk.dim(` [${drop.attachment_count} files]`) : ""

	return `${unread} ${padRight(time, 10)} ${padRight(inbox, 14)} ${padRight(channel, 5)} ${subject}${files} ${from}`
}

function formatDropDetail(drop: any): string {
	const lines: string[] = []
	lines.push(chalk.bold(`Drop ${drop.id}`))
	lines.push(`  Inbox:    ${chalk.cyan(drop.inbox)}`)
	lines.push(`  Channel:  ${drop.channel}`)
	lines.push(`  Created:  ${isoDate(drop.created_at)} (${relativeTime(drop.created_at)})`)
	if (drop.read_at) lines.push(`  Read:     ${isoDate(drop.read_at)}`)
	if (drop.from_addr) lines.push(`  From:     ${drop.from_addr}`)
	if (drop.from_user) lines.push(`  User:     ${drop.from_user}`)
	if (drop.subject) lines.push(`  Subject:  ${drop.subject}`)
	if (drop.topic) lines.push(`  Topic:    ${drop.topic}`)
	if (drop.attachment_count > 0) lines.push(`  Files:    ${drop.attachment_count}`)
	if (drop.body_text) {
		lines.push("")
		lines.push(chalk.dim("--- body ---"))
		lines.push(truncate(drop.body_text, 500))
	}
	return lines.join("\n")
}

// ============================================================================
// Commands
// ============================================================================

async function cmdDrops(options: any) {
	const log = createLogger(options.quiet)
	const params = new URLSearchParams()

	if (options.limit) params.set("limit", options.limit)

	if (options.since) {
		const ms = parseDuration(options.since)
		params.set("since", String(Date.now() - ms))
	}

	if (options.channel) params.set("channel", options.channel)

	let url = "/api/drops"
	// If --box is set, use the inbox endpoint instead
	if (options.box) {
		url = `/api/inbox/${encodeURIComponent(options.box)}`
	}

	const qs = params.toString()
	if (qs) url += `?${qs}`

	// /api/drops needs admin auth, /api/inbox/* uses API key
	const useAdmin = !options.box
	const data = await api(url, { admin: useAdmin })
	const drops = data.drops || []

	if (options.format === "json") {
		formatOutput(data, options)
		return
	}

	if (drops.length === 0) {
		log.info("No drops found")
		return
	}

	console.log(chalk.bold(`\n  Drops (${drops.length}):\n`))
	console.log(chalk.dim(`  ${padRight("", 2)}${padRight("WHEN", 10)} ${padRight("INBOX", 14)} ${padRight("CH", 5)} SUBJECT`))
	for (const drop of drops) {
		console.log(`  ${formatDropRow(drop)}`)
	}
	console.log("")
}

async function cmdBoxes(options: any) {
	const data = await api("/api/boxes", { admin: true })
	const boxes = data.boxes || []

	if (options.format === "json") {
		formatOutput(data, options)
		return
	}

	if (boxes.length === 0) {
		console.log(chalk.dim("No boxes found"))
		return
	}

	console.log(chalk.bold(`\n  Boxes (${boxes.length}):\n`))
	console.log(chalk.dim(`  ${padRight("NAME", 18)} ${padLeft("TOTAL", 6)} ${padLeft("UNREAD", 7)} ${padLeft("FILES", 6)} ${padRight("CHANNELS", 14)} ${padRight("LAST DROP", 12)} TOKENS`))

	for (const box of boxes) {
		const unread = box.unread > 0 ? chalk.yellow(String(box.unread)) : chalk.dim("0")
		const lastDrop = box.last_drop_at ? relativeTime(box.last_drop_at) : chalk.dim("never")
		const tokens = box.active_tokens > 0 ? chalk.green(String(box.active_tokens)) : chalk.dim("0")

		console.log(
			`  ${padRight(chalk.cyan(box.inbox), 18)} ` +
			`${padLeft(String(box.total_drops), 6)} ` +
			`${padLeft(unread, 7)} ` +
			`${padLeft(String(box.total_files || 0), 6)} ` +
			`${padRight(box.channels || "", 14)} ` +
			`${padRight(lastDrop, 12)} ` +
			`${tokens}`
		)
	}
	console.log("")
}

async function cmdInbox(name: string, options: any) {
	const params = new URLSearchParams()
	if (options.limit) params.set("limit", options.limit)
	if (options.unread) params.set("unread", "true")
	if (options.topic) params.set("topic", options.topic)

	const qs = params.toString()
	const url = `/api/inbox/${encodeURIComponent(name)}${qs ? `?${qs}` : ""}`

	const data = await api(url)
	const drops = data.drops || []

	if (options.format === "json") {
		formatOutput(data, options)
		return
	}

	if (drops.length === 0) {
		console.log(chalk.dim(`No drops in inbox "${name}"`))
		return
	}

	console.log(chalk.bold(`\n  Inbox: ${chalk.cyan(name)} (${drops.length} drops)\n`))
	console.log(chalk.dim(`  ${padRight("", 2)}${padRight("WHEN", 10)} ${padRight("CH", 5)} SUBJECT`))

	for (const drop of drops) {
		const time = relativeTime(drop.created_at)
		const channel = chalk.dim(drop.channel)
		const subject = drop.subject ? truncate(drop.subject, 60) : chalk.dim("(no subject)")
		const unread = drop.read_at ? " " : chalk.yellow("*")
		const files = drop.attachment_count > 0 ? chalk.dim(` [${drop.attachment_count} files]`) : ""
		const from = drop.from_addr ? chalk.dim(` <${truncate(drop.from_addr, 25)}>`) : ""

		console.log(`  ${unread} ${padRight(time, 10)} ${padRight(channel, 5)} ${subject}${files}${from}`)
	}
	console.log("")
}

async function cmdTarget(name: string, options: any) {
	const ttl = parseInt(options.ttl || "2")

	const data = await api("/api/targets", {
		method: "POST",
		body: { inbox: name, ttl_hours: ttl },
		admin: true,
	})

	if (options.format === "json") {
		formatOutput(data, options)
		return
	}

	console.log(chalk.bold(`\n  Drop target created\n`))
	console.log(`  Inbox:     ${chalk.cyan(data.inbox)}`)
	console.log(`  URL:       ${chalk.green(data.url)}`)
	console.log(`  Token:     ${chalk.dim(data.token)}`)
	console.log(`  Expires:   ${isoDate(data.expires_at)} (${data.expires_in})`)
	console.log("")
}

async function cmdTargets(options: any) {
	const data = await api("/api/targets", { admin: true })
	const targets = data.targets || []

	if (options.format === "json") {
		formatOutput(data, options)
		return
	}

	if (targets.length === 0) {
		console.log(chalk.dim("No active drop targets"))
		return
	}

	console.log(chalk.bold(`\n  Active targets (${targets.length}):\n`))
	console.log(chalk.dim(`  ${padRight("ID", 38)} ${padRight("INBOX", 18)} ${padRight("EXPIRES", 12)} CREATED BY`))

	for (const t of targets) {
		const expires = relativeTime(t.expires_at)
		const remaining = t.expires_at - Date.now()
		const expiresStr = remaining > 0 ? chalk.green(`in ${Math.ceil(remaining / 3_600_000)}h`) : chalk.red("expired")

		console.log(
			`  ${padRight(chalk.dim(t.id), 38)} ` +
			`${padRight(chalk.cyan(t.inbox), 18)} ` +
			`${padRight(expiresStr, 12)} ` +
			`${t.created_by || chalk.dim("-")}`
		)
	}
	console.log("")
}

async function cmdPoll(options: any) {
	const log = createLogger(options.quiet)
	const interval = parseInt(options.interval || "5") * 1000
	const continuous = options.continuous || false
	const periodMs = continuous ? Infinity : parseDuration(options.period || "10m")
	const startTime = Date.now()
	let lastSeen = Date.now()

	const boxFilter = options.box ? `/${encodeURIComponent(options.box)}` : ""
	const endpoint = options.box ? `/api/inbox${boxFilter}` : "/api/drops"

	log.info(`Polling ${options.box || "all boxes"} every ${interval / 1000}s${continuous ? " (continuous)" : ` for ${options.period || "10m"}`}...`)

	while (true) {
		const elapsed = Date.now() - startTime
		if (!continuous && elapsed >= periodMs) {
			log.info("Poll period ended")
			break
		}

		try {
			const data = await api(`${endpoint}?since=${lastSeen}&limit=50`, { admin: !options.box })
			const drops = data.drops || []

			if (drops.length > 0) {
				for (const drop of drops.reverse()) {
					if (drop.created_at > lastSeen) lastSeen = drop.created_at

					if (options.format === "json") {
						console.log(JSON.stringify(drop))
					} else {
						const time = new Date(drop.created_at).toISOString().slice(11, 19)
						const inbox = chalk.cyan(drop.inbox || options.box)
						const subject = drop.subject || "(no subject)"
						const from = drop.from_addr ? chalk.dim(` <${drop.from_addr}>`) : ""
						console.log(`  ${chalk.dim(time)} ${inbox} [${drop.channel}] ${subject}${from}`)
					}
				}
			}
		} catch (err: any) {
			log.error(`Poll error: ${err.message}`)
		}

		await new Promise(resolve => setTimeout(resolve, interval))
	}
}

async function cmdKeys(options: any) {
	const data = await api("/api/keys", { admin: true })
	const keys = data.keys || []

	if (options.format === "json") {
		formatOutput(data, options)
		return
	}

	if (keys.length === 0) {
		console.log(chalk.dim("No API keys"))
		return
	}

	console.log(chalk.bold(`\n  API Keys (${keys.length}):\n`))
	console.log(chalk.dim(`  ${padRight("ID", 38)} ${padRight("NAME", 20)} ${padRight("PERMS", 8)} ${padRight("SCOPE", 14)} ${padRight("CREATED", 12)} LAST USED`))

	for (const k of keys) {
		const created = relativeTime(k.created_at)
		const lastUsed = k.last_used_at ? relativeTime(k.last_used_at) : chalk.dim("never")
		const permsColor = k.permissions === "admin" ? chalk.red : k.permissions === "write" ? chalk.yellow : chalk.green

		console.log(
			`  ${padRight(chalk.dim(k.id), 38)} ` +
			`${padRight(k.name, 20)} ` +
			`${padRight(permsColor(k.permissions), 8)} ` +
			`${padRight(k.inbox_scope || chalk.dim("*"), 14)} ` +
			`${padRight(created, 12)} ` +
			`${lastUsed}`
		)
	}
	console.log("")
}

async function cmdKeyCreate(name: string, options: any) {
	const body: any = {
		name,
		permissions: options.permissions || "read",
	}
	if (options.inbox) body.inbox_scope = options.inbox

	const data = await api("/api/keys", { method: "POST", body, admin: true })

	if (options.format === "json") {
		formatOutput(data, options)
		return
	}

	console.log(chalk.bold(`\n  API key created\n`))
	console.log(`  Name:        ${chalk.cyan(data.name)}`)
	console.log(`  Key:         ${chalk.green(data.key)}`)
	console.log(`  Permissions: ${options.permissions || "read"}`)
	if (options.inbox) console.log(`  Scope:       ${options.inbox}`)
	console.log("")
	console.log(chalk.yellow("  Save this key now - it cannot be retrieved later."))
	console.log("")
}

// ============================================================================
// send-email
// ============================================================================

const UPLOAD_THRESHOLD = 1_000_000 // 1MB: above this, local files go via R2

const CONTENT_TYPES: Record<string, string> = {
	".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg",
	".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
	".avif": "image/avif", ".ico": "image/x-icon",
	".svg": "image/svg+xml", ".txt": "text/plain", ".html": "text/html",
	".htm": "text/html", ".csv": "text/csv", ".json": "application/json",
	".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript",
	".xml": "application/xml", ".wasm": "application/wasm", ".map": "application/json",
	".webmanifest": "application/manifest+json",
	".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
	".zip": "application/zip", ".md": "text/markdown", ".mp3": "audio/mpeg",
	".mp4": "video/mp4", ".webm": "video/webm", ".doc": "application/msword",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".xls": "application/vnd.ms-excel",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}

function fmtBytes(n: number): string {
	if (n < 1024) return `${n}B`
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`
	return `${(n / (1024 * 1024)).toFixed(1)}MB`
}

function guessContentType(filename: string): string {
	return CONTENT_TYPES[path.extname(filename).toLowerCase()] || "application/octet-stream"
}

function isUrl(s: string): boolean {
	return /^https?:\/\//i.test(s)
}

// A value that may be an inline string OR a path to a file to read
// Body value resolution: a leading "@" means "read from this file" (curl-style),
// "@-" means stdin. Anything else is a literal string. Explicit, no magic guessing.
function resolveBody(val: string): string {
	if (val === "@-") return fs.readFileSync(0, "utf8") // stdin
	if (val.startsWith("@")) {
		const file = path.resolve(val.slice(1))
		if (!fs.existsSync(file)) throw new Error(`body file not found: ${val.slice(1)}`)
		return fs.readFileSync(file, "utf8")
	}
	return val
}

// Parse "cid:source" / "source". A leading url scheme (http/https/file) is NOT a cid.
function parseAttachSpec(spec: string): { cid?: string; source: string } {
	const idx = spec.indexOf(":")
	if (idx > 0) {
		const left = spec.slice(0, idx)
		if (left === "http" || left === "https" || left === "file") return { source: spec }
		return { cid: left, source: spec.slice(idx + 1) }
	}
	return { source: spec }
}

// commander collector for repeatable options
function collectArg(val: string, prev: string[]): string[] {
	return [...prev, val]
}

function toArray(v: any): string[] {
	if (v == null) return []
	return (Array.isArray(v) ? v : [v]).map(String)
}

async function cmdSendEmail(opts: any) {
	// Load template (flags override its values)
	let tpl: any = {}
	if (opts.template) {
		tpl = yaml.parse(fs.readFileSync(path.resolve(opts.template), "utf8")) || {}
	}

	const drop = opts.drop || tpl.drop || tpl.from
	if (!drop) throw new Error("--drop (sending box) is required")

	const to = opts.to?.length ? opts.to : toArray(tpl.to)
	const cc = opts.cc?.length ? opts.cc : toArray(tpl.cc)
	const bcc = opts.bcc?.length ? opts.bcc : toArray(tpl.bcc)
	const replyTo = opts.replyTo ?? tpl.replyTo
	const fromName = opts.fromName ?? tpl.fromName
	const subject = opts.subject ?? tpl.subject
	const topic = opts.topic ?? tpl.topic
	const inReplyTo = opts.inReplyTo ?? tpl.inReplyTo

	const bodyVal = opts.body ?? tpl.body
	const htmlVal = opts.bodyHtml ?? tpl.bodyHtml
	const text = bodyVal != null ? resolveBody(String(bodyVal)) : undefined
	const html = htmlVal != null ? resolveBody(String(htmlVal)) : undefined

	if (to.length === 0 && cc.length === 0 && bcc.length === 0) {
		throw new Error("at least one --to / --cc / --bcc is required")
	}
	if (!subject) throw new Error("--subject is required")

	const specs: string[] = opts.attach?.length
		? opts.attach
		: toArray(tpl.attach ?? tpl.attachments)

	// Resolve each attachment: URL -> reference, small local -> base64, big/forced -> R2
	const attachments: any[] = []
	for (const raw of specs) {
		const { cid, source } = parseAttachSpec(String(raw))
		const inline = !!cid

		if (isUrl(source)) {
			attachments.push({ url: source, cid, inline })
			continue
		}

		const filePath = path.resolve(source)
		if (!fs.existsSync(filePath)) throw new Error(`attachment not found: ${source}`)
		const size = fs.statSync(filePath).size
		const filename = path.basename(filePath)
		const contentType = guessContentType(filename)

		if (opts.upload || size > UPLOAD_THRESHOLD) {
			const pre = await api(`/api/send/presign/${encodeURIComponent(drop)}`, {
				method: "POST",
				body: { fileName: filename, contentType },
			})
			const put = await fetch(pre.uploadUrl, {
				method: "PUT",
				headers: { "Content-Type": contentType },
				body: fs.readFileSync(filePath),
			})
			if (!put.ok) throw new Error(`R2 upload failed (${put.status}) for ${filename}`)
			attachments.push({ r2Key: pre.r2Key, filename, contentType, cid, inline })
		} else {
			attachments.push({
				dataBase64: fs.readFileSync(filePath).toString("base64"),
				filename, contentType, cid, inline,
			})
		}
	}

	const payload: any = { to, cc, bcc, subject }
	if (replyTo) payload.replyTo = replyTo
	if (fromName) payload.fromName = fromName
	if (topic) payload.topic = topic
	if (inReplyTo) payload.inReplyTo = inReplyTo
	if (text != null) payload.text = text
	if (html != null) payload.html = html
	if (attachments.length) payload.attachments = attachments
	if (opts.deleteAfterSend) payload.deleteAfterSend = true

	// --dry-run / --compose: hit /api/compose, which assembles the EXACT same MIME
	// as /api/send but returns the raw RFC822 .eml and never calls SES. Nothing is sent.
	if (opts.dryRun || opts.compose) {
		const res = await fetch(`${getBaseUrl()}/api/compose/${encodeURIComponent(drop)}`, {
			method: "POST",
			headers: { Authorization: `Bearer ${getApiKey()}`, "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		})
		if (!res.ok) {
			let msg = await res.text()
			try { msg = JSON.parse(msg).error || msg } catch {}
			throw new Error(`API ${res.status}: ${msg}`)
		}
		const eml = await res.text()
		if (opts.out) {
			fs.writeFileSync(path.resolve(opts.out), eml)
			console.error(chalk.yellow(`\n  Composed (NOT sent)`) + chalk.dim(` -> ${opts.out} (${eml.length} bytes)\n`))
		} else {
			process.stdout.write(eml)
		}
		return
	}

	const data = await api(`/api/send/${encodeURIComponent(drop)}`, { method: "POST", body: payload })

	if (opts.format === "json") {
		formatOutput(data, opts)
		return
	}

	console.log(chalk.bold(`\n  Email sent\n`))
	console.log(`  From:      ${chalk.cyan(`${drop}${topic ? `+${topic}` : ""}@example.com`)}`)
	console.log(`  To:        ${data.recipients.to.join(", ") || chalk.dim("(none)")}`)
	if (data.recipients.cc?.length) console.log(`  Cc:        ${data.recipients.cc.join(", ")}`)
	if (data.recipients.bcc?.length) console.log(`  Bcc:       ${data.recipients.bcc.join(", ")}`)
	console.log(`  Subject:   ${subject}`)
	if (attachments.length) console.log(`  Files:     ${attachments.length}`)
	console.log(`  MessageId: ${chalk.green(data.messageId)}`)
	console.log("")
}

// ============================================================================
// CLI Setup
// ============================================================================

const program = new Command()
	.name("agent-drop")
	.description("Agent Drop - manage drop inboxes, targets, and API keys")
	.version("1.0.0")

addCommonOptions(program)

program
	.addHelpText("after", `
DESCRIPTION
  CLI for the agent-drop system at example.com. Manage inboxes that receive
  emails, web form submissions, and API drops. List drops, create temporary
  drop targets, manage API keys, and poll for new messages. Also compose and
  send real outbound email on behalf of a box (send-email, with --dry-run /
  --compose to assemble the raw .eml without sending), and host static sites.

AUTHENTICATION
  Two keys are used (both auto-loaded from context/projects/agent-drop/.env):
    - Admin key (ADMIN_API_KEY): for drops, boxes, keys, targets
    - API key (API_KEY): for inbox reads and sends

  Override via env vars:
    - AGENT_DROP_ADMIN_KEY overrides ADMIN_API_KEY
    - AGENT_DROP_API_KEY overrides API_KEY

ENVIRONMENT
  AGENT_DROP_URL        Override API base URL (default: https://example.com)
  AGENT_DROP_ADMIN_KEY  Override admin API key
  AGENT_DROP_API_KEY    Override API key (for inbox/send routes)

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

  # JSON output for piping
  bun tools/agent-drop.ts drops --format json | jq '.drops[].subject'
`)

// drops - list all drops
program
	.command("drops")
	.description("List all drops across all boxes, chronologically")
	.option("-l, --limit <n>", "Max results", "20")
	.option("-b, --box <name>", "Filter by box/inbox name")
	.option("-c, --channel <channel>", "Filter by channel (email, web, api)")
	.option("-s, --since <duration>", "Only drops since duration (e.g. 1h, 24h, 7d)")
	.action(async (opts) => {
		const merged = { ...program.opts(), ...opts }
		try {
			await cmdDrops(merged)
		} catch (err: any) {
			console.error(chalk.red(err.message))
			process.exit(3)
		}
	})

// boxes - list all inboxes with stats
program
	.command("boxes")
	.description("List all boxes with stats")
	.action(async (opts) => {
		const merged = { ...program.opts(), ...opts }
		try {
			await cmdBoxes(merged)
		} catch (err: any) {
			console.error(chalk.red(err.message))
			process.exit(3)
		}
	})

// inbox - list drops in a specific box
program
	.command("inbox <name>")
	.description("List drops in a specific inbox")
	.option("-l, --limit <n>", "Max results", "20")
	.option("-u, --unread", "Only unread drops")
	.option("-t, --topic <topic>", "Filter by topic")
	.action(async (name, opts) => {
		const merged = { ...program.opts(), ...opts }
		try {
			await cmdInbox(name, merged)
		} catch (err: any) {
			console.error(chalk.red(err.message))
			process.exit(3)
		}
	})

// target - create a temporary drop target
program
	.command("target <name>")
	.description("Create a temporary drop target URL")
	.option("--ttl <hours>", "Time to live in hours", "2")
	.action(async (name, opts) => {
		const merged = { ...program.opts(), ...opts }
		try {
			await cmdTarget(name, merged)
		} catch (err: any) {
			console.error(chalk.red(err.message))
			process.exit(3)
		}
	})

// targets - list active drop targets
program
	.command("targets")
	.description("List active drop targets")
	.action(async (opts) => {
		const merged = { ...program.opts(), ...opts }
		try {
			await cmdTargets(merged)
		} catch (err: any) {
			console.error(chalk.red(err.message))
			process.exit(3)
		}
	})

// poll - watch for new drops
program
	.command("poll")
	.description("Watch for new drops in real-time")
	.option("-b, --box <name>", "Filter by box")
	.option("-p, --period <duration>", "How long to poll (e.g. 10m, 1h)", "10m")
	.option("-i, --interval <seconds>", "Poll interval in seconds", "5")
	.option("--continuous", "Run until killed (ignore --period)")
	.action(async (opts) => {
		const merged = { ...program.opts(), ...opts }
		try {
			await cmdPoll(merged)
		} catch (err: any) {
			console.error(chalk.red(err.message))
			process.exit(3)
		}
	})

// keys - list API keys
program
	.command("keys")
	.description("List API keys")
	.action(async (opts) => {
		const merged = { ...program.opts(), ...opts }
		try {
			await cmdKeys(merged)
		} catch (err: any) {
			console.error(chalk.red(err.message))
			process.exit(3)
		}
	})

// key-create - create an API key
program
	.command("key-create <name>")
	.description("Create a new API key")
	.option("-p, --permissions <level>", "Permission level: read, write, admin", "read")
	.option("-i, --inbox <name>", "Scope key to specific inbox")
	.action(async (name, opts) => {
		const merged = { ...program.opts(), ...opts }
		try {
			await cmdKeyCreate(name, merged)
		} catch (err: any) {
			console.error(chalk.red(err.message))
			process.exit(3)
		}
	})

// users - list allowed users
program
	.command("users")
	.description("List allowed Google sign-in users")
	.action(async () => {
		const merged = program.opts()
		try {
			const data = await api("/api/users", { admin: true })
			if (merged.format === "json") {
				console.log(JSON.stringify(data, null, 2))
				return
			}
			const users = data.users || []
			if (users.length === 0) {
				console.log(chalk.dim("\n  No allowed users\n"))
				return
			}
			console.log(`\n${chalk.bold(`  Allowed Users (${users.length}):`)}`)
			console.log()
			console.log(chalk.dim("  EMAIL                              NAME             ADDED"))
			for (const u of users) {
				console.log(
					`  ${chalk.cyan(u.email.padEnd(36))} ${(u.name || "").padEnd(16)} ${relativeTime(u.created_at)}`
				)
			}
			console.log()
		} catch (err: any) {
			console.error(chalk.red(err.message))
			process.exit(3)
		}
	})

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
			})
			console.log(chalk.green(`\n  Added: ${data.added}\n`))
		} catch (err: any) {
			console.error(chalk.red(err.message))
			process.exit(3)
		}
	})

// user-remove - remove allowed user
program
	.command("user-remove <email>")
	.description("Remove a user from the allowlist")
	.action(async (email) => {
		try {
			const data = await api(`/api/users/${encodeURIComponent(email)}`, {
				method: "DELETE",
				admin: true,
			})
			console.log(chalk.yellow(`\n  Removed: ${data.deleted}\n`))
		} catch (err: any) {
			console.error(chalk.red(err.message))
			process.exit(3)
		}
	})

// invite - add user, create target, send invitation email
program
	.command("invite <email>")
	.description("Invite someone to drop files via email + web link")
	.requiredOption("-t, --target <inbox>", "Drop inbox name")
	.option("--ttl <hours>", "Link TTL in hours", "48")
	.option("-n, --name <name>", "Display name for the user")
	.action(async (email, opts) => {
		const merged = { ...program.opts(), ...opts }
		const log = createLogger(merged.quiet)
		try {
			// 1. Add user to allowlist
			let userStatus: string
			try {
				const userData = await api("/api/users", {
					method: "POST",
					body: { email, name: opts.name },
					admin: true,
				})
				userStatus = userData.added ? "added" : "already exists"
			} catch (err: any) {
				if (err.message.includes("409") || err.message.includes("already")) {
					userStatus = "already exists"
				} else {
					throw err
				}
			}

			// 2. Create temporary drop target
			const ttl = parseInt(opts.ttl)
			const targetData = await api("/api/targets", {
				method: "POST",
				body: { inbox: opts.target, ttl_hours: ttl },
				admin: true,
			})

			const dropUrl = targetData.url

			// 3. Send invitation email
			const greeting = opts.name ? `Hi ${opts.name}` : "Hi"
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
			].join("\n")

			await api(`/api/send/${encodeURIComponent(opts.target)}`, {
				method: "POST",
				body: {
					to: email,
					subject: "You've been invited to drop files",
					text: emailBody,
				},
			})

			if (merged.format === "json") {
				formatOutput({
					user: { email, name: opts.name, status: userStatus },
					target: { inbox: opts.target, url: dropUrl, expires_at: targetData.expires_at, expires_in: targetData.expires_in },
					email: { sent: true, to: email },
				}, merged)
				return
			}

			console.log(chalk.bold(`\n  Invitation sent\n`))
			console.log(`  User:      ${chalk.cyan(email)} (${userStatus})`)
			console.log(`  Inbox:     ${chalk.cyan(opts.target)}`)
			console.log(`  URL:       ${chalk.green(dropUrl)}`)
			console.log(`  Expires:   ${isoDate(targetData.expires_at)} (${targetData.expires_in})`)
			console.log(`  Email:     ${chalk.green("sent")} to ${email}`)
			console.log("")
		} catch (err: any) {
			console.error(chalk.red(err.message))
			process.exit(3)
		}
	})

// get - get a specific drop with full details + metadata
program
	.command("get <dropId>")
	.description("Get full details of a drop (body, metadata, files). Use --format json for complete body text.")
	.action(async (dropId, opts) => {
		const merged = { ...program.opts(), ...opts }
		try {
			// Find which inbox this drop belongs to via admin list
			const data = await api(`/api/drops?limit=200`, { admin: true })
			const summary = data.drops?.find((d: any) => d.id === dropId)
			if (!summary) {
				console.error(chalk.red(`Drop ${dropId} not found`))
				process.exit(1)
			}

			// Fetch full drop (with body) from the inbox endpoint
			const drop = await api(`/api/inbox/${summary.inbox}/${dropId}`)

			if (merged.format === "json") {
				if (drop.metadata && typeof drop.metadata === "string") {
					drop.metadata = JSON.parse(drop.metadata)
				}
				console.log(JSON.stringify(drop, null, 2))
				return
			}

			const meta = drop.metadata ? (typeof drop.metadata === "string" ? JSON.parse(drop.metadata) : drop.metadata) : {}

			console.log(chalk.bold(`\n  Drop: ${chalk.cyan(drop.id)}\n`))
			console.log(`  Inbox:       ${chalk.cyan(drop.inbox)}`)
			console.log(`  Channel:     ${drop.channel}`)
			console.log(`  Status:      ${drop.status === "completed" ? chalk.green(drop.status) : chalk.yellow(drop.status)}`)
			console.log(`  Subject:     ${drop.subject || chalk.dim("(none)")}`)
			if (drop.topic) console.log(`  Topic:       ${chalk.cyan(drop.topic)}`)
			if (drop.from_addr) console.log(`  From:        ${chalk.yellow(drop.from_addr)}`)
			console.log(`  Created:     ${relativeTime(drop.created_at)} (${new Date(drop.created_at).toISOString()})`)
			console.log(`  Read:        ${drop.read_at ? relativeTime(drop.read_at) : chalk.dim("unread")}`)
			console.log(`  Attachments: ${drop.attachment_count}`)
			if (drop.body_text) {
				const bodyLen = drop.body_text.length
				const truncated = bodyLen > 200
				console.log(chalk.bold(`\n  Body:`) + chalk.dim(` (${bodyLen} chars)`))
				console.log(`  ${drop.body_text.slice(0, 200).replace(/\n/g, "\n  ")}`)
				if (truncated) {
					console.log(chalk.dim(`  ... (${bodyLen - 200} more chars)`))
					console.log(chalk.dim(`  Tip: use --format json for full body, or: body ${drop.inbox} ${drop.id}`))
				}
			} else {
				console.log(chalk.dim(`\n  Body: (none)`))
			}

			if (Object.keys(meta).length > 0) {
				console.log(chalk.bold(`\n  Metadata:`))
				if (meta.auth_method) console.log(`    Auth:      ${meta.auth_method}`)
				if (meta.auth_key_name) console.log(`    Key:       ${chalk.cyan(meta.auth_key_name)}`)
				if (meta.remote_ip) console.log(`    IP:        ${meta.remote_ip}`)
				if (meta.country) console.log(`    Country:   ${meta.country}${meta.city ? ` (${meta.city})` : ""}`)
				if (meta.user_agent) console.log(`    UA:        ${chalk.dim(meta.user_agent.slice(0, 80))}`)
			}

			// List files
			try {
				const files = await api(`/api/inbox/${drop.inbox}/${drop.id}/attachments`)
				if (files.files?.length > 0) {
					console.log(chalk.bold(`\n  Files:`))
					for (const f of files.files) {
						const size = f.size < 1024 ? `${f.size}B`
							: f.size < 1024 * 1024 ? `${(f.size / 1024).toFixed(0)}KB`
							: `${(f.size / (1024 * 1024)).toFixed(1)}MB`
						console.log(`    ${chalk.cyan(f.filename)}  ${chalk.dim(size)}`)
					}
				}
			} catch {}

			console.log("")
		} catch (err: any) {
			console.error(chalk.red(err.message))
			process.exit(3)
		}
	})

// body - print the full body text of a drop (no truncation)
program
	.command("body <inbox> [dropId]")
	.description("Print full body text of a drop (default: latest). Use for piping/processing.")
	.option("--html", "Output HTML body instead of plain text")
	.action(async (inbox, dropId, opts) => {
		try {
			let drop: any
			if (dropId) {
				drop = await api(`/api/inbox/${inbox}/${dropId}`)
			} else {
				drop = await api(`/api/inbox/${inbox}/latest`)
			}

			const content = opts.html ? drop.body_html : drop.body_text
			if (!content) {
				console.error(chalk.dim("(no body content)"))
				process.exit(0)
			}
			process.stdout.write(content + "\n")
		} catch (err: any) {
			console.error(chalk.red(err.message))
			process.exit(3)
		}
	})

// files - list files/attachments in a drop
program
	.command("files <inbox> [dropId]")
	.description("List files in a drop (default: latest drop in inbox)")
	.action(async (inbox, dropId, opts) => {
		const merged = { ...program.opts(), ...opts }
		try {
			// If no dropId, get the latest
			if (!dropId) {
				const latest = await api(`/api/inbox/${inbox}/latest`)
				dropId = latest.id
				if (!dropId) {
					console.error(chalk.red("No drops in this inbox"))
					process.exit(1)
				}
			}

			const data = await api(`/api/inbox/${inbox}/${dropId}/attachments`)
			const files = data.files || []

			if (merged.format === "json") {
				console.log(JSON.stringify({ dropId, files }, null, 2))
				return
			}

			if (files.length === 0) {
				console.log(chalk.dim(`\n  No files in drop ${dropId}\n`))
				return
			}

			console.log(chalk.bold(`\n  Files in ${chalk.cyan(dropId)}:\n`))
			for (const f of files) {
				const size = f.size < 1024 ? `${f.size}B`
					: f.size < 1024 * 1024 ? `${(f.size / 1024).toFixed(0)}KB`
					: `${(f.size / (1024 * 1024)).toFixed(1)}MB`
				console.log(`  ${chalk.cyan(f.filename.padEnd(40))} ${chalk.dim(size.padStart(8))}  ${chalk.dim(f.uploaded)}`)
			}
			console.log("")
		} catch (err: any) {
			console.error(chalk.red(err.message))
			process.exit(3)
		}
	})

// download - download a file from a drop
program
	.command("download <inbox> <dropId> <filename>")
	.description("Download a file from a drop to current directory")
	.option("-o, --output <path>", "Output path (default: ./<filename>)")
	.action(async (inbox, dropId, filename, opts) => {
		try {
			const res = await apiRaw(`/api/inbox/${inbox}/${dropId}/file/${encodeURIComponent(filename)}`)
			const outPath = opts.output || `./${filename}`
			const buffer = await res.arrayBuffer()
			await Bun.write(outPath, buffer)
			const size = buffer.byteLength < 1024 ? `${buffer.byteLength}B`
				: buffer.byteLength < 1024 * 1024 ? `${(buffer.byteLength / 1024).toFixed(0)}KB`
				: `${(buffer.byteLength / (1024 * 1024)).toFixed(1)}MB`
			console.log(chalk.green(`\n  Downloaded: ${outPath} (${size})\n`))
		} catch (err: any) {
			console.error(chalk.red(err.message))
			process.exit(3)
		}
	})

// raw - download the raw .eml file for an email drop
program
	.command("raw <inbox> <dropId>")
	.description("Download the original .eml file (email drops only, contains full unstripped content)")
	.option("-o, --output <path>", "Output path (default: ./<dropId>.eml)")
	.action(async (inbox, dropId, opts) => {
		try {
			const drop = await api(`/api/inbox/${inbox}/${dropId}`)
			if (!drop.raw_r2_key) {
				console.error(chalk.red("No raw .eml for this drop (not an email)"))
				process.exit(1)
			}

			const res = await apiRaw(`/api/inbox/${inbox}/${dropId}/file/raw.eml`)
			const outPath = opts.output || `./${dropId}.eml`
			const buffer = await res.arrayBuffer()
			await Bun.write(outPath, buffer)
			const size = buffer.byteLength < 1024 ? `${buffer.byteLength}B`
				: buffer.byteLength < 1024 * 1024 ? `${(buffer.byteLength / 1024).toFixed(0)}KB`
				: `${(buffer.byteLength / (1024 * 1024)).toFixed(1)}MB`
			console.log(chalk.green(`\n  Downloaded: ${outPath} (${size})\n`))
		} catch (err: any) {
			console.error(chalk.red(err.message))
			process.exit(3)
		}
	})

// url - generate a presigned download URL for a file
program
	.command("url <inbox> <dropId> <filename>")
	.description("Generate a presigned download URL (default 1h, shareable)")
	.option("--ttl <seconds>", "URL validity in seconds", "3600")
	.action(async (inbox, dropId, filename, opts) => {
		const merged = { ...program.opts(), ...opts }
		try {
			const data = await api(`/api/inbox/${inbox}/${dropId}/url/${encodeURIComponent(filename)}?ttl=${opts.ttl}`)

			if (merged.format === "json") {
				console.log(JSON.stringify(data, null, 2))
				return
			}

			console.log(chalk.bold(`\n  Presigned Download URL\n`))
			console.log(`  File:      ${chalk.cyan(data.filename)} (${data.size < 1024 * 1024 ? `${(data.size / 1024).toFixed(0)}KB` : `${(data.size / (1024 * 1024)).toFixed(1)}MB`})`)
			console.log(`  Expires:   ${data.expires_in}`)
			console.log(`  URL:       ${chalk.green(data.url)}`)
			console.log("")
		} catch (err: any) {
			console.error(chalk.red(err.message))
			process.exit(3)
		}
	})

// rules - list drop rules
program
	.command("rules")
	.description("List all drop rules (forwards + webhooks)")
	.action(async (opts) => {
		const merged = program.opts()
		try {
			const data = await api("/api/rules", { admin: true })
			if (merged.format === "json") {
				console.log(JSON.stringify(data, null, 2))
				return
			}
			const rules = data.rules || []
			if (rules.length === 0) {
				console.log(chalk.dim("\n  No rules configured\n"))
				return
			}
			console.log(chalk.bold(`\n  Rules (${rules.length}):\n`))
			console.log(chalk.dim("  PATTERN          TYPE       SCOPES    TARGET"))
			for (const r of rules) {
				const pattern = chalk.cyan(r.pattern.padEnd(16))
				const type = (r.type === "forward" ? chalk.yellow(r.type) : chalk.magenta(r.type)).padEnd(18)
				const scopes = chalk.dim(r.scopes.padEnd(9))
				const target = r.target
				const enabled = r.enabled ? "" : chalk.red(" [disabled]")
				console.log(`  ${pattern} ${type} ${scopes} ${target}${enabled}`)
			}
			console.log("")
		} catch (err: any) {
			console.error(chalk.red(err.message))
			process.exit(3)
		}
	})

// rule-add - create a rule
program
	.command("rule-add <pattern>")
	.description("Add a drop rule. Pattern: 'lisa', '*', 'shop-*'")
	.option("--forward <email>", "Forward to this address (repeatable, or comma-separated; supports {inbox}, {name}, {topic})", collectArg, [])
	.option("--webhook <url>", "POST webhook to this URL on drops")
	.option("--scope <scopes>", "Comma-separated: email,web,api,all", "all")
	.option("--header <kv...>", "Webhook headers as Key:Value pairs")
	.option("--priority <n>", "Priority (higher fires first)", "0")
	.action(async (pattern, opts) => {
		try {
			const forwards: string[] = (opts.forward || []).flatMap((f: string) => f.split(",")).map((s: string) => s.trim()).filter(Boolean)
			if (forwards.length === 0 && !opts.webhook) {
				console.error(chalk.red("Specify --forward <email> (repeatable) or --webhook <url>"))
				process.exit(1)
			}

			const type = forwards.length > 0 ? "forward" : "webhook"
			const target = forwards.length > 0 ? forwards.join(",") : opts.webhook

			let headers: Record<string, string> | undefined
			if (opts.header) {
				headers = {}
				for (const h of opts.header) {
					const [k, ...v] = h.split(":")
					headers[k.trim()] = v.join(":").trim()
				}
			}

			const data = await api("/api/rules", {
				method: "POST",
				body: {
					pattern,
					type,
					scopes: opts.scope,
					target,
					headers,
					priority: parseInt(opts.priority),
				},
				admin: true,
			})

			console.log(chalk.green(`\n  Rule created: ${chalk.cyan(pattern)} -> ${type} -> ${target}\n`))
		} catch (err: any) {
			console.error(chalk.red(err.message))
			process.exit(3)
		}
	})

// rule-enable / rule-disable
program
	.command("rule-enable <id>")
	.description("Enable a drop rule")
	.action(async (id) => {
		try {
			await api(`/api/rules/${id}`, { method: "PATCH", body: { enabled: true }, admin: true })
			console.log(chalk.green(`\n  Rule ${id} enabled\n`))
		} catch (err: any) {
			console.error(chalk.red(err.message))
			process.exit(3)
		}
	})

program
	.command("rule-disable <id>")
	.description("Disable a drop rule (keeps it, stops firing)")
	.action(async (id) => {
		try {
			await api(`/api/rules/${id}`, { method: "PATCH", body: { enabled: false }, admin: true })
			console.log(chalk.yellow(`\n  Rule ${id} disabled\n`))
		} catch (err: any) {
			console.error(chalk.red(err.message))
			process.exit(3)
		}
	})

// rule-update
program
	.command("rule-update <id>")
	.description("Update a drop rule")
	.option("--target <target>", "New target (email or URL)")
	.option("--scope <scopes>", "New scopes (comma-separated)")
	.option("--priority <n>", "New priority")
	.option("--header <kv...>", "New webhook headers as Key:Value pairs")
	.action(async (id, opts) => {
		try {
			const body: Record<string, unknown> = {}
			if (opts.target) body.target = opts.target
			if (opts.scope) body.scopes = opts.scope
			if (opts.priority) body.priority = parseInt(opts.priority)
			if (opts.header) {
				const headers: Record<string, string> = {}
				for (const h of opts.header) {
					const [k, ...v] = h.split(":")
					headers[k.trim()] = v.join(":").trim()
				}
				body.headers = headers
			}
			if (Object.keys(body).length === 0) {
				console.error(chalk.red("Nothing to update. Use --target, --scope, --priority, or --header"))
				process.exit(1)
			}
			await api(`/api/rules/${id}`, { method: "PATCH", body, admin: true })
			console.log(chalk.green(`\n  Rule ${id} updated\n`))
		} catch (err: any) {
			console.error(chalk.red(err.message))
			process.exit(3)
		}
	})

// rule-remove - delete a rule
program
	.command("rule-remove <id>")
	.description("Remove a drop rule by ID")
	.action(async (id) => {
		try {
			await api(`/api/rules/${id}`, { method: "DELETE", admin: true })
			console.log(chalk.yellow(`\n  Rule removed: ${id}\n`))
		} catch (err: any) {
			console.error(chalk.red(err.message))
			process.exit(3)
		}
	})

// rule-test - dry-run: show what rules would fire
program
	.command("rule-test <inbox>")
	.description("Test which rules would fire for an inbox (dry run)")
	.option("--channel <ch>", "Channel to simulate: email, web, api", "email")
	.action(async (inbox, opts) => {
		try {
			const data = await api("/api/rules", { admin: true })
			const rules = data.rules || []

			// Simulate pattern matching locally (same logic as server)
			function matchPattern(pattern: string, name: string): { match: boolean; captures: Record<string, string> } {
				if (pattern === "*") return { match: true, captures: { name } }
				if (pattern === name) return { match: true, captures: {} }
				if (pattern.endsWith("-*")) {
					const prefix = pattern.slice(0, -2)
					if (name.startsWith(prefix + "-")) return { match: true, captures: { name: name.slice(prefix.length + 1) } }
				}
				if (pattern.startsWith("*-")) {
					const suffix = pattern.slice(2)
					if (name.endsWith("-" + suffix)) return { match: true, captures: { name: name.slice(0, -(suffix.length + 1)) } }
				}
				const starIdx = pattern.indexOf("*")
				if (starIdx > 0 && starIdx < pattern.length - 1) {
					const prefix = pattern.slice(0, starIdx)
					const suffix = pattern.slice(starIdx + 1)
					if (name.startsWith(prefix) && name.endsWith(suffix)) {
						const captured = name.slice(prefix.length, name.length - suffix.length)
						if (captured.length > 0) return { match: true, captures: { name: captured } }
					}
				}
				return { match: false, captures: {} }
			}

			function substitute(tpl: string, vars: Record<string, string>): string {
				return tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] || "")
			}

			// Strip dots for normalization (same as server)
			const normalized = inbox.toLowerCase().replace(/\./g, "").replace(/_/g, "-").replace(/[^a-z0-9-]/g, "")

			console.log(chalk.bold(`\n  Rule test: ${chalk.cyan(normalized)} (channel: ${opts.channel})\n`))

			const vars: Record<string, string> = {
				inbox: normalized,
				topic: "",
				from: "test@example.com",
				subject: "(test)",
				drop_id: "test-dry-run",
				channel: opts.channel,
			}

			let matchCount = 0
			for (const rule of rules) {
				const { match, captures } = matchPattern(rule.pattern, normalized)
				if (!match) continue

				const scopes = rule.scopes.split(",").map((s: string) => s.trim())
				if (!scopes.includes(opts.channel) && !scopes.includes("all")) {
					console.log(chalk.dim(`  ~ ${rule.pattern} -> pattern matches but scope "${rule.scopes}" excludes "${opts.channel}"`))
					continue
				}

				if (!rule.enabled) {
					console.log(chalk.dim(`  ~ ${rule.pattern} -> matches but DISABLED`))
					continue
				}

				matchCount++
				const allVars = { ...vars, ...captures }
				const resolved = substitute(rule.target, allVars)

				const typeColor = rule.type === "forward" ? chalk.yellow : chalk.magenta
				console.log(`  ${chalk.green(">")} ${chalk.cyan(rule.pattern)} -> ${typeColor(rule.type)} -> ${resolved}`)

				if (Object.keys(captures).length > 0) {
					console.log(chalk.dim(`    captures: ${Object.entries(captures).map(([k, v]) => `{${k}}=${v}`).join(", ")}`))
				}
			}

			if (matchCount === 0) {
				console.log(chalk.dim("  No rules would fire"))
			} else {
				console.log(chalk.dim(`\n  ${matchCount} rule(s) would fire`))
			}
			console.log("")
		} catch (err: any) {
			console.error(chalk.red(err.message))
			process.exit(3)
		}
	})

// deliveries - view delivery log
program
	.command("deliveries")
	.description("View forward/webhook delivery log")
	.option("--drop <id>", "Filter by drop ID")
	.option("--status <status>", "Filter: pending, success, failed, retrying")
	.option("-l, --limit <n>", "Max results", "20")
	.action(async (opts) => {
		const merged = { ...program.opts(), ...opts }
		try {
			let path = `/api/deliveries?limit=${opts.limit}`
			if (opts.drop) path += `&drop_id=${opts.drop}`
			if (opts.status) path += `&status=${opts.status}`

			const data = await api(path, { admin: true })
			if (merged.format === "json") {
				console.log(JSON.stringify(data, null, 2))
				return
			}

			const deliveries = data.deliveries || []
			if (deliveries.length === 0) {
				console.log(chalk.dim("\n  No deliveries\n"))
				return
			}

			console.log(chalk.bold(`\n  Deliveries (${deliveries.length}):\n`))
			console.log(chalk.dim("  WHEN          TYPE       STATUS     TARGET"))
			for (const d of deliveries) {
				const when = relativeTime(d.created_at).padEnd(13)
				const type = d.type.padEnd(10)
				const statusColor = d.status === "success" ? chalk.green
					: d.status === "failed" ? chalk.red
					: d.status === "retrying" ? chalk.yellow
					: chalk.dim
				const status = statusColor(d.status.padEnd(10))
				const target = d.target.length > 50 ? d.target.slice(0, 50) + "..." : d.target
				console.log(`  ${when} ${type} ${status} ${target}`)
				if (d.error) console.log(chalk.dim(`                                      ${d.error.slice(0, 60)}`))
			}
			console.log("")
		} catch (err: any) {
			console.error(chalk.red(err.message))
			process.exit(3)
		}
	})

// masks - list email masks
program
	.command("masks")
	.description("List email relay masks")
	.option("--all", "Include disabled masks")
	.action(async (opts) => {
		const merged = program.opts()
		try {
			const q = opts.all ? "?all=true" : ""
			const data = await api(`/api/masks${q}`, { admin: true })
			if (merged.format === "json") {
				console.log(JSON.stringify(data, null, 2))
				return
			}
			const masks = data.masks || []
			if (masks.length === 0) {
				console.log(chalk.dim("\n  No masks\n"))
				return
			}
			console.log(chalk.bold(`\n  Masks (${masks.length}):\n`))
			console.log(chalk.dim("  ID                EMAIL                              LABEL            STATUS"))
			for (const m of masks) {
				const status = m.active ? chalk.green("active") : chalk.red("disabled")
				console.log(`  ${chalk.cyan(m.id.padEnd(18))} ${m.email.padEnd(34)} ${(m.label || "").padEnd(16)} ${status}`)
			}
			console.log("")
		} catch (err: any) {
			console.error(chalk.red(err.message))
			process.exit(3)
		}
	})

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
				console.error(chalk.red("Specify --prefix or --id"))
				process.exit(1)
			}
			const body: Record<string, string> = {}
			if (opts.id) body.id = opts.id
			if (opts.prefix) body.prefix = opts.prefix
			if (opts.label) body.label = opts.label

			const data = await api("/api/masks", { method: "POST", body, admin: true })
			console.log(chalk.bold(`\n  Mask created\n`))
			console.log(`  ID:    ${chalk.cyan(data.id)}`)
			console.log(`  Email: ${chalk.green(data.email)}`)
			if (data.label) console.log(`  Label: ${data.label}`)
			console.log("")
		} catch (err: any) {
			console.error(chalk.red(err.message))
			process.exit(3)
		}
	})

// mask-disable / mask-enable
program
	.command("mask-disable <id>")
	.description("Disable a mask (emails will bounce)")
	.action(async (id) => {
		try {
			await api(`/api/masks/${id}`, { method: "PATCH", body: { active: false }, admin: true })
			console.log(chalk.yellow(`\n  Mask ${id} disabled\n`))
		} catch (err: any) {
			console.error(chalk.red(err.message))
			process.exit(3)
		}
	})

program
	.command("mask-enable <id>")
	.description("Re-enable a disabled mask")
	.action(async (id) => {
		try {
			await api(`/api/masks/${id}`, { method: "PATCH", body: { active: true }, admin: true })
			console.log(chalk.green(`\n  Mask ${id} enabled\n`))
		} catch (err: any) {
			console.error(chalk.red(err.message))
			process.exit(3)
		}
	})

// mask-remove
program
	.command("mask-remove <id>")
	.description("Permanently delete a mask")
	.action(async (id) => {
		try {
			await api(`/api/masks/${id}`, { method: "DELETE", admin: true })
			console.log(chalk.yellow(`\n  Mask ${id} removed\n`))
		} catch (err: any) {
			console.error(chalk.red(err.message))
			process.exit(3)
		}
	})

// send-email - send an email on behalf of a drop box
program
	.command("send-email")
	.description("Send an email on behalf of a drop box (From: {drop}@example.com)")
	.option("-d, --drop <box>", "Sending box (From: {box}@example.com)")
	.option("--to <addr>", `Recipient, repeatable. Accepts '"Name" <a@b.com>'`, collectArg, [])
	.option("--cc <addr>", "Cc recipient (repeatable)", collectArg, [])
	.option("--bcc <addr>", "Bcc recipient (repeatable)", collectArg, [])
	.option("--reply-to <addr>", "Reply-To header")
	.option("--from-name <name>", "Display name for the From address")
	.option("-s, --subject <text>", "Subject line")
	.option("--body <text|@file>", "Plain-text body: literal text, or @path to read a file (@- for stdin)")
	.option("--body-html <html|@file>", "HTML body: literal text, or @path to read a file (@- for stdin)")
	.option("--attach <spec>", "Attachment: path, URL, or cid:path for inline images (repeatable)", collectArg, [])
	.option("--topic <topic>", "Send from {box}+{topic}@example.com")
	.option("--in-reply-to <dropId|msgId>", "Thread as a reply to a received drop")
	.option("--template <file.yml>", "Load fields from a YAML template (flags override)")
	.option("--upload", "Force all local attachments through R2 (default: auto above 1MB)")
	.option("--delete-after-send", "Delete R2-uploaded attachments immediately after sending (default: kept, 30d TTL)")
	.option("--dry-run", "Compose the raw .eml (via /api/compose) and print it, without sending")
	.option("--compose", "Alias for --dry-run: return the assembled .eml instead of sending")
	.option("--out <file>", "With --dry-run/--compose, write the .eml to a file instead of stdout")
	.action(async (opts) => {
		const merged = { ...program.opts(), ...opts }
		try {
			await cmdSendEmail(merged)
		} catch (err: any) {
			console.error(chalk.red(err.message))
			process.exit(3)
		}
	})

// ============================================================================
// host - publish static files to example.com/f/{box}/{site}/
// ============================================================================

function walkFiles(root: string): string[] {
	const stat = fs.statSync(root)
	if (stat.isFile()) return [root]
	const out: string[] = []
	for (const entry of fs.readdirSync(root)) {
		if (entry === ".DS_Store") continue
		out.push(...walkFiles(path.join(root, entry)))
	}
	return out
}

program
	.command("host <box> <site> [paths...]")
	.description("Publish static files publicly at https://example.com/f/<box>/<site>/")
	.option("--ttl <dur>", "Auto-expire after a duration (e.g. 24h, 7d)")
	.option("--base <dir>", "Compute relative paths from this dir (preserves structure)")
	.option("--auth <token>", "Make the site private: require ?auth=<token> to view")
	.action(async (box, site, paths, opts) => {
		try {
			if (!paths || paths.length === 0) {
				console.error(chalk.red("Provide at least one file or directory to host"))
				process.exit(1)
			}

			// Resolve every input into { abs, rel }. A directory contributes its
			// tree relative to itself; a file contributes its basename. --base
			// overrides the relative root for everything.
			const files: { abs: string; rel: string }[] = []
			for (const p of paths) {
				const abs = path.resolve(p)
				if (!fs.existsSync(abs)) throw new Error(`not found: ${p}`)
				const stat = fs.statSync(abs)
				const baseDir = opts.base
					? path.resolve(opts.base)
					: stat.isDirectory() ? abs : path.dirname(abs)
				for (const f of walkFiles(abs)) {
					const rel = path.relative(baseDir, f).split(path.sep).join("/")
					files.push({ abs: f, rel })
				}
			}
			if (files.length === 0) throw new Error("no files found to upload")

			console.log(chalk.bold(`\n  Hosting ${files.length} file(s) -> example.com/f/${box}/${site}/\n`))
			let totalBytes = 0
			for (const { abs, rel } of files) {
				const ct = guessContentType(rel)
				const data = fs.readFileSync(abs)
				const pre = await api(`/api/host/presign/${encodeURIComponent(box)}`, {
					method: "POST",
					body: { site, path: rel, contentType: ct },
				})
				const put = await fetch(pre.uploadUrl, {
					method: "PUT",
					headers: { "Content-Type": ct },
					body: data,
				})
				if (!put.ok) throw new Error(`R2 upload failed (${put.status}) for ${rel}`)
				totalBytes += data.byteLength
				console.log(`  ${chalk.green("↑")} ${pre.path} ${chalk.dim(`(${fmtBytes(data.byteLength)})`)}`)
			}

			const ttlHours = opts.ttl ? parseDuration(opts.ttl) / 3_600_000 : undefined
			const fin = await api(`/api/host/finalize/${encodeURIComponent(box)}`, {
				method: "POST",
				body: { site, ttlHours, authToken: opts.auth || null },
			})

			console.log(chalk.bold(`\n  Live: ${chalk.green(fin.url)}`))
			console.log(`  ${fin.fileCount} files, ${fmtBytes(fin.totalBytes)}${fin.private ? chalk.yellow("  [private]") : ""}`)
			if (fin.expiresAt) console.log(chalk.dim(`  Expires: ${isoDate(fin.expiresAt)}`))
			if (opts.auth) console.log(chalk.dim(`  View with: ${fin.url}?auth=${opts.auth}`))
			console.log("")
		} catch (err: any) {
			console.error(chalk.red(err.message))
			process.exit(3)
		}
	})

// sites - list hosted sites for a box
program
	.command("sites <box>")
	.description("List hosted sites for a box")
	.action(async (box) => {
		const merged = program.opts()
		try {
			const data = await api(`/api/host/sites/${encodeURIComponent(box)}`)
			if (merged.format === "json") {
				console.log(JSON.stringify(data, null, 2))
				return
			}
			const sites = data.sites || []
			if (sites.length === 0) {
				console.log(chalk.dim(`\n  No hosted sites for ${box}\n`))
				return
			}
			console.log(chalk.bold(`\n  Hosted sites for ${box} (${sites.length}):\n`))
			console.log(chalk.dim("  SITE                FILES   SIZE      EXPIRES        URL"))
			for (const s of sites) {
				const site = chalk.cyan(String(s.site).padEnd(18))
				const files = String(s.file_count).padStart(5)
				const size = fmtBytes(s.total_bytes).padEnd(8)
				const expires = (s.expires_at ? isoDate(s.expires_at).slice(0, 10) : "never").padEnd(13)
				const priv = s.private ? chalk.yellow(" [private]") : ""
				console.log(`  ${site} ${files}   ${size}  ${chalk.dim(expires)}  ${s.url}${priv}`)
			}
			console.log("")
		} catch (err: any) {
			console.error(chalk.red(err.message))
			process.exit(3)
		}
	})

// unhost - delete a hosted site
program
	.command("unhost <box> <site>")
	.description("Delete a hosted site (removes all its files from R2 - irreversible)")
	.action(async (box, site) => {
		try {
			const data = await api(`/api/host/sites/${encodeURIComponent(box)}/${encodeURIComponent(site)}`, {
				method: "DELETE",
			})
			console.log(chalk.green(`\n  Deleted site '${data.site}' (${data.deleted} file(s) removed)\n`))
		} catch (err: any) {
			console.error(chalk.red(err.message))
			process.exit(3)
		}
	})

program.parseAsync()
