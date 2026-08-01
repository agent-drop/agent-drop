/**
 * Reading and writing the three S3 multipart documents R2 speaks.
 *
 * Split out of `api/upload.ts` so the parsing has tests of its own, and so the
 * endpoint reads as "ask R2, hand the answer to a parser" rather than as a pile
 * of regexes with an HTTP call in the middle.
 *
 * Every reader here answers `null`/`[]` on anything it cannot make sense of --
 * malformed XML, the wrong document, a missing field. The callers already turn
 * that into the same 500 they returned before, so a hostile or truncated
 * response fails closed instead of completing an upload against a guess.
 */

import { childText, children, escapeXml, parseXml, XmlParseError } from "./xml";

export interface UploadPart {
	partNumber: number;
	/** The ETag exactly as S3 meant it, entity references resolved. */
	etag: string;
}

function root(xml: string, expected: string) {
	try {
		const node = parseXml(xml);
		return node.name === expected ? node : null;
	} catch (err) {
		if (err instanceof XmlParseError) return null;
		throw err;
	}
}

/** The upload id from an `InitiateMultipartUploadResult`. */
export function readUploadId(xml: string): string | null {
	const node = root(xml, "InitiateMultipartUploadResult");
	if (!node) return null;
	// Trimmed because the element is frequently pretty-printed onto its own line,
	// and an upload id never has meaningful leading or trailing whitespace.
	const id = childText(node, "UploadId")?.trim();
	return id || null;
}

/**
 * The parts of a `ListPartsResult`, ordered by part number.
 *
 * A `<Part>` missing either field, or carrying a part number that is not a
 * positive integer, is dropped rather than guessed at -- completing an upload
 * with a wrong ETag corrupts the object silently.
 */
export function readListedParts(xml: string): UploadPart[] {
	const node = root(xml, "ListPartsResult");
	if (!node) return [];

	const parts: UploadPart[] = [];
	for (const part of children(node, "Part")) {
		const partNumber = Number(childText(part, "PartNumber")?.trim());
		const etag = childText(part, "ETag")?.trim();
		if (!Number.isInteger(partNumber) || partNumber < 1 || !etag) continue;
		parts.push({ partNumber, etag });
	}
	return parts.sort((a, b) => a.partNumber - b.partNumber);
}

/** The `CompleteMultipartUpload` body that finishes the upload. */
export function renderCompleteBody(parts: UploadPart[]): string {
	return [
		"<CompleteMultipartUpload>",
		...parts.map(
			(p) =>
				`<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${escapeXml(p.etag)}</ETag></Part>`,
		),
		"</CompleteMultipartUpload>",
	].join("");
}
