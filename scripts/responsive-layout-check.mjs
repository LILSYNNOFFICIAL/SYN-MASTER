import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const baseUrl = 'http://127.0.0.1:4180';
const server = spawn('npm', ['run', 'preview', '--', '--host', '127.0.0.1', '--port', '4180', '--strictPort'], {
  stdio: 'ignore',
  env: process.env,
});

async function waitForPreview() {
  for (let attempt = 0; attempt < 45; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Vite preview exited with code ${server.exitCode}`);
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // The preview server is still starting.
    }
    await delay(500);
  }
  throw new Error('Vite preview did not become ready within 22.5 seconds');
}

async function inspectLayout(page, width, workspace) {
  const report = await page.evaluate(() => {
    const workstation = document.querySelector('.syn-workstation');
    const main = document.querySelector('.syn-daw-main');
    const footer = document.querySelector('.syn-meter-bridge');
    const viewport = window.innerWidth;
    const offenders = [];

    if (workstation) {
      for (const element of workstation.querySelectorAll('*')) {
        const style = getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
        const rect = element.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) continue;

        let ancestor = element.parentElement;
        let containedByScroller = false;
        while (ancestor && ancestor !== workstation) {
          const overflowX = getComputedStyle(ancestor).overflowX;
          if (['auto', 'scroll', 'hidden', 'clip'].includes(overflowX)) {
            containedByScroller = true;
            break;
          }
          ancestor = ancestor.parentElement;
        }

        if (!containedByScroller && (rect.left < -1 || rect.right > viewport + 1)) {
          offenders.push({
            tag: element.tagName.toLowerCase(),
            className: typeof element.className === 'string' ? element.className.slice(0, 100) : '',
            left: Math.round(rect.left),
            right: Math.round(rect.right),
          });
        }
      }
    }

    const meterReadouts = document.querySelector('.syn-meter-readouts');
    const meterColumns = meterReadouts ? getComputedStyle(meterReadouts).gridTemplateColumns.trim().split(/\\s+/).length : 0;
    return {
      viewport,
      documentWidth: document.documentElement.scrollWidth,
      workstationWidth: workstation?.scrollWidth ?? 0,
      workstationClientWidth: workstation?.clientWidth ?? 0,
      mainWidth: main?.scrollWidth ?? 0,
      mainClientWidth: main?.clientWidth ?? 0,
      footerWidth: footer?.scrollWidth ?? 0,
      footerClientWidth: footer?.clientWidth ?? 0,
      meterColumns,
      offenders: offenders.slice(0, 12),
    };
  });

  assert.equal(report.viewport, width, `${workspace}: browser viewport mismatch`);
  assert.ok(report.documentWidth <= width + 1, `${workspace} at ${width}px: document width ${report.documentWidth} exceeds viewport`);
  assert.ok(report.workstationWidth <= report.workstationClientWidth + 1, `${workspace} at ${width}px: workstation overflows horizontally`);
  assert.ok(report.mainWidth <= report.mainClientWidth + 1, `${workspace} at ${width}px: main workspace overflows horizontally`);
  assert.ok(report.footerWidth <= report.footerClientWidth + 1, `${workspace} at ${width}px: meter bridge overflows horizontally`);
  assert.deepEqual(report.offenders, [], `${workspace} at ${width}px: visible elements escape the viewport: ${JSON.stringify(report.offenders)}`);

  if (width === 375) {
    assert.equal(report.meterColumns, 5, 'Mobile meter bridge must present five readouts in its second row');
  }
  if (width === 1440 && workspace === 'studio') {
    const display = await page.locator('.syn-daw-main').evaluate((el) => getComputedStyle(el).display);
    const columns = await page.locator('.syn-daw-main').evaluate((el) => getComputedStyle(el).gridTemplateColumns.trim().split(/\\s+/).length);
    assert.equal(display, 'grid', 'Desktop mastering workspace must retain its grid cockpit');
    assert.equal(columns, 2, 'Desktop mastering workspace must retain spectrum and rack lanes');
  }

  console.log(`PASS ${workspace} @ ${width}px: no page/workspace/footer overflow`);
}

async function runViewport(browser, width, height, mobile) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    isMobile: mobile,
    hasTouch: mobile,
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.getByRole('button', { name: /Try the demo mix/i }).click({ timeout: 15000 });
    await page.locator('.syn2-stage').waitFor({ state: 'visible', timeout: 30000 });
    await page.locator('.syn-meter-bridge').waitFor({ state: 'visible', timeout: 10000 });

    if (mobile) {
      const menu = page.locator('.syn-mobile-command-menu');
      assert.equal(await menu.locator('> summary').isVisible(), true, 'Mobile header must show the single Menu control');
      assert.equal(await page.locator('.syn-header-export').isVisible(), true, 'Mobile header must keep Export visible');
      await menu.locator('> summary').click();
      assert.equal(await menu.locator('> .syn-menubar').isVisible(), true, 'Mobile command drawer must open');
      await menu.locator('.syn-menu-group > summary').first().click();
      assert.equal(await menu.locator('.syn-menu-panel').first().isVisible(), true, 'Mobile command groups must expand');
      await menu.locator('> summary').click();
    }

    await inspectLayout(page, width, 'studio');

    const library = page.locator('aside[aria-label="Audio Library and Presets"]');
    for (const [index, label] of ['Audio', 'Presets', 'Chains', 'Projects'].entries()) {
      await library.locator(':scope > div:first-child button').nth(index).click();
      await inspectLayout(page, width, `library-${label.toLowerCase()}`);
    }

    const workspaces = [
      ['ai', 'AI Director'],
      ['lab', 'Analysis Lab'],
      ['stems', 'Stem Studio'],
      ['battle', 'A/B Battle'],
      ['reference', 'Reference Match'],
      ['qc', 'Quality Control'],
      ['plugins', 'Plugin Manager'],
      ['studio', 'Mastering Studio'],
    ];

    for (const [id, label] of workspaces) {
      await page.locator('.syn-workspace-menu-trigger').click();
      await page.locator('.syn-workspace-menu-item').filter({ hasText: label }).click();
      await page.locator(`main[data-layout="${id}"]`).waitFor({ state: 'attached', timeout: 10000 });
      await delay(120);
      await inspectLayout(page, width, id);

      if (id === 'ai' && mobile) {
        const analyze = page.getByRole('button', { name: 'ANALYZE TRACK' });
        assert.equal(await analyze.isVisible(), true, 'Mobile Mastering Control Desk must keep Analyze Track visible');
        const box = await analyze.boundingBox();
        assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1, 'Analyze Track button must fit within the mobile viewport');
      }
    }

    assert.deepEqual(pageErrors, [], `Browser runtime errors at ${width}px: ${pageErrors.join('; ')}`);
  } finally {
    await context.close();
  }
}

try {
  await waitForPreview();
  const browser = await chromium.launch({ headless: true });
  try {
    await runViewport(browser, 375, 812, true);
    await runViewport(browser, 1440, 1000, false);
  } finally {
    await browser.close();
  }
} finally {
  server.kill('SIGTERM');
}
