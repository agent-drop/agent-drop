/**
 * The outbound-mail limits, in ONE place: the worker enforces them in
 * src/api/send.ts and the CLI plans its requests around them in
 * tools/lib/attachment-plan.ts. Pure constants, no runtime types, so the CLI's
 * tsconfig can import this file directly instead of keeping a copy that drifts.
 */

/** Keep decoded attachments comfortably below the binding's 25 MiB message cap. */
export const MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024;
export const MAX_ATTACHMENT_TOTAL_BYTES = 16 * 1024 * 1024;
export const MAX_ATTACHMENTS = 32;
/** Inline JSON is intentionally smaller; the CLI moves files above 1 MB through R2. */
export const MAX_INLINE_ATTACHMENT_BYTES = 5 * 1024 * 1024;
/** Enough for one max-size inline attachment after base64 expansion, plus JSON metadata. */
export const MAX_EMAIL_REQUEST_BYTES = 8 * 1024 * 1024;
