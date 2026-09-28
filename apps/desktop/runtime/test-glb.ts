/**
 * Binary glTF files for the tests that cover the 3D preview: the smallest
 * well-formed GLB, around whatever JSON and binary chunk a test gives it.
 * Nothing outside a test imports it.
 */
export function glbBytes(json: unknown = { asset: { version: "2.0" } }, binary?: Uint8Array): Buffer {
  const chunks = [chunk(Buffer.from(JSON.stringify(json), "utf8"), 0x4e4f534a, 0x20)];
  if (binary !== undefined) chunks.push(chunk(Buffer.from(binary), 0x004e4942, 0));
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + body.length, 8);
  return Buffer.concat([header, body]);
}

/** A chunk's length and type, then its data padded to four bytes as the format requires. */
function chunk(data: Buffer, type: number, fill: number): Buffer {
  const padded = Buffer.concat([data, Buffer.alloc((4 - (data.length % 4)) % 4, fill)]);
  const head = Buffer.alloc(8);
  head.writeUInt32LE(padded.length, 0);
  head.writeUInt32LE(type, 4);
  return Buffer.concat([head, padded]);
}
