import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { QUICK_WINDOW } from "./quick-player";
import "./styles.css";

const quick = isTauri() && getCurrentWebviewWindow().label === QUICK_WINDOW;
const QuickPlayer = lazy(() => import("./components/QuickPlayer"));
if (quick) document.documentElement.classList.add("quick-window");

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    {quick ? <Suspense><QuickPlayer /></Suspense> : <App />}
  </StrictMode>,
);
