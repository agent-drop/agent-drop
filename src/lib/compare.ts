/**
 * One comparison, used everywhere a secret is checked.
 *
 * It lives here rather than beside its first caller because the webhook verifier
 * needs exactly this and a second copy of a security primitive is how the two
 * copies end up disagreeing.
 */

/**
 * Compare without an early exit, so the loop runs the same number of iterations
 * whatever the inputs are.
 *
 * The length check DOES exit early, which is deliberate and standard: the length
 * of a digest or a token is public information, and padding to a common length
 * would only compare bytes that are not there.
 */
export function constantTimeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}
