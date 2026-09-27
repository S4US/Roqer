import type { ReactNode } from "react";

/**
 * The pieces Settings is built from.
 *
 * A group is one soft panel of rows under a quiet heading, with an optional
 * action beside the heading and a footnote below it. Every row has the same
 * shape: a name, one line of detail, and its controls on the right. Anything
 * longer than a line belongs in the group's footnote, not in a row, so the
 * rows stay scannable.
 */

export function SettingsGroup({ title, action, footnote, children }: {
  title?: string;
  /** A control for the group as a whole, e.g. "Add endpoint". */
  action?: ReactNode;
  footnote?: ReactNode;
  children: ReactNode;
}) {
  return <section className="settings-group">
    {(title !== undefined || action !== undefined) && <div className="settings-group-head">
      {title !== undefined && <h2>{title}</h2>}
      {action}
    </div>}
    <div className="settings-list">{children}</div>
    {footnote !== undefined && <p className="settings-footnote">{footnote}</p>}
  </section>;
}

export function SettingsRow({ title, detail, children }: {
  title: ReactNode;
  detail?: ReactNode;
  /** The row's controls, on the right. */
  children?: ReactNode;
}) {
  return <div className="settings-row">
    <div className="settings-row-text">
      <strong>{title}</strong>
      {detail !== undefined && detail !== null && detail !== "" && <span>{detail}</span>}
    </div>
    {children !== undefined && <div className="settings-actions">{children}</div>}
  </div>;
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
