// Mobile emulation checks (Chromium device emulation, NOT a real phone).
// 412×915 (Pixel-class Android) and 390×844 (iPhone-class) with isMobile + touch:
//   1. touch drag-seek on the existing EQ waveform moves the playhead/time readout,
//   2. the header Menu (menubar) dropdowns, the hamburger library drawer and the More
//      workspace menu stay inside the viewport,
//   3. prefers-reduced-motion (emulateMedia reducedMotion) leaves no running glow animations,
//      while the default (no-preference) does run them.
// Usage: npm run build && node scripts/mobile-emulation-check.mjs   (needs playwright + Chromium)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const port = process.env.SYN_MOBILE_PORT ?? '4182';
const baseUrl = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server.ts'], {
  stdio: 'ignore',
  env: { ...process.env, NODE_ENV: 'production', PORT: port, HOST: '127.0.0.1', SYN_MASTER_SESSION_SECRET: 'mobile-emulation-session-secret-0123456789abcdef' },
});

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    if (server.exitCode !== null) throw new Error(`server exited with ${server.exitCode}`);
    try { if ((await fetch(baseUrl)).ok) return; } catch { /* starting */ }
    await delay(500);
  }
  throw new Error('server did not start');
}

const inside = (box, w, h, label) => {
  assert.ok(box, `${label}: element has no box`);
  assert.ok(box.x >= -1 && box.y >= -1 && box.x + box.width <= w + 1 && box.y + box.height <= h + 1,
    `${label} must stay on screen at ${w}×${h}: ${JSON.stringify(box)}`);
};

async function touchDrag(page, cdp, from, to, steps = 8) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y }] });
  for (let i = 1; i <= steps; i++) {
    const x = from.x + ((to.x - from.x) * i) / steps;
    const y = from.y + ((to.y - from.y) * i) / steps;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
    await delay(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await delay(120);
}

const readTime = async (page) => {
  const text = await page.locator('.syn-player-time').first().innerText();
  const m = text.match(/(\d+):(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};
const playheadX = (page) => page.locator('.syn-eqx-svg .syn-ceq-playhead').first().evaluate((el) => (el.x1.baseVal.value / 640) * el.ownerSVGElement.getBoundingClientRect().width);

async function runViewport(browser, width, height) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /Try the demo mix/i }).click({ timeout: 20000 });
    await page.locator('.syn-eqx-svg').first().waitFor({ state: 'visible', timeout: 30000 });
    const docWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(docWidth <= width + 1, `no horizontal page scroll at ${width}px (document ${docWidth}px)`);

    // 0. Meter bridge: stereo row + readout row, no overlapping or clipped readouts.
    const meter = await page.evaluate(() => {
      const bridge = document.querySelector('.syn-workstation .syn-meter-bridge');
      const boxes = [...document.querySelectorAll('.syn-meter-readouts .syn-meter-metric')].map((el) => el.getBoundingClientRect());
      const values = [...document.querySelectorAll('.syn-meter-readouts .syn-meter-value')].map((el) => ({ text: el.textContent, over: el.scrollWidth - el.clientWidth }));
      const stereo = document.querySelector('.syn-meter-stereo')?.getBoundingClientRect();
      const readouts = document.querySelector('.syn-meter-readouts')?.getBoundingClientRect();
      let overlaps = 0;
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]; const b = boxes[j];
        if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) overlaps++;
      }
      return { display: bridge ? getComputedStyle(bridge).display : null, overlaps, clipped: values.filter((v) => v.over > 1), stacked: Boolean(stereo && readouts && readouts.top >= stereo.bottom - 1) };
    });
    assert.equal(meter.display, 'grid', 'mobile meter bridge uses its stacked grid');
    assert.ok(meter.stacked, 'mobile meter readouts sit below the stereo meters');
    assert.equal(meter.overlaps, 0, 'meter readouts must not overlap');
    assert.deepEqual(meter.clipped, [], 'meter readout values must not be clipped');

    // 1. Touch drag-seek on the single existing EQ waveform.
    const wave = page.locator('.syn-eqx-svg').first();
    await wave.scrollIntoViewIfNeeded();
    const box = await wave.boundingBox();
    assert.ok(box && box.width > 200, 'existing EQ waveform is measurable');
    assert.ok(box.height >= 44, `timeline touch target ≥ 44 px tall (got ${box.height})`);
    const cdp = await context.newCDPSession(page);
    const y = box.y + box.height * 0.65; // below the fade-handle row
    const scrollBefore = await page.evaluate(() => window.scrollY);
    await touchDrag(page, cdp, { x: box.x + box.width * 0.2, y }, { x: box.x + box.width * 0.7, y });
    const t1 = await readTime(page);
    const x1 = await playheadX(page);
    const durationText = await page.locator('.syn-player-time').first().innerText();
    const duration = Number(durationText.split('/')[1].trim().split(':')[0]) * 60 + Number(durationText.split('/')[1].trim().split(':')[1]);
    assert.ok(Math.abs(t1 / duration - 0.7) < 0.06, `touch drag must seek to ~70% (time ${t1}s of ${duration}s)`);
    assert.ok(Math.abs(x1 / box.width - 0.7) < 0.06, `playhead must follow the drag (x ${x1} of ${box.width})`);
    await touchDrag(page, cdp, { x: box.x + box.width * 0.7, y }, { x: box.x + box.width * 0.3, y });
    const t2 = await readTime(page);
    assert.ok(Math.abs(t2 / duration - 0.3) < 0.06, `backwards touch drag must seek to ~30% (time ${t2}s)`);
    const scrollAfter = await page.evaluate(() => window.scrollY);
    assert.ok(Math.abs(scrollAfter - scrollBefore) < 4, 'a horizontal scrub must not scroll the page');
    console.log(`PASS ${width}×${height}: touch drag-seek ${t1.toFixed(1)}s → ${t2.toFixed(1)}s`);

    // 2a. Header Menu (menubar) dropdowns stay on screen.
    await page.evaluate(() => window.scrollTo(0, 0));
    const menu = page.locator('.syn-mobile-command-menu');
    await menu.locator(':scope > label').click();
    const groups = menu.locator('.syn-menu-group');
    const groupCount = await groups.count();
    assert.ok(groupCount >= 4, `mobile menu exposes the command groups (found ${groupCount})`);
    for (let i = 0; i < groupCount; i++) {
      const group = groups.nth(i);
      const name = (await group.locator(':scope > summary').innerText()).trim();
      await group.locator(':scope > summary').click();
      const panel = group.locator('.syn-menu-panel');
      await panel.waitFor({ state: 'visible', timeout: 3000 });
      const pbox = await panel.boundingBox();
      // Panels may be taller than the viewport (they scroll inside the drawer), but never wider or off the side.
      assert.ok(pbox && pbox.x >= -1 && pbox.x + pbox.width <= width + 1, `menu "${name}" panel off screen horizontally: ${JSON.stringify(pbox)}`);
      assert.ok(pbox.y >= -1 && pbox.y < height, `menu "${name}" panel must start on screen: ${JSON.stringify(pbox)}`);
      const items = panel.locator('button, a, [role="menuitem"]');
      const n = await items.count();
      for (let k = 0; k < n; k++) {
        const ib = await items.nth(k).boundingBox();
        if (!ib) continue;
        assert.ok(ib.x >= -1 && ib.x + ib.width <= width + 1, `menu "${name}" item ${k} off screen: ${JSON.stringify(ib)}`);
      }
      const drawer = menu.locator(':scope > .syn-menubar');
      const dbox = await drawer.boundingBox();
      inside({ ...dbox, height: Math.min(dbox.height, height - dbox.y) }, width, height, 'mobile menu drawer');
      const scrollable = await drawer.evaluate((el) => el.scrollHeight <= el.clientHeight + 1 || ['auto', 'scroll'].includes(getComputedStyle(el).overflowY));
      assert.ok(scrollable, `menu drawer must scroll when "${name}" overflows it`);
      await group.locator(':scope > summary').click();
    }
    await menu.locator(':scope > label').click();
    console.log(`PASS ${width}×${height}: ${groupCount} header menu dropdowns stay on screen`);

    // 2b. Hamburger library drawer.
    await page.locator('.syn-library-toggle').click();
    const drawer = page.locator('.syn-library-drawer[data-open="true"]');
    await drawer.waitFor({ state: 'visible', timeout: 5000 });
    await delay(400);
    inside(await drawer.boundingBox(), width, height, 'library drawer');
    await page.keyboard.press('Escape');
    await page.locator('.syn-library-drawer[data-open="false"]').waitFor({ state: 'attached', timeout: 5000 });

    // 2c. More workspace menu.
    await page.locator('.syn-primary-nav-more').click();
    const wsMenu = page.locator('.syn-workspace-menu');
    await wsMenu.waitFor({ state: 'visible', timeout: 5000 });
    await delay(400);
    inside(await wsMenu.boundingBox(), width, height, 'More workspace menu');
    const wsItems = wsMenu.locator('.syn-workspace-menu-item');
    for (let k = 0; k < await wsItems.count(); k++) inside(await wsItems.nth(k).boundingBox(), width, height, `More item ${k}`);
    await page.keyboard.press('Escape');
    console.log(`PASS ${width}×${height}: hamburger drawer and More menu stay on screen`);

    // 3. Reduced motion turns the glow animations off.
    const running = () => page.evaluate(() => document.getAnimations()
      .filter((a) => a.playState === 'running' && a.effect && a.effect.getComputedTiming().iterations === Infinity)
      .map((a) => `${a.effect.target?.className?.baseVal ?? a.effect.target?.className ?? '?'}:${a.animationName ?? a.constructor.name}`));
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await delay(300);
    const animated = await running();
    assert.ok(animated.length > 0, 'glow animations run with no motion preference (sanity check)');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await delay(300);
    const stillAnimated = await running();
    assert.deepEqual(stillAnimated, [], `reduced motion must stop every infinite (glow) animation; still running: ${stillAnimated.join(', ')}`);
    console.log(`PASS ${width}×${height}: reduced motion stops ${animated.length} infinite glow animations`);

    assert.deepEqual(errors, [], `page errors: ${errors.join('; ')}`);
  } finally {
    await context.close();
  }
}

try {
  await waitForServer();
  const browser = await chromium.launch();
  try {
    await runViewport(browser, 412, 915);
    await runViewport(browser, 390, 844);
  } finally {
    await browser.close();
  }
  console.log('Mobile emulation checks passed (Chromium emulation, not a physical device).');
} finally {
  server.kill('SIGTERM');
}
