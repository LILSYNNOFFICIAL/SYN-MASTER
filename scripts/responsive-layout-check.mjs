import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const port = process.env.SYN_RESPONSIVE_PORT ?? '4180';
const baseUrl = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server.ts'], {
  stdio: 'ignore',
  env: {
    ...process.env,
    NODE_ENV: 'production',
    PORT: port,
    HOST: '127.0.0.1',
    SYN_MASTER_AI_ACCESS_TOKEN: 'responsive-layout-check-token-0123456789abcdef',
  },
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
        if (id !== 'qc') {
          const heroGraphic = page.locator(`[data-testid="workspace-hero"][data-workspace="${id}"] [data-testid="workspace-hero-graphic"]`);
          assert.equal(await heroGraphic.isVisible(), true, `${label} must retain its purpose-built instrument graphic`);
        }
      }
      await page.locator('.syn-primary-nav-item').filter({ hasText: 'Dashboard' }).click();
      await page.getByRole('button', { name: /LOAD DEMO SESSION/i }).click({ timeout: 15000 });
    }
    await page.locator('.syn2-stage').waitFor({ state: 'visible', timeout: 30000 });
    await page.locator('.syn-meter-bridge').waitFor({ state: 'visible', timeout: 10000 });
    // The rack UI is code-split (prefetched on mount); wait for it rather than sampling once.
    await page.locator('[data-syn-skin="instrument"][data-workspace="rack"]').waitFor({ state: 'visible', timeout: 10000 });
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
    const knobs = page.locator('.syn-console .syn-arcknob-dial[role="slider"]:visible');
    assert.ok((await knobs.count()) >= 2, 'Console must expose labelled, keyboard-focusable knobs/faders');
    const firstKnob = knobs.first();
    const before = await firstKnob.getAttribute('aria-valuenow');
    await firstKnob.focus();
    await page.keyboard.press('ArrowUp');
    assert.notEqual(await firstKnob.getAttribute('aria-valuenow'), before, 'Console knob must respond to the keyboard');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.locator('.syn2-wave-wrap').count(), 0, 'The default mastering workspace must use the unified waveform-behind-EQ visualization, not a second stacked waveform panel');
    // Guided flow (README round 3 · A): 1 Import/timeline → 2 Fix with AI → 3 Master it yourself (EQ).
    const fixPrecedesEq = await page.evaluate(() => {
      const eq = document.querySelector('[data-testid="central-spectrum"]');
      const fix = document.querySelector('.syn2-fix-centerpiece');
      return Boolean(eq && fix && fix.getBoundingClientRect().bottom <= eq.getBoundingClientRect().top + 1);
    });
    if (mobile) assert.equal(fixPrecedesEq, true, 'FIX ALL AI (step 2) must appear above the EQ (step 3) on mobile');

    // The always-visible TimelinePlayer replaced the old "Timeline & fades" toggle.
    assert.equal(await page.locator('.syn-player .syn2-wave').count(), 1, 'Timeline and fade editing must stay available in the TimelinePlayer');
    await inspectLayout(page, width, 'studio-timeline');

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
      // QC's static hero illustration was removed (README round 3 · I: Live Loudness panel instead).
      if (id !== 'studio' && id !== 'qc') {
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
    await context.close().catch(() => undefined);
  }
}

function makeToneWav(sampleRate = 48000, durationSec = 1, frequency = 260) {
  const frames = Math.floor(sampleRate * durationSec);
  const dataBytes = frames * 2 * 4;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(3, 20);
  wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 8, 28);
  wav.writeUInt16LE(8, 32);
  wav.writeUInt16LE(32, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < frames; i++) {
    // 260 Hz sits on the default Dynamic EQ band; 1 kHz is an untouched reference partial.
    const sample = 0.5 * Math.sin((2 * Math.PI * frequency * i) / sampleRate) + 0.2 * Math.sin((2 * Math.PI * 1000 * i) / sampleRate);
    wav.writeFloatLE(sample, 44 + i * 8);
    wav.writeFloatLE(sample, 48 + i * 8);
  }
  return wav;
}

async function extractWavFromStoreZip(download) {
  const archive = await readFile(await download.path());
  let offset = 0;
  while (offset + 30 <= archive.length && archive.readUInt32LE(offset) === 0x04034b50) {
    const method = archive.readUInt16LE(offset + 8);
    const compressedSize = archive.readUInt32LE(offset + 18);
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = archive.toString('utf8', nameStart, nameStart + nameLength);
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (method !== 0) throw new Error(`Unexpected compressed ZIP entry: ${name}`);
    if (name.toLowerCase().endsWith('.wav')) return archive.subarray(dataStart, dataEnd);
    offset = dataEnd;
  }
  throw new Error('Export ZIP did not contain a WAV file.');
}

async function runWavExportE2E(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  // Headless Chromium exposes showSaveFilePicker but can never answer it; use the download
  // fallback (the path Android Chrome / Firefox / Safari take) so the ZIP arrives as a download.
  await context.addInitScript(() => { delete window.showSaveFilePicker; });
  const page = await context.newPage();
  const pageErrors = [];
  const t0 = Date.now();
  const step = (msg) => { if (process.env.SYN_DEBUG) console.error(`[export e2e +${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`); };
  page.on('crash', () => console.error('PAGE CRASHED during export e2e'));
  if (process.env.SYN_DEBUG) page.on('console', (m) => console.error('console:', m.text()));
  page.on('pageerror', (error) => pageErrors.push(error.message));

  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.locator('.syn-console').waitFor({ state: 'visible', timeout: 15000 });
    const audioInput = page.locator('input[type="file"][accept*="audio"]').first();
    await audioInput.setInputFiles({
      name: 'dynamic-eq-fades-test.wav',
      mimeType: 'audio/wav',
      buffer: makeToneWav(),
    });
    step('imported');
    await page.locator('.syn2-wave').waitFor({ state: 'visible', timeout: 30000 });

    const waveform = page.locator('.syn2-wave');
    const box = await waveform.boundingBox();
    assert.ok(box && box.width > 100, 'Imported track must expose an interactive timeline');
    const dragHandle = async (fromX, toX) => {
      await page.mouse.move(fromX, box.y + 28);
      await page.mouse.down();
      await page.mouse.move(toX, box.y + 28, { steps: 4 });
      await page.mouse.up();
    };
    step('fades');
    await dragHandle(box.x + 7, box.x + box.width * 0.1);
    await dragHandle(box.x + box.width - 7, box.x + box.width * 0.9);
    const fadeControls = await page.locator('.syn-player-fades').innerText();
    assert.match(fadeControls, /Fade in\s+0\.10s/i, 'Timeline interaction must set a non-zero fade-in');
    assert.match(fadeControls, /Fade out\s+0\.10s/i, 'Timeline interaction must set a non-zero fade-out');

    step('dynamic eq tab');
    await page.locator('.syn-eq-head .syn-seg button').filter({ hasText: 'Dynamic EQ' }).click();
    // The Dynamic EQ editor is code-split: wait for it (empty state or editor) before deciding to add it.
    await page.locator('.syn-deq').waitFor({ state: 'visible', timeout: 10000 });
    const addDynamicEq = page.getByRole('button', { name: /Add Dynamic EQ/i });
    if (await addDynamicEq.isVisible()) await addDynamicEq.click();
    await page.locator('.syn-deq-power').waitFor({ state: 'visible', timeout: 10000 });

    // Verify the Dynamic EQ editor uses the shared Ozone graph, type menu, popover and trace meter.
    const dynGraph = page.locator('.syn-deq-graph .syn-eqx-svg');
    await dynGraph.waitFor({ state: 'visible', timeout: 10000 });
    const dynNodes = page.locator('.syn-deq-graph .syn-eqx-node');
    assert.equal(await dynNodes.count(), 2, 'default Dynamic EQ must render both bands on the shared graph');
    await dynNodes.first().click();
    const dynPop = page.locator('.syn-deq .syn-eqx-pop');
    await dynPop.waitFor({ state: 'visible' });
    await dynPop.locator('.syn-eqx-thr-meter').waitFor({ state: 'visible' });
    await dynPop.locator('.syn-eqx-type-btn').click();
    const dynTypeMenu = page.locator('.syn-eqx-menu');
    await dynTypeMenu.waitFor({ state: 'visible' });
    for (const type of ['Bell', 'Proportional Q', 'Band Shelf', 'Baxandall Bass', 'Baxandall Treble', 'Low Shelf', 'High Shelf']) {
      assert.equal(await dynTypeMenu.getByText(type, { exact: true }).isVisible(), true, 'Dynamic EQ type menu includes ' + type);
    }
    await page.keyboard.press('Escape');
    await dynPop.getByRole('button', { name: 'More settings' }).click();
    await dynPop.locator('.syn-eqx-pop-adv').waitFor({ state: 'visible' });
    assert.equal(await dynPop.getByLabel('Ratio').isVisible(), true, 'advanced Dynamic EQ controls include ratio');
    await page.locator('.syn-deq-addband').click();
    assert.equal(await dynNodes.count(), 3, 'Dynamic EQ + Band adds a graph node');
    await page.locator('.syn-deq .syn-eqx-pop').getByRole('button', { name: 'Delete Band 3' }).click();
    assert.equal(await dynNodes.count(), 2, 'deleting a Dynamic EQ band removes its graph node');
    step('telemetry');
    await page.locator('[data-testid="render-peak-telemetry"]').waitFor({ state: 'visible', timeout: 30000 });

    const exportWav = async (name) => {
      await page.locator('.syn-header-export').click();
      const dialog = page.getByRole('dialog', { name: 'Export Master Audio' });
      await dialog.waitFor({ state: 'visible' });
      await dialog.getByLabel('Output Filename').fill(name);
      await dialog.getByLabel('WAV Bit Depth').selectOption('32');
      const downloadEvent = page.waitForEvent('download', { timeout: 120000 });
      downloadEvent.catch(() => undefined); // surface the real failure instead of this rejection
      await dialog.getByRole('button', { name: 'Render ZIP Package' }).click();
      const download = await downloadEvent;
      const wav = await extractWavFromStoreZip(download);
      await dialog.getByRole('button', { name: 'Close Export Modal' }).click();
      await dialog.waitFor({ state: 'hidden' });
      return wav;
    };

    const power = page.locator('.syn-deq-power');
    if (await power.innerText() === 'ON') await power.click();
    step('export 1');
    const bypassedWav = await exportWav('dynamic-eq-bypassed');
    if (await power.innerText() !== 'ON') await power.click();
    step('export 2');
    const activeWav = await exportWav('dynamic-eq-active');

    const inspect = (wav) => {
      assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
      assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
      const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
      assert.equal(view.getUint16(34, true), 32, 'Export should contain 32-bit float WAV samples');
      const frameCount = (wav.length - 44) / 8;
      const rms = (start, end) => {
        let power = 0;
        const first = Math.floor(frameCount * start);
        const last = Math.floor(frameCount * end);
        for (let i = first; i < last; i++) power += view.getFloat32(44 + i * 8, true) ** 2;
        return Math.sqrt(power / Math.max(1, last - first));
      };
      const sampleRate = view.getUint32(24, true);
      const toneDb = (freq) => {
        const first = Math.floor(frameCount * 0.4);
        const last = Math.floor(frameCount * 0.6);
        const k = 2 * Math.cos((2 * Math.PI * freq) / sampleRate);
        let s1 = 0;
        let s2 = 0;
        for (let i = first; i < last; i++) {
          const s0 = view.getFloat32(44 + i * 8, true) + k * s1 - s2;
          s2 = s1;
          s1 = s0;
        }
        return 10 * Math.log10((s1 * s1 + s2 * s2 - k * s1 * s2) / (last - first) ** 2 + 1e-30);
      };
      return {
        frameCount,
        lowVsRefDb: toneDb(260) - toneDb(1000),
        earlyRms: rms(0.005, 0.025),
        midRms: rms(0.4, 0.6),
        lateRms: rms(0.975, 0.995),
      };
    };

    const bypassed = inspect(bypassedWav);
    const active = inspect(activeWav);
    assert.ok(bypassed.frameCount > 40000, 'Exported WAV must contain the imported song');
    assert.ok(bypassed.earlyRms < bypassed.midRms * 0.3, 'Exported WAV must include the timeline fade-in');
    assert.ok(active.lateRms < active.midRms * 0.3, 'Exported WAV must include the timeline fade-out');
    if (process.env.SYN_DEBUG) console.error('export e2e rms', JSON.stringify({ bypassed, active }));
    let maxDiff = 0;
    const bv = new DataView(bypassedWav.buffer, bypassedWav.byteOffset, bypassedWav.byteLength);
    const av = new DataView(activeWav.buffer, activeWav.byteOffset, activeWav.byteLength);
    for (let o = 44; o + 4 <= Math.min(bypassedWav.length, activeWav.length); o += 4) maxDiff = Math.max(maxDiff, Math.abs(bv.getFloat32(o, true) - av.getFloat32(o, true)));
    if (process.env.SYN_DEBUG) console.error('export e2e max sample diff', maxDiff);
    // The maximizer re-levels the whole master, so compare the 260 Hz band against the 1 kHz reference
    // instead of overall RMS: the Dynamic EQ must cut 260 Hz relative to the untouched partial.
    const deqCutDb = active.lowVsRefDb - bypassed.lowVsRefDb;
    assert.ok(maxDiff > 1e-3, 'Enabling Dynamic EQ must change the exported samples');
    assert.ok(deqCutDb < -1.5, `Enabling Dynamic EQ must cut 260 Hz relative to 1 kHz in the export (got ${deqCutDb.toFixed(2)} dB)`);
    assert.deepEqual(pageErrors, [], `Browser runtime errors during WAV export: ${pageErrors.join('; ')}`);
    console.log('PASS production-browser export: WAV includes timeline fades and Dynamic EQ processing');
  } finally {
    await context.close().catch(() => undefined);
  }
}

try {
  await waitForPreview();
  const browser = await chromium.launch({ headless: true });
  try {
    // SYN_RESPONSIVE_ONLY=360,1440,export runs a subset (local runs are time-limited).
    const only = process.env.SYN_RESPONSIVE_ONLY?.split(',');
    const want = (key) => !only || only.includes(String(key));
    if (want(360)) await runViewport(browser, 360, 800, true);
    if (want(375)) await runViewport(browser, 375, 812, true);
    if (want(412)) await runViewport(browser, 412, 915, true);
    if (want(1024)) await runViewport(browser, 1024, 900, false);
    if (want(1440)) await runViewport(browser, 1440, 1000, false);
    if (want('export')) await runWavExportE2E(browser);
  } finally {
    await browser.close();
  }
} finally {
  server.kill('SIGTERM');
}
