import { cpSync, copyFileSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
const repoDir = resolve(desktopDir, '..');
const rootDist = join(repoDir, 'dist');
const desktopDist = join(desktopDir, 'dist');
const bundledServer = join(desktopDir, 'server.production.mjs');
const nativeBuild = join(repoDir, 'native', 'build', 'windows-x64-release', 'Release');
const nativeTarget = join(desktopDir, 'native');

if (!statSync(rootDist, { throwIfNoEntry: false })?.isDirectory()) {
  throw new Error('Root dist/ is missing. Run npm run build before preparing the Windows runtime.');
}
if (!statSync(bundledServer, { throwIfNoEntry: false })?.isFile()) {
  throw new Error('desktop/server.production.mjs is missing. Run npm run build:desktop-server first.');
}

rmSync(desktopDist, { recursive: true, force: true });
cpSync(rootDist, desktopDist, { recursive: true });
rmSync(nativeTarget, { recursive: true, force: true });
mkdirSync(nativeTarget, { recursive: true });

for (const binary of ['syn-plugin-host.exe', 'syn-plugin-scanner.exe', 'syn-plugin-worker.exe']) {
  const source = join(nativeBuild, binary);
  if (!statSync(source, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Required native companion binary is missing: ${source}`);
  }
  copyFileSync(source, join(nativeTarget, binary));
}

console.log('Prepared Electron runtime: Vite dist, bundled Express server, and all three native VST3 companion executables.');
