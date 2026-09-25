/**
 * Add settings owned by Roqer to one provider turn.
 *
 * These are developer instructions rather than transcript text: the renderer
 * cannot impersonate them, and both provider adapters receive the same policy.
 */
export function runDeveloperInstructions(base: string, autoPlaytest: boolean): string {
  const playtestSetting = autoPlaytest
    ? "Automatic playtesting is enabled for this run. After a change that benefits from runtime verification, run the smallest useful playtest, inspect observable evidence, and stop it before replying."
    : "Automatic playtesting is disabled for this run. Do not start a playtest merely for automatic verification; start one only when the user explicitly asks for testing or the request cannot be completed truthfully without runtime evidence.";

  return `${base}\n\n<run-settings>\n${playtestSetting}\n</run-settings>`;
}
