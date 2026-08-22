/**
 * The sender-authentication verdicts Cloudflare reached before handing us the
 * message, lifted off the `Authentication-Results` header so a consumer can see
 * them without re-parsing `raw.eml`.
 *
 * Nothing here decides delivery. `from_addr` on a drop is whatever the sender
 * put in the From header, and a box address is guessable by design, so an agent
 * that treats it as identity is trusting an attacker. These fields are what let
 * it stop doing that.
 */
export interface MailAuthResults {
	/** The authserv-id that made these claims -- meaningless unless recognised. */
	authserv: string | null;
	spf: string | null;
	dkim: string | null;
	dmarc: string | null;
}

const EMPTY: MailAuthResults = { authserv: null, spf: null, dkim: null, dmarc: null };

/**
 * Parse the FIRST `Authentication-Results` field only.
 *
 * A receiving MTA prepends its own; anything a sender supplies is pushed below
 * it. `Headers.get` joins repeats in order, so the first field is the one added
 * by the MTA that actually accepted the mail, and every later one is sender
 * data. Taking the first is the whole reason this cannot be spoofed by adding a
 * header -- read a later one and the check inverts into a lie.
 */
export function parseAuthResults(header: string | null | undefined): MailAuthResults {
	if (!header) return { ...EMPTY };

	// A joined repeat starts a new field after ", " + authserv-id; cutting at the
	// first comma that precedes another `authserv;` keeps us inside field one.
	const field = header.split(/,\s*(?=[^;,\s]+;)/)[0] ?? header;
	const parts = field.split(";").map((p) => p.trim());

	const authserv = parts[0] && !parts[0].includes("=") ? parts[0] : null;
	const verdict = (method: string): string | null => {
		for (const part of parts) {
			const match = part.match(new RegExp(`^${method}=([a-z]+)\\b`, "i"));
			if (match) return match[1].toLowerCase();
		}
		return null;
	};

	return { authserv, spf: verdict("spf"), dkim: verdict("dkim"), dmarc: verdict("dmarc") };
}
