/** GLB magic (`glTF`) and the JSON / BIN chunk types, as the little-endian uint32s the file stores. */
export const GLB_MAGIC = 0x46546c67;
export const CHUNK_JSON = 0x4e4f534a;
export const CHUNK_BIN = 0x004e4942;

function chunkHeader(length: number, type: number): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(length, 0);
  header.writeUInt32LE(type, 4);
  return header;
}

/** A glTF 2.0 binary built by hand: header, a space-padded first chunk (JSON unless `chunkType` says otherwise), then an optional BIN chunk. */
export function glbBytes(
  json: unknown,
  { chunkType = CHUNK_JSON, bin }: { chunkType?: number; bin?: Uint8Array } = {},
): Buffer {
  const text = Buffer.from(JSON.stringify(json));
  const jsonData = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
  const chunks = [chunkHeader(jsonData.length, chunkType), jsonData];
  if (bin) {
    const binData = Buffer.concat([Buffer.from(bin), Buffer.alloc((4 - (bin.length % 4)) % 4)]);
    chunks.push(chunkHeader(binData.length, CHUNK_BIN), binData);
  }
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(GLB_MAGIC, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + body.length, 8);
  return Buffer.concat([header, body]);
}
