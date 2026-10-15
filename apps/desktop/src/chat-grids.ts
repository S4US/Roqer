import { placeChat } from "./chat-tabs";

/** Session-only layouts; histories and running tasks remain workspace-owned. */
export type ChatGrid = { id: number; size: 2 | 4 | 6; slots: readonly (string | null)[] };

export function createChatGrid(id: number): ChatGrid {
  return { id, size: 4, slots: [null, null, null, null, null, null] };
}

export function nextChatGridId(grids: readonly ChatGrid[]): number {
  const used = new Set(grids.map((grid) => grid.id));
  let id = 1;
  while (used.has(id)) id++;
  return id;
}

export function placeGridChat(grids: readonly ChatGrid[], gridId: number, cell: number, chatId: string | null): readonly ChatGrid[] {
  return grids.map((grid) => grid.id === gridId ? { ...grid, slots: placeChat(grid.slots, cell, chatId) } : grid);
}

export function closeChatGrid(grids: readonly ChatGrid[], gridId: number): readonly ChatGrid[] {
  const next = grids.filter((grid) => grid.id !== gridId);
  return next.length > 0 ? next : [createChatGrid(gridId)];
}
