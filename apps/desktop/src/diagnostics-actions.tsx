import { ClipboardCopy, FolderOpen } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { copyDiagnostics, showBridgeLog } from "./platform";

/**
 * What a report of Studio not connecting needs, one press each: a copy of the
 * connection's facts and the end of the bridge's log, or the log file itself.
 * Before these, the log sat in a data folder nothing in the app named.
 *
 * Shown in the connection popover and in Settings, each drawing the buttons
 * its own way.
 */
export function DiagnosticsActions({ endpoint, buttonClassName, icons = false }: {
  /** The bridge the window is talking to, whose status goes in the report. */
  endpoint: string;
  buttonClassName: string;
  icons?: boolean;
}) {
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const resetTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(resetTimer.current), []);

  const copyReport = async () => {
    const copied = await copyDiagnostics(endpoint).catch(() => false);
    setCopy(copied ? "copied" : "failed");
    window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setCopy("idle"), 2_500);
  };

  return <>
    <button type="button" className={buttonClassName} onClick={() => void copyReport()} title="Roqer's version, the bridge's state and the end of its log, with your user folder left out">
      {icons && <ClipboardCopy size={15} />}
      <span role="status">{copy === "copied" ? "Copied" : copy === "failed" ? "Could not copy" : "Copy diagnostics"}</span>
    </button>
    <button type="button" className={buttonClassName} onClick={() => void showBridgeLog().catch(() => false)}>
      {icons && <FolderOpen size={15} />} Show bridge log
    </button>
  </>;
}
