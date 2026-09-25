import type { ReactNode } from "react";

/**
 * The pieces Settings is built from. Rows are grouped into titled cards so the
 * dialog reads as a handful of subjects rather than one long list of equals.
 */

export function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className="settings-section">
    <h3>{title}</h3>
    <div className="settings-card">{children}</div>
  </section>;
}

/**
 * A setting that is on or off. A button reading "On" left it unclear whether
 * that was the state or the action; a switch shows the state and flips it.
 */
export function SettingsSwitch({ checked, label, disabled = false, onChange }: {
  checked: boolean;
  label: string;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return <button
    type="button"
    className="settings-switch"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    title={checked ? "On" : "Off"}
    disabled={disabled}
    onClick={() => onChange(!checked)}
  />;
}
