// autotender 補漏掃描器
// 流程:讀機構名單 → 普通 fetch 探測 → 只對「抓唔到」嘅站用 Playwright 真瀏覽器
//       → 關鍵字 + AI 過濾 → 對照已見紀錄去重 → email 俾同事 → 更新紀錄
//
// 與 Apps Script 主掃描互補:fetch 得到嘅站留返俾 Apps Script,避免重覆通知。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOrganisations } from './lib/csv.mjs';
import { launchBrowser, newContext, fetchPage } from './lib/browser.mjs';
import { keywordCandidates, aiAnalyse } from './lib/filter.mjs';
import { buildHtml, sendEmail } from './lib/email.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const CSV_PATH = path.join(REPO, 'data', 'organisations.csv');
const STATE_PATH = path.join(REPO, 'playwright-scanner', 'state', 'seen_items.json');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const CHALLENGE_MARKERS = ['Just a moment', 'Attention Required', 'Checking your browser', 'cf-browser-verification'];

const RECIPIENTS = (process.env.RECIPIENTS || 'alex@sshk.ltd')
  .split(',').map((s) => s.trim()).filter(Boolean);

const DRY_RUN = process.argv.includes('--dry-run');
const SCAN_ALL = process.argv.includes('--all'); // 預設只掃探測失敗嘅站

function hkNow() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 16).replace('T', ' ');
}
function todayStr() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); }
  catch { return { seen: {} }; }
}
function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

// 普通 fetch 探測:成功(真.內容頁)就代表 Apps Script 都掃到 → 唔使 Playwright
async function probe(url) {
  try {
    const ctrl = AbortSignal.timeout(20000);
    const resp = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-HK,zh;q=0.9,en;q=0.8' },
      redirect: 'follow',
      signal: ctrl,
    });
    if ([401, 403, 406, 429, 503].includes(resp.status)) return { accessible: false, reason: `HTTP ${resp.status}` };
    if (resp.status >= 400) return { accessible: false, reason: `HTTP ${resp.status}` };
    const body = await resp.text();
    if (body.length < 1500) return { accessible: false, reason: '內容過短(疑 JS 渲染)' };
    if (CHALLENGE_MARKERS.some((m) => body.includes(m))) return { accessible: false, reason: 'Cloudflare 攔截' };
    return { accessible: true, reason: 'ok' };
  } catch (e) {
    return { accessible: false, reason: '連線失敗:' + String(e.name || e.message || e) };
  }
}

async function main() {
  const orgs = loadOrganisations(CSV_PATH);
  const state = loadState();
  const today = todayStr();
  const scanTime = hkNow();
  console.log(`[${scanTime}] 補漏掃描開始,共 ${orgs.length} 個機構`);

  // 1. 探測:揀出 Apps Script 掃唔到、需要 Playwright 嘅站
  const needBrowser = [];
  for (const o of orgs) {
    if (SCAN_ALL) { needBrowser.push({ org: o, reason: '(--all)' }); continue; }
    const p = await probe(o.url);
    if (!p.accessible) needBrowser.push({ org: o, reason: p.reason });
  }
  console.log(`需用真瀏覽器嘅受阻站:${needBrowser.length} 個`);

  const newItems = [];
  const stillBlocked = [];

  // 2. Playwright 逐個抓
  const browser = await launchBrowser();
  const ctx = await newContext(browser);
  try {
    for (const { org, reason } of needBrowser) {
      let res;
      try {
        res = await fetchPage(ctx, org.url);
      } catch (e) {
        res = { ok: false, error: String(e.message || e) };
      }
      if (!res.ok) {
        console.log(`  ✗ ${org.name} — ${res.error || (res.challenged ? '仍被攔截' : 'HTTP ' + res.status)}`);
        stillBlocked.push({ name: org.name, url: org.url, reason: res.challenged ? '真瀏覽器仍被攔截' : (res.error || `HTTP ${res.status}`) });
        continue;
      }
      // 3. 過濾:關鍵字候選 → AI 判斷
      const cands = keywordCandidates(res.links);
      let picked = null;
      const ai = await aiAnalyse(res.text, today);
      if (ai && ai.isSuitable) {
        picked = { title: ai.tenderTitle || (cands[0] && cands[0].title) || '(見網頁)', link: org.url, deadline: ai.tenderDeadline };
      } else if (!process.env.AI_API_KEY && cands.length) {
        // 無 AI key:用「關鍵字 + tender 信號詞」嘅候選作保守通知
        const strong = cands.find((c) => c.hasSignal);
        if (strong) picked = { title: strong.title, link: strong.link, deadline: '未知(未經AI判斷)' };
      }

      if (picked) {
        const uid = `${org.name}::${String(picked.title).trim().toLowerCase()}`;
        if (state.seen[uid]) {
          console.log(`  = ${org.name} — 《${picked.title}》屬歷史重覆,跳過`);
        } else {
          console.log(`  ★ ${org.name} — 新標書:《${picked.title}》`);
          newItems.push({ org: org.name, ...picked, uid });
        }
      } else {
        console.log(`  ○ ${org.name} — 抓取成功,暫無合適標書`);
      }
    }
  } finally {
    await ctx.close();
    await browser.close();
  }

  console.log(`結果:新標書 ${newItems.length} 個,仍受阻 ${stillBlocked.length} 個`);

  if (DRY_RUN) { console.log('(--dry-run:唔發 email、唔更新紀錄)'); return; }

  // 4. Email
  if (newItems.length || stillBlocked.length) {
    const subject = `[autotender補漏] ${newItems.length} 個新標書 · ${stillBlocked.length} 個仍受阻 — ${scanTime}`;
    const html = buildHtml(newItems, stillBlocked, scanTime);
    const sent = await sendEmail(subject, html, RECIPIENTS);
    if (sent) console.log(`已發送 email 俾 ${RECIPIENTS.join(', ')}`);
  }

  // 5. 更新已見紀錄
  for (const it of newItems) state.seen[it.uid] = scanTime;
  saveState(state);
}

main().catch((e) => { console.error('掃描失敗:', e); process.exit(1); });
