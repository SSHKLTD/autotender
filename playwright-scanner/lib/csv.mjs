// 極簡 CSV 讀寫(處理引號、逗號、換行),對應 data/organisations.csv 格式
import fs from 'node:fs';

export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  // 去 BOM
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') { /* skip */ }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 1 || (r.length === 1 && r[0] !== ''));
}

export function loadOrganisations(path) {
  const rows = parseCsv(fs.readFileSync(path, 'utf8'));
  const header = rows[0];
  return rows.slice(1).map((r, idx) => ({
    idx,
    name: (r[0] || '').trim(),
    url: (r[1] || '').trim(),
    category: (r[2] || '').trim(),
    linkStatus: (r[3] || '').trim(),
    lastLog: (r[4] || '').trim(),
    remark: (r[5] || '').trim(),
  })).filter(o => o.name && o.url);
}
