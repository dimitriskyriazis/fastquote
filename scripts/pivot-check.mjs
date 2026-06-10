import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1900, height: 950 } });

let summaryFetches = 0;
page.on('request', (req) => {
  if (req.url().includes('/api/offered-products/summary')) summaryFetches += 1;
});

await page.goto('http://localhost:3000/offered-products', { waitUntil: 'networkidle', timeout: 120000 });
await page.getByRole('button', { name: 'Pivot Mode' }).click();
await page.waitForSelector('.ag-pivot-mode-panel', { timeout: 30000 });
await page.waitForTimeout(6000);
const fetchesAfterOpen = summaryFetches;

// Type and delete letter by letter in the brand combobox
const brand = page.getByPlaceholder('Brand: All');
await brand.click();
await brand.pressSequentially('barco', { delay: 120 });
for (let i = 0; i < 5; i += 1) await brand.press('Backspace', { delay: 120 });
await page.waitForTimeout(1500);

// The pivot grid should never have been replaced by the loading placeholder
const gridStillThere = await page.evaluate(() => document.querySelectorAll('.ag-root-wrapper').length >= 2);
console.log(JSON.stringify({
  fetchesAfterOpen,
  fetchesDuringTyping: summaryFetches - fetchesAfterOpen,
  gridStillThere,
}));

await page.screenshot({ path: 'scripts/pivot-check.png' });
await browser.close();
