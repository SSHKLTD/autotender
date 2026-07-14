// 用 nodemailer 經 SMTP 發送 HTML 補漏報告
import nodemailer from 'nodemailer';

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function buildHtml(newItems, stillBlocked, scanTime) {
  let h = `<div style="font-family:'Microsoft JhengHei',Arial,sans-serif;max-width:760px;margin:0 auto;color:#333">`;
  h += `<h2 style="color:#6a1b9a;border-bottom:2px solid #6a1b9a;padding-bottom:8px">🕵️ 補漏掃描報告 (Playwright) — ${esc(scanTime)}</h2>`;
  h += `<p style="font-size:13px;color:#666">此報告只涵蓋 Apps Script 無法抓取(Cloudflare 攔截 / JS 渲染)嘅網站,與主掃描互補。</p>`;

  h += `<h3 style="color:#2e7d32;background:#e8f5e9;padding:8px 12px;border-left:5px solid #2e7d32">🎯 受阻站中發現的合適標書 (${newItems.length})</h3>`;
  if (!newItems.length) {
    h += `<p style="color:#777;font-style:italic;padding-left:15px">今次於受阻網站暫無發現全新合適標書。</p>`;
  } else {
    h += `<table border="1" cellpadding="9" cellspacing="0" style="border-collapse:collapse;width:100%;border-color:#ddd;font-size:14px">`;
    h += `<tr style="background:#f5f5f5;font-weight:bold"><th>機構</th><th>標書</th><th>截標</th><th></th></tr>`;
    for (const t of newItems) {
      h += `<tr><td><b>${esc(t.org)}</b></td><td>${esc(t.title)}</td>` +
        `<td style="color:#d32f2f;font-weight:bold">${esc(t.deadline || '未知')}</td>` +
        `<td><a href="${esc(t.link)}" style="background:#2e7d32;color:#fff;padding:4px 8px;border-radius:4px;text-decoration:none;font-size:12px" target="_blank">開啟</a></td></tr>`;
    }
    h += `</table>`;
  }

  h += `<h3 style="color:#e65100;background:#fff3e0;padding:8px 12px;border-left:5px solid #e65100;margin-top:20px">🔒 連 Playwright 都抓唔到 / 需人手檢查 (${stillBlocked.length})</h3>`;
  if (!stillBlocked.length) {
    h += `<p style="color:#777;font-style:italic;padding-left:15px">全部受阻站今次都成功用真瀏覽器抓取。</p>`;
  } else {
    h += `<ul style="font-size:14px">`;
    for (const b of stillBlocked) {
      h += `<li style="margin-bottom:6px"><b>${esc(b.name)}</b> — ${esc(b.reason)} ➡️ <a href="${esc(b.url)}" target="_blank">手動開啟</a></li>`;
    }
    h += `</ul>`;
  }

  h += `<hr style="border:0;border-top:1px solid #eee;margin-top:20px"><p style="font-size:11px;color:#999;text-align:center">autotender Playwright 補漏掃描器 · GitHub Actions 自動發出</p></div>`;
  return h;
}

export async function sendEmail(subject, html, recipients) {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.MAIL_FROM || user;
  if (!host || !user || !pass) {
    console.log('⚠️ 未設定 SMTP 環境變數,略過發送。報告內容:\n' + html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 800));
    return false;
  }
  const transporter = nodemailer.createTransport({
    host, port, secure: port === 465, auth: { user, pass },
  });
  await transporter.sendMail({ from, to: recipients.join(','), subject, html });
  return true;
}
