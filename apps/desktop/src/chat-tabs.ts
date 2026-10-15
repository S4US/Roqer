/** Open tabs are session UI state; chat history and runs are owned by the workspace. */
/** Moving an assigned chat swaps cells, keeping one mounted pane per chat. */
export function placeChat(slots: readonly (string | null)[], target: number, chatId: string | null): readonly (string | null)[] {
  if (target < 0 || target >= slots.length) return slots;
  const next = [...slots];
  const source = chatId === null ? -1 : slots.indexOf(chatId);
  if (source >= 0) next[source] = slots[target];
  next[target] = chatId;
  return next;
}

export function reconcileChatTabs(tabs: readonly string[], existing: ReadonlySet<string>, selected: string | null): readonly string[] {
  const next = tabs.filter((id) => existing.has(id));
  if (selected !== null && existing.has(selected) && !next.includes(selected)) next.push(selected);
  return next.length === tabs.length && next.every((id, index) => id === tabs[index]) ? tabs : next;
}

export function closeChatTab(tabs: readonly string[], closed: string, selected: string | null): { tabs: readonly string[]; selected: string | null } {
  const next = tabs.filter((id) => id !== closed);
  return { tabs: next, selected: selected === closed ? next[Math.min(Math.max(0, tabs.indexOf(closed)), next.length - 1)] ?? null : selected };
}
