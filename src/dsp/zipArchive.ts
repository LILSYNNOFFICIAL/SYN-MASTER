export interface ZipFileEntry {
  name: string;
  data: Blob | Uint8Array | ArrayBuffer | string;
}

const encoder = new TextEncoder();
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[n] = c >>> 0;
}

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function asBlob(data: ZipFileEntry['data']): Promise<Blob> {
  if (data instanceof Blob) return data;
  if (typeof data === 'string') return new Blob([encoder.encode(data)]);
  if (data instanceof ArrayBuffer) return new Blob([data]);
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return new Blob([copy.buffer]);
}

async function crc32Blob(blob: Blob): Promise<number> {
  let crc = 0xffffffff;
  const reader = blob.stream().getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (let i = 0; i < value.length; i++) {
        crc = CRC_TABLE[(crc ^ value[i]) & 0xff] ^ (crc >>> 8);
      }
    }
  } finally {
    reader.releaseLock();
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function write16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true);
}

function write32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true);
}

/** Creates a standards-compliant ZIP32 archive using STORE (no compression). */
export async function createZipBlob(entries: ZipFileEntry[]): Promise<Blob> {
  if (entries.length === 0) throw new Error('Cannot create an empty ZIP archive.');
  if (entries.length > 0xffff) throw new Error('ZIP archive contains too many files.');

  const parts: BlobPart[] = [];
  const centralParts: ArrayBuffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name.replace(/\\/g, '/'));
    if (name.length === 0 || name.length > 0xffff) throw new Error('ZIP entry has an invalid filename.');
    const data = await asBlob(entry.data);
    if (data.size > 0xffffffff || offset > 0xffffffff) throw new Error('ZIP32 size limit exceeded.');
    const checksum = await crc32Blob(data);
    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);
    write32(localView, 0, 0x04034b50);
    write16(localView, 4, 20);
    write16(localView, 6, 0x0800);
    write16(localView, 8, 0);
    write16(localView, 10, 0);
    write16(localView, 12, 0x0021);
    write32(localView, 14, checksum);
    write32(localView, 18, data.size);
    write32(localView, 22, data.size);
    write16(localView, 26, name.length);
    write16(localView, 28, 0);
    local.set(name, 30);
    parts.push(toArrayBuffer(local), data);
    
    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    write32(centralView, 0, 0x02014b50);
    write16(centralView, 4, 0x0314);
    write16(centralView, 6, 20);
    write16(centralView, 8, 0x0800);
    write16(centralView, 10, 0);
    write16(centralView, 12, 0);
    write16(centralView, 14, 0x0021);
    write32(centralView, 16, checksum);
    write32(centralView, 20, data.size);
    write32(centralView, 24, data.size);
    write16(centralView, 28, name.length);
    write16(centralView, 30, 0);
    write16(centralView, 32, 0);
    write16(centralView, 34, 0);
    write16(centralView, 36, 0);
    write32(centralView, 38, 0);
    write32(centralView, 42, offset);
    central.set(name, 46);
    centralParts.push(toArrayBuffer(central));
    offset += local.byteLength + data.size;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.byteLength, 0);
  if (offset + centralSize > 0xffffffff) throw new Error('ZIP32 archive size limit exceeded.');
  parts.push(...centralParts);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  write32(endView, 0, 0x06054b50);
  write16(endView, 4, 0);
  write16(endView, 6, 0);
  write16(endView, 8, entries.length);
  write16(endView, 10, entries.length);
  write32(endView, 12, centralSize);
  write32(endView, 16, offset);
  write16(endView, 20, 0);
  parts.push(end);
  return new Blob(parts, { type: 'application/zip' });
}
