import type { PlanUsageView } from "./plan-usage";

/**
 * A plan's usage, one meter per window: in the Settings account row, and in
 * the sidebar's account card when it is hovered or clicked.
 */
export function PlanUsageList({ usage, name }: { usage: PlanUsageView; name: string }) {
  return <>
    {usage.reached && <p className="plan-usage-reached">{name} reports this plan's usage limit is reached.</p>}
    {usage.rows.map((row) => <div key={row.label} className={`plan-usage-row ${row.tone}`}>
      <span className="plan-usage-label">{row.label}</span>
      <span className="plan-usage-track" role="meter" aria-label={row.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={row.percent}>
        <span style={{ width: `${row.percent}%` }} />
      </span>
      <span className="plan-usage-detail">{row.detail}</span>
    </div>)}
    <p className="plan-usage-note">{usage.footnote}</p>
  </>;
}
