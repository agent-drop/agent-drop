import { useState, useEffect, useCallback } from "react";

interface GoogleSignInProps {
	onAuth: (token: string, email: string, name: string) => void;
}

declare global {
	interface Window {
		google?: {
			accounts: {
				id: {
					initialize: (config: any) => void;
					renderButton: (el: HTMLElement, config: any) => void;
					prompt: (cb?: (notification: any) => void) => void;
				};
			};
		};
	}
}

export function GoogleSignIn({ onAuth }: GoogleSignInProps) {
	const [clientId, setClientId] = useState<string | null>(null);
	const [ready, setReady] = useState(false);

	useEffect(() => {
		fetch("/api/config")
			.then((r) => r.json())
			.then((data: any) => {
				if (data.google_client_id) setClientId(data.google_client_id);
			})
			.catch(() => {});
	}, []);

	const handleCredentialResponse = useCallback(
		(response: any) => {
			const jwt = response.credential;
			const payload = JSON.parse(atob(jwt.split(".")[1]));
			onAuth(jwt, payload.email, payload.name);
		},
		[onAuth],
	);

	useEffect(() => {
		if (!clientId) return;

		function loadAndInit() {
			if (window.google) {
				window.google.accounts.id.initialize({
					client_id: clientId,
					callback: handleCredentialResponse,
					auto_select: true,
				});
				setReady(true);
				return;
			}

			if (document.getElementById("google-gis")) return;
			const script = document.createElement("script");
			script.id = "google-gis";
			script.src = "https://accounts.google.com/gsi/client";
			script.async = true;
			script.onload = () => {
				window.google!.accounts.id.initialize({
					client_id: clientId!,
					callback: handleCredentialResponse,
					auto_select: true,
				});
				setReady(true);
			};
			document.head.appendChild(script);
		}

		loadAndInit();
	}, [clientId, handleCredentialResponse]);

	function handleClick() {
		if (ready && window.google) {
			window.google.accounts.id.prompt();
		}
	}

	if (!clientId) return null;

	return (
		<button
			onClick={handleClick}
			disabled={!ready}
			className="px-8 py-3 text-sm font-medium tracking-wider uppercase cursor-pointer disabled:opacity-30"
			style={{
				border: "1px solid var(--color-neon-cyan)",
				color: "var(--color-neon-cyan)",
				background: "transparent",
				textShadow: "0 0 8px rgba(125, 207, 255, 0.4)",
			}}
		>
			authenticate
		</button>
	);
}
