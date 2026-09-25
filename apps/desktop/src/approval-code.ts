import { lexCodeLine, type LexState, type SyntaxToken } from "./diff-view";

/**
 * The code an approval is really asking about.
 *
 * A tool that runs code is approved on that code, not on a one-line summary of
 * it: the person deciding sees every line that would run.
 */
export type ApprovalCode = {
  /** Accessible name of the code block. */
  label: string;
  subtitle: string;
  /** One entry per line, already highlighted; the text is never altered. */
  lines: SyntaxToken[][];
};

type CodeTool = {
  argument: string;
  language: string;
  label: string;
  subtitle: (args: Record<string, unknown>) => string;
};

const CODE_TOOLS: Readonly<Record<string, CodeTool>> = {
  run_blender_script: {
    argument: "script",
    language: "python",
    label: "Blender script",
    subtitle: () => "Runs this Python in Blender on your computer, with your permissions",
  },
  execute_luau: {
    argument: "code",
    language: "luau",
    label: "Luau code",
    subtitle: (args) => typeof args.target === "string" && args.target !== "" && args.target !== "edit"
      ? `Runs this Luau on the playtest's ${args.target} peer`
      : "Runs this Luau in Studio. It cannot be undone from Studio",
  },
  eval_server_runtime: {
    argument: "code",
    language: "luau",
    label: "Luau code",
    subtitle: () => "Runs this Luau on the running game's server",
  },
  eval_client_runtime: {
    argument: "code",
    language: "luau",
    label: "Luau code",
    subtitle: () => "Runs this Luau in a running game client",
  },
};

export function approvalCode(tool: string, args: Record<string, unknown>): ApprovalCode | undefined {
  const spec = Object.hasOwn(CODE_TOOLS, tool) ? CODE_TOOLS[tool] : undefined;
  const code = spec === undefined ? undefined : args[spec.argument];
  if (spec === undefined || typeof code !== "string") return undefined;

  let state: LexState = null;
  const lines = code.split(/\r?\n/).map((line) => {
    const lexed = lexCodeLine(line, spec.language, state);
    state = lexed.state;
    return lexed.tokens;
  });
  return { label: spec.label, subtitle: spec.subtitle(args), lines };
}
