// Browser check for the Ozone-class EQ editors at 1440 px (desktop) and 412 px (Android width):
// band popover, cascading Type menu, solo, keyboard nudge, double-click add, popovers on screen, no page overflow, no runtime errors.
// Usage: npm run build && node scripts/eq-overhaul-check.mjs   (SYN_EQ_SHOTS=dir saves screenshots)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const port = process.env.SYN_EQ_PORT ?? '4182';
const baseUrl = `http://127.0.0.1:${port}`;
const shots = process.env.SYN_EQ_SHOTS ?? '';
const server = spawn(process.execPath, ['server.ts'], {
  stdio: 'ignore',
  env: { ...process.env, NODE_ENV: 'production', PORT: port, HOST: '127.0.0.1', SYN_MASTER_SESSION_SECRET: 'eq-overhaul-session-secret-0123456789abcdef' },
});

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    if (server.exitCode !== null) throw new Error(`server exited with ${server.exitCode}`);
    try {
      if ((await fetch(baseUrl)).ok) return;
    } catch { /* starting */ }
    await delay(500);
  }
  throw new Error('server did not start');
}

function toneWav(sampleRate = 48000, seconds = 2) {
  const frames = Math.floor(sampleRate * seconds);
  const bytes = frames * 8;
  const wav = Buffer.alloc(44 + bytes);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + bytes, 4); wav.write('WAVE', 8); wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(3, 20); wav.writeUInt16LE(2, 22); wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 8, 28); wav.writeUInt16LE(8, 32); wav.writeUInt16LE(32, 34); wav.write('data', 36); wav.writeUInt32LE(bytes, 40);
  for (let i = 0; i < frames; i++) {
    const s = 0.4 * Math.sin((2 * Math.PI * 260 * i) / sampleRate) + 0.2 * Math.sin((2 * Math.PI * 3500 * i) / sampleRate);
    wav.writeFloatLE(s, 44 + i * 8);
    wav.writeFloatLE(s, 48 + i * 8);
  }
  return wav;
}

async function assertOnScreen(page, selector, width, label) {
  const box = await page.locator(selector).first().boundingBox();
  assert.ok(box, `${label}: ${selector} has no box`);
  assert.ok(box.x >= -1 && box.x + box.width <= width + 1, `${label}: ${selector} escapes the viewport horizontally (${JSON.stringify(box)})`);
}

async function noOverflow(page, width, label) {
  const sw = await page.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(sw <= width + 1, `${label}: page scrollWidth ${sw} > ${width}`);
}

async function snap(page, name) {
  if (!shots) return;
  await mkdir(shots, { recursive: true });
  await page.screenshot({ path: `${shots}/${name}.png`, fullPage: false });
}

async function run(browser, width, height, mobile) {
  const context = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const tag = `${width}px`;
  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.locator('input[type="file"][accept*="audio"]').first().setInputFiles({ name: 'eq-check.wav', mimeType: 'audio/wav', buffer: toneWav() });
    const eq = page.locator('.syn-eq-panel .syn-eqx').first();
    await eq.waitFor({ state: 'visible', timeout: 30000 });
    // Let the first preview render land (the console re-renders when it does).
    await page.locator('[data-testid="render-peak-telemetry"]').first().waitFor({ state: 'attached', timeout: 30000 }).catch(() => undefined);
    await delay(300);
    await eq.scrollIntoViewIfNeeded();

    // Select band 3 (bell) by its chip: the popover opens next to the node.
    const chips = eq.locator('.syn-eqx-band');
    const bandCount = await chips.count();
    assert.ok(bandCount >= 3, `${tag}: expected default bands`);
    await chips.nth(2).click();
    const pop = eq.locator('.syn-eqx-pop');
    await pop.waitFor({ state: 'visible' });
    await assertOnScreen(page, '.syn-eq-panel .syn-eqx-pop', width, tag);

    // Cascading Type menu: Low Shelf -> Baxandall.
    await pop.locator('.syn-eqx-type-btn').click();
    const menu = page.locator('.syn-eqx-menu');
    await menu.waitFor({ state: 'visible' });
    const lowShelf = menu.locator('.syn-eqx-menu-item').filter({ hasText: 'Low Shelf' }).first();
    if (mobile) await lowShelf.click();
    else await lowShelf.hover();
    const sub = page.locator('.syn-eqx-submenu');
    await sub.waitFor({ state: 'visible' });
    for (const t of ['Analog', 'Baxandall', 'Vintage', 'Resonant']) assert.equal(await sub.getByText(t, { exact: true }).isVisible(), true, `${tag}: submenu lists ${t}`);
    await assertOnScreen(page, '.syn-eqx-menu', width, `${tag} type menu`);
    await snap(page, `eq-${width}-type-menu`);
    await sub.getByText('Baxandall', { exact: true }).click();
    await menu.waitFor({ state: 'hidden' });
    assert.match(await chips.nth(2).getAttribute('aria-label'), /Low Shelf Baxandall/, `${tag}: band 3 became a Baxandall low shelf`);

    // Pass-filter subtypes and slope.
    await chips.nth(0).click();
    await pop.locator('.syn-eqx-type-btn').click();
    const hp = menu.locator('.syn-eqx-menu-item').filter({ hasText: 'High-Pass' }).first();
    if (mobile) await hp.click(); else await hp.hover();
    await sub.getByText('Brickwall', { exact: true }).click();
    assert.match(await chips.nth(0).getAttribute('aria-label'), /High-Pass Brickwall/);
    await pop.locator('.syn-eqx-type-btn').click();
    if (mobile) await hp.click(); else await hp.hover();
    await sub.getByText('Flat', { exact: true }).click();
    await pop.getByLabel('Slope').selectOption('48');
    assert.equal(await pop.getByLabel('Slope').inputValue(), '48');
    await pop.getByLabel('Channel').selectOption('side');
    assert.match(await chips.nth(0).getAttribute('aria-label'), /Side/);

    // Numeric entry with note readout.
    await chips.nth(1).click();
    const freq = pop.getByLabel('Freq (Hz)');
    await freq.fill('440');
    await freq.press('Enter');
    assert.match(await pop.locator('.syn-eqx-note').innerText(), /A4/);

    // Solo (listen) shows the preview-only notice.
    await pop.getByRole('button', { name: /Listen to Band 2/ }).click();
    await eq.locator('.syn-eqx-solo-note').waitFor({ state: 'visible' });
    await pop.getByRole('button', { name: /Stop listening/ }).click();
    await eq.locator('.syn-eqx-solo-note').waitFor({ state: 'hidden' });

    // Keyboard: nudge band 2 right.
    const node = eq.locator('.syn-eqx-node').nth(1);
    await node.focus();
    const before = await node.getAttribute('aria-label');
    await page.keyboard.press('ArrowRight');
    await delay(50);
    assert.notEqual(await eq.locator('.syn-eqx-node').nth(1).getAttribute('aria-label'), before, `${tag}: ArrowRight moves the band`);
    await page.keyboard.press('Escape');

    // Double-click empty graph space adds a band (desktop pointer).
    if (!mobile) {
      const svg = eq.locator('.syn-eqx-svg');
      const box = await svg.boundingBox();
      await page.mouse.dblclick(box.x + box.width * 0.62, box.y + box.height * 0.3);
      await delay(50);
      assert.equal(await chips.count(), bandCount + 1, `${tag}: double-click adds a band`);
      await snap(page, `eq-${width}-popover`);
    } else {
      await chips.nth(2).click();
      await snap(page, `eq-${width}-popover`);
    }
    await noOverflow(page, width, `${tag} EQ`);

    // The Dynamic EQ tab has its own check (owned by the Dynamic EQ UI work).

    assert.deepEqual(errors, [], `${tag}: runtime errors ${errors.join('; ')}`);
    console.log(`PASS EQ overhaul @ ${tag}`);
  } finally {
    await context.close();
  }
}

try {
  await waitForServer();
  const browser = await chromium.launch({ headless: true });
  try {
    await run(browser, 1440, 1000, false);
    await run(browser, 412, 915, true);
  } finally {
    await browser.close();
  }
} finally {
  server.kill('SIGTERM');
}
