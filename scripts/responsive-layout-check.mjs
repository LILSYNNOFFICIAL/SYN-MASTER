import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const baseUrl = 'http://127.0.0.1:4180';
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '4180', '--strictPort'], {
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
    const meterColumns = meterReadouts ? getComputedStyle(meterReadouts).gridTemplateColumns.trim().split(/\s+/).length : 0;
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
  assert.ok(report.workstationWidth <= report.workstationClientWidth + 1, `${workspace} at ${width}px: workstation overflows horizontally: ${JSON.stringify(report)}`);
  assert.ok(report.mainWidth <= report.mainClientWidth + 1, `${workspace} at ${width}px: main workspace overflows horizontally`);
  assert.ok(report.footerWidth <= report.footerClientWidth + 1, `${workspace} at ${width}px: meter bridge overflows horizontally`);
  assert.deepEqual(report.offenders, [], `${workspace} at ${width}px: visible elements escape the viewport: ${JSON.stringify(report.offenders)}`);

  if (width < 768) {
    assert.equal(report.meterColumns, 5, 'Mobile meter bridge must present five readouts in its second row');
  }
  if (width >= 1024 && workspace === 'studio') {
    const display = await page.locator('.syn-daw-main').evaluate((el) => getComputedStyle(el).display);
    const columns = await page.locator('.syn-daw-main').evaluate((el) => getComputedStyle(el).gridTemplateColumns.trim().split(/\s+/).length);
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
    if (mobile) {
      await page.getByRole('button', { name: /Try the demo mix/i }).click({ timeout: 15000 });
    } else {
      await page.locator('.syn-dashboard-welcome').waitFor({ state: 'visible', timeout: 15000 });
      assert.equal(await page.locator('.syn-dashboard-visual').isVisible(), true, 'Desktop must open on the designed visual mastering dashboard, not the import splash');
      assert.equal(await page.locator('.syn-signal-art').isVisible(), true, 'Desktop dashboard must include the signal graphic');
      for (const selector of ['.syn-fix-orbit', '.syn-meter-instrument', '.syn-vectorscope', '.syn-dashboard-loudness', '.syn-chain-flow']) {
        assert.equal(await page.locator(selector).isVisible(), true, `Desktop mastering cockpit must include ${selector}`);
      }
      await page.locator('.syn-primary-nav-more').click();
      await page.locator('.syn-workspace-menu-item').filter({ hasText: 'AI Director' }).click();
      await page.locator('.syn-ai-hero').waitFor({ state: 'visible', timeout: 10000 });
      assert.equal(await page.getByText('WAITING FOR SOURCE AUDIO').isVisible(), true, 'AI Assistant must have a designed empty state before import');
      assert.equal(await page.locator('[data-testid="workspace-empty-state"]').isVisible(), true, 'AI Assistant must expose a distinct pre-import state');
      assert.equal(await page.locator('[data-testid="workspace-hero"][data-workspace="ai"]').isVisible(), true, 'AI Assistant must have the shared workspace identity header before source import');
      assert.equal(await page.locator('[data-testid="workspace-hero"][data-workspace="ai"] [data-testid="workspace-hero-graphic"]').isVisible(), true, 'AI Assistant must show its native instrument graphic');
      for (const [id, label] of [
        ['lab', 'Analysis Lab'],
        ['stems', 'Stem Studio'],
        ['battle', 'A/B Battle'],
        ['reference', 'Reference Match'],
        ['qc', 'Quality Control'],
        ['plugins', 'Plugin Manager'],
      ]) {
        await page.locator('.syn-primary-nav-more').click();
        await page.locator('.syn-workspace-menu-item').filter({ hasText: label }).click();
        await page.locator(`main[data-layout="${id}"]`).waitFor({ state: 'visible', timeout: 10000 });
        const emptyState = page.locator('[data-testid="workspace-empty-state"]');
        await emptyState.waitFor({ state: 'visible', timeout: 10000 });
        assert.equal(await emptyState.isVisible(), true, `${label} must explain its no-source/no-host state`);
      }
      await page.locator('.syn-primary-nav-item').filter({ hasText: 'Dashboard' }).click();
      await page.getByRole('button', { name: /LOAD DEMO SESSION/i }).click({ timeout: 15000 });
    }
    await page.locator('.syn2-stage').waitFor({ state: 'visible', timeout: 30000 });
    await page.locator('.syn-meter-bridge').waitFor({ state: 'visible', timeout: 10000 });

    if (!mobile) {
      assert.equal(await page.locator('.syn-mobile-command-menu > label').isVisible(), false, 'Desktop must retain the full command bar instead of the mobile Menu button');
      assert.equal(await page.locator('.syn-menubar').isVisible(), true, 'Desktop command menus must remain visible');
      assert.equal(await page.locator('.syn-header-export').isVisible(), true, 'Desktop Export Master action must remain visible');
    }

    if (mobile) {
      const menu = page.locator('.syn-mobile-command-menu');
      assert.equal(await menu.locator(':scope > label').isVisible(), true, 'Mobile header must show the single Menu control');
      const exportButton = page.locator('.syn-header-export');
      assert.equal(await exportButton.isVisible(), true, 'Mobile header must keep Export visible');
      const logoBox = await page.locator('.syn-app-header > div:first-child').boundingBox();
      const menuBox = await menu.locator(':scope > label').boundingBox();
      const exportBox = await exportButton.boundingBox();
      assert.ok(logoBox && menuBox && exportBox, 'Mobile header controls must have measurable boxes');
      assert.ok(logoBox.x + logoBox.width <= menuBox.x + 1, `Mobile logo must not overlap Menu: ${JSON.stringify({ logoBox, menuBox, exportBox })}`);
      assert.ok(menuBox.x + menuBox.width <= exportBox.x + 1, `Mobile Menu must not overlap Export: ${JSON.stringify({ logoBox, menuBox, exportBox })}`);
      assert.ok(exportBox.x + exportBox.width <= width + 1, 'Mobile Export button must remain inside the viewport');
      const menuToggle = menu.locator(':scope > .syn-mobile-menu-toggle');
      await menu.locator(':scope > label').click();
      assert.equal(await menuToggle.isChecked(), true, 'Mobile Menu checkbox must toggle open');
      assert.equal(await menu.locator(':scope > .syn-menubar').isVisible(), true, 'Mobile command drawer must open');
      await menu.locator('.syn-menu-group > summary').first().click();
      assert.equal(await menu.locator('.syn-menu-panel').first().isVisible(), true, 'Mobile command groups must expand');
      await inspectLayout(page, width, 'mobile-command-menu-open');
      await menu.locator(':scope > label').click();
      assert.equal(await menuToggle.isChecked(), false, 'Mobile Menu checkbox must close');
    }

    await inspectLayout(page, width, 'studio');
    const spectrumCanvas = page.locator('[data-testid="spectrum-canvas"]');
    if (await spectrumCanvas.count()) {
      const canvasBox = await spectrumCanvas.boundingBox();
      assert.ok(canvasBox && canvasBox.width <= width + 1, `Spectrum canvas must fit at ${width}px`);
      if (mobile) assert.ok(canvasBox.height >= 240, 'Mobile spectrum canvas must be at least 240 px high');
    }

    assert.equal(await page.locator('.syn2-fix-centerpiece').isVisible(), true, 'FIX ALL AI must appear as a separate centerpiece below the EQ workspace');
    assert.equal(await page.locator('.syn2-wave-wrap').count(), 0, 'The default mastering workspace must use the unified waveform-behind-EQ visualization, not a second stacked waveform panel');
    const eqPrecedesFix = await page.evaluate(() => {
      const eq = document.querySelector('[data-testid="central-spectrum"]');
      const fix = document.querySelector('.syn2-fix-centerpiece');
      return Boolean(eq && fix && (eq.compareDocumentPosition(fix) & Node.DOCUMENT_POSITION_FOLLOWING));
    });
    assert.equal(eqPrecedesFix, true, 'PRAGMATIC EQ must appear before the FIX ALL AI centerpiece');

    await page.getByRole('button', { name: /Timeline & fades/ }).click();
    assert.equal(await page.locator('.syn2-wave-wrap').count(), 1, 'Timeline and fade editing must remain available on demand');
    await inspectLayout(page, width, 'studio-timeline-expanded');
    await page.getByRole('button', { name: /Hide timeline & fades/ }).click();
    assert.equal(await page.locator('.syn2-wave-wrap').count(), 0, 'Collapsing the timeline must restore the unified default visualization');

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
      ['studio', 'Dashboard'],
    ];

    for (const [id, label] of workspaces) {
      if (id === 'studio') {
        await page.locator('.syn-primary-nav-item').filter({ hasText: 'Dashboard' }).click();
      } else {
        await page.locator('.syn-primary-nav-more').click();
        await page.locator('.syn-workspace-menu-item').filter({ hasText: label }).click();
      }
      await page.locator(`main[data-layout="${id}"]`).waitFor({ state: 'visible', timeout: 10000 });
      if (id !== 'studio') {
        const workspaceHero = page.locator(`[data-testid="workspace-hero"][data-workspace="${id}"]`);
        await workspaceHero.waitFor({ state: 'visible', timeout: 10000 });
        assert.equal(await workspaceHero.locator('[data-testid="workspace-hero-graphic"]').isVisible(), true, `${label} must display its workspace-specific instrument graphic`);
      }
      await inspectLayout(page, width, id);

      if (id === 'ai') {
        const modeGrid = page.getByText('Operating Mode', { exact: true }).locator('xpath=following-sibling::div[1]');
        const modeColumns = await modeGrid.evaluate((el) => getComputedStyle(el).gridTemplateColumns.trim().split(/\s+/).length);
        assert.equal(modeColumns, mobile ? 1 : 3, 'AI Director operating mode cards must stack on mobile and use three desktop columns');

        const telemetryGrid = page.locator('[data-testid="measured-before-after-telemetry"] > div.grid');
        const telemetryColumns = await telemetryGrid.evaluate((el) => getComputedStyle(el).gridTemplateColumns.trim().split(/\s+/).length);
        assert.equal(telemetryColumns, mobile ? 2 : 3, 'AI Director telemetry must use two mobile columns and three desktop columns');

        if (mobile) {
          const analyze = page.getByRole('button', { name: 'ANALYZE TRACK' });
          assert.equal(await analyze.isVisible(), true, 'Mobile Mastering Control Desk must keep Analyze Track visible');
          const box = await analyze.boundingBox();
          assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1, 'Analyze Track button must fit within the mobile viewport');
        }
      }

      if (id === 'lab') {
        const labHeading = page.getByText('Spectral Zone Balance (Pre vs Master)', { exact: true });
        const labGrid = labHeading.locator('xpath=ancestor::div[contains(@class,"grid-cols-1")][1]');
        const labColumns = await labGrid.evaluate((el) => getComputedStyle(el).gridTemplateColumns.trim().split(/\s+/).length);
        assert.equal(labColumns, mobile ? 1 : 2, 'Analysis Lab spectral diagnostics must stack on mobile and use two desktop columns');
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
    await runViewport(browser, 360, 800, true);
    await runViewport(browser, 375, 812, true);
    await runViewport(browser, 412, 915, true);
    await runViewport(browser, 1024, 900, false);
    await runViewport(browser, 1440, 1000, false);
  } finally {
    await browser.close();
  }
} finally {
  server.kill('SIGTERM');
}
