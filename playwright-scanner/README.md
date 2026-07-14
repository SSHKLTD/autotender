# Playwright 補漏掃描器

主掃描器(`apps-script/Code.gs`,行喺 Google Sheet)用嘅 `UrlFetchApp`
**唔識行 JavaScript**,所以有防護嘅網站抓唔到:

- **Cloudflare「Just a moment…」JS challenge** — HKTB、西九、香港芭蕾舞團、
  HKECIC、東華學院、YMCA 等
- **靠 JS 先 render 出內容嘅頁** — 例如 HKPC(fetch 返 200 但得個空殼)
- **連線被 reset / 需要完整瀏覽器指紋** — 部分大學同 NGO

呢個補漏掃描器用 **Playwright 真.headless Chromium** 專攻嗰批站,同主掃描互補。

## 點樣避免同主掃描重覆?

Scanner 會先用普通 `fetch` **探測**每個網址:

- 探測**成功**(真.內容頁)→ 代表 Apps Script 都掃到 → **交返俾主掃描**,唔理
- 探測**失敗**(403 / Cloudflare / 空殼 / 連線失敗)→ **先用 Playwright** 抓

咁就自動 focus 喺受阻站,唔使人手維護清單,網站改咗防護都會自動適應。

## 流程

1. 讀 `../data/organisations.csv`
2. 普通 fetch 探測,揀出受阻站
3. Playwright 真瀏覽器抓(自動等 Cloudflare challenge 過)
4. 關鍵字粗篩候選連結 → (如有 `AI_API_KEY`)交 DeepSeek AI 判斷主要目的 + 有冇過期
5. 對照 `state/seen_items.json` 去重
6. 有嘢就 email 俾同事(預設 `alex@sshk.ltd`)
7. 更新 `state/seen_items.json`

## 本地執行

```bash
cd playwright-scanner
npm install
npx playwright install chromium

# 只掃「探測失敗」嘅受阻站,唔發 email(測試)
node scan.mjs --dry-run

# 強制掃全部 183 個(慢,一般唔需要)
node scan.mjs --all --dry-run

# 正式(需要 SMTP 環境變數)
SMTP_HOST=smtp.gmail.com SMTP_PORT=587 \
SMTP_USER=you@example.com SMTP_PASS=app_password \
RECIPIENTS=alex@sshk.ltd node scan.mjs
```

## GitHub Actions

`.github/workflows/playwright-scan.yml` 每日香港時間 **10:00**
(排喺 Apps Script 主掃描 09:30 之後)自動執行,亦可喺 Actions 頁手動觸發。

需要喺 repo **Settings → Secrets and variables → Actions** 設定:

| Secret | 說明 |
| --- | --- |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | 發 email 用嘅 SMTP |
| `MAIL_FROM` | 寄件人(可選,預設同 `SMTP_USER`) |
| `RECIPIENTS` | 收件人,逗號分隔(可選,預設 `alex@sshk.ltd`) |
| `AI_API_KEY` | DeepSeek API key(可選;冇就用純關鍵字 + tender 信號詞保守篩選) |
| `AI_API_URL` / `AI_MODEL` | 可選,預設 DeepSeek |

> 冇設定 `AI_API_KEY` 都行得:會用「關鍵字 + tender/RFP/招標 信號詞」保守篩選,
> 但就冇 AI 幫手判斷截標日期有冇過期,可能有少量過期或無關項目,email 內會標明。

## 同主掃描嘅分工

| | 主掃描 (Apps Script) | 補漏掃描 (呢個) |
| --- | --- | --- |
| 執行環境 | Google Sheet 定時 trigger | GitHub Actions |
| 抓取方式 | UrlFetchApp(無 JS) | Playwright 真瀏覽器 |
| 負責網站 | 一般可直接抓嘅站 | Cloudflare / JS 渲染 / 受阻站 |
| 時間 | 每日 09:30 | 每日 10:00 |
| 收件人 | `alex@sshk.ltd` | `alex@sshk.ltd` |
