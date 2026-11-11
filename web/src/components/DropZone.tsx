import { useRef, useState } from "react";

interface DropZoneProps {
	inbox: string;
	apiKey?: string;
	dropToken?: string | null;
	googleToken?: string | null;
	onDropped?: () => void;
}

interface DroppedFile {
	filename: string;
	dropId: string;
	ts: number;
	size: number;
}

const DIRECT_LIMIT = 95 * 1024 * 1024;
// Only for a server too old to send `partSize`, which was a fixed 50 MiB then.
const FALLBACK_PART_SIZE = 50 * 1024 * 1024;
const MAX_CONCURRENT = 4;

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}

export function DropZone({ inbox, apiKey, dropToken, googleToken, onDropped }: DropZoneProps) {
	const [dragOver, setDragOver] = useState(false);
	const [uploading, setUploading] = useState(false);
	const [progress, setProgress] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [dropped, setDropped] = useState<DroppedFile[]>([]);
	const [copied, setCopied] = useState(false);
	const fileRef = useRef<HTMLInputElement>(null);

	function authHeaders(): Record<string, string> {
		if (googleToken) return { Authorization: `Google ${googleToken}` };
		if (apiKey) return { Authorization: `Bearer ${apiKey}` };
		return {};
	}

	function authQuery(): string {
		if (dropToken) return `?auth=${dropToken}`;
		return "";
	}

	async function apiFetch(path: string, body: unknown) {
		const res = await fetch(path + authQuery(), {
			method: "POST",
			headers: { "Content-Type": "application/json", ...authHeaders() },
			body: JSON.stringify(body),
		});
		if (!res.ok) throw new Error(await res.text());
		return res.json();
	}

	async function uploadDirect(file: File): Promise<DroppedFile> {
		setProgress(`signing ${file.name}...`);

		const data = (await apiFetch(`/api/upload/presign/${inbox}`, {
			fileName: file.name,
			contentType: file.type || "application/octet-stream",
			fileSize: file.size,
		})) as { dropId: string; uploadUrl: string };

		setProgress(`uploading ${file.name} (${formatSize(file.size)})...`);

		const putRes = await fetch(data.uploadUrl, {
			method: "PUT",
			headers: { "Content-Type": file.type || "application/octet-stream" },
			body: file,
		});

		if (!putRes.ok) throw new Error(`upload failed: ${putRes.status}`);

		await apiFetch("/api/upload/confirm", { dropId: data.dropId });

		return { filename: file.name, dropId: data.dropId, ts: Date.now(), size: file.size };
	}

	async function uploadMultipart(file: File): Promise<DroppedFile> {
		setProgress(`initiating multipart for ${file.name}...`);

		const data = (await apiFetch(`/api/upload/multipart/${inbox}`, {
			fileName: file.name,
			contentType: file.type || "application/octet-stream",
			fileSize: file.size,
		})) as {
			dropId: string;
			uploadId: string;
			objectKey: string;
			partSize?: number;
			parts: { partNumber: number; url: string }[];
		};

		// The server picks the part size (it grows with the file to keep the part
		// count bounded), and R2 needs every part but the last to be exactly that
		// size -- so slice by its number, never by a constant of our own.
		const partSize = data.partSize ?? FALLBACK_PART_SIZE;

		// Upload chunks in parallel
		const totalParts = data.parts.length;
		let completedParts = 0;

		async function uploadPart(part: { partNumber: number; url: string }) {
			const start = (part.partNumber - 1) * partSize;
			const end = Math.min(start + partSize, file.size);
			const chunk = file.slice(start, end);

			const res = await fetch(part.url, { method: "PUT", body: chunk });
			if (!res.ok) throw new Error(`part ${part.partNumber} failed`);

			completedParts++;
			setProgress(`uploading ${file.name}: ${completedParts}/${totalParts} parts`);
		}

		// Parallel upload pool
		const queue = [...data.parts];
		const workers = Array.from({ length: Math.min(MAX_CONCURRENT, queue.length) }, async () => {
			while (queue.length > 0) {
				const part = queue.shift()!;
				await uploadPart(part);
			}
		});

		await Promise.all(workers);

		setProgress(`finalizing ${file.name}...`);
		// No objectKey: the worker derives it from the drop row. Sending one used
		// to let any caller complete an upload against an arbitrary R2 key.
		await apiFetch("/api/upload/complete", {
			dropId: data.dropId,
			uploadId: data.uploadId,
		});

		return { filename: file.name, dropId: data.dropId, ts: Date.now(), size: file.size };
	}

	// Not memoized: uploadDirect/uploadMultipart are redefined every render, so a
	// useCallback here would either change identity anyway or capture a stale
	// closure. Nothing consuming handleDrop is memoized, so there is nothing to win.
	async function handleDrop(files: FileList) {
		setUploading(true);
		setError(null);

		try {
			const results: DroppedFile[] = [];

			for (let i = 0; i < files.length; i++) {
				const file = files[i];
				const result =
					file.size > DIRECT_LIMIT ? await uploadMultipart(file) : await uploadDirect(file);
				results.push(result);
			}

			setDropped((prev) => [...results, ...prev]);
			setProgress("");
			onDropped?.();
		} catch (err: any) {
			setError(err.message || "upload failed");
			setProgress("");
		} finally {
			setUploading(false);
		}
	}

	function handleCopy() {
		const text = dropped.map((f) => `${f.filename}: ${f.dropId}`).join("\n");
		navigator.clipboard.writeText(text);
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	}

	return (
		<div className="space-y-3">
			{/* biome-ignore lint/a11y/useSemanticElements: a native <button> cannot
			    wrap the file input and drop target without breaking the drag styling;
			    role + tabIndex + key handler give it the same keyboard affordance. */}
			<div
				className={`drop-zone p-8 text-center cursor-pointer ${dragOver ? "drag-over" : ""}`}
				role="button"
				tabIndex={0}
				onDragOver={(e) => {
					e.preventDefault();
					setDragOver(true);
				}}
				onDragLeave={() => setDragOver(false)}
				onDrop={(e) => {
					e.preventDefault();
					setDragOver(false);
					if (e.dataTransfer.files.length) handleDrop(e.dataTransfer.files);
				}}
				onClick={() => fileRef.current?.click()}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						fileRef.current?.click();
					}
				}}
			>
				<input
					ref={fileRef}
					type="file"
					multiple
					className="hidden"
					onChange={(e) => {
						if (e.target.files?.length) handleDrop(e.target.files);
					}}
				/>

				{uploading ? (
					<div className="text-sm" style={{ color: "var(--color-neon-cyan)" }}>
						<span className="cursor-blink">{progress || "uploading"}</span>
					</div>
				) : (
					<div className="text-sm">
						<p style={{ color: "var(--color-neon-cyan)" }}>drop files here</p>
						<p className="text-xs mt-1" style={{ color: "var(--color-fg-dim)" }}>
							or click to browse
						</p>
					</div>
				)}
			</div>

			{error && (
				<p className="text-xs font-mono" style={{ color: "var(--color-neon-red)" }}>
					<span style={{ color: "var(--color-neon-purple)" }}>&gt;</span> error: {error}
				</p>
			)}

			{dropped.length > 0 && (
				<div
					style={{
						background: "var(--color-bg-dark)",
						border: "1px solid var(--color-surface-border)",
					}}
					className="p-3"
				>
					<div className="flex items-center justify-between mb-2">
						<span className="text-xs">
							<span style={{ color: "var(--color-neon-yellow)" }}>{dropped.length}</span>
							<span style={{ color: "var(--color-fg-dim)" }}> dropped</span>
						</span>
						<button
							type="button"
							onClick={handleCopy}
							className="text-xs px-2 py-1 cursor-pointer"
							style={{
								border: "1px solid var(--color-surface-border)",
								color: copied ? "var(--color-neon-green)" : "var(--color-fg-dim)",
								background: "transparent",
							}}
						>
							{copied ? "copied!" : "copy"}
						</button>
					</div>
					<div className="space-y-0.5 font-mono text-xs">
						{dropped.map((f) => (
							<div key={f.dropId} className="flex gap-2">
								<span style={{ color: "var(--color-neon-purple)" }}>&gt;</span>
								<span style={{ color: "var(--color-fg)" }}>{f.filename}</span>
								<span style={{ color: "var(--color-fg-dark)" }}>({formatSize(f.size)})</span>
								<span style={{ color: "var(--color-neon-teal)" }}>{f.dropId}</span>
							</div>
						))}
					</div>
				</div>
			)}
		</div>
	);
}
