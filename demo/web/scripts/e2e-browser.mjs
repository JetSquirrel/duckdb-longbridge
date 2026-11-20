// Browser end-to-end check for the DuckDB Trading Lab demo.
//
//   node scripts/e2e-browser.mjs                  # local: spawns sidecar + vite
//   BASE_URL=https://example.com node scripts/e2e-browser.mjs
//                                                 # remote: no local servers
//   PRESET=4 node scripts/e2e-browser.mjs         # run preset dropdown option N
//   SQL_FILE=/tmp/q.sql node scripts/e2e-browser.mjs
//                                                 # paste arbitrary SQL into the editor
//   JEV_KEY=... JEV_ENDPOINT=https://host/jev node scripts/e2e-browser.mjs
//                                                 # fill the settings panel before reload
//
// Drives the page with headless Chrome: connect (INSTALL/LOAD both unsigned
// extensions), run the default query, assert the result grid shows 10 rows
// with a signal.action column whose values are buy/hold/sell.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import puppeteer from 'puppeteer';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..');
const sidecarDir = join(webRoot, '..', 'sidecar');

const REMOTE = process.env.BASE_URL || null;
const PRESET = process.env.PRESET ?? null;
const SQL_FILE = process.env.SQL_FILE || null;
// Jev settings-panel overrides. JEV_KEY: API key typed into the password box
// (never logged). JEV_ENDPOINT: value typed into the endpoint box; unset means
// "leave the UI default untouched".
const JEV_KEY = process.env.JEV_KEY || null;
const JEV_ENDPOINT = process.env.JEV_ENDPOINT ?? null;
const SIDECAR_PORT = 8787;
const VITE_PORT = 5199;
const BASE = REMOTE ?? `http://localhost:${VITE_PORT}`;

const children = [];
function run(cmd, args, opts) {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  child.log = '';
  child.stdout.on('data', (d) => (child.log += d));
  child.stderr.on('data', (d) => (child.log += d));
  children.push(child);
  return child;
}

function cleanup() {
  for (const child of children) {
    try {
      child.kill('SIGTERM');
    } catch {}
  }
}

async function waitForUrl(url, timeoutMs, fetchOpts) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, fetchOpts);
      if (res.status < 500) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${url} (${lastErr ?? 'no response'})`);
}

let browser;
const pageLogs = [];
try {
  if (REMOTE) {
    await waitForUrl(`${REMOTE}/healthz`, 30_000);
    console.log(`remote target ${REMOTE} is up`);
  } else {
    run('node', ['server.js'], { cwd: sidecarDir });
    run('npx', ['vite', '--port', String(VITE_PORT), '--strictPort'], { cwd: webRoot });

    await waitForUrl(`http://localhost:${SIDECAR_PORT}/`, 30_000);
    await waitForUrl(BASE, 60_000);
    console.log('sidecar and vite dev server are up');
  }

  browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  page.on('console', (msg) => pageLogs.push(`[console.${msg.type()}] ${msg.text()}`));
  page.on('pageerror', (err) => pageLogs.push(`[pageerror] ${err.message}`));

  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 60_000 });

  if (JEV_KEY !== null || JEV_ENDPOINT !== null) {
    // Fill the Jev settings BEFORE reloading extensions. The page auto-connects
    // on load with the defaults; let that finish, then reload with our config.
    await page.click('header button.ghost');
    await page.evaluate(
      ({ key, endpoint }) => {
        const setVal = (el, v) => {
          // React controls the inputs: go through the native value setter and
          // fire an input event for the onChange to fire.
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setter.call(el, v);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        if (key !== null) setVal(document.querySelector('.config-row input[type="password"]'), key);
        if (endpoint !== null)
          setVal(document.querySelector('.config-row input:not([type="password"])'), endpoint);
      },
      { key: JEV_KEY, endpoint: JEV_ENDPOINT },
    );
    console.log(
      `jev settings: key ${JEV_KEY ? 'filled from env (not shown)' : 'left empty'}, ` +
        `endpoint ${JEV_ENDPOINT ?? 'left at UI default'}`,
    );
    const waitConnected = () =>
      page.waitForFunction(() => !document.querySelector('header button.primary').disabled, {
        timeout: 180_000,
      });
    await waitConnected();
    await page.click('header button.primary');
    await waitConnected();
  } else {
    // Connect / Reload extensions
    await page.click('header button.primary');
    // The extension pills live inside the Settings panel — reveal them.
    await page.click('header button.ghost');
  }
  await page.waitForFunction(
    () => {
      const pills = [...document.querySelectorAll('.ext-pill')];
      return pills.length === 2 && pills.every((p) => p.textContent.includes('(loaded)'));
    },
    { timeout: 180_000 },
  );
  console.log('both extension pills report loaded');

  // Swap in a preset or arbitrary SQL before running, if requested.
  if (SQL_FILE) {
    const sqlText = readFileSync(SQL_FILE, 'utf8');
    await page.evaluate((text) => {
      const ta = document.querySelector('.sql-editor');
      // React controls the textarea, so go through the native value setter
      // and fire an input event for the onChange to fire.
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, text);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }, sqlText);
    console.log(`loaded SQL from ${SQL_FILE}`);
  } else if (PRESET !== null) {
    await page.select('.sql-toolbar select', PRESET);
    const label = await page.evaluate(
      (i) => document.querySelectorAll('.sql-toolbar select option')[Number(i) + 1].textContent,
      PRESET,
    );
    console.log(`selected preset ${PRESET}: ${label}`);
  }

  // Run the query
  const startedAt = Date.now();
  await page.click('.sql-toolbar button.primary');
  await page.waitForFunction(
    () => document.querySelectorAll('.result-grid tbody tr').length > 0 ||
          document.querySelector('.error-box'),
    { timeout: 180_000 },
  );
  console.log(`query finished in ${((Date.now() - startedAt) / 1000).toFixed(1)}s (wall clock)`);

  const grid = await page.evaluate(() => {
    const headers = [...document.querySelectorAll('.result-grid thead th')].map((th) => th.textContent);
    const rows = [...document.querySelectorAll('.result-grid tbody tr')].map((tr) =>
      [...tr.querySelectorAll('td')].map((td) => td.textContent),
    );
    const error = document.querySelector('.error-box')?.textContent ?? null;
    return { headers, rows, error };
  });

  if (grid.error) throw new Error(`page reported an error: ${grid.error}`);
  console.log(`first row: ${JSON.stringify(grid.rows[0])}`);

  const failures = [];
  const isDefaultQuery = PRESET === null && !SQL_FILE;
  if (isDefaultQuery && grid.rows.length !== 10) {
    failures.push(`expected 10 rows, got ${grid.rows.length}`);
  } else if (grid.rows.length < 1) {
    failures.push('expected at least 1 row, got 0');
  }
  const actionIdx = grid.headers.findIndex((h) => h === 'signal.action' || h === 'action');
  if (actionIdx === -1) {
    failures.push(`no action column in headers: ${JSON.stringify(grid.headers)}`);
  } else {
    const allowed = new Set(['buy', 'hold', 'sell']);
    const bad = grid.rows.filter((r) => !allowed.has(r[actionIdx]));
    if (bad.length > 0) {
      failures.push(
        `${bad.length} rows have unexpected action values: ${JSON.stringify(bad.map((r) => r[actionIdx]))}`,
      );
    }
  }
  const riskIdx = grid.headers.findIndex((h) => h === 'signal.risk' || h === 'risk');
  if (riskIdx !== -1) {
    // A LIST criterion is a jev score question: the answer is a DOUBLE on the
    // rubric scale (e.g. 0..2 for [low, medium, high]), not the level name.
    const bad = grid.rows.filter((r) => r[riskIdx] === 'NULL' || r[riskIdx] === '' ||
                                        Number.isNaN(Number(r[riskIdx])));
    if (bad.length > 0) {
      failures.push(
        `${bad.length} rows have missing/non-numeric risk scores: ${JSON.stringify(bad.map((r) => r[riskIdx]))}`,
      );
    }
  }

  if (failures.length > 0) {
    console.error('FAIL');
    for (const f of failures) console.error(`  - ${f}`);
    console.error('page console logs:');
    for (const line of pageLogs.slice(-50)) console.error(`  ${line}`);
    process.exitCode = 1;
  } else {
    console.log(`result grid: ${grid.rows.length} rows, headers: ${grid.headers.join(', ')}`);
    console.log(`signal.action values: ${[...new Set(grid.rows.map((r) => r[actionIdx]))].join(', ')}`);
    console.log('PASS');
  }
} catch (err) {
  console.error(`FAIL: ${err instanceof Error ? err.message : err}`);
  if (pageLogs.length > 0) {
    console.error('page console logs:');
    for (const line of pageLogs.slice(-50)) console.error(`  ${line}`);
  }
  for (const child of children) {
    if (child.log) console.error(`--- output of pid ${child.pid} ---\n${child.log.slice(-3000)}`);
  }
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  cleanup();
}
