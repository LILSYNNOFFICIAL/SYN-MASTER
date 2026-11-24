import assert from 'node:assert/strict';
import test from 'node:test';
import { crc32, createZipBlob } from './zipArchive';

test('CRC32 matches the standard check value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('creates ZIP entries with correct sizes, checksums and directory offsets', async () => {
  const blob = await createZipBlob([
    { name: 'master/test.txt', data: 'SYN MASTER' },
    { name: 'master/audio.bin', data: new Blob([new Uint8Array([1, 2, 3, 4])]) },
  ]);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  assert.equal(blob.type, 'application/zip');
  assert.equal(view.getUint32(0, true), 0x04034b50);

  const localNameLength = view.getUint16(26, true);
  const localDataStart = 30 + localNameLength;
  assert.equal(view.getUint32(18, true), 10);
  assert.equal(new TextDecoder().decode(bytes.slice(localDataStart, localDataStart + 10)), 'SYN MASTER');

  const endOffset = bytes.length - 22;
  assert.equal(view.getUint32(endOffset, true), 0x06054b50);
  assert.equal(view.getUint16(endOffset + 10, true), 2);
  const centralOffset = view.getUint32(endOffset + 16, true);
  assert.equal(view.getUint32(centralOffset, true), 0x02014b50);
  assert.equal(view.getUint32(centralOffset + 16, true), crc32(new TextEncoder().encode('SYN MASTER')));
  assert.equal(view.getUint32(centralOffset + 20, true), 10);
  assert.equal(view.getUint32(centralOffset + 24, true), 10);
  assert.equal(view.getUint32(centralOffset + 42, true), 0);

  const secondCentralOffset = centralOffset + 46 + view.getUint16(centralOffset + 28, true);
  assert.equal(view.getUint32(secondCentralOffset, true), 0x02014b50);
  assert.equal(view.getUint32(secondCentralOffset + 20, true), 4);
});
