const ENCODING = "0123456789abcdefghjkmnpqrstvwxyz";

export function generateId(): string {
	const now = Date.now();
	const chars: string[] = new Array(26);

	// Timestamp (10 chars, 48-bit ms since epoch)
	let ts = now;
	for (let i = 9; i >= 0; i--) {
		chars[i] = ENCODING[ts % 32];
		ts = Math.floor(ts / 32);
	}

	// Randomness (16 chars)
	const rand = crypto.getRandomValues(new Uint8Array(10));
	for (let i = 0; i < 16; i++) {
		chars[10 + i] = ENCODING[rand[i % 10] % 32];
	}

	return chars.join("");
}
