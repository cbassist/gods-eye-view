#!/usr/bin/env node
/** Real RTC app QA (no synthetic bus positions or mocked feeds).
 * QA_BASE_URL=http://127.0.0.1:4177 QA_SHOTS_DIR=<approved-dir> node scripts/qa-rtc-arrivals.mjs
 * Uses an isolated Chromium test context, not a user's authenticated browser.
 * Proves source-to-board timestamps, search, map focus, mobile fit, polling and close.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
const base = process.env.QA_BASE_URL || 'http://127.0.0.1:4177';
const output = process.env.QA_SHOTS_DIR;
assert.ok(output, 'QA_SHOTS_DIR is required');
await fs.mkdir(output, { recursive: true });
const browser = await puppeteer.launch({
  headless: true,
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
  args:
    process.platform === 'darwin'
      ? ['--use-angle=metal', '--enable-gpu']
      : ['--use-gl=angle', '--use-angle=swiftshader'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  const snapshots = [],
    errors = [];
  let requests = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    if (r.url().endsWith('/api/rtc-arrivals')) requests++;
  });
  page.on('response', async (r) => {
    if (r.url().endsWith('/api/rtc-arrivals') && r.status() === 200)
      snapshots.push(await r.json());
  });
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForSelector('[data-first-run-choice="explore"]', {
    visible: true,
    timeout: 90000,
  });
  await page.click('[data-first-run-choice="explore"]');
  await page.waitForSelector('#first-run-launcher', { hidden: true });
  await page.click('#location-bar-toggle');
  await page.waitForSelector('#rtc-arrivals-open', { visible: true });
  assert.equal(requests, 0, 'RTC is opt-in');
  await page.click('#rtc-arrivals-open');
  await page.waitForSelector('.rtc-arrival-row time', { timeout: 50000 });
  const data = snapshots[0];
  assert.equal(data.status, 'available');
  assert.ok(data.arrivals.length > 0);
  const first = await page.$eval('.rtc-arrival-row time', (el) => el.dateTime);
  assert.ok(
    data.arrivals.some(
      (row) => new Date(row.arrivalTime * 1000).toISOString() === first,
    ),
    'rendered time is an explicit upstream arrival',
  );
  const selected = data.arrivals.find(
    (row) => row.arrivalTime * 1000 > Date.now() + 300000,
  );
  assert.ok(
    selected,
    'a future arrival leaves time to exercise the stop action',
  );
  await page.type('#rtc-stop-search', selected.stopName);
  await page.waitForFunction(
    (name) => {
      const rows = [...document.querySelectorAll('.rtc-arrival-row strong')];
      return (
        rows.length > 0 && rows.every((el) => el.textContent.includes(name))
      );
    },
    {},
    selected.stopName,
  );
  await page.click(
    `.rtc-arrival-row[data-stop-id=${JSON.stringify(selected.stopId)}] button`,
  );
  await page.waitForFunction(
    ({ lat, lon }) => {
      const p = window.__godsEyeView?.viewer?.camera?.positionCartographic;
      return (
        p &&
        Math.abs(p.height - 900) < 50 &&
        Math.abs((p.latitude * 180) / Math.PI - lat) < 0.01 &&
        Math.abs((p.longitude * 180) / Math.PI - lon) < 0.01
      );
    },
    { timeout: 20000 },
    { lat: selected.latitude, lon: selected.longitude },
  );
  await new Promise((resolve) => setTimeout(resolve, 3000));
  await page.screenshot({ path: path.join(output, 'rtc-desktop.png') });
  await page.setViewport({ width: 390, height: 844 });
  const fits = await page.$eval('#rtc-arrivals-panel', (el) => {
    const r = el.getBoundingClientRect();
    return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
  });
  assert.ok(fits, 'board fits mobile viewport');
  await page.screenshot({ path: path.join(output, 'rtc-mobile.png') });
  await page.waitForResponse(
    (r) => r.url().endsWith('/api/rtc-arrivals') && r.status() === 200,
    { timeout: 75000 },
  );
  assert.ok(requests >= 2, 'open board refreshes');
  await page.click('[aria-label="Close RTC arrivals"]');
  await page.waitForSelector('#rtc-arrivals-panel', { hidden: true });
  const afterClose = requests;
  await new Promise((r) => setTimeout(r, 62000));
  assert.equal(requests, afterClose, 'close stops requests');
  assert.deepEqual(errors, [], 'no uncaught page errors');
  const result = {
    result: 'PASS',
    context:
      'isolated repo QA browser; real upstream static GTFS and trip updates',
    arrivals: data.arrivals.length,
    stops: new Set(data.arrivals.map((r) => r.stopId)).size,
    feedTimestamp: data.feedTimestamp,
    ageSeconds: data.snapshotAgeSeconds,
    staticVersion: data.staticProvenance.feed_version,
    arrivalDisplayed: first,
    requests,
    screenshots: output,
  };
  await fs.writeFile(
    path.join(output, 'verification.json'),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
