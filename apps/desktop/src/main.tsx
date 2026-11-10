import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist/wght-italic.css";
import "@fontsource-variable/geist-mono";
import "@fontsource-variable/geist-mono/wght-italic.css";
import App from "./App";
import { AppErrorBoundary } from "./error-boundary";
import "./styles.css";

// On the document before the first paint, so the window never flashes the
// other theme; the app keeps it in step from then on. Dark unless this machine
// chose light, as in App.
try {
  document.documentElement.dataset.theme = window.localStorage.getItem("workbench-theme") === "light" ? "light" : "dark";
} catch {
  document.documentElement.dataset.theme = "dark";
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
);
