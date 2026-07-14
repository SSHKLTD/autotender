// Playwright 真瀏覽器抓頁:過 Cloudflare「Just a moment...」JS challenge、
// render 靠 JS 先出內容嘅網頁,再抽出正文同連結。
import { chromium } from 'playwright';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const CHALLENGE_MARKERS = [
  'Just a moment',
  'Attention Required',
  'cf-browser-verification',
  'Checking your browser',
  'Enable JavaScript and cookies to continue',
];

export async function launchBrowser() {
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  const opts = { args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] };
  if (proxy) opts.proxy = { server: proxy };
  return chromium.launch(opts);
}

export async function newContext(browser) {
  const ctx = await browser.newContext({
    userAgent: UA,
    locale: 'zh-HK',
    viewport: { width: 1366, height: 900 },
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: {
      'Accept-Language': 'zh-HK,zh;q=0.9,en;q=0.8',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });
  // 輕量隱藏 webdriver 特徵
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  return ctx;
}

// 抓一頁,盡量等 Cloudflare challenge 過。回傳 { status, title, text, links[] }
export async function fetchPage(ctx, url, { timeout = 45000 } = {}) {
  const page = await ctx.newPage();
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    // 等 challenge:最多等 3 輪、每輪 4 秒,睇 challenge marker 有冇消失
    for (let attempt = 0; attempt < 3; attempt++) {
      const body = await page.evaluate(() => document.body?.innerText || '');
      if (!CHALLENGE_MARKERS.some((m) => body.includes(m))) break;
      await page.waitForTimeout(4000);
    }
    // 俾 JS 渲染多一陣
    await page.waitForTimeout(2500);
    const status = resp ? resp.status() : 0;
    const title = await page.title();
    const text = (await page.evaluate(() => document.body?.innerText || '')).replace(/\s+/g, ' ').trim();
    const links = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href]'))
        .map((a) => ({ text: (a.textContent || '').replace(/\s+/g, ' ').trim(), href: a.href }))
        .filter((l) => l.text.length >= 8)
    );
    const challenged = CHALLENGE_MARKERS.some((m) => text.includes(m) || title.includes(m));
    return { ok: !challenged && text.length > 200, status, title, text, links, challenged };
  } catch (e) {
    return { ok: false, status: 0, title: '', text: '', links: [], error: String(e.message || e) };
  } finally {
    await page.close();
  }
}
