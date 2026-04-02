import { useState, useEffect, useCallback } from "react";
import { useParams, Link } from "react-router-dom";
import { DropZone } from "./DropZone";
import { GoogleSignIn } from "./GoogleSignIn";

interface Drop {
	id: string;
	inbox: string;
	topic: string | null;
	channel: string;
	from_addr: string | null;
	subject: string | null;
	body_text: string | null;
	has_attachments: number;
	attachment_count: number;
	created_at: number;
	read_at: number | null;
}

export function InboxView() {
	const { name } = useParams<{ name: string }>();
	const [drops, setDrops] = useState<Drop[]>([]);
	const [loading, setLoading] = useState(false);

	const dropToken = (() => {
		const params = new URLSearchParams(window.location.search);
		const fromQuery = params.get("auth");
		if (fromQuery) return fromQuery;
		const hash = window.location.hash;
		if (hash.startsWith("#auth=")) return hash.slice(6);
		return null;
	})();

	const apiKey = localStorage.getItem("agent-drop-key") || "";

	// Persist Google auth across page loads
	const [googleToken, setGoogleToken] = useState<string | null>(() =>
		localStorage.getItem("agent-drop-google-token"),
	);
	const [googleUser, setGoogleUser] = useState<string | null>(() =>
		localStorage.getItem("agent-drop-google-user"),
	);
	const hasAccess = !!dropToken || !!apiKey || !!googleToken;

	function handleGoogleAuth(token: string, email: string) {
		localStorage.setItem("agent-drop-google-token", token);
		localStorage.setItem("agent-drop-google-user", email);
		setGoogleToken(token);
		setGoogleUser(email);
	}

	function handleSignOut() {
		localStorage.removeItem("agent-drop-google-token");
		localStorage.removeItem("agent-drop-google-user");
		setGoogleToken(null);
		setGoogleUser(null);
	}

	const fetchDrops = useCallback(async () => {
		if (!apiKey) return;
		setLoading(true);
		try {
			const res = await fetch(`/api/inbox/${name}`, {
				headers: { Authorization: `Bearer ${apiKey}` },
			});
			if (res.ok) {
				const data = await res.json();
				setDrops(data.drops || []);
			}
		} catch {}
		setLoading(false);
	}, [name, apiKey]);

	useEffect(() => {
		if (apiKey) fetchDrops();
	}, [apiKey, fetchDrops]);

	function formatTime(ts: number) {
		const diff = Date.now() - ts;
		if (diff < 60000) return "just now";
		if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
		if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
		return new Date(ts).toISOString().slice(0, 10);
	}

	// No access - centered landing with Google sign-in
	if (!hasAccess) {
		return (
			<div className="min-h-dvh flex flex-col items-center justify-center px-4">
				<div className="text-center mb-10">
					<Link to="/" className="text-xs" style={{ color: "var(--color-neon-purple)" }}>
						Agent Drop
					</Link>
					<h1
						className="text-5xl font-bold text-glow-subtle mt-2"
						style={{ color: "var(--color-neon-cyan)" }}
					>
						/{name}
					</h1>
					<p className="mt-4" style={{ color: "var(--color-fg)" }}>
						drop files and messages here
					</p>
					<p className="text-sm mt-2" style={{ color: "var(--color-fg-dim)" }}>
						or email{" "}
						<span style={{ color: "var(--color-cga-cyan)" }}>{name}@example.com</span>
					</p>
				</div>

				<div className="mb-6">
					<GoogleSignIn onAuth={(token, email) => handleGoogleAuth(token, email)} />
				</div>

				<p className="text-xs" style={{ color: "var(--color-fg-dark)" }}>
					sign in to drop files
				</p>
			</div>
		);
	}

	// Has access - drop zone view
	return (
		<div className="min-h-dvh p-4 max-w-2xl mx-auto">
			<div className="flex items-baseline justify-between mb-8 pt-4">
				<div>
					<Link to="/" className="text-xs" style={{ color: "var(--color-neon-purple)" }}>
						Agent Drop
					</Link>
					<h1
						className="text-2xl font-bold text-glow-subtle mt-1"
						style={{ color: "var(--color-neon-cyan)" }}
					>
						/{name}
					</h1>
					<p className="text-xs mt-1 flex items-center gap-2">
						<span style={{
							color: googleUser
								? "var(--color-neon-teal)"
								: dropToken
									? "var(--color-neon-yellow)"
									: "var(--color-fg-dim)",
						}}>
							{googleUser || (dropToken ? "temporary access" : `${name}@example.com`)}
						</span>
						{googleUser && (
							<button
								onClick={handleSignOut}
								className="cursor-pointer"
								style={{ color: "var(--color-fg-dark)", fontSize: "0.65rem" }}
							>
								sign out
							</button>
						)}
					</p>
				</div>
				{apiKey && (
					<div className="text-xs" style={{ color: "var(--color-neon-yellow)" }}>
						{drops.length} drop{drops.length !== 1 ? "s" : ""}
					</div>
				)}
			</div>

			<div className="mb-8">
				<DropZone inbox={name!} apiKey={apiKey} dropToken={dropToken} googleToken={googleToken} onDropped={fetchDrops} />
			</div>

			{/* Agent instructions */}
			<CurlInstructions inbox={name!} dropToken={dropToken} />

			{apiKey && (
				<div className="space-y-1">
					{loading ? (
						<p className="text-sm cursor-blink" style={{ color: "var(--color-neon-cyan)" }}>loading</p>
					) : drops.length === 0 ? (
						<div className="text-sm py-8 text-center" style={{ color: "var(--color-fg-dim)" }}>
							<p>no drops yet</p>
						</div>
					) : (
						drops.map((drop) => (
							<div key={drop.id} className="drop-card p-3">
								<div className="flex items-start justify-between gap-4">
									<div className="min-w-0 flex-1">
										<div className="flex items-center gap-2 text-xs">
											<span style={{ color: "var(--color-neon-purple)" }}>
												{drop.channel === "email" ? "mail" : drop.channel}
											</span>
											{drop.topic && (
												<span
													className="px-1.5 py-0.5 text-[10px]"
													style={{ color: "var(--color-neon-teal)", background: "rgba(115, 218, 202, 0.12)" }}
												>
													{drop.topic}
												</span>
											)}
											{!drop.read_at && (
												<span className="text-[10px] font-bold" style={{ color: "var(--color-cga-yellow)" }}>
													NEW
												</span>
											)}
										</div>
										<p className="text-sm mt-1 truncate" style={{ color: "var(--color-fg)" }}>
											{drop.subject || drop.body_text?.slice(0, 80) || "(empty)"}
										</p>
										{drop.from_addr && (
											<p className="text-xs mt-0.5 truncate" style={{ color: "var(--color-neon-orange)" }}>
												from {drop.from_addr}
											</p>
										)}
									</div>
									<div className="text-right shrink-0">
										<p className="text-xs" style={{ color: "var(--color-fg-dim)" }}>
											{formatTime(drop.created_at)}
										</p>
										{drop.has_attachments > 0 && (
											<p className="text-[10px] mt-0.5" style={{ color: "var(--color-neon-yellow)" }}>
												{drop.attachment_count} file{drop.attachment_count !== 1 ? "s" : ""}
											</p>
										)}
									</div>
								</div>
							</div>
						))
					)}
				</div>
			)}
		</div>
	);
}

function CurlInstructions({ inbox, dropToken }: { inbox: string; dropToken: string | null }) {
	const [open, setOpen] = useState(false);

	const authParam = dropToken ? `?auth=${dropToken}` : "";
	const authNote = dropToken
		? "# auth token is embedded in the URL"
		: '# replace KEY with your API key (Bearer token)';
	const authHeader = dropToken ? "" : '\n  -H "Authorization: Bearer KEY" \\';

	const presignUrl = dropToken
		? `https://example.com/api/upload/presign/${inbox}${authParam}`
		: `https://example.com/api/upload/presign/${inbox}`;

	return (
		<div className="mb-6">
			<button
				onClick={() => setOpen(!open)}
				className="text-[10px] cursor-pointer flex items-center gap-1"
				style={{ color: "var(--color-fg-dark)", background: "none", border: "none", padding: 0 }}
			>
				<span style={{ color: "var(--color-neon-purple)" }}>{open ? "v" : ">"}</span>
				{" "}agent instructions (curl)
			</button>

			{open && (
				<div
					className="mt-2 p-3 text-[11px] leading-relaxed overflow-x-auto"
					style={{ background: "var(--color-bg-dark)", border: "1px solid var(--color-surface-border)" }}
				>
					<pre style={{ color: "var(--color-fg)" }}>{`${authNote}

${commentLine("step 1: get a signed upload url")}
curl -X POST "${presignUrl}" \\${authHeader}
  -H "Content-Type: application/json" \\
  -d '{"fileName":"FILE_NAME","contentType":"MIME_TYPE"}'

${commentLine("returns: {\"dropId\":\"...\",\"uploadUrl\":\"https://...\"}")}

${commentLine("step 2: upload the file")}
curl -X PUT "$UPLOAD_URL" \\
  -H "Content-Type: MIME_TYPE" \\
  --data-binary @FILE_NAME

${commentLine("step 3: confirm")}
curl -X POST "https://example.com/api/upload/confirm" \\
  -H "Content-Type: application/json" \\
  -d '{"dropId":"$DROP_ID"}'`}</pre>

					<div className="my-3" style={{ borderTop: "1px solid var(--color-surface-border)" }} />

					<p className="mb-2" style={{ color: "var(--color-fg-dim)" }}>
						<span style={{ color: "var(--color-neon-purple)" }}>#</span> or just email: <span style={{ color: "var(--color-neon-teal)" }}>{inbox}@example.com</span>
					</p>
				</div>
			)}
		</div>
	);
}

function commentLine(text: string): string {
	return `# ${text}`;
}
