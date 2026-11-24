import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const assetDir = join(process.cwd(), 'dist', 'assets');
const jsFiles = readdirSync(assetDir)
  .filter((name) => name.endsWith('.js'))
  .map((name) => {
    const path = join(assetDir, name);
    const content = readFileSync(path);
    return { name, bytes: statSync(path).size, gzipBytes: gzipSync(content).length };
  })
  .sort((a, b) => b.bytes - a.bytes);

if (jsFiles.length === 0) {
  throw new Error('No production JavaScript chunks found in dist/assets.');
}

const maxRawBytes = 800 * 1024;
const maxGzipBytes = 250 * 1024;
const totalRaw = jsFiles.reduce((sum, file) => sum + file.bytes, 0);
const totalGzip = jsFiles.reduce((sum, file) => sum + file.gzipBytes, 0);

console.log('SYN MASTER JavaScript bundle budget');
for (const file of jsFiles.slice(0, 10)) {
  console.log(`  ${file.name}: ${(file.bytes / 1024).toFixed(1)} KiB raw / ${(file.gzipBytes / 1024).toFixed(1)} KiB gzip`);
}
console.log(`  TOTAL: ${(totalRaw / 1024).toFixed(1)} KiB raw / ${(totalGzip / 1024).toFixed(1)} KiB gzip`);
console.log(`  Largest-chunk limits: ${(maxRawBytes / 1024).toFixed(0)} KiB raw / ${(maxGzipBytes / 1024).toFixed(0)} KiB gzip`);

const largest = jsFiles[0];
if (largest.bytes > maxRawBytes || largest.gzipBytes > maxGzipBytes) {
  console.error(`Bundle budget exceeded by ${largest.name}.`);
  process.exitCode = 1;
}
