/**
 * Normalize inbox name:
 * - lowercase
 * - strip dots (gmail-style: a.b.c -> abc)
 * - only a-z, 0-9, hyphens allowed
 * - cannot start or end with hyphen
 * - cannot start with number
 * - no consecutive hyphens
 * - min 1 char, max 64 chars
 *
 * Returns null if invalid (caller should return 400).
 */
export function normalizeInbox(raw: string): string | null {
	// Decode any URL encoding first
	let name: string;
	try {
		name = decodeURIComponent(raw);
	} catch {
		return null;
	}

	// Lowercase + strip dots
	name = name.toLowerCase().replace(/\./g, "");

	// Replace underscores with hyphens (normalize to kebab)
	name = name.replace(/_/g, "-");

	// Strip everything except a-z, 0-9, hyphen
	name = name.replace(/[^a-z0-9-]/g, "");

	// Collapse consecutive hyphens
	name = name.replace(/-{2,}/g, "-");

	// Strip leading/trailing hyphens
	name = name.replace(/^-+|-+$/g, "");

	// Must not start with a number
	if (/^[0-9]/.test(name)) return null;

	// Length check
	if (name.length < 1 || name.length > 64) return null;

	return name;
}

/**
 * Normalize a webhook receiver slug: lowercase, kebab, a-z0-9 and hyphens.
 * Unlike an inbox name, a leading digit is fine (`2024-campaign`) -- a slug is a
 * path segment, not an email local part.
 *
 * Returns null if nothing usable is left, which the caller answers with a 400
 * (or, on the public receive path, a 404 -- an unusable slug cannot name a row).
 */
export function normalizeSlug(raw: string): string | null {
	let slug: string;
	try {
		slug = decodeURIComponent(raw);
	} catch {
		return null;
	}
	slug = slug
		.toLowerCase()
		.trim()
		.replace(/[\s_]+/g, "-")
		.replace(/[^a-z0-9-]/g, "")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "");
	if (slug.length < 1 || slug.length > 64) return null;
	return slug;
}

// Romanize unicode characters (umlauts, accents, etc)
const CHAR_MAP: Record<string, string> = {
	à: "a",
	á: "a",
	â: "a",
	ã: "a",
	ä: "a",
	å: "a",
	æ: "ae",
	ç: "c",
	è: "e",
	é: "e",
	ê: "e",
	ë: "e",
	ì: "i",
	í: "i",
	î: "i",
	ï: "i",
	ð: "d",
	ñ: "n",
	ò: "o",
	ó: "o",
	ô: "o",
	õ: "o",
	ö: "o",
	ø: "o",
	ù: "u",
	ú: "u",
	û: "u",
	ü: "u",
	ý: "y",
	ÿ: "y",
	þ: "th",
	ß: "ss",
	đ: "d",
	ł: "l",
	ŋ: "ng",
	ő: "o",
	ű: "u",
	ą: "a",
	ć: "c",
	ę: "e",
	ń: "n",
	ś: "s",
	ź: "z",
	ż: "z",
	č: "c",
	ď: "d",
	ě: "e",
	ň: "n",
	ř: "r",
	š: "s",
	ť: "t",
	ů: "u",
	ž: "z",
	ā: "a",
	ē: "e",
	ī: "i",
	ō: "o",
	ū: "u",
	ก: "k",
	ข: "kh",
	ค: "kh",
	ง: "ng",
	จ: "ch",
	ช: "ch",
	ซ: "s",
};

function romanize(str: string): string {
	// Normalize to NFD (decompose accents) then strip combining marks
	// This handles most accented chars: é -> e + combining accent -> e
	const decomposed = str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
	// Then apply char map for special cases (ß->ss, æ->ae, ø->o, etc)
	// biome-ignore lint/suspicious/noControlCharactersInRegex: \x00 is a range bound, not a literal match -- [^\x00-\x7F] means "any non-ASCII character".
	return decomposed.replace(/[^\x00-\x7F]/g, (ch) => CHAR_MAP[ch] || "");
}

/**
 * Slugify a filename for R2 storage:
 * - romanize unicode (ä->a, é->e, ö->o, ß->ss)
 * - lowercase
 * - spaces/underscores -> hyphens
 * - strip non-alphanumeric except hyphens and dots
 * - collapse consecutive hyphens
 * - preserve file extension
 *
 * "Z Profile (Final).jpg" -> "z-profile-final.jpg"
 * "INVOICE_2024_03.PDF" -> "invoice-2024-03.pdf"
 * "résumé.docx" -> "resume.docx"
 * "Ärende Ö.pdf" -> "arende-o.pdf"
 * "björk björk.mp3" -> "bjork-bjork.mp3"
 */
export function slugifyFilename(raw: string): string {
	const lastDot = raw.lastIndexOf(".");
	const hasExt = lastDot > 0;
	const name = hasExt ? raw.slice(0, lastDot) : raw;

	// The extension is attacker-controlled too (inbound MIME part names, upload
	// form fields), and every caller concatenates the result straight into an R2
	// key. Copying it verbatim let "../../etc/passwd" through as
	// "file./etc/passwd" -- separators and all. Strip it like the name.
	const extChars = hasExt
		? raw
				.slice(lastDot + 1)
				.toLowerCase()
				.replace(/[^a-z0-9]/g, "")
		: "";
	const ext = extChars ? `.${extChars}` : "";

	const slug =
		romanize(name.toLowerCase())
			.replace(/[\s_]+/g, "-")
			.replace(/[^a-z0-9-]/g, "")
			.replace(/-{2,}/g, "-")
			.replace(/^-+|-+$/g, "") || "file";

	return slug + ext;
}
