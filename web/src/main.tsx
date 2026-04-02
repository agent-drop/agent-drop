import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Landing } from "./components/Landing";
import { InboxView } from "./components/InboxView";
import "./styles/globals.css";

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<BrowserRouter>
			<Routes>
				<Route path="/" element={<Landing />} />
				<Route path="/:name" element={<InboxView />} />
			</Routes>
		</BrowserRouter>
	</StrictMode>,
);
