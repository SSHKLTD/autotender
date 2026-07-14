# autotender — 香港招標自動監控

用 Google Sheets + Apps Script 自動掃描香港各政府部門、公營機構、法定機構、
大學、社福機構等嘅招標專頁,以 AI(DeepSeek)過濾出同 social media / marketing /
公關宣傳相關嘅 potential tender,再自動發送綜合報告 email 俾同事。

## Repo 結構

| 路徑 | 用途 |
| --- | --- |
| `apps-script/Code.gs` | 改良版掃描 script(貼入 Google Sheet 嘅 Apps Script 編輯器) |
| `data/Tender_Organisations.xlsx` | 重建後嘅完整機構列表(Excel 版) |
| `data/organisations.csv` | 同一份列表嘅 CSV 版(UTF-8) |
| `data/new_organisations_only.csv` | 只包含今次新增機構,方便直接貼入現有 Google Sheet |

## 兩種通知方式:email 或直接更新 Google Sheet

`Code.gs` 頂部有兩個開關:

```js
const SEND_EMAIL = true;      // 發綜合報告 email
const WRITE_TO_SHEET = true;  // 將發現直接寫入「掃描發現」分頁
```

- 想**唔要 email、淨係更新 Sheet**:設 `SEND_EMAIL = false; WRITE_TO_SHEET = true;`
- 「掃描發現」分頁會自動建立,最新發現永遠置頂,一開 Sheet 就見到,方便定期查看。
- 主掃描同 Playwright 補漏掃描嘅發現都會集中喺呢個分頁(來源欄區分)。

## 改良版 Code.gs 對比原版嘅分別

1. **向同事群發報告** — 頂部新增 `RECIPIENTS` 名單,綜合報告會發俾名單上所有同事;
   留空就照舊只發俾自己。
2. **修正歷史重覆判斷 bug** — 原版只用 URL 比對 `Sent_Log`,當同一個招標專頁
   出咗第二份新標書(例如 HKDC 同一頁先後出 Communications Services 同
   Digital Marketing Services 兩份 RFP),會被誤判為「歷史重覆項目」而跳過。
   而家改用 **URL + 標書標題** 一齊比對。
3. **批次續跑防超時** — 機構名單擴充後掃一次需時更長,新增時間守衛:
   單次執行超過 `MAX_RUNTIME_MS`(預設 20 分鐘)就自動儲存斷點,
   開一個一次性 trigger 一分鐘後由斷點繼續,掃完先發 email,唔會重覆掃或漏掃。
4. **修正相對路徑解析** — Apps Script V8 runtime 冇瀏覽器嘅 `new URL()`,
   原版處理 meta-refresh 跳轉時會拋錯落入 catch 被當成「網絡連線超時」;
   而家用自製 `resolveUrl()` 處理。

## 更新步驟

1. 開你嘅 Google Sheet「Tender List (for AI)」
2. **擴充機構名單**:將 `data/new_organisations_only.csv` 入面嘅新機構
   貼入 `list` 分頁最底(欄位次序一樣:機構名稱、招標專頁網址、分類)
   — 或者直接用 `data/Tender_Organisations.xlsx` 成個列表換入去
3. **更新 script**:擴充功能 → Apps Script,將 `apps-script/Code.gs` 成個檔案
   內容覆蓋原有 script
4. 喺 `Code.gs` 頂部:
   - 填返你嘅 `AI_API_KEY`
   - 喺 `RECIPIENTS` 加入同事 email,例:
     ```js
     const RECIPIENTS = [
       'colleague1@sshk.ltd',
       'colleague2@sshk.ltd',
     ];
     ```
5. 定時 trigger 照舊(每 3 日行一次 `mainTenderScanner`)

## 注意事項

- 新增機構後首次 Full Scan 需時較耐(約 15–25 分鐘,視乎 AI 回應速度);
  超過 20 分鐘會自動分段續跑,屬正常現象。
- 有啲機構網站(HKTB、西九、海洋公園、香港郵政等)有防爬蟲攔截,
  會照舊喺報告嘅「受阻」區列出,提示人手快閃檢查。
- `Sent_Log` 分頁係去重紀錄,唔好刪走,否則舊標書會被重覆通知。
