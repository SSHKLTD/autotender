// 過濾:先用關鍵字粗篩候選連結,再(如有 DeepSeek API key)交 AI 判斷
// 主要目的是否為 8 類目標服務、以及有冇過期。無 key 就淨用關鍵字。

const TARGET_KEYWORDS = [
  'social media', 'digital marketing', 'video production', 'videography', 'photography',
  'event management', 'event production', 'public relations', 'publicity', 'marketing',
  'advertising', 'media buy', 'media planning', 'branding', 'campaign', 'creative services',
  'content creation', 'influencer', 'promotion', 'audio-visual', 'av production',
  '社交媒體', '數碼營銷', '市場推廣', '宣傳', '推廣', '廣告', '公關',
  '影片', '短片', '攝影', '錄影', '活動策劃', '活動製作', '媒體',
];

// 真標書信號詞(避免拎到導覽列雜訊)
const TENDER_SIGNALS = [
  'tender', 'rfp', 'request for proposal', 'request for quotation', 'quotation',
  'call for proposal', 'invitation to', 'expression of interest', 'eoi',
  '招標', '報價', '標書', '邀請', '建議書', '徵求',
];

export function keywordCandidates(links) {
  const seen = new Set();
  const out = [];
  for (const { text, href } of links) {
    const low = text.toLowerCase();
    const matched = TARGET_KEYWORDS.filter((k) => low.includes(k));
    if (!matched.length) continue;
    const hasSignal = TENDER_SIGNALS.some((s) => low.includes(s));
    const key = text.slice(0, 120);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title: text, link: href, matched, hasSignal });
  }
  // 有 tender 信號詞嘅排前
  out.sort((a, b) => Number(b.hasSignal) - Number(a.hasSignal));
  return out;
}

// DeepSeek AI 判斷(同 Apps Script 一致):主要目的是否符合 8 類、有冇過期
export async function aiAnalyse(pageText, todayStr) {
  const key = process.env.AI_API_KEY;
  if (!key) return null;
  const url = process.env.AI_API_URL || 'https://api.deepseek.com/v1/chat/completions';
  const model = process.env.AI_MODEL || 'deepseek-chat';
  const clean = pageText.slice(0, 22000);
  const prompt = `你是一個極度嚴格、絕對不容忍「過期標書」與「無關項目」的招標篩選專家。
今天的日期是:${todayStr} (格式: YYYY-MM-DD)

我們【只要】以下 8 類服務的公開招標:
1. Social media marketing 2. Digital marketing 3. Video production 4. Photography
5. Event management 6. General marketing 7. Issue management 8. Public relations

【排除】旅遊/機票/酒店、車輛/巴士營運、建築工程/裝修/物管/保安清潔、IT系統開發/伺服器、招商引資/經貿推廣。

任務:
1. 網頁是否有標書【主要目的】符合上述 8 類服務?
2. 找出截標日期,如【早於或等於】今天 (${todayStr}) 即已過期,isSuitable 必為 false。
3. 符合且未過期,提取截止日期填 tenderDeadline。

嚴格用以下 JSON 回覆,不要 Markdown:
{"isSuitable": false, "tenderTitle": "", "tenderDeadline": "YYYY-MM-DD 或 未知"}

網頁文字:
${clean}`;

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.1,
      }),
    });
    const data = await resp.json();
    return JSON.parse(data.choices[0].message.content);
  } catch {
    return null;
  }
}
