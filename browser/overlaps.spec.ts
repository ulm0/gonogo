/** The overlap checker (geometry.ts, overlaps) finds each kind it names, and keeps quiet on a page laid out right. */
import { expect, test } from '@playwright/test';
import { overlaps } from './geometry.js';

test.use({ viewport: { width: 400, height: 300 } });

test('a clean page has no overlap', async ({ page }) => {
  await page.setContent(`<body style="margin:0;font:14px sans-serif">
    <p>One line of text</p><p>Another line</p>
    <span style="display:block;width:60px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">a long name cut with an ellipsis</span><span>next</span>
    <details><summary>Folded</summary><p style="margin-top:-40px">hidden text laid out over the rest</p></details>
    <nav style="position:sticky;bottom:0;background:#fff;height:40px">bar</nav></body>`);
  expect(await overlaps(page)).toEqual([]);
});

test('text drawn on text', async ({ page }) => {
  await page.setContent(`<body style="margin:0;font:14px sans-serif"><p>Flight Plan assigned</p><span class="chip" style="position:absolute;top:2px;left:20px">READ</span></body>`);
  expect(await overlaps(page)).toEqual([expect.stringMatching(/^text on text: /)]);
});

test('a popover off the screen', async ({ page }) => {
  await page.setContent(`<body style="margin:0"><div role="dialog" style="position:absolute;top:250px;left:10px;width:100px;height:120px">menu</div></body>`);
  expect(await overlaps(page)).toEqual([expect.stringMatching(/^off screen: /)]);
});

test('content left under a bottom bar at the end of the page', async ({ page }) => {
  await page.setContent(`<body style="margin:0;font:14px sans-serif"><div style="height:600px"></div>
    <nav style="position:fixed;bottom:0;left:0;right:0;height:60px;background:#fff">bar</nav><p style="margin:0">the last line</p></body>`);
  expect(await overlaps(page)).toEqual([expect.stringMatching(/^under the bar: at the end of the page nav/)]);
});
