/**
 * Giving a recorded WebM its length.
 *
 * Chromium's MediaRecorder writes a live WebM: a Segment of unknown size with
 * no Duration in its Info, because it does not know the length while it
 * records. A player then shows no length and cannot seek until it has read
 * the whole file. The recorder knows how long it ran, so the Duration is
 * written in afterwards, the way a muxer would have. Anything this does not
 * understand is left exactly as it was: a clip without a length still plays.
 */

const ID_EBML = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_SEEK_HEAD = 0x114d9b74;
const ID_INFO = 0x1549a966;
const ID_CLUSTER = 0x1f43b675;
const ID_TIMECODE_SCALE = 0x2ad7b1;
const ID_DURATION = 0x4489;
/** Nanoseconds per timecode tick when Info names none: one millisecond. */
const DEFAULT_TIMECODE_SCALE = 1_000_000;

type Element = Readonly<{ id: number; start: number; idLength: number; sizeLength: number; dataStart: number; size: number | undefined }>;

/** A variable-length integer's byte length, from its first byte's leading zeros; 0 when malformed. */
function vintLength(first: number): number {
  for (let length = 1; length <= 8; length += 1) if (first & (0x80 >> (length - 1))) return length;
  return 0;
}

/** An element id, marker bits kept, as the ids above are written. */
function readId(bytes: Uint8Array, offset: number): Readonly<{ value: number; length: number }> | undefined {
  if (offset >= bytes.length) return undefined;
  const length = vintLength(bytes[offset]);
  if (length === 0 || length > 4 || offset + length > bytes.length) return undefined;
  let value = 0;
  for (let index = 0; index < length; index += 1) value = value * 256 + bytes[offset + index];
  return { value, length };
}

/** A data size, marker removed; `undefined` for the all-ones "unknown" size a live stream writes. */
function readSize(bytes: Uint8Array, offset: number): Readonly<{ value: number | undefined; length: number }> | undefined {
  if (offset >= bytes.length) return undefined;
  const length = vintLength(bytes[offset]);
  if (length === 0 || offset + length > bytes.length) return undefined;
  let value = bytes[offset] & (0xff >> length);
  let allOnes = value === (0xff >> length);
  for (let index = 1; index < length; index += 1) {
    value = value * 256 + bytes[offset + index];
    allOnes &&= bytes[offset + index] === 0xff;
  }
  return { value: allOnes ? undefined : value, length };
}

function readElement(bytes: Uint8Array, offset: number): Element | undefined {
  const id = readId(bytes, offset);
  if (id === undefined) return undefined;
  const size = readSize(bytes, offset + id.length);
  if (size === undefined) return undefined;
  return { id: id.value, start: offset, idLength: id.length, sizeLength: size.length, dataStart: offset + id.length + size.length, size: size.value };
}

/** A size as a variable-length integer of `length` bytes, or undefined when it does not fit. */
function encodeSize(value: number, length: number): Uint8Array | undefined {
  if (length < 1 || length > 8 || value < 0 || value > 2 ** (7 * length) - 2) return undefined;
  const out = new Uint8Array(length);
  let rest = value;
  for (let index = length - 1; index >= 0; index -= 1) {
    out[index] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  out[0] |= 0x80 >> (length - 1);
  return out;
}

function readUint(bytes: Uint8Array, start: number, size: number): number {
  let value = 0;
  for (let index = 0; index < size; index += 1) value = value * 256 + bytes[start + index];
  return value;
}

/** The ticks a length in milliseconds is, at Info's timecode scale. */
function ticks(durationMs: number, timecodeScale: number): number {
  return durationMs * 1_000_000 / timecodeScale;
}

/**
 * The WebM with `durationMs` written into its Info, or the same bytes when it
 * already has a length, is not a WebM this understands, or has a seek table
 * whose positions an insertion would break.
 */
export function withWebmDuration(bytes: Uint8Array, durationMs: number): Uint8Array {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return bytes;
  const header = readElement(bytes, 0);
  if (header === undefined || header.id !== ID_EBML || header.size === undefined) return bytes;
  const segment = readElement(bytes, header.dataStart + header.size);
  if (segment === undefined || segment.id !== ID_SEGMENT) return bytes;
  const segmentEnd = segment.size === undefined ? bytes.length : Math.min(bytes.length, segment.dataStart + segment.size);

  let info: Element | undefined;
  for (let offset = segment.dataStart; offset < segmentEnd;) {
    const child = readElement(bytes, offset);
    if (child === undefined || child.size === undefined) return bytes;
    if (child.id === ID_SEEK_HEAD || child.id === ID_CLUSTER) return bytes;
    if (child.id === ID_INFO) { info = child; break; }
    offset = child.dataStart + child.size;
  }
  if (info === undefined || info.size === undefined) return bytes;
  const infoEnd = info.dataStart + info.size;
  if (infoEnd > bytes.length) return bytes;

  let timecodeScale = DEFAULT_TIMECODE_SCALE;
  let duration: Element | undefined;
  for (let offset = info.dataStart; offset < infoEnd;) {
    const child = readElement(bytes, offset);
    if (child === undefined || child.size === undefined || child.dataStart + child.size > infoEnd) return bytes;
    if (child.id === ID_TIMECODE_SCALE && child.size >= 1 && child.size <= 8) timecodeScale = readUint(bytes, child.dataStart, child.size) || DEFAULT_TIMECODE_SCALE;
    if (child.id === ID_DURATION) duration = child;
    offset = child.dataStart + child.size;
  }
  const value = ticks(durationMs, timecodeScale);

  if (duration !== undefined) {
    if (duration.size !== 4 && duration.size !== 8) return bytes;
    const out = new Uint8Array(bytes);
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    if (duration.size === 4) view.setFloat32(duration.dataStart, value, false);
    else view.setFloat64(duration.dataStart, value, false);
    return out;
  }

  // Appended to Info: the id, a one-byte size of eight, and the length as a double.
  const added = new Uint8Array(2 + 1 + 8);
  added[0] = 0x44; added[1] = 0x89; added[2] = 0x88;
  new DataView(added.buffer).setFloat64(3, value, false);
  const infoSize = encodeSize(info.size + added.length, info.sizeLength);
  if (infoSize === undefined) return bytes;
  let segmentSize: Uint8Array | undefined;
  if (segment.size !== undefined) {
    segmentSize = encodeSize(segment.size + added.length, segment.sizeLength);
    if (segmentSize === undefined) return bytes;
  }
  const out = new Uint8Array(bytes.length + added.length);
  out.set(bytes.subarray(0, info.start + info.idLength), 0);
  out.set(infoSize, info.start + info.idLength);
  out.set(bytes.subarray(info.dataStart, infoEnd), info.dataStart);
  out.set(added, infoEnd);
  out.set(bytes.subarray(infoEnd), infoEnd + added.length);
  if (segmentSize !== undefined) out.set(segmentSize, segment.start + segment.idLength);
  return out;
}

/** The length Info names, in milliseconds, for checking a patched file; undefined when it names none. */
export function webmDurationMs(bytes: Uint8Array): number | undefined {
  const header = readElement(bytes, 0);
  if (header === undefined || header.id !== ID_EBML || header.size === undefined) return undefined;
  const segment = readElement(bytes, header.dataStart + header.size);
  if (segment === undefined || segment.id !== ID_SEGMENT) return undefined;
  for (let offset = segment.dataStart; offset < bytes.length;) {
    const child = readElement(bytes, offset);
    if (child === undefined || child.size === undefined) return undefined;
    if (child.id === ID_CLUSTER) return undefined;
    if (child.id === ID_INFO) {
      let timecodeScale = DEFAULT_TIMECODE_SCALE;
      let duration: number | undefined;
      for (let inner = child.dataStart; inner < child.dataStart + child.size;) {
        const field = readElement(bytes, inner);
        if (field === undefined || field.size === undefined) return undefined;
        if (field.id === ID_TIMECODE_SCALE) timecodeScale = readUint(bytes, field.dataStart, field.size) || DEFAULT_TIMECODE_SCALE;
        if (field.id === ID_DURATION) {
          const view = new DataView(bytes.buffer, bytes.byteOffset + field.dataStart, field.size);
          duration = field.size === 4 ? view.getFloat32(0, false) : field.size === 8 ? view.getFloat64(0, false) : undefined;
        }
        inner = field.dataStart + field.size;
      }
      return duration === undefined ? undefined : duration * timecodeScale / 1_000_000;
    }
    offset = child.dataStart + child.size;
  }
  return undefined;
}
