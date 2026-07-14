// ============================================================
// autotender — 香港招標自動監控 (Google Apps Script)
// 改良版:支援向多位同事發送 email、批次續跑防超時、
//         修正「同一URL第二份新標書被誤判為歷史重覆」嘅 bug
// ============================================================

// 填入你喺 DeepSeek 或 OpenRouter 申請嘅 API Key
const AI_API_KEY = '##API_key###';
const AI_API_URL = 'https://api.deepseek.com/v1/chat/completions';
const AI_MODEL = 'deepseek-chat';

// 🌟【新】同事收件人名單:綜合報告會發俾以下所有人
//    留空 [] 就會 fallback 返發俾執行 script 嘅人自己
const RECIPIENTS = [
  // 'colleague1@sshk.ltd',
  // 'colleague2@sshk.ltd',
];

// 🌟【新】單次執行時間上限(毫秒)。超過就自動儲存進度,
//    開一個一次性 trigger 一分鐘後由斷點繼續掃,唔會由頭嚟過。
//    Workspace 帳戶上限 30 分鐘,預留 buffer 設 20 分鐘。
const MAX_RUNTIME_MS = 20 * 60 * 1000;

const TARGET_SERVICES = ['social media marketing', 'digital marketing', 'video production', 'photography', 'event management', 'general marketing', 'issue management', 'public relations'];

function mainTenderScanner() {
  const startTime = Date.now();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('list');
  const data = sheet.getDataRange().getValues();

  // 1. 初始化或檢查 Sent_Log 架構
  let logSheet = ss.getSheetByName('Sent_Log');
  if (!logSheet) {
    logSheet = ss.insertSheet('Sent_Log');
    logSheet.appendRow(['Date', 'URL', 'Tender Title', 'Tender Deadline']);
  }

  let todayStr = Utilities.formatDate(new Date(), "GMT+8", "yyyy-MM-dd");

  // 🌟 由 ScriptProperties 讀返上次斷點(冇就由第二行開始)
  const props = PropertiesService.getScriptProperties();
  let startRow = parseInt(props.getProperty('SCAN_NEXT_ROW') || '1', 10);
  let summaryReport = JSON.parse(props.getProperty('SCAN_SUMMARY') || 'null') || {
    suitableTenders: [], // 儲存全新發現的合適標書
    blockedUrls: [],     // 儲存需要人手排查的受阻網站
    deadUrls: []         // 儲存確定死Link的網站
  };
  if (startRow > 1) {
    Logger.log(`由斷點第 ${startRow + 1} 行繼續掃描`);
  }

  let fetchOptions = {
    "muteHttpExceptions": true,
    "followRedirects": true,
    "headers": {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "Accept-Language": "zh-HK,zh;q=0.9,en-US;q=0.8,en;q=0.7"
    }
  };

  for (let i = startRow; i < data.length; i++) {

    // 🌟 時間守衛:快夠鐘就儲低進度,一分鐘後自動續跑
    if (Date.now() - startTime > MAX_RUNTIME_MS) {
      props.setProperty('SCAN_NEXT_ROW', String(i));
      props.setProperty('SCAN_SUMMARY', JSON.stringify(summaryReport));
      const trigger = ScriptApp.newTrigger('mainTenderScanner')
        .timeBased().after(60 * 1000).create();
      props.setProperty('SCAN_CONT_TRIGGER_ID', trigger.getUniqueId());
      Logger.log(`⏸️ 執行 ${Math.round((Date.now() - startTime) / 60000)} 分鐘,已掃到第 ${i} 行,1 分鐘後自動續跑`);
      return;
    }

    let orgName = data[i][0];
    let url = data[i][1];
    if (!url) continue;

    try {
      let response = UrlFetchApp.fetch(url, fetchOptions);
      let responseCode = response.getResponseCode();
      let htmlContent = response.getContentText();

      // 智能化破解網頁層面跳轉 (解決 HKU 類型的 Meta Refresh)
      let redirectUrl = null;
      let metaMatch = htmlContent.match(/<meta[^>]+http-equiv=["']refresh["'][^>]+url=["']?([^"' >]+)/i);
      let jsMatch = htmlContent.match(/window\.location\.href\s*=\s*["']([^"']+)["']/i) || htmlContent.match(/window\.location\.replace\s*\(\s*["']([^"']+)["']/i);

      if (metaMatch && metaMatch[1]) redirectUrl = metaMatch[1];
      else if (jsMatch && jsMatch[1]) redirectUrl = jsMatch[1];

      if (redirectUrl) {
        let fullRedirectUrl = resolveUrl(redirectUrl, url);
        response = UrlFetchApp.fetch(fullRedirectUrl, fetchOptions);
        responseCode = response.getResponseCode();
        htmlContent = response.getContentText();
      }

      // 【過濾 1】防爬蟲攔截 ➡️ 寫入試算表,並塞入綜合電郵待手動處理
      if (responseCode === 403 || responseCode === 401 || responseCode === 429 || htmlContent.length < 600) {
        updateStatus(sheet, i + 1, "受阻", `🔒 網站防爬蟲攔截 (${responseCode}),已加入綜合報告提示手動檢查`);
        summaryReport.blockedUrls.push({ orgName: orgName, url: url });
        continue;
      }

      // 【過濾 2】真正死 Link (404) ➡️ 寫入試算表,塞入綜合電郵待刪除
      if (responseCode === 404 || htmlContent.includes("404 Not Found") || htmlContent.includes("Page Not Found")) {
        updateStatus(sheet, i + 1, "失效", `❌ 確定死Link,已加入綜合報告待處理`);
        summaryReport.deadUrls.push({ orgName: orgName, url: url });
        continue;
      }

      // 2. 呼叫 AI 進行過濾
      let aiAnalysis = analyzeContentWithAI(htmlContent, url, todayStr);

      // 深入子網頁分析
      if (aiAnalysis.needDeepCrawl && aiAnalysis.subUrls.length > 0) {
        let foundInSub = false;
        for (let subUrl of aiAnalysis.subUrls) {
          let fullSubUrl = resolveUrl(subUrl, url);
          let subResponse = UrlFetchApp.fetch(fullSubUrl, fetchOptions);
          let subHtml = subResponse.getContentText();
          let subAnalysis = analyzeContentWithAI(subHtml, fullSubUrl, todayStr);

          if (subAnalysis.isSuitable) {
            processFoundTender(orgName, subAnalysis.tenderTitle, subAnalysis.tenderDeadline, fullSubUrl, sheet, i + 1, logSheet, summaryReport);
            foundInSub = true;
            break;
          }
        }
        if (!foundInSub) {
          updateStatus(sheet, i + 1, "正常", `掃描完成:已深入子網頁,確認暫無合適新標書`);
        }
      }
      // 主頁命中合適標書
      else if (aiAnalysis.isSuitable) {
        processFoundTender(orgName, aiAnalysis.tenderTitle, aiAnalysis.tenderDeadline, url, sheet, i + 1, logSheet, summaryReport);
      }
      else {
        updateStatus(sheet, i + 1, "正常", `掃描完成:暫無符合條件之新標書`);
      }

    } catch (e) {
      updateStatus(sheet, i + 1, "受阻", `🌐 網絡連線超時,已加入綜合報告提示手動檢查`);
      summaryReport.blockedUrls.push({ orgName: orgName, url: url });
    }

    Utilities.sleep(1500); // 降噪防 Block 停頓
  }

  // 🌟 掃完全部:清走斷點紀錄同續跑 trigger,先至發報告
  props.deleteProperty('SCAN_NEXT_ROW');
  props.deleteProperty('SCAN_SUMMARY');
  cleanupContinuationTrigger(props);

  // 🌟【核心步驟】全掃描完成後,統一發送一封精美的 HTML 綜合報告電郵
  sendConsolidatedEmail(summaryReport, todayStr);
}

// Apps Script V8 冇瀏覽器嘅 URL class,自製相對路徑解析
function resolveUrl(href, baseUrl) {
  if (/^https?:\/\//i.test(href)) return href;
  const m = baseUrl.match(/^(https?:\/\/[^\/]+)(\/.*)?$/i);
  if (!m) return href;
  const origin = m[1];
  if (href.startsWith('//')) return baseUrl.split(':')[0] + ':' + href;
  if (href.startsWith('/')) return origin + href;
  const basePath = (m[2] || '/').replace(/[^\/]*$/, '');
  return origin + basePath + href;
}

// 續跑完成後,按紀錄低嘅 trigger ID 清理自己開嘅一次性 trigger,
// 唔會掂你手動設定嘅每 3 日定時 trigger
function cleanupContinuationTrigger(props) {
  const triggerId = props.getProperty('SCAN_CONT_TRIGGER_ID');
  if (!triggerId) return;
  for (const t of ScriptApp.getProjectTriggers()) {
    if (t.getUniqueId() === triggerId) {
      ScriptApp.deleteTrigger(t);
    }
  }
  props.deleteProperty('SCAN_CONT_TRIGGER_ID');
}

// AI 核心過濾
function analyzeContentWithAI(htmlText, currentUrl, todayDate) {
  let cleanText = htmlText.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                          .replace(/<[^>]*>/g, ' ')
                          .replace(/\s+/g, ' ')
                          .substring(0, 22000);

  const prompt = `
    你是一個極度嚴格、絕對不容忍「過期標書」與「無關項目」的招標篩選專家。
    今天的日期是:${todayDate} (格式: YYYY-MM-DD)

    我們【只要】以下 8 類服務的公開招標(Tender):
    1. Social media marketing | 2. Digital marketing | 3. Video production | 4. Photography
    5. Event management | 6. General marketing | 7. Issue management | 8. Public relations

    【❌ 嚴格禁止 / 絕對排除以下無關領域】:
    - 任何旅遊、機票、酒店、企業旅遊代理服務 (Corporate Travel / Travel Services)
    - 任何車輛採購、租車、小巴/巴士營運服務、司機服務 (Private Light Bus / Coach Rental)
    - 任何建築工程、裝修維修、物業管理、保安清潔、硬件設備採購
    - 任何 IT 系統開發、伺服器維護、網絡保安(除非純粹是數碼營銷工具)
    - 任何政府或機構的「招商引資」、「促進外來投資」、「經貿代表推廣」(Inward Investment / Trade Exhibition Partner)

    【審查任務】:
    1. 網頁文字中是否有標書【主要目的】強烈符合上述 8 類服務?
    2. 找出該標書的「截標日期」(Closing Date/End Date/Deadline)。如果該日期【早於或等於】今天 (${todayDate}),即代表已過期,必須判定 isSuitable 為 false!
    3. 如果符合上述服務且【未過期】,請提取其截止日期填入 "tenderDeadline"。

    請嚴格以下列 JSON 格式回覆,不要包含任何 Markdown 標記或解釋文字:
    {
      "isSuitable": false,
      "tenderTitle": "標書完整標題",
      "tenderDeadline": "YYYY-MM-DD (若找不到填未知)",
      "needDeepCrawl": false,
      "subUrls": []
    }

    網頁文字內容:
    ${cleanText}
  `;

  try {
    const response = UrlFetchApp.fetch(AI_API_URL, {
      "method": "post",
      "headers": { "Authorization": "Bearer " + AI_API_KEY, "Content-Type": "application/json" },
      "payload": JSON.stringify({
        "model": AI_MODEL,
        "messages": [{ "role": "user", "content": prompt }],
        "response_format": { "type": "json_object" },
        "temperature": 0.1
      }),
      "muteHttpExceptions": true
    });
    const resData = JSON.parse(response.getContentText());
    return JSON.parse(resData.choices[0].message.content);
  } catch (err) {
    return { "isSuitable": false, "tenderTitle": "", "tenderDeadline": "", "needDeepCrawl": false, "subUrls": [] };
  }
}

// 檢查重複、記錄歷史並將新發現塞入 summaryReport
// 🌟【修正】舊版只用 URL 比對,導致同一個招標專頁出咗第二份新標書時,
//    會被誤判為「歷史重覆項目」跳過(例:HKDC 同一頁先後出
//    Communications Services 同 Digital Marketing Services 兩份標書)。
//    而家改用 URL + 標書標題 一齊比對。
function processFoundTender(orgName, tenderTitle, tenderDeadline, url, sheet, rowIndex, logSheet, summaryReport) {
  let logData = logSheet.getDataRange().getValues();
  const normTitle = String(tenderTitle).trim().toLowerCase();
  for (let i = 0; i < logData.length; i++) {
    if (logData[i][1] === url && String(logData[i][2]).trim().toLowerCase() === normTitle) {
      updateStatus(sheet, rowIndex, "正常", `發現標書《${tenderTitle}》,但屬歷史重覆項目,跳過`);
      return;
    }
  }

  // 寫入包含 Deadline 欄位的 Log 紀錄,防止下次重複通知
  logSheet.appendRow([new Date(), url, tenderTitle, tenderDeadline]);
  updateStatus(sheet, rowIndex, "正常", `🔥 發現合適標書並已記錄:${tenderTitle} (截止: ${tenderDeadline})`);

  // 塞入綜合電郵陣列
  summaryReport.suitableTenders.push({
    orgName: orgName,
    title: tenderTitle,
    deadline: tenderDeadline,
    url: url
  });
}

// 建立並發送精美的 HTML 綜合大報告
// 🌟【新】發送對象改為 RECIPIENTS 同事名單(留空就發俾自己)
function sendConsolidatedEmail(summary, dateStr) {
  // 如果三個陣列都是空的(即世界和平,沒新標書、沒死link、沒阻擋),可選擇不發信或發一封平安信
  if (summary.suitableTenders.length === 0 && summary.blockedUrls.length === 0 && summary.deadUrls.length === 0) {
    return; // 這裡設定為完全沒有特別事情就不發信騷擾你
  }

  let toList = RECIPIENTS.length > 0 ? RECIPIENTS.join(',') : Session.getActiveUser().getEmail();
  let subject = `【📊 綜合標書自動監控報告】${dateStr}`;

  // 開始排版 HTML 電郵內容
  let htmlBody = `<div style="font-family: 'Microsoft JhengHei', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 800px; margin: 0 auto; border: 1px solid #e0e0e0; padding: 20px; border-radius: 8px;">`;
  htmlBody += `<h2 style="color: #1a73e8; border-bottom: 2px solid #1a73e8; padding-bottom: 10px; margin-top: 0;">🔍 標書定期掃描綜合報告 (${dateStr})</h2>`;
  htmlBody += `<p style="font-size: 14px;">你好,系統已順利完成定期公開招標網頁 Full Scan。以下是為你統整的行動清單:</p><br>`;

  // --- 區域一:全新發現的合適標書 ---
  htmlBody += `<h3 style="color: #2e7d32; background-color: #e8f5e9; padding: 8px 12px; border-left: 5px solid #2e7d32; margin-bottom: 10px;">🎯 全新發現的合適標書 (${summary.suitableTenders.length})</h3>`;
  if (summary.suitableTenders.length === 0) {
    htmlBody += `<p style="color: #777; font-style: italic; font-size: 13px; padding-left: 15px;">本次掃描暫無發現全新未讀的 Marketing / PR 相關標書。</p>`;
  } else {
    htmlBody += `<table border="1" cellpadding="10" cellspacing="0" style="border-collapse: collapse; width: 100%; border-color: #e0e0e0; font-size: 14px; text-align: left;">`;
    htmlBody += `<tr style="background-color: #f5f5f5; font-weight: bold;"><th>機構名稱</th><th>標書項目名稱</th><th>截標日期</th><th>操作動作</th></tr>`;
    for (let t of summary.suitableTenders) {
      htmlBody += `<tr>` +
                  `<td><b>${t.orgName}</b></td>` +
                  `<td>${t.title}</td>` +
                  `<td style="color: #d32f2f; font-weight: bold;">${t.deadline}</td>` +
                  `<td><a href="${t.url}" style="background-color: #2e7d32; color: white; padding: 4px 8px; text-decoration: none; border-radius: 4px; font-size: 12px;" target="_blank">直達標書</a></td>` +
                  `</tr>`;
    }
    htmlBody += `</table>`;
  }
  htmlBody += `<br><br>`;

  // --- 區域二:被防爬蟲攔截的受阻網站(需要手動把關) ---
  htmlBody += `<h3 style="color: #e65100; background-color: #fff3e0; padding: 8px 12px; border-left: 5px solid #e65100; margin-bottom: 10px;">🔒 網站防禦受阻 / 需人手檢查 (${summary.blockedUrls.length})</h3>`;
  htmlBody += `<p style="font-size: 13px; color: #555; padding-left: 5px;">以下公營或政府機構安裝了防火牆封鎖了自動化機器。<b>為確保無漏網之魚,請直接點擊連結進行手動快閃檢查:</b></p>`;
  if (summary.blockedUrls.length === 0) {
    htmlBody += `<p style="color: #777; font-style: italic; font-size: 13px; padding-left: 15px;">暫無受阻網站,所有連結皆成功完成自動化解析。</p>`;
  } else {
    htmlBody += `<ul style="padding-left: 20px; font-size: 14px;">`;
    for (let b of summary.blockedUrls) {
      htmlBody += `<li style="margin-bottom: 8px;"><b>${b.orgName}</b> ➡️ <a href="${b.url}" style="color: #e65100; font-weight: bold; text-decoration: underline;" target="_blank">按此開啟招標專頁</a></li>`;
    }
    htmlBody += `</ul>`;
  }
  htmlBody += `<br><br>`;

  // --- 區域三:確定失效的死 Link ---
  htmlBody += `<h3 style="color: #c62828; background-color: #ffebee; padding: 8px 12px; border-left: 5px solid #c62828; margin-bottom: 10px;">❌ 確定失效 / 死 Link 警告 (${summary.deadUrls.length})</h3>`;
  if (summary.deadUrls.length === 0) {
    htmlBody += `<p style="color: #777; font-style: italic; font-size: 13px; padding-left: 15px;">非常健康!本次掃描未發現任何 404 失效網址。</p>`;
  } else {
    htmlBody += `<p style="font-size: 13px; color: #555; padding-left: 5px;">以下網址確定回傳 404 錯誤,請有空時手動到試算表修改或刪除:</p>`;
    htmlBody += `<ul style="padding-left: 20px; font-size: 14px; color: #c62828;">`;
    for (let d of summary.deadUrls) {
      htmlBody += `<li style="margin-bottom: 6px;"><b>${d.orgName}</b>: <a href="${d.url}" target="_blank" style="color: #c62828;">${d.url}</a></li>`;
    }
    htmlBody += `</ul>`;
  }

  htmlBody += `<br><hr style="border: 0; border-top: 1px solid #e0e0e0;"><p style="font-size: 11px; color: #999; text-align: center;">本郵件由你的 Google Sheets 自動化腳本系統定期發出。</p></div>`;

  // 正式發送
  MailApp.sendEmail({
    to: toList,
    subject: subject,
    htmlBody: htmlBody
  });
}

function updateStatus(sheet, rowIndex, connectionStatus, activityLog) {
  let now = Utilities.formatDate(new Date(), "GMT+8", "yyyy-MM-dd HH:mm");
  sheet.getRange(rowIndex, 4).setValue(connectionStatus);
  sheet.getRange(rowIndex, 5).setValue(`[${now}] ${activityLog}`);
}
