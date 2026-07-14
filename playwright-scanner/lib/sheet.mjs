// 將發現直接寫入 Google Sheet(經 Apps Script Web App 端點),唔使 email。
// 需要:SHEET_WEBHOOK_URL(Apps Script 網頁應用程式 URL)+ WEBHOOK_TOKEN(密碼)

export async function postToSheet(items) {
  const url = process.env.SHEET_WEBHOOK_URL;
  const token = process.env.WEBHOOK_TOKEN;
  if (!url || !token) return { ok: false, skipped: true };
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        items: items.map((it) => ({
          org: it.org,
          title: it.title,
          deadline: it.deadline || '未知',
          url: it.link || it.url || '',
          source: '補漏掃描 (Playwright)',
        })),
      }),
      redirect: 'follow',
    });
    const data = await resp.json().catch(() => ({}));
    return { ok: !!data.ok, added: data.added, raw: data };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}
