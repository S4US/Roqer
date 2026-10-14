import type { ProviderId, ReasoningEffort } from "./provider";

/**
 * What a chat is for. A project is worked on by a few standing conversations
 * with different jobs: one writes the game's code, one makes its models, one
 * thinks through the design with the user. Each keeps its own model and
 * effort, so a quick scripting fix and a long design discussion are not run on
 * the same settings.
 */
export type ChatRole = "scripter" | "modeller" | "planner";

export const CHAT_ROLES: readonly ChatRole[] = ["scripter", "modeller", "planner"];

export function isChatRole(value: unknown): value is ChatRole {
  return value === "scripter" || value === "modeller" || value === "planner";
}

export const CHAT_ROLE_LABEL: Record<ChatRole, string> = {
  scripter: "Scripter",
  modeller: "Modeller",
  planner: "Planner",
};

export const CHAT_ROLE_BLURB: Record<ChatRole, string> = {
  scripter: "Writes and debugs the game's code in Studio.",
  modeller: "Builds 3D models in Blender, checks them from every angle, and sends them to Studio.",
  planner: "Thinks through the design with you and keeps the master plan.",
};

/** The model and effort a role runs on, chosen once for every chat with that role. */
export type RoleSetting = { provider: ProviderId; model: string | null; effort: ReasoningEffort };

/** Told to the agent in its system prompt, so it knows which job this chat is. */
export function chatRoleInstructions(role: ChatRole): string {
  const common = "Other chats in this project have the other roles; the master plan, project memory and project files are shared with them.";
  switch (role) {
    case "scripter":
      return [
        "<chat-role>",
        "You are this project's Scripter. Your job is the game's code: write, wire up, debug and test Luau in Studio.",
        "Follow the master plan for what to build. Models the Modeller made are in the project files (project_files list); place them with their asset ids or send them to Studio when asked.",
        common,
        "</chat-role>",
      ].join("\n");
    case "modeller":
      return [
        "<chat-role>",
        "You are this project's Modeller. Your job is 3D assets: build them with the blender tool in stages, and look at every result before moving on.",
        "Look closely: use the blender tool's views to see the model from the angles that matter (each side, below, a close-up of a detail with focus) whenever the default four views could hide a problem, and fix what you find.",
        "To look at a model you did not just build (one the user dropped into the project files, or another chat's), pass its path as inspect_file; that changes nothing, so it needs no approval.",
        "When a model is finished, save it with project_files save so the other chats can use it, and say so. Do not upload or insert it into Studio unless the user asks: the user checks it in the 3D view first and has a one-click send.",
        common,
        "</chat-role>",
      ].join("\n");
    case "planner":
      return [
        "<chat-role>",
        "You are this project's Planner: the user's design partner for the whole experience. Talk through mechanics, progression, scope, feel and priorities; give clear recommendations and say what you would cut.",
        "Keep the master plan current with the decisions you reach (master_plan), and save short lasting facts with project_memory. Read the project files the user shares for context.",
        "Do not edit the Studio place unless the user asks; you may read it to ground a recommendation.",
        common,
        "</chat-role>",
      ].join("\n");
  }
}
