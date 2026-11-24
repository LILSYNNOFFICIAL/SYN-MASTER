import assert from 'node:assert/strict';
import test from 'node:test';
import { crc32, createZipBlob } from './zipArchive';

test('CRC32 matches the standard check value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('creates a ZIP with valid local header, central directory and end record', async () => {
  const blob = await createZipBlob([
    { name: 'master/test.txt', data: 'SYN MASTER' },
    { name: 'manifest.json', data: '{"ok":true}' },
  ]);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  assert.equal(blob.type, 'application/zip');
  assert.equal(view.getUint32(0, true), 0x04034b50);
  const endOffset = bytes.length - 22;
  assert.equal(view.getUint32(endOffset, true), 0x06054b50);
  assert.equal(view.getUint16(endOffset + 10, true), 2);
  const centralOffset = view.getUint32(endOffset + 16, true);
  assert.equal(view.getUint32(centralOffset, true), 0x02014b50);
});
