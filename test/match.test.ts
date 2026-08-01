import { describe, expect, test } from "bun:test";
import { exact, prefix, segments, segmentsThenRest } from "../src/api/match";

describe("exact", () => {
	const m = exact("/api/health");
	test("matches only that path", () => {
		expect(m("/api/health")).toEqual({});
		expect(m("/api/health/")).toBeNull();
		expect(m("/api/healthz")).toBeNull();
		expect(m("/api")).toBeNull();
	});
});

describe("prefix", () => {
	const m = prefix("/api/keys");
	test("matches the path itself and anything under it", () => {
		expect(m("/api/keys")).toEqual({});
		expect(m("/api/keys/abc")).toEqual({});
	});

	test("also matches a partial segment, which is the wart it preserves", () => {
		// `path.startsWith("/api/keys")` is what the old router did, warts and all.
		// Documented here so a future segment-exact change is a decision, not a
		// side effect.
		expect(m("/api/keysfoo")).toEqual({});
	});

	test("does not match a different path", () => {
		expect(m("/api/key")).toBeNull();
		expect(m("/apikeys")).toBeNull();
	});
});

describe("segments", () => {
	const one = segments("/api/drop/:inbox");
	const two = segments("/api/host/sites/:inbox/:site");

	test("captures one segment", () => {
		expect(one("/api/drop/lisa")).toEqual({ inbox: "lisa" });
	});

	test("captures several", () => {
		expect(two("/api/host/sites/lisa/marketing")).toEqual({
			inbox: "lisa",
			site: "marketing",
		});
	});

	test("segment count must match exactly", () => {
		expect(one("/api/drop")).toBeNull();
		expect(one("/api/drop/lisa/extra")).toBeNull();
		expect(two("/api/host/sites/lisa")).toBeNull();
	});

	test("a capture never matches an EMPTY segment", () => {
		// Without this, `POST /api/drop/` would reach the write gate with an empty
		// inbox and answer 400 instead of falling through to 404 -- a visible API
		// change hiding in a matcher detail.
		expect(one("/api/drop/")).toBeNull();
		expect(two("/api/host/sites//marketing")).toBeNull();
		expect(two("/api/host/sites/lisa/")).toBeNull();
	});

	test("literal segments must match", () => {
		expect(one("/api/drops/lisa")).toBeNull();
		expect(one("/api/upload/lisa")).toBeNull();
	});
});

describe("segmentsThenRest", () => {
	const m = segmentsThenRest("/api/inbox/:inbox");

	test("an empty rest is a match", () => {
		expect(m("/api/inbox/lisa")).toEqual({ inbox: "lisa", rest: "" });
	});

	test("the rest is captured verbatim, leading slash and all", () => {
		expect(m("/api/inbox/lisa/latest")).toEqual({ inbox: "lisa", rest: "/latest" });
		expect(m("/api/inbox/lisa/d1/file/a%20b.pdf")).toEqual({
			inbox: "lisa",
			rest: "/d1/file/a%20b.pdf",
		});
		// A bare trailing slash is a sub-path too, not a normalization to "".
		expect(m("/api/inbox/lisa/")).toEqual({ inbox: "lisa", rest: "/" });
	});

	test("still needs the named segment", () => {
		expect(m("/api/inbox")).toBeNull();
		expect(m("/api/inbox/")).toBeNull();
		expect(m("/api/inboxes/lisa")).toBeNull();
	});
});
