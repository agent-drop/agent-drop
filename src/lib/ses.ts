import { AwsClient } from "aws4fetch";
import type { Env } from "../types";

function createClient(env: Env) {
	return new AwsClient({
		accessKeyId: env.AWS_ACCESS_KEY_ID,
		secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
		region: env.SES_REGION,
		service: "ses",
	});
}

export async function sendEmail(
	env: Env,
	from: string,
	to: string,
	subject: string,
	text: string,
	html?: string,
): Promise<{ messageId: string }> {
	const ses = createClient(env);

	const body: Record<string, unknown> = {
		FromEmailAddress: from,
		Destination: { ToAddresses: [to] },
		Content: {
			Simple: {
				Subject: { Data: subject, Charset: "UTF-8" },
				Body: {
					Text: { Data: text, Charset: "UTF-8" },
				},
			},
		},
	};

	if (html) {
		(body.Content as any).Simple.Body.Html = {
			Data: html,
			Charset: "UTF-8",
		};
	}

	const endpoint = `https://email.${env.SES_REGION}.amazonaws.com/v2/email/outbound-emails`;
	const response = await ses.fetch(endpoint, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});

	if (!response.ok) {
		const err = await response.text();
		throw new Error(`SES ${response.status}: ${err}`);
	}

	const result = (await response.json()) as { MessageId: string };
	return { messageId: result.MessageId };
}
