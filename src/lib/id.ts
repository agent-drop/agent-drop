// ULID-shaped id: 10 chars of base32 millisecond timestamp (lexicographically
// sortable) followed by 16 chars of randomness. Crockford alphabet minus i/l/o/u.
const ENCODING = "0123456789abcdefghjkmnpqrstvwxyz";
const TS_LEN = 10;
const RAND_LEN = 16;

export function generateId(): string {
	const chars: string[] = new Array(TS_LEN + RAND_LEN);

	// Timestamp (10 chars, 50 bits of base32 -- covers ms since epoch with room to spare)
	let ts = Date.now();
	for (let i = TS_LEN - 1; i >= 0; i--) {
		chars[i] = ENCODING[ts % 32];
		ts = Math.floor(ts / 32);
	}

	// Randomness: one fresh byte per char. 256 is a multiple of 32, so masking the
	// low 5 bits is unbiased. (Drawing fewer bytes than chars and wrapping the index
	// silently duplicates positions -- that was a real bug here.)
	const rand = crypto.getRandomValues(new Uint8Array(RAND_LEN));
	for (let i = 0; i < RAND_LEN; i++) {
		chars[TS_LEN + i] = ENCODING[rand[i] & 31];
	}

	return chars.join("");
}
