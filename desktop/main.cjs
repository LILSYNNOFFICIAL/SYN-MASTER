const { app, BrowserWindow, dialog, ipcMain, shell, utilityProcess } = require('electron');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');

let mainWindow = null;
let webProcess = null;
let nativeProcess = null;
let webPort = null;
let aiAccessToken = null;
let backendPromise = null;
let appOrigin = null;
let nativePairing = null;
let nativeHostWarning = null;
let nativeProcessError = null;
let quitting = false;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getFreeLoopbackPort(excluded = []) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') {
        probe.close();
        reject(new Error('Could not reserve a loopback TCP port.'));
        return;
      }
      const port = address.port;
      probe.close((error) => {
        if (error) reject(error);
        else if (excluded.includes(port)) getFreeLoopbackPort(excluded).then(resolve, reject);
        else resolve(port);
      });
    });
  });
}

async function waitForWebServer(port) {
  let lastError = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(1500),
      });
      if (response.ok) return;
      lastError = new Error(`Local SYN MASTER server returned HTTP ${response.status}.`);
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`Local SYN MASTER server did not become healthy: ${lastError?.message ?? 'startup timeout'}`);
}

async function waitForNativeHttpPort(port, child) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Native VST3 host exited before its HTTP listener started (code ${child.exitCode}).`);
    }
    const listening = await new Promise((resolve) => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      socket.setTimeout(600);
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('timeout', () => {
        socket.destroy();
        resolve(false);
      });
      socket.once('error', () => resolve(false));
    });
    if (listening) return;
    await delay(150);
  }
  throw new Error(`Native VST3 host did not open its HTTP listener on 127.0.0.1:${port}.`);
}

async function waitForNativePairing(pairingPath, child) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (nativeProcessError) throw nativeProcessError;
    if (child.exitCode !== null) {
      throw new Error(`Native VST3 host exited during startup (code ${child.exitCode}).`);
    }
    try {
      const raw = await fs.readFile(pairingPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (typeof parsed.sessionToken === 'string' &&
          Number.isInteger(parsed.httpPort) &&
          Number.isInteger(parsed.wsPort)) {
        // The native host writes host_pairing.json immediately before opening its listener.
        // Wait for TCP readiness so the renderer's one-shot auto-pair cannot race startup.
        await waitForNativeHttpPort(parsed.httpPort, child);
        await fs.rm(pairingPath, { force: true });
        return parsed;
      }
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    await delay(250);
  }
  throw new Error('Native VST3 host did not publish its pairing information before timeout.');
}

async function startBackend() {
  if (backendPromise) return backendPromise;
  backendPromise = (async () => {
    const appPath = app.getAppPath();
    const serverPath = path.join(appPath, 'server.production.mjs');
    const userData = app.getPath('userData');
    const envFile = path.join(userData, '.env');
    await fs.mkdir(userData, { recursive: true });
    if (!await fs.stat(serverPath).catch(() => null)) {
      throw new Error('The packaged SYN MASTER server runtime is missing. Rebuild the desktop runtime before packaging.');
    }

    webPort = await getFreeLoopbackPort();
    aiAccessToken = randomBytes(32).toString('hex');
    appOrigin = `http://127.0.0.1:${webPort}`;

    webProcess = utilityProcess.fork(serverPath, [], {
      env: {
        ...process.env,
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: String(webPort),
        DOTENV_CONFIG_PATH: envFile,
        SYN_MASTER_AI_ACCESS_TOKEN: aiAccessToken,
      },
      stdio: 'ignore',
    });
    await waitForWebServer(webPort);

    const nativeDir = app.isPackaged
      ? path.join(process.resourcesPath, 'native')
      : path.join(__dirname, 'native');
    const nativeHostPath = path.join(nativeDir, 'syn-plugin-host.exe');
    if (await fs.stat(nativeHostPath).catch(() => null)) {
      const usedPorts = [webPort];
      const httpPort = await getFreeLoopbackPort(usedPorts);
      usedPorts.push(httpPort);
      const wsPort = await getFreeLoopbackPort(usedPorts);
      const nativeDataDir = path.join(userData, 'native-host');
      const pairingPath = path.join(nativeDataDir, 'host_pairing.json');
      await fs.mkdir(nativeDataDir, { recursive: true });
      await fs.rm(pairingPath, { force: true });
      nativeProcessError = null;
      nativeProcess = spawn(nativeHostPath, [
        '--port', String(httpPort),
        '--ws-port', String(wsPort),
        '--data-dir', nativeDataDir,
        '--allow-origin', appOrigin,
      ], { windowsHide: true, stdio: 'ignore' });
      nativeProcess.once('error', (error) => {
        nativeProcessError = error;
        console.error('[SYN MASTER] Native host process error:', error.message);
      });
      try {
        nativePairing = await waitForNativePairing(pairingPath, nativeProcess);
      } catch (error) {
        nativeHostWarning = error instanceof Error ? error.message : String(error);
        if (nativeProcess && nativeProcess.exitCode === null) nativeProcess.kill();
        nativeProcess = null;
        nativePairing = null;
      }
    }

    return { origin: appOrigin, pairing: nativePairing, nativeWarning: nativeHostWarning };
  })();
  try {
    return await backendPromise;
  } catch (error) {
    backendPromise = null;
    throw error;
  }
}

async function createMainWindow() {
  if (mainWindow) {
    mainWindow.focus();
    return;
  }

  const backend = await startBackend();
  const window = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 960,
    minHeight: 680,
    backgroundColor: '#070709',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = window;
  const localOrigin = new URL(backend.origin).origin;
  window.webContents.on('will-navigate', (event, target) => {
    try {
      if (new URL(target).origin !== localOrigin) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:') void shell.openExternal(url);
    } catch {
      // Invalid external target is discarded.
    }
    return { action: 'deny' };
  });
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });

  const hash = backend.pairing
    ? `#pairToken=${encodeURIComponent(backend.pairing.sessionToken)}&hostPort=${backend.pairing.httpPort}`
    : '';
  await window.loadURL(`${backend.origin}/${hash}`);
  if (backend.nativeWarning) {
    await dialog.showMessageBox(window, {
      type: 'warning',
      title: 'VST3 companion unavailable',
      message: 'SYN MASTER is open, but native VST3 hosting did not start.',
      detail: backend.nativeWarning,
    });
  }
}

ipcMain.handle('syn-master:get-ai-access-token', () => aiAccessToken);

app.setAppUserModelId('com.lilsynn.synmaster');
const hasSingleInstance = app.requestSingleInstanceLock();
if (!hasSingleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => createMainWindow()).catch(async (error) => {
    await dialog.showMessageBox({
      type: 'error',
      title: 'SYN MASTER could not start',
      message: 'The local workstation runtime failed to start.',
      detail: error instanceof Error ? error.message : String(error),
    });
    app.quit();
  });
}

app.on('before-quit', () => {
  quitting = true;
  if (nativeProcess && nativeProcess.exitCode === null) nativeProcess.kill();
  if (webProcess) webProcess.kill();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (app.isReady() && !quitting && BrowserWindow.getAllWindows().length === 0) {
    void createMainWindow();
  }
});
