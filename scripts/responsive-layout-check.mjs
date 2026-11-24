import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const baseUrl = `http://127.0.0.1:${process.env.SYN_RESPONSIVE_PORT ?? 4180}`;
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(process.env.SYN_RESPONSIVE_PORT ?? 4180), '--strictPort'], {
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
      await page.locator('[data-testid="syn-console"]').waitFor({ state: 'visible', timeout: 15000 });
      assert.equal(await page.locator('.syn-wordmark').isVisible(), true, 'Desktop must show the SYN-MASTER serif wordmark');
      for (const selector of ['.syn-fixai', '.syn-scope', '.syn-card-loud', '.syn-ribbons', '[data-testid="central-spectrum"]', '.syn-bottom-tabs']) {
        assert.equal(await page.locator(selector).first().isVisible(), true, `Desktop console must include ${selector}`);
      }
      assert.equal(await page.locator('.syn-fixai').isDisabled(), true, 'FIX ALL AI must be disabled until a track is loaded');
      await page.locator('.syn-primary-nav-more').click();
      await page.locator('.syn-workspace-menu-item').filter({ hasText: 'AI Director' }).click();
      await page.locator('.syn-ai-hero').waitFor({ state: 'visible', timeout: 10000 });
      assert.equal(await page.getByText('WAITING FOR SOURCE AUDIO').isVisible(), true, 'AI Assistant must have a designed empty state before import');
      assert.equal(await page.locator('[data-testid="workspace-empty-state"][data-workspace="ai"]').isVisible(), true, 'AI Assistant must expose a distinct pre-import state');
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
        const emptyState = page.locator(`[data-testid="workspace-empty-state"][data-workspace="${id}"]`);
        await emptyState.waitFor({ state: 'visible', timeout: 10000 });
        assert.equal(await emptyState.isVisible(), true, `${label} must explain its no-source/no-host state`);
        const instrumentSurface = page.locator(`main.syn-daw-main[data-syn-skin="instrument"][data-workspace="${id}"]`);
        assert.equal(await instrumentSurface.isVisible(), true, `${label} must render inside the shared instrument-grade workspace surface`);
        const heroGraphic = page.locator(`[data-testid="workspace-hero"][data-workspace="${id}"] [data-testid="workspace-hero-graphic"]`);
        assert.equal(await heroGraphic.isVisible(), true, `${label} must retain its purpose-built instrument graphic`);
      }
      await page.locator('.syn-primary-nav-item').filter({ hasText: 'Dashboard' }).click();
      await page.getByRole('button', { name: /LOAD DEMO SESSION/i }).click({ timeout: 15000 });
    }
    await page.locator('.syn2-stage').waitFor({ state: 'visible', timeout: 30000 });
    await page.locator('.syn-meter-bridge').waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await page.locator('[data-syn-skin="instrument"][data-workspace="rack"]').isVisible(), true, 'Mastering Rack must use the shared instrument surface');
    assert.equal(await page.locator('#syn-library-drawer [data-syn-skin="instrument"][data-workspace="library"]').count(), 1, 'Audio Library must use the shared instrument surface inside the library drawer');

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
      const logoBox = await page.locator('.syn-wordmark').boundingBox();
      const menuBox = await menu.locator(':scope > label').boundingBox();
      const exportBox = await exportButton.boundingBox();
      const burgerBox = await page.locator('.syn-library-toggle').boundingBox();
      assert.ok(logoBox && menuBox && exportBox && burgerBox, 'Mobile header controls must have measurable boxes');
      const overlaps = (a, b) => a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1 && a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1;
      const header = { logoBox, menuBox, exportBox, burgerBox };
      assert.ok(!overlaps(logoBox, menuBox) && !overlaps(logoBox, exportBox) && !overlaps(logoBox, burgerBox), `Mobile wordmark must not overlap header controls: ${JSON.stringify(header)}`);
      assert.ok(!overlaps(burgerBox, menuBox) && menuBox.x + menuBox.width <= exportBox.x + 1, `Mobile header controls must not overlap: ${JSON.stringify(header)}`);
      assert.ok(exportBox.x + exportBox.width <= width + 1 && logoBox.x >= -1 && logoBox.x + logoBox.width <= width + 1, 'Mobile header must remain inside the viewport');
      for (const box of [burgerBox, menuBox, exportBox]) assert.ok(box.height >= 44, `Mobile header touch targets must be at least 44 px: ${JSON.stringify(header)}`);
      const tabBar = await page.locator('.syn-bottom-tabs').boundingBox();
      const viewportHeight = await page.evaluate(() => window.innerHeight);
      assert.ok(tabBar && Math.abs(tabBar.y + tabBar.height - viewportHeight) <= 2, `Mobile tab bar must be fixed to the bottom of the viewport: ${JSON.stringify(tabBar)}`);
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
    assert.equal(await page.locator('.syn-fixai').isEnabled(), true, 'FIX ALL AI must be enabled once a track is loaded');
    const knobs = page.locator('.syn-console [role="slider"]:visible');
    assert.ok((await knobs.count()) >= 2, 'Console must expose labelled, keyboard-focusable knobs/faders');
    const firstKnob = knobs.first();
    const before = await firstKnob.getAttribute('aria-valuenow');
    await firstKnob.focus();
    await page.keyboard.press('ArrowUp');
    assert.notEqual(await firstKnob.getAttribute('aria-valuenow'), before, 'Console knob must respond to the keyboard');
    await page.keyboard.press('ArrowDown');
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

    await page.locator('.syn-library-toggle').click();
    await page.locator('.syn-library-drawer[data-open="true"]').waitFor({ state: 'visible', timeout: 5000 });
    const library = page.locator('aside[aria-label="Audio Library and Presets"]');
    for (const [index, label] of ['Audio', 'Presets', 'Chains', 'Projects'].entries()) {
      const libraryTab = library.locator(':scope > div:first-child button').nth(index);
      await libraryTab.click();
      assert.equal(await libraryTab.getAttribute('aria-pressed'), 'true', `${label} library tab must expose its selected state accessibly`);
      await inspectLayout(page, width, `library-${label.toLowerCase()}`);
    }
    await page.keyboard.press('Escape');
    await page.locator('.syn-library-drawer[data-open="false"]').waitFor({ state: 'attached', timeout: 5000 });

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
      const expectedPrimary = id === 'lab' ? 'Imager' : id === 'qc' ? 'Loudness' : id === 'studio' ? 'Dashboard' : 'More';
      if (expectedPrimary === 'More') {
        await page.locator('.syn-primary-nav-more[data-active="true"]').waitFor({ state: 'visible', timeout: 3000 });
      }
      await page.locator('.syn-primary-nav-item[data-active="true"]').filter({ hasText: new RegExp(expectedPrimary, 'i') }).waitFor({ state: 'visible', timeout: 3000 });
      const activePrimary = page.locator('.syn-primary-nav-item[data-active="true"]');
      assert.equal(await activePrimary.count(), 1, `${label} must have exactly one active primary navigation item`);
      assert.equal((await activePrimary.innerText()).toLowerCase().includes(expectedPrimary.toLowerCase()), true, `${label} must mark ${expectedPrimary} as the active navigation item`);

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
