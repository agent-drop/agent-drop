import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");

// A D1Database over an in-memory SQLite, so tests run the real SQL from the real
// migrations instead of asserting against a hand-mocked object. D1 is SQLite,
// so "did this UPDATE actually match a row" is a question the fake can answer
// truthfully -- which is the whole point for the upload-auth regressions.

type Param = string | number | null;

function normalizeParam(value: unknown): Param {
	if (value === undefined || value === null) return null;
	if (typeof value === "boolean") return value ? 1 : 0;
	if (typeof value === "number" || typeof value === "string") return value;
	return String(value);
}

class FakeStatement {
	constructor(
		private readonly db: Database,
		private readonly sql: string,
		private readonly params: Param[] = [],
	) {}

	bind(...params: unknown[]): FakeStatement {
		return new FakeStatement(this.db, this.sql, params.map(normalizeParam));
	}

	async first<T = Record<string, unknown>>(): Promise<T | null> {
		return (this.db.query(this.sql).get(...this.params) as T) ?? null;
	}

	async all<T = Record<string, unknown>>(): Promise<{
		results: T[];
		success: true;
		meta: { changes: number; last_row_id: number; duration: number };
	}> {
		const results = this.db.query(this.sql).all(...this.params) as T[];
		return {
			results,
			success: true,
			meta: { changes: 0, last_row_id: 0, duration: 0 },
		};
	}

	async run(): Promise<{
		success: true;
		results: never[];
		meta: { changes: number; last_row_id: number; duration: number };
	}> {
		const out = this.db.query(this.sql).run(...this.params);
		return {
			success: true,
			results: [],
			meta: {
				changes: Number(out.changes ?? 0),
				last_row_id: Number(out.lastInsertRowid ?? 0),
				duration: 0,
			},
		};
	}
}

export interface FakeD1 {
	prepare(sql: string): FakeStatement;
	/** Escape hatch for arranging fixtures without going through prepare/bind. */
	raw: Database;
}

export function makeD1(): FakeD1 {
	const db = new Database(":memory:");
	for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
		db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
	}
	return {
		prepare: (sql: string) => new FakeStatement(db, sql),
		raw: db,
	};
}
