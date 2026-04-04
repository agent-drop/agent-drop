import type { Env } from "../types";
import { normalizeInbox } from "../lib/normalize";

function generateMaskId(prefix: string): string {
	const bytes = crypto.getRandomValues(new Uint8Array(4));
	const suffix = Array.from(bytes)
		.map((b) => b.toString(36))
		.join("")
		.slice(0, 5);
	return `${prefix}-${suffix}`;
}

export async function handleMasks(
	request: Request,
	env: Env,
	url: URL,
): Promise<Response> {
	const method = request.method;
	const path = url.pathname;

	// POST /api/masks - create mask
	if (method === "POST" && path === "/api/masks") {
		const body = (await request.json()) as {
			id?: string;
			prefix?: string;
			label?: string;
		};

		let maskId: string;

		if (body.id) {
			// User-provided ID
			const normalized = normalizeInbox(body.id);
			if (!normalized) {
				return Response.json({ error: "invalid mask ID" }, { status: 400 });
			}
			maskId = normalized;

			// Check uniqueness
			const existing = await env.DB.prepare(
				"SELECT id FROM email_masks WHERE id = ?",
			).bind(maskId).first();
			if (existing) {
				return Response.json({ error: "mask ID already exists" }, { status: 409 });
			}
		} else if (body.prefix) {
			// Auto-generate with prefix
			const prefix = normalizeInbox(body.prefix);
			if (!prefix) {
				return Response.json({ error: "invalid prefix" }, { status: 400 });
			}
			// Generate unique ID
			for (let i = 0; i < 10; i++) {
				maskId = generateMaskId(prefix);
				const existing = await env.DB.prepare(
					"SELECT id FROM email_masks WHERE id = ?",
				).bind(maskId).first();
				if (!existing) break;
			}
			maskId = maskId!;
		} else {
			return Response.json({ error: "provide id or prefix" }, { status: 400 });
		}

		// Also check it doesn't collide with a real inbox
		const inboxCollision = await env.DB.prepare(
			"SELECT inbox FROM drops WHERE inbox = ? LIMIT 1",
		).bind(maskId).first();
		if (inboxCollision) {
			return Response.json({ error: "collides with existing inbox" }, { status: 409 });
		}

		await env.DB.prepare(
			"INSERT INTO email_masks (id, label, active, created_at) VALUES (?, ?, 1, ?)",
		).bind(maskId, body.label || null, Date.now()).run();

		return Response.json({
			id: maskId,
			email: `${maskId}@${env.DOMAIN}`,
			label: body.label || null,
		}, { status: 201 });
	}

	// PATCH /api/masks/:id - enable/disable
	const patchMatch = path.match(/^\/api\/masks\/([^/]+)$/);
	if (method === "PATCH" && patchMatch) {
		const body = (await request.json()) as { active?: boolean; label?: string };
		const id = patchMatch[1];
		const updates: string[] = [];
		const params: (string | number)[] = [];

		if (body.active !== undefined) { updates.push("active = ?"); params.push(body.active ? 1 : 0); }
		if (body.label !== undefined) { updates.push("label = ?"); params.push(body.label); }

		if (updates.length === 0) {
			return Response.json({ error: "nothing to update" }, { status: 400 });
		}

		params.push(id);
		await env.DB.prepare(`UPDATE email_masks SET ${updates.join(", ")} WHERE id = ?`)
			.bind(...params).run();

		return Response.json({ updated: id });
	}

	// DELETE /api/masks/:id
	const deleteMatch = path.match(/^\/api\/masks\/([^/]+)$/);
	if (method === "DELETE" && deleteMatch) {
		await env.DB.prepare("DELETE FROM email_masks WHERE id = ?")
			.bind(deleteMatch[1]).run();
		return Response.json({ deleted: deleteMatch[1] });
	}

	// GET /api/masks - list
	if (method === "GET") {
		const showAll = url.searchParams.get("all") === "true";
		const query = showAll
			? "SELECT * FROM email_masks ORDER BY created_at DESC"
			: "SELECT * FROM email_masks WHERE active = 1 ORDER BY created_at DESC";
		const { results } = await env.DB.prepare(query).all();

		const masks = results.map((m: any) => ({
			...m,
			email: `${m.id}@${env.DOMAIN}`,
		}));

		return Response.json({ masks });
	}

	return Response.json({ error: "method not allowed" }, { status: 405 });
}
