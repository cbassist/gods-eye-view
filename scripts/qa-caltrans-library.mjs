#!/usr/bin/env node
/**
 * Live Caltrans browser smoke test against an already running candidate server.
 * PUPPETEER_EXECUTABLE_PATH=/path/to/chrome node scripts/qa-caltrans-library.mjs http://127.0.0.1:4176
 * No fixtures: two official feeds, real Browse/Add, row counts and removal.
 * A new isolated browser profile is closed on exit; no server lifecycle actions.
 */
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
const base = process.argv[2] || 'http://localhost:4173';
const browser = await puppeteer.launch({
  executablePath:
    process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
  headless: true,
  defaultViewport: { width: 1440, height: 900 },
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader'],
});
try {
  const page = await browser.newPage();
  const responses = [];
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('response', (response) => {
    if (response.url().includes('cwwp2.dot.ca.gov/data/'))
      responses.push({ url: response.url(), status: response.status() });
  });
  await page.evaluateOnNewDocument(() =>
    localStorage.setItem('gev:first-run-mission:v1', 'suppressed'),
  );
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      window.__gevDataLibrary?.library.ready &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 180000 },
  );
  await page.evaluate(() =>
    document.getElementById('data-library-browse').click(),
  );
  for (const district of [7, 11]) {
    const id = `caltrans-lcs-d${district}`;
    await page.click(
      `#data-library button[data-library-id="${id}"][data-library-action="add"]`,
    );
    await page.waitForFunction(
      (id) => {
        const row = document.querySelector(
          `#data-toggles [data-library-entry="${id}"]`,
        );
        return (
          row
            ?.querySelector('.data-toggle-btn')
            ?.classList.contains('active') &&
          /^\d+$/.test(row.querySelector('.data-count')?.textContent || '')
        );
      },
      { timeout: 60000 },
      id,
    );
    console.log(
      JSON.stringify(
        await page.evaluate(
          (id) => ({
            id,
            count: document.querySelector(
              `#data-toggles [data-library-entry="${id}"] .data-count`,
            ).textContent,
            registered: window.__godsEyeView.dataManager.layers.has(
              `lib-${id}`,
            ),
          }),
          id,
        ),
      ),
    );
  }
  assert.equal(responses.length, 2);
  assert.ok(responses.every((response) => response.status === 200));
  assert.deepEqual(errors, []);
  await page.evaluate(async () => {
    for (const id of ['caltrans-lcs-d7', 'caltrans-lcs-d11'])
      await window.__gevDataLibrary.library.remove(id);
  });
  assert.equal(
    await page.evaluate(
      () =>
        window.__godsEyeView.dataManager.layers.has('lib-caltrans-lcs-d7') ||
        window.__godsEyeView.dataManager.layers.has('lib-caltrans-lcs-d11'),
    ),
    false,
  );
  console.log(
    JSON.stringify({
      passed: true,
      responses,
      pageErrors: errors,
      removed: true,
    }),
  );
} finally {
  await browser.close();
}
