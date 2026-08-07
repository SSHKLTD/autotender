# n8n 整合 — 補漏掃描結果自動寫入 Google Sheet

用 n8n Cloud 做「橋」,將 GitHub Actions 上 Playwright 補漏掃描嘅發現
**直接寫入你現有 Google Sheet**(「Tender List (for AI)」)嘅「掃描發現」分頁。

好處:**唔使部署 Apps Script Web App、唔使 SMTP** —— n8n 喺 UI 度連一次
Google 帳戶就搞掂。呢個 workflow 只喺補漏掃描有發現時先執行(每日最多一次),
用量極低,唔會食晒 n8n Cloud 個 execution quota。

## 設定步驟(一次過,約 5 分鐘)

### 1. Import workflow
n8n → **Workflows → ⋯ → Import from File** → 揀 `autotender-findings-workflow.json`

### 2. 連 Google 帳戶
撳「寫入 Google Sheet」個 node → Credential 揀 **Create new credential**
→ 用 Google 帳戶登入授權(OAuth,喺 n8n 入面完成,唔使貼 key 俾任何人)

### 3. 改 Token
撳「驗證 Token」個 node → 將 `CHANGE_ME_SECRET_TOKEN` 改做你自訂嘅一串密碼

### 4. 攞 Webhook URL
撳「Webhook (收補漏掃描結果)」個 node → copy 個 **Production URL**
(似 `https://你的帳戶.app.n8n.cloud/webhook/autotender-findings`)

### 5. 喺 Google Sheet 加「掃描發現」分頁
開你個「Tender List (for AI)」,新增一個叫 `掃描發現` 嘅分頁,
第一行貼入表頭(7 欄):

```
發現日期	機構名稱	標書項目名稱	截標日期	來源	連結	狀態
```

(如果你已經用緊最新 `apps-script/Code.gs`,主掃描第一次跑會自動建立呢個分頁,咁就唔使手動加。)

### 6. 設 GitHub Secrets
Repo **Settings → Secrets and variables → Actions** 加:

| Secret | 值 |
| --- | --- |
| `SHEET_WEBHOOK_URL` | 步驟 4 個 Production URL |
| `WEBHOOK_TOKEN` | 步驟 3 你自訂嗰串密碼 |

### 7. Activate
喺 n8n 將個 workflow 較做 **Active**。搞掂。

## 測試

喺終端機(或者任何 HTTP 工具)發個測試 POST:

```bash
curl -X POST "你的WebhookURL" \
  -H "Content-Type: application/json" \
  -d '{"token":"你的密碼","items":[{"org":"測試機構","title":"Test Tender","deadline":"2026-12-31","url":"https://example.com","source":"測試"}]}'
```

之後開 Sheet 嘅「掃描發現」分頁,應該見到一行新資料。

## 技術備註

- Playwright scanner 個 payload 格式同 Apps Script Web App 完全一樣
  (`{token, items:[{org,title,deadline,url,source}]}`),所以兩條橋任用一條,
  `SHEET_WEBHOOK_URL` 指去邊個就用邊個。
- 去重由 scanner 自己個 `state/seen_items.json` 負責,n8n 呢邊唔使理。
- Scanner 冇發現時唔會 POST,所以 n8n 唔會有空執行。
- n8n Cloud 唔支援 Puppeteer 社群 node,所以爬 Cloudflare 站嗰部分
  維持喺 GitHub Actions(免費 quota 內)用 Playwright 做,n8n 純做寫入。
