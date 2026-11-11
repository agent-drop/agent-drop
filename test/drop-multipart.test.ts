import { describe, expect, test } from "bun:test";
import {
	handleDrop,
	MAX_DIRECT_MULTIPART_BYTES,
	MAX_DIRECT_UPLOAD_BYTES,
	MAX_DIRECT_UPLOAD_FILES,
} from "../src/api/drop";
import { makeEnv } from "./helpers/env";

const URL_STRING = "https://drop.test/api/drop/lisa";

function requestFor(form: FormData): Request {
	return new Request(URL_STRING, { method: "POST", body: form });
}

async function submit(form: FormData, env = makeEnv()): Promise<Response> {
	const request = requestFor(form);
	return handleDrop(request, env, "lisa", new URL(request.url), { authMethod: "api_key" });
}

function formWithFile(file: File): FormData {
	const form = new FormData();
	form.set("subject", "Quarterly report");
	form.set("text", "attached");
	form.set("file", file);
	return form;
}

describe("direct multipart drop budgets", () => {
	test("keeps normal curl-style file uploads and streams the bounded File to R2", async () => {
		let storedKey = "";
		let storedBody: unknown;
		const bucket = {
			put: async (key: string, body: unknown) => {
				storedKey = key;
				storedBody = body;
				return { key };
			},
		} as unknown as R2Bucket;
		const env = makeEnv({ BUCKET: bucket });
		const response = await submit(
			formWithFile(new File(["hello"], "Report Final.txt", { type: "text/plain" })),
			env,
		);

		expect(response.status).toBe(201);
		const result = (await response.json()) as { id: string; files: string[]; attachments: number };
		expect(result).toMatchObject({ files: ["report-final.txt"], attachments: 1 });
		expect(storedKey).toBe(`drops/lisa/${result.id}/uploads/report-final.txt`);
		expect(storedBody).toBeInstanceOf(Blob);
		expect(await (storedBody as Blob).text()).toBe("hello");
		expect(
			env.DB.raw
				.query("SELECT subject, body_text, attachment_count FROM drops WHERE id = ?")
				.get(result.id),
		).toMatchObject({ subject: "Quarterly report", body_text: "attached", attachment_count: 1 });
	});

	test("rejects a declared request over the aggregate cap before parsing or writing", async () => {
		let puts = 0;
		const bucket = {
			put: async () => {
				puts++;
			},
		} as unknown as R2Bucket;
		const env = makeEnv({ BUCKET: bucket });
		const request = requestFor(formWithFile(new File(["small"], "small.txt")));
		request.headers.set("Content-Length", String(MAX_DIRECT_MULTIPART_BYTES + 1));

		const response = await handleDrop(request, env, "lisa", new URL(request.url));

		expect(response.status).toBe(413);
		expect(puts).toBe(0);
		expect(env.DB.raw.query("SELECT COUNT(*) AS n FROM drops").get()).toEqual({ n: 0 });
	});

	test("rejects too many files before the first R2 write", async () => {
		const form = new FormData();
		for (let i = 0; i <= MAX_DIRECT_UPLOAD_FILES; i++) {
			form.append("file", new File(["x"], `${i}.txt`));
		}
		let puts = 0;
		const env = makeEnv({
			BUCKET: {
				put: async () => {
					puts++;
				},
			} as unknown as R2Bucket,
		});

		const response = await submit(form, env);

		expect(response.status).toBe(413);
		expect((await response.json()) as { error: string }).toEqual({
			error: `too many files (max ${MAX_DIRECT_UPLOAD_FILES})`,
		});
		expect(puts).toBe(0);
	});

	test("rejects an individual file over the direct-upload cap before writing", async () => {
		const large = new File([new Uint8Array(MAX_DIRECT_UPLOAD_BYTES + 1)], "large.bin");
		let puts = 0;
		const env = makeEnv({
			BUCKET: {
				put: async () => {
					puts++;
				},
			} as unknown as R2Bucket,
		});

		const response = await submit(formWithFile(large), env);

		expect(response.status).toBe(413);
		expect((await response.json()) as { error: string }).toEqual({
			error: `file exceeds direct-upload limit (${MAX_DIRECT_UPLOAD_BYTES} bytes)`,
		});
		expect(puts).toBe(0);
	});

	test("returns a controlled 400 for malformed multipart data", async () => {
		const env = makeEnv();
		const request = new Request(URL_STRING, {
			method: "POST",
			headers: { "Content-Type": "multipart/form-data" },
			body: "not a multipart body",
		});

		const response = await handleDrop(request, env, "lisa", new URL(request.url));

		expect(response.status).toBe(400);
		expect(env.DB.raw.query("SELECT COUNT(*) AS n FROM drops").get()).toEqual({ n: 0 });
	});
});
