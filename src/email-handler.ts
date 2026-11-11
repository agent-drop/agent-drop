import PostalMime from "postal-mime";
import { generateId } from "./lib/id";
import { firstSenderAuth } from "./lib/mail-auth";
import { normalizeInbox, slugifyFilename } from "./lib/normalize";
import {
	isRelayReply,
	parseLegacyRelayAddress,
	parseRelayToken,
	resolveRelayAddress,
	findRelayRule,
	createRelayAddress,
	enqueueRelay,
	forwardViaBinding,
	pickSenderAddress,
	relayReplyRefusal,
	viaDisplayName,
} from "./lib/relay";
import { fireRules } from "./lib/rules";
import type { Env, Drop } from "./types";

/**
 * Strip quoted reply text from plain text emails.
 * Removes everything from common quote markers to end of string.
 */
export function stripQuotedText(text: string): string {
	const patterns = [
		// Gmail: "On Mon, Jan 1, 2026 at 12:00 PM Name <email> wrote:"
		/\r?\nOn .+wrote:\s*$/s,
		// Outlook: "-----Original Message-----"
		/\r?\n-{3,}Original Message-{3,}.*/s,
		// Outlook divider: line of underscores
		/\r?\n_{10,}.*/s,
		// Outlook headers: "From: ...\nSent: ...\nTo: ..."
		/\r?\nFrom:\s+.+\r?\nSent:\s+.+\r?\nTo:\s+.*/s,
		// Standard signature delimiter: "-- \n"
		/\r?\n-- \r?\n.*/s,
		// Apple mobile signatures
		/\r?\nSent from my (iPhone|iPad|Mac)\s*$/s,
		// Generic quoting: empty line followed by lines starting with ">"
		/\r?\n\s*\r?\n(>[^\n]*\r?\n?)+\s*$/,
	];

	let result = text;
	for (const pattern of patterns) {
		result = result.replace(pattern, "");
	}
	return result.trimEnd();
}

/**
 * Strip quoted reply markup from HTML emails.
 * Removes gmail_quote divs, cite blockquotes, and Outlook appendonsend divs.
 */
export function stripQuotedHtml(html: string): string {
	const patterns = [
		// Gmail: <div class="gmail_quote"> ... </div> (greedy to end)
		/<div\s+class="gmail_quote"[^>]*>[\s\S]*$/i,
		// Outlook: <div id="appendonsend"> ... </div>
		/<div\s+id="appendonsend"[^>]*>[\s\S]*$/i,
		// Blockquote with type="cite"
		/<blockquote\s+[^>]*type=["']cite["'][^>]*>[\s\S]*?<\/blockquote>/gi,
		// Outlook divider: <hr> or line of underscores in HTML
		/<hr\s*\/?>\s*<div\s+id="divRplyFwdMsg"[^>]*>[\s\S]*$/i,
	];

	let result = html;
	for (const pattern of patterns) {
		result = result.replace(pattern, "");
	}
	return result.trimEnd();
}

// One reason for every refused reply route, whether the token is unknown or its
// sender is not the owner, so a leaked route's holder learns nothing from it.
const RELAY_REPLY_REJECTION = "Invalid relay reply address";

export async function handleEmail(
	message: ForwardableEmailMessage,
	env: Env,
	ctx: ExecutionContext,
): Promise<void> {
	const to = message.to;
	const from = message.from;
	const localPart = to.split("@")[0];

	// Check if this is a relay reply (someone replying through a mask)
	if (isRelayReply(localPart)) {
		const relay = await resolveRelayAddress(env, localPart);
		if (!relay) {
			const legacy = parseLegacyRelayAddress(localPart);
			const activeLegacyMask = legacy
				? await env.DB.prepare("SELECT id FROM email_masks WHERE id = ? AND active = 1")
						.bind(legacy.maskId)
						.first()
				: null;
			if (parseRelayToken(localPart) || activeLegacyMask) {
				// A guessed token or an unsigned route for a live mask is never allowed
				// to fall through and become an ordinary inbox delivery.
				message.setReject(RELAY_REPLY_REJECTION);
				return;
			}
		} else {
			// Parse the reply to get body
			const rawBytes = await new Response(message.raw).arrayBuffer();
			const parser = new PostalMime();
			const parsed = await parser.parse(rawBytes);

			// Only the mask's owner may send as the mask. A refusal is final: it
			// never falls through to become an ordinary inbox delivery either.
			const rule = await findRelayRule(env, relay.maskId);
			const refusal = rule
				? relayReplyRefusal({
						owner: rule.target,
						headerFrom: parsed.from?.address,
						envelope: from,
						auth: firstSenderAuth(parsed.headers),
					})
				: "mask has no relay rule";
			if (refusal) {
				console.warn(`relay reply refused for mask ${relay.maskId} (envelope ${from}): ${refusal}`);
				message.setReject(RELAY_REPLY_REJECTION);
				return;
			}

			await enqueueRelay(env, {
				maskId: relay.maskId,
				direction: "reply",
				from: `${relay.maskId}@${env.MAIL_DOMAIN}`,
				to: relay.sender,
				subject: parsed.subject || "(no subject)",
				textBody: parsed.text ? stripQuotedText(parsed.text) : undefined,
				htmlBody: parsed.html ? stripQuotedHtml(parsed.html) : undefined,
				inReplyTo: message.headers.get("in-reply-to") || undefined,
				references: message.headers.get("references") || undefined,
			});
			return;
		}
	}

	// Check if this is a direct email to a mask (inbound relay)
	const maskLookup = await env.DB.prepare("SELECT id FROM email_masks WHERE id = ? AND active = 1")
		.bind(normalizeInbox(localPart.split("+")[0]) || "")
		.first<{ id: string }>();

	if (maskLookup) {
		const rule = await findRelayRule(env, maskLookup.id);
		if (rule) {
			const rawBytes = await new Response(message.raw).arrayBuffer();
			const parser = new PostalMime();
			const parsed = await parser.parse(rawBytes);

			// `from` is the SMTP envelope, usually a bounce address rather than a
			// person, so the route replies where a mail client would.
			const replyTarget = pickSenderAddress([parsed.replyTo, parsed.from], from);
			const replyTo = await createRelayAddress(env, replyTarget, maskLookup.id);

			// The opaque route hides the sender's address, so the display name is
			// the only place the mask owner still sees who wrote, and where a
			// reply will go when that is someone else.
			await enqueueRelay(env, {
				maskId: maskLookup.id,
				direction: "inbound",
				from: replyTo,
				fromName: viaDisplayName(
					{ name: parsed.from?.name, address: pickSenderAddress([parsed.from], from) },
					`${maskLookup.id}@${env.MAIL_DOMAIN}`,
					replyTarget,
				),
				to: rule.target,
				replyTo,
				subject: parsed.subject || "(no subject)",
				textBody: parsed.text ? stripQuotedText(parsed.text) : undefined,
				htmlBody: parsed.html ? stripQuotedHtml(parsed.html) : undefined,
				inReplyTo: message.headers.get("message-id") || undefined,
			});
			return;
		}
	}

	// Normal drop handling
	const [rawInbox, ...topicParts] = localPart.split("+");
	const inbox = normalizeInbox(rawInbox) || "unknown";
	const topic = topicParts.length > 0 ? topicParts.join("+") : null;

	const dropId = generateId();
	const r2Prefix = `drops/${inbox}/${dropId}`;

	// Read raw email
	const rawBytes = await new Response(message.raw).arrayBuffer();

	// Store raw .eml
	await env.BUCKET.put(`${r2Prefix}/raw.eml`, rawBytes, {
		customMetadata: { from, to, inbox },
	});

	// Parse with postal-mime
	const parser = new PostalMime();
	const parsed = await parser.parse(rawBytes);

	// Store attachments
	let attachmentCount = 0;
	for (const att of parsed.attachments) {
		const originalName = att.filename || `attachment-${attachmentCount}`;
		const filename = slugifyFilename(originalName);
		await env.BUCKET.put(`${r2Prefix}/attachments/${filename}`, att.content, {
			httpMetadata: { contentType: att.mimeType },
			customMetadata: { originalFilename: originalName },
		});
		attachmentCount++;
	}

	// Build metadata
	const metadata = JSON.stringify({
		auth_method: "email",
		from_name: parsed.from?.name || null,
		from_header: parsed.headers.find((header) => header.key === "from")?.value ?? null,
		to_full: to,
		message_id: message.headers.get("message-id") || null,
		sender_auth: firstSenderAuth(parsed.headers),
	});

	// Index in D1
	await env.DB.prepare(
		`INSERT INTO drops (id, inbox, topic, channel, from_addr, subject,
			body_text, body_html, has_attachments, attachment_count,
			r2_prefix, raw_r2_key, metadata, created_at)
		VALUES (?, ?, ?, 'email', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			dropId,
			inbox,
			topic,
			from,
			parsed.subject || null,
			parsed.text ? stripQuotedText(parsed.text) : null,
			parsed.html ? stripQuotedHtml(parsed.html) : null,
			attachmentCount > 0 ? 1 : 0,
			attachmentCount,
			r2Prefix,
			`${r2Prefix}/raw.eml`,
			metadata,
			Date.now(),
		)
		.run();

	// Fire matching rules (forwards + webhooks)
	const drop: Drop = {
		id: dropId,
		inbox,
		topic,
		channel: "email",
		from_addr: from,
		from_user: null,
		subject: parsed.subject || null,
		body_text: parsed.text ? stripQuotedText(parsed.text) : null,
		body_html: parsed.html ? stripQuotedHtml(parsed.html) : null,
		has_attachments: attachmentCount > 0 ? 1 : 0,
		attachment_count: attachmentCount,
		r2_prefix: r2Prefix,
		raw_r2_key: `${r2Prefix}/raw.eml`,
		metadata,
		created_at: Date.now(),
		read_at: null,
	};

	// Forward via the Email Sending binding (not message.forward, which only
	// delivers to CF-verified destinations). Carries the full unstripped body and
	// the original attachments; From is rewritten to the box, sender kept in Reply-To.
	await fireRules(env, ctx, drop, "email", async (to) => {
		await forwardViaBinding(env, {
			box: inbox,
			to,
			from,
			fromName: parsed.from?.name || null,
			subject: parsed.subject || null,
			textBody: parsed.text || undefined,
			htmlBody: parsed.html || undefined,
			attachments: parsed.attachments.map((a) => ({
				filename: a.filename || undefined,
				mimeType: a.mimeType,
				content: a.content,
				contentId: a.contentId || undefined,
				disposition: a.disposition || undefined,
			})),
			messageId: message.headers.get("message-id"),
		});
	});
}
