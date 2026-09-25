/**
 * The Discord application id the desktop presence connects as, from the Discord
 * developer portal.
 *
 * Baked at build time rather than read from the environment at runtime, because
 * a packaged app has no environment to read: left to `process.env` this would
 * be empty in every build that ships, and the setting would be a switch wired
 * to nothing. Public by design — every client that connects sends it — so it
 * belongs in the repository rather than in a secret.
 *
 * Empty disables the feature outright. Fill this in, or pass
 * `ROQER_DISCORD_CLIENT_ID` to the build, once the application is registered.
 */
export const PRODUCTION_DISCORD_CLIENT_ID = "1546618167894343681";

export function resolveDiscordClientId(value = process.env.ROQER_DISCORD_CLIENT_ID) {
  const candidate = (value ?? PRODUCTION_DISCORD_CLIENT_ID).trim();
  if (candidate === "") return "";
  // A Discord snowflake, and nothing else: anything unexpected here would be
  // sent to a local socket as an application id and fail in a way that looks
  // like Discord being closed rather than like a mistyped build variable.
  if (!/^[0-9]{15,25}$/.test(candidate)) {
    throw new Error(`ROQER_DISCORD_CLIENT_ID must be a Discord application id: ${candidate}`);
  }
  return candidate;
}
