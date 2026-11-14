#!/usr/bin/env node
/** Real browser proof, no mocked feeds. Start dev, then:
 * QA_BASE_URL=http://127.0.0.1:4176 QA_SHOTS_DIR=<output-dir> node scripts/qa-san-ysidro-browser.mjs
 * Uses an isolated test browser, never an everyday or authenticated profile.
 * Set PUPPETEER_EXECUTABLE_PATH if the pinned Chrome for Testing is not installed.
 * Upstream outages fail the live-data assertions rather than fabricate records.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';

const url = process.env.QA_BASE_URL || 'http://127.0.0.1:4176';
const output = process.env.QA_SHOTS_DIR;
assert.ok(output, 'Set QA_SHOTS_DIR to an approved artifact directory');
await fs.mkdir(output, { recursive: true });
const browser = await puppeteer.launch({
  headless: true,
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
  args: process.platform === 'darwin'
    ? ['--use-angle=metal', '--enable-gpu']
    : ['--use-gl=angle', '--use-angle=swiftshader'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForSelector('[data-first-run-choice="explore"]', { visible: true, timeout: 90_000 });
  await page.click('[data-first-run-choice="explore"]');
  await page.waitForSelector('#first-run-launcher', { hidden: true });
  await page.waitForSelector('#location-bar-toggle', { timeout: 90_000 });
  await page.click('#location-bar-toggle');
  await page.waitForSelector('#san-ysidro-waits-open', { visible: true });
  await page.click('#san-ysidro-waits-open');
  await page.waitForFunction(() => {
    const p = window.__godsEyeView?.viewer?.camera?.positionCartographic;
    return p && Math.abs(p.latitude * 180 / Math.PI - 32.54) < 0.15 &&
      Math.abs(p.longitude * 180 / Math.PI + 117.03) < 0.15;
  }, { timeout: 45_000 });
  await page.waitForFunction(() => document.querySelectorAll('.border-waits > * .border-lane').length >= 7, { timeout: 45_000 });
  const data = await page.evaluate(async () => {
    const response = await fetch('/api/border-waits/san-ysidro');
    return response.json();
  });
  assert.equal(data.sourceStatus, 'available');
  assert.equal(data.lanes.length, 7);
  assert.equal(data.southbound.sourceStatus, 'available');
  assert.deepEqual(data.southbound.routes.map(route => route.route), ['I-5', 'I-805']);
  await page.waitForSelector('.border-southbound', { visible: true });
  assert.equal(await page.$$eval('.border-southbound article', rows => rows.length), 2);
  assert.equal(await page.$$eval('.border-waits iframe, .border-waits video', rows => rows.length), 0);
  await page.screenshot({ path: path.join(output, 'san-ysidro-desktop.png') });
  const panel = await page.$('.border-waits');
  await panel.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.screenshot({ path: path.join(output, 'san-ysidro-southbound.png') });
  await page.setViewport({ width: 390, height: 844 });
  const bounds = await panel.evaluate(element => {
    const r = element.getBoundingClientRect();
    return { left: r.left, right: r.right, width: innerWidth };
  });
  assert.ok(bounds.left >= 0 && bounds.right <= bounds.width, 'panel fits mobile viewport');
  const unobstructed = await panel.evaluate(element => {
    const button = [...element.querySelectorAll('button')].find(b => b.textContent.includes('Load / refresh Caltrans'));
    button.scrollIntoView({ block: 'center' });
    const r = button.getBoundingClientRect();
    return button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  });
  assert.ok(unobstructed, 'mobile camera action is not covered by the voice dock');

  const cameraButtonHandle = await page.evaluateHandle(() =>
    [...document.querySelectorAll('.border-waits button')].find(b => b.textContent.includes('Load / refresh Caltrans')));
  await cameraButtonHandle.asElement().click();
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll('.border-waits figure img')];
    return images.length === 2 && images.every(image => image.complete && image.naturalWidth > 0);
  }, { timeout: 60_000 });
  await cameraButtonHandle.dispose();
  await page.screenshot({ path: path.join(output, 'san-ysidro-mobile.png') });
  await page.click('[aria-label="Close border waits"]');
  await page.waitForSelector('.border-waits', { hidden: true });
  console.log(JSON.stringify({ result: 'PASS', northboundLanes: data.lanes.length,
    southboundRoutes: data.southbound.routes.length, northboundFetchedAt: data.fetchedAt,
    southboundFetchedAt: data.southbound.fetchedAt, screenshots: output,
    note: 'Actual upstream reports; no claim of calibrated queue geometry or continuous camera playback.' }, null, 2));
} finally {
  await browser.close();
}
