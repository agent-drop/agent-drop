import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lookupSecret, readSecret } from "../tools/lib/secrets";

// A stand-in for ~/.local/bin/key. It answers from FAKE_STORE_VALUE in ITS OWN
// environment, so a test can tell whether the lookup's env reached the child.
const FAKE_KEY = `#!/bin/sh
[ -n "$FAKE_KEY_MARKER" ] && : > "$FAKE_KEY_MARKER"
case "$1" in
  PRESENT) printf '  %s\\n' "$FAKE_STORE_VALUE" ;;
  LEAKY) printf 'half-written-value'; echo "key: decrypt failed" >&2; exit 1 ;;
  *) echo "key: no such secret: env/$1" >&2; exit 1 ;;
esac
`;

let dir: string;
let keyBin: string;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "agent-drop-secrets-"));
	keyBin = join(dir, "key");
	writeFileSync(keyBin, FAKE_KEY);
	chmodSync(keyBin, 0o755);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("lookupSecret", () => {
	it("returns the environment variable without running key", () => {
		const marker = join(dir, "ran-env");
		const got = lookupSecret("PRESENT", {
			env: { PRESENT: "from-env", FAKE_STORE_VALUE: "from-store", FAKE_KEY_MARKER: marker },
			keyBin,
		});
		expect(got).toEqual({ found: true, value: "from-env", source: "env" });
		expect(existsSync(marker)).toBe(false);
	});

	it("falls back to key, trimmed, using the env it was given", () => {
		const got = lookupSecret("PRESENT", { env: { FAKE_STORE_VALUE: "from-store" }, keyBin });
		expect(got).toEqual({ found: true, value: "from-store", source: "passage" });
	});

	it("finds key on the given PATH when no binary is named", () => {
		const got = readSecret("PRESENT", { env: { PATH: dir, FAKE_STORE_VALUE: "via-path" } });
		expect(got).toBe("via-path");
	});

	it("reports a secret passage does not have as not found", () => {
		const got = lookupSecret("ABSENT", { env: {}, keyBin });
		expect(got.found).toBe(false);
	});

	it("never carries stdout of a failed key run into the problem", () => {
		const got = lookupSecret("LEAKY", { env: {}, keyBin });
		expect(got.found).toBe(false);
		if (!got.found) expect(got.problem).not.toContain("half-written-value");
	});

	it("reports a missing key binary instead of throwing", () => {
		const got = lookupSecret("PRESENT", { env: {}, keyBin: join(dir, "no-such-key") });
		expect(got.found).toBe(false);
	});
});
