import type { Env } from "../types";

/**
 * R2 event notifications: the bucket tells us an object landed, so a drop no
 * longer depends on the client coming back to say so.
 *
 * The old handshake was `presign -> PUT to R2 -> POST /api/upload/confirm`. The
 * third step is the client's job, so a browser that closes the tab -- or a CLI
 * that dies -- left the drop `pending` forever with its bytes sitting in R2,
 * invisible to every agent reading the inbox. R2 now reports the write itself.
 *
 * `/api/upload/confirm` is kept and still works (the SPA and the CLI call it),
 * but nothing depends on it any more; whichever of the two arrives first wins
 * and the other is a no-op.
 */

/** The queue R2 delivers object-create notifications to. */
export const R2_EVENT_QUEUE = "agent-drop-r2-events";

/** The message body R2 puts on the queue. */
export interface R2EventNotification {
	account: string;
	action: "PutObject" | "CopyObject" | "CompleteMultipartUpload" | "DeleteObject";
	bucket: string;
	object: { key: string; size?: number; eTag?: string };
	eventTime: string;
	copySource?: { bucket: string; object: string };
}

/** Actions that mean "bytes are now at this key". */
const CREATE_ACTIONS = new Set(["PutObject", "CopyObject", "CompleteMultipartUpload"]);

/**
 * Recover the drop a presigned upload belongs to from its R2 key.
 *
 * Presign and multipart-init both build `drops/{inbox}/{dropId}/uploads/{file}`,
 * and both derive that prefix from the *authenticated* inbox and a
 * server-generated id -- so unlike the old client-supplied `objectKey`, this is
 * server-side state coming back to us via R2, not user input.
 *
 * Anything else under `drops/` (an email's `raw.eml`, its `attachments/`)
 * belongs to a drop that was already `completed` when it was written, so it is
 * not our business.
 */
export function parseUploadKey(key: string): { inbox: string; dropId: string } | null {
	const segs = key.split("/");
	if (segs.length < 5) return null;
	const [root, inbox, dropId, kind] = segs;
	if (root !== "drops" || kind !== "uploads") return null;
	if (!inbox || !dropId) return null;
	return { inbox, dropId };
}

export interface R2EventOutcome {
	/** "completed" | "ignored" | "no-match" -- what the notification did. */
	result: "completed" | "ignored" | "no-match";
	dropId?: string;
}

/**
 * Flip the drop this object belongs to from `pending` to `completed`.
 *
 * Deliberately narrow: only a `pending` row moves, and only if its recorded
 * `object_key` is the key that actually landed. Rows written before migration
 * 0008 carry no key and match on id + inbox alone. Idempotent -- a redelivered
 * notification updates nothing and reports "no-match".
 */
export async function processR2Event(
	env: Env,
	event: R2EventNotification,
): Promise<R2EventOutcome> {
	if (!CREATE_ACTIONS.has(event.action)) return { result: "ignored" };

	const parsed = parseUploadKey(event.object?.key ?? "");
	if (!parsed) return { result: "ignored" };

	const res = await env.DB.prepare(
		`UPDATE drops SET status = 'completed'
		WHERE id = ? AND inbox = ? AND status = 'pending'
			AND (object_key IS NULL OR object_key = ?)`,
	)
		.bind(parsed.dropId, parsed.inbox, event.object.key)
		.run();

	if (!res.meta.changes) return { result: "no-match", dropId: parsed.dropId };
	return { result: "completed", dropId: parsed.dropId };
}

/** Queue consumer for the R2 notification queue. */
export async function processR2EventBatch(
	batch: MessageBatch<R2EventNotification>,
	env: Env,
): Promise<void> {
	for (const msg of batch.messages) {
		try {
			const outcome = await processR2Event(env, msg.body);
			if (outcome.result === "completed") {
				console.log(`R2 event completed drop ${outcome.dropId} (${msg.body.object.key})`);
			}
			msg.ack();
		} catch (err) {
			// A D1 blip should be retried, not swallowed: the drop is invisible to
			// agents until this lands.
			console.error("R2 event handler error:", err, msg.body?.object?.key);
			msg.retry();
		}
	}
}
