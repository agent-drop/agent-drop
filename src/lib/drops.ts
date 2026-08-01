import { slugifyFilename } from "./normalize";

/**
 * The columns the finalize path needs. The router loads this row to decide who
 * is allowed to finalize the drop, then hands it to the handler so the key and
 * the inbox both come from the same authenticated row.
 */
export interface FinalizeDrop {
	id: string;
	inbox: string;
	r2_prefix: string | null;
	object_key: string | null;
	subject: string | null;
	status: string;
}

/**
 * The R2 key this drop's upload was signed against, derived from server-side
 * state only.
 *
 * `/api/upload/complete` used to take `dropId` and `objectKey` as independent
 * body fields and never check they belonged to the same row, so a caller
 * holding any valid drop id could complete a multipart upload against an
 * arbitrary key -- another box's object included -- and flip that drop to
 * `completed`. The key is now recorded at presign time (migration 0008) and
 * read back here; the request body is not consulted.
 *
 * This lives in `lib/` rather than next to the upload endpoints because the
 * cron reaper needs it too, and `lib/` importing from `api/` was the wrong
 * direction.
 */
export function resolveObjectKey(drop: FinalizeDrop): string | null {
	if (drop.object_key) return drop.object_key;
	// Rows written before migration 0008 -- an upload already in flight across the
	// deploy -- carry no key. Rebuild it the way presign built it, still without
	// touching the request: `subject` holds the original filename.
	if (drop.r2_prefix && drop.subject) {
		return `${drop.r2_prefix}/uploads/${slugifyFilename(drop.subject)}`;
	}
	return null;
}
