/**
 * Dictation: speaking a message instead of typing it.
 *
 * The audio never leaves the computer. It is recorded in the window, sent to
 * the main process as 16 kHz mono samples, and turned into text there by a
 * speech model that is downloaded once, on the person's say-so.
 */

/** The sample rate the speech model takes: mono, 32-bit float. */
export const DICTATION_SAMPLE_RATE = 16_000;

/** The longest recording one dictation holds. Recording stops by itself there. */
export const MAX_DICTATION_SECONDS = 180;

/** The most samples one transcription request may carry. */
export const MAX_DICTATION_SAMPLES = DICTATION_SAMPLE_RATE * MAX_DICTATION_SECONDS;

/** One speech model file: where it comes from and how its download is checked. */
export type DictationModelSpec = Readonly<{
  /** What the person is told they are downloading. */
  name: string;
  publisher: string;
  license: string;
  /** Where it is published, shown before the download. */
  source: string;
  file: string;
  url: string;
  bytes: number;
  sha256: string;
}>;

/**
 * NVIDIA's Parakeet TDT 0.6B v3, quantized for transcribe.cpp. It transcribes
 * 25 European languages, French and English among them, finds the language by
 * itself, and writes punctuation and capitals. The four-bit file is the
 * smallest published, and transcribed a French test clip word for word, the
 * same as the eight-bit one.
 */
export const DICTATION_MODEL: DictationModelSpec = {
  name: "Parakeet TDT 0.6B v3",
  publisher: "NVIDIA",
  license: "CC BY 4.0",
  source: "huggingface.co/handy-computer/parakeet-tdt-0.6b-v3-gguf",
  file: "parakeet-tdt-0.6b-v3-Q4_K_M.gguf",
  // Pinned to the commit the checksum below was taken from, so a later upload
  // to the repository cannot make every download fail its check.
  url: "https://huggingface.co/handy-computer/parakeet-tdt-0.6b-v3-gguf/resolve/d8d8c32cb2017c57e5307767343e97870f8a7f53/parakeet-tdt-0.6b-v3-Q4_K_M.gguf",
  bytes: 485_425_504,
  sha256: "b68557be1e3c40207fd7c4bd9d63f1d3316b963f15325bfb0cc16a8bb0ffd181",
};

/** Where the speech model stands on this computer. */
export type DictationModelState =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "downloading"; receivedBytes: number; totalBytes: number }>
  | Readonly<{ kind: "ready" }>
  /** The last download did not finish or did not check out; it can be started again. */
  | Readonly<{ kind: "failed"; message: string }>;

export function isDictationModelState(value: unknown): value is DictationModelState {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.kind === "missing" || record.kind === "ready") return true;
  if (record.kind === "failed") return typeof record.message === "string";
  return record.kind === "downloading" &&
    typeof record.receivedBytes === "number" && Number.isFinite(record.receivedBytes) && record.receivedBytes >= 0 &&
    typeof record.totalBytes === "number" && Number.isFinite(record.totalBytes) && record.totalBytes > 0;
}

/** What a transcription came to: the words, or why there are none. */
export type DictationResult =
  | Readonly<{ ok: true; text: string }>
  | Readonly<{ ok: false; message: string }>;

export function isDictationResult(value: unknown): value is DictationResult {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.ok === true ? typeof record.text === "string" : record.ok === false && typeof record.message === "string";
}

/**
 * Dictated words added to what is already written: after it, with one space
 * between unless the text ends a line or is empty. Nothing is added for a
 * transcription with no words in it.
 */
export function withDictation(draft: string, spoken: string): string {
  const words = spoken.trim();
  if (words === "") return draft;
  if (draft === "" || /\s$/.test(draft)) return `${draft}${words}`;
  return `${draft} ${words}`;
}
