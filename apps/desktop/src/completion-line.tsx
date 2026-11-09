import React from "react";
import type { RunUsage } from "../shared/run-events";
import { completedRunDetailsLabel } from "./activity-model";
import { usageLabel } from "./run-view";

/** Elapsed time and provider usage in one DOM line; nothing when neither is known. */
export function CompletionLine({ metadata, usage }: { metadata: string; usage?: RunUsage }) {
  const details = completedRunDetailsLabel(metadata, usage === undefined ? null : usageLabel(usage));
  if (details === "") return null;
  return <p
    className="run-completion-metadata"
    title={usage === undefined
      ? undefined
      : usage.costUsd === undefined
        ? "As the provider reported it."
        : "As the provider reported it. The price is its estimate at API list prices; on a subscription it is not what you pay."}
  >{details}</p>;
}
