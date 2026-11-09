import { Component, type ErrorInfo, type ReactNode } from "react";

/** The longest error text shown; the full text goes to the app log through the console. */
const MAX_SHOWN_ERROR_CHARACTERS = 2_000;

/**
 * The last line of defence for the window. Without it, an error React cannot
 * render past unmounts the whole interface and leaves an empty, dark window
 * with no explanation. This says what happened instead, logs it (the main
 * process writes page errors to app.log), and offers a reload.
 */
export class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const stack = error instanceof Error && error.stack ? error.stack : String(error);
    console.error(`Roqer's window hit an error it could not draw past: ${stack}\nIn:${info.componentStack ?? ""}`);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    const text = `${error.name}: ${error.message}`;
    return <div className="app-crash" role="alert">
      <h1>Roqer's window ran into a problem</h1>
      <p>Your saved chats are kept. Reload the window to carry on. What went wrong is recorded in app.log in Roqer's data folder.</p>
      <pre>{text.length <= MAX_SHOWN_ERROR_CHARACTERS ? text : `${text.slice(0, MAX_SHOWN_ERROR_CHARACTERS)}…`}</pre>
      <button type="button" className="primary-action" onClick={() => window.location.reload()}>Reload the window</button>
    </div>;
  }
}
