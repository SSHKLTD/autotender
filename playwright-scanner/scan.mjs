// autotender 全量掃描器(Sheets-free 主掃描)
// 流程:讀機構名單 → 普通 fetch 全部站(成功就直接就地內容掃描)
//       → 抓唔到嘅站先用 Playwright 真瀏覽器 → 關鍵字 + AI 過濾
//       → 對照已見紀錄去重 → 寫入 state/findings.csv(dashboard 每日讀呢度)
//
// 唯一呈現介面係 Claude dashboard artifact;Google Sheet / email 為可選舊路。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOrganisations } from './lib/csv.mjs';
import { launchBrowser, newContext, fetchPage } from './lib/browser.mjs';
import { keywordCandidates, aiAnalyse } from './lib/filter.mjs';
import { buildHtml, sendEmail } from './lib/email.mjs';
import { postToSheet } from './lib/sheet.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const CSV_PATH = path.join(REPO, 'data', 'organisations.csv');
const STATE_PATH = path.join(REPO, 'playwright-scanner', 'state', 'seen_items.json');
const FINDINGS_CSV = path.join(REPO, 'playwright-scanner', 'state', 'findings.csv');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const CHALLENGE_MARKERS = ['Just a moment', 'Attention Required', 'Checking your browser', 'cf-browser-verification'];

const RECIPIENTS = (process.env.RECIPIENTS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

const DRY_RUN = process.argv.includes('--dry-run');

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

// 由普通 fetch 攞返嚟嘅 HTML 抽 links + 純文字(Playwright 路徑先有 DOM,呢度用輕量 regex)
function extractFromHtml(html, baseUrl) {
  const noScript = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
  const links = [];
  const re = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(noScript)) !== null && links.length < 400) {
    const text = m[2].replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    if (text.length < 8) continue;
    let href;
    try { href = new URL(m[1], baseUrl).href; } catch { continue; }
    links.push({ text, href });
  }
  const text = noScript
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { links, text };
}

// 普通 fetch:成功就連內容一齊帶返嚟就地掃描,失敗先交 Playwright
async function plainFetch(url) {
  try {
    const ctrl = AbortSignal.timeout(20000);
    const resp = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-HK,zh;q=0.9,en;q=0.8' },
      redirect: 'follow',
      signal: ctrl,
    });
    if (resp.status >= 400) return { accessible: false, reason: `HTTP ${resp.status}` };
    const body = await resp.text();
    if (body.length < 1500) return { accessible: false, reason: '內容過短(疑 JS 渲染)' };
    if (CHALLENGE_MARKERS.some((mk) => body.includes(mk))) return { accessible: false, reason: 'Cloudflare 攔截' };
    return { accessible: true, body, finalUrl: resp.url || url };
  } catch (e) {
    return { accessible: false, reason: '連線失敗:' + String(e.name || e.message || e) };
  }
}

// 過濾:AI(有 key 時)判斷一項;無 key 就收最多 3 個「關鍵字+標書信號詞」強候選
async function pickItems(org, links, text, today, baseUrl) {
  const items = [];
  const cands = keywordCandidates(links, baseUrl || org.url);
  if (process.env.AI_API_KEY) {
    const ai = await aiAnalyse(text, today);
    if (ai && ai.isSuitable) {
      items.push({
        title: ai.tenderTitle || (cands[0] && cands[0].title) || '(見網頁)',
        link: (cands[0] && cands[0].link) || org.url,
        deadline: ai.tenderDeadline || '未知',
      });
    }
  } else {
    for (const c of cands.filter((c) => c.hasSignal).slice(0, 3)) {
      items.push({ title: c.title, link: c.link, deadline: '未知(未經AI判斷)' });
    }
  }
  return items;
}

async function main() {
  const orgs = loadOrganisations(CSV_PATH);
  const state = loadState();
  const today = todayStr();
  const scanTime = hkNow();
  console.log(`[${scanTime}] 全量掃描開始,共 ${orgs.length} 個機構`);

  const newItems = [];
  const stillBlocked = [];
  const needBrowser = [];
  let okCount = 0;

  const collect = async (org, links, text, baseUrl) => {
    const picked = await pickItems(org, links, text, today, baseUrl);
    let fresh = 0;
    for (const it of picked) {
      const uid = `${org.name}::${String(it.title).trim().toLowerCase()}`;
      if (state.seen[uid]) continue;
      newItems.push({ org: org.name, ...it, uid });
      fresh++;
    }
    if (fresh) console.log(`  ★ ${org.name} — ${fresh} 個新候選:《${newItems.slice(-fresh).map((x) => x.title).join('》《')}》`);
    return fresh;
  };

  // 1. 普通 fetch 全部站;成功嘅即場內容掃描,失敗嘅排隊等 Playwright
  for (const org of orgs) {
    const p = await plainFetch(org.url);
    if (!p.accessible) { needBrowser.push({ org, reason: p.reason }); continue; }
    okCount++;
    const { links, text } = extractFromHtml(p.body, p.finalUrl);
    await collect(org, links, text, p.finalUrl);
  }
  console.log(`普通 fetch 掃完 ${okCount} 個站;需用真瀏覽器:${needBrowser.length} 個`);

  // 2. 受阻站行 Playwright
  const browser = await launchBrowser();
  const ctx = await newContext(browser);
  try {
    for (const { org } of needBrowser) {
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
      const fresh = await collect(org, res.links, res.text);
      if (!fresh) console.log(`  ○ ${org.name} — 抓取成功,暫無合適新標書`);
    }
  } finally {
    await ctx.close();
    await browser.close();
  }

  console.log(`結果:新標書候選 ${newItems.length} 個,仍受阻 ${stillBlocked.length} 個`);

  if (DRY_RUN) { console.log('(--dry-run:唔寫紀錄)'); return; }

  // 3.【主要出口】寫入 state/findings.csv,workflow commit 後 dashboard 每日讀呢度
  if (newItems.length) {
    const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
    if (!fs.existsSync(FINDINGS_CSV)) {
      fs.writeFileSync(FINDINGS_CSV, '﻿發現日期,機構名稱,標書項目名稱,截標日期,連結,來源\n');
    }
    const lines = newItems
      .map((it) => [scanTime, it.org, it.title, it.deadline || '未知', it.link || '', '全量掃描'].map(esc).join(','))
      .join('\n');
    fs.appendFileSync(FINDINGS_CSV, lines + '\n');
    console.log(`已記錄 ${newItems.length} 個發現到 state/findings.csv`);
  }

  // 4.(可選舊路)Google Sheet webhook / email — 冇設定 secrets 就自動跳過
  if (newItems.length) {
    const r = await postToSheet(newItems);
    if (r.ok) console.log(`已寫入 Google Sheet:新增 ${r.added} 個`);
  }
  if (RECIPIENTS.length && (newItems.length || stillBlocked.length)) {
    const subject = `[autotender] ${newItems.length} 個新標書 · ${stillBlocked.length} 個受阻 — ${scanTime}`;
    const sent = await sendEmail(subject, buildHtml(newItems, stillBlocked, scanTime), RECIPIENTS);
    if (sent) console.log(`已發送 email 俾 ${RECIPIENTS.join(', ')}`);
  }

  // 5. 更新已見紀錄
  for (const it of newItems) state.seen[it.uid] = scanTime;
  saveState(state);
}

main().catch((e) => { console.error('掃描失敗:', e); process.exit(1); });
