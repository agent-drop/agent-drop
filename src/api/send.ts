import { sendEmail } from "../lib/ses";
import { generateId } from "../lib/id";
import type { Env } from "../types";

export async function handleSend(
	request: Request,
	env: Env,
	inbox: string,
): Promise<Response> {
	const body = (await request.json()) as {
		to: string;
		subject: string;
		text: string;
		html?: string;
	};

	if (!body.to || !body.subject || !body.text) {
		return Response.json(
			{ error: "to, subject, and text are required" },
			{ status: 400 },
		);
	}

	const from = `${inbox}@${env.DOMAIN}`;

	const result = await sendEmail(
		env,
		from,
		body.to,
		body.subject,
		body.text,
		body.html,
	);

	// Log outbound
	const id = generateId();
	await env.DB.prepare(
		`INSERT INTO outbound (id, inbox, to_addr, subject, body_text, ses_message_id, status, created_at)
		VALUES (?, ?, ?, ?, ?, ?, 'sent', ?)`,
	)
		.bind(id, inbox, body.to, body.subject, body.text, result.messageId, Date.now())
		.run();

	return Response.json({ sent: true, messageId: result.messageId });
}
