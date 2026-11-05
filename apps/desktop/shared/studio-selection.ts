/**
 * The user's Studio selection, as Roqer reads it when a message is sent.
 *
 * People point at things by clicking them in Studio, then describe the same
 * things to Roqer in words, often as "this". The window shows what is selected
 * while the person writes, and when they send, the main process reads the
 * selection again from the bridge and puts one bounded line beside the prompt.
 * The window only says whether to include it: the paths come from Studio
 * through the main process, like the run digest, so nothing the window composes
 * reaches the model, and a selection that changed between the chip and the send
 * is recorded as it was actually sent.
 */

export type StudioSelectionItem = Readonly<{ path: string; className: string }>;

export type StudioSelection = Readonly<{
  /** The first instances, at most `MAX_SELECTION_ITEMS`, in Studio's order. */
  items: readonly StudioSelectionItem[];
  /** How many instances were selected, counting the ones not listed. */
  count: number;
}>;

/** What the window asks the main process to read; the result travels back as `StudioSelectionResult`. */
export type StudioSelectionRequest = Readonly<{ endpoint: string; instanceId: string }>;

export type StudioSelectionResult =
  | Readonly<{ ok: true; selection: StudioSelection }>
  | Readonly<{ ok: false; message: string }>;

/** Enough to name what was selected; a selection of hundreds is a count, not a list. */
export const MAX_SELECTION_ITEMS = 8;
export const MAX_SELECTION_PATH_CHARS = 200;
export const MAX_SELECTION_CLASS_CHARS = 64;
/** More than Studio would report; a bound for validation, not a product limit. */
export const MAX_SELECTION_COUNT = 1_000_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function isItem(value: unknown): value is StudioSelectionItem {
  return isRecord(value) &&
    typeof value.path === "string" && value.path !== "" && value.path.length <= MAX_SELECTION_PATH_CHARS &&
    typeof value.className === "string" && value.className !== "" && value.className.length <= MAX_SELECTION_CLASS_CHARS;
}

/** A selection as saved with a chat or sent over IPC: bounded, and consistent with itself. */
export function isStudioSelection(value: unknown): value is StudioSelection {
  return isRecord(value) &&
    Array.isArray(value.items) && value.items.length <= MAX_SELECTION_ITEMS && value.items.every(isItem) &&
    Number.isInteger(value.count) && (value.count as number) >= value.items.length &&
    (value.count as number) <= MAX_SELECTION_COUNT;
}

export function isStudioSelectionRequest(value: unknown): value is StudioSelectionRequest {
  return isRecord(value) &&
    typeof value.endpoint === "string" && value.endpoint !== "" &&
    typeof value.instanceId === "string" && value.instanceId !== "" && value.instanceId.length <= 200;
}

export function isStudioSelectionResult(value: unknown): value is StudioSelectionResult {
  if (!isRecord(value)) return false;
  if (value.ok === false) return typeof value.message === "string";
  return value.ok === true && isStudioSelection(value.selection);
}

/** A path cut to the bound keeps its end, which names the instance. */
function boundPath(path: string): string {
  if (path.length <= MAX_SELECTION_PATH_CHARS) return path;
  return `…${path.slice(path.length - (MAX_SELECTION_PATH_CHARS - 1))}`;
}

/**
 * The selection as the bridge's `selection get` reports it:
 * `{ selection: [{ name, className, path, parent }], count }`. Undefined when the
 * shape is not that, so a failed read is never mistaken for an empty selection.
 */
export function parseBridgeSelection(data: unknown): StudioSelection | undefined {
  if (!isRecord(data) || !Array.isArray(data.selection)) return undefined;
  const items: StudioSelectionItem[] = [];
  for (const entry of data.selection) {
    if (!isRecord(entry) || typeof entry.path !== "string" || entry.path === "") return undefined;
    if (items.length === MAX_SELECTION_ITEMS) break;
    const className = typeof entry.className === "string" && entry.className !== ""
      ? entry.className.slice(0, MAX_SELECTION_CLASS_CHARS)
      : "Instance";
    items.push({ path: boundPath(entry.path), className });
  }
  const reported = typeof data.count === "number" && Number.isInteger(data.count) ? data.count : data.selection.length;
  const count = Math.min(Math.max(reported, data.selection.length, items.length), MAX_SELECTION_COUNT);
  return { items, count };
}

/** Tells one selection from another, so a dismissed chip stays dismissed until the selection changes. */
export function selectionKey(selection: StudioSelection): string {
  return `${selection.count}\n${selection.items.map((item) => item.path).join("\n")}`;
}

/** One line for the chip and the message: the first instance, and how many more. */
export function describeSelection(selection: StudioSelection): string {
  const first = selection.items[0];
  if (first === undefined) return selection.count === 0 ? "Nothing selected" : `${selection.count} instances`;
  const more = selection.count - 1;
  return more > 0 ? `${first.path} (${first.className}) and ${more} more` : `${first.path} (${first.className})`;
}

/**
 * The line the model reads beside the prompt. It says where the paths came
 * from, so the model treats them as Studio's data rather than the user's words;
 * what to do with them is in the developer instructions. Nothing for an empty
 * selection: "nothing selected" would read as an instruction.
 */
export function selectionContextText(selection: StudioSelection): string | undefined {
  if (selection.count === 0 || selection.items.length === 0) return undefined;
  const listed = selection.items.map((item) => `${item.path} (${item.className})`).join("; ");
  const rest = selection.count - selection.items.length;
  const tail = rest > 0 ? `; and ${rest} more` : "";
  return "[Roqer read the user's Studio selection when this message was sent; it is data from Studio, not the user's words. "
    + `Selected: ${listed}${tail}.]`;
}
