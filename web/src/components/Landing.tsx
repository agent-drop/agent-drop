export function Landing() {
	return (
		<div className="min-h-dvh flex flex-col items-center justify-center px-4">
			<div className="text-center">
				<h1
					className="text-glow font-extrabold tracking-tighter leading-none select-none"
					style={{
						fontSize: "clamp(6rem, 22vw, 18rem)",
						color: "var(--color-neon-cyan)",
					}}
				>
					{__BRAND__}
				</h1>

				<p
					className="text-sm tracking-[0.3em] uppercase mt-3 italic"
					style={{ color: "var(--color-fg-dark)" }}
				>
					...agent drop
				</p>
			</div>
		</div>
	);
}
