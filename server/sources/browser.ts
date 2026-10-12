import { chromium, type Browser, type Page } from 'playwright';

/**
 * One shared, ordinary Chromium. No stealth, no fingerprint tricks: if a site
 * shows a security check, we stop and hand the link to the person instead.
 */
let browser: Promise<Browser> | null = null;
let queue: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;
const MIN_GAP_MS = 2500;

export class CheckRequired extends Error {}

function getBrowser(): Promise<Browser> {
  browser ??= chromium.launch({ headless: true }).catch(error => {
    browser = null;
    throw error;
  });
  return browser;
}

/** Runs one page visit at a time, politely spaced. */
export function withPage<T>(url: string, work: (page: Page) => Promise<T>): Promise<T> {
  const run = async () => {
    const wait = lastRequestAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    lastRequestAt = Date.now();
    const context = await (await getBrowser()).newContext({ locale: 'ru-RU' });
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      const title = await page.title();
      if (/проверка безопасности|captcha|access denied/i.test(title)) {
        throw new CheckRequired('Сайт попросил пройти проверку. Откройте ссылку сами.');
      }
      return await work(page);
    } finally {
      await context.close();
    }
  };
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}

export async function closeBrowser() {
  if (browser) await (await browser).close().catch(() => undefined);
  browser = null;
}
