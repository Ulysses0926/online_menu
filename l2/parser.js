/* LINE 收單整理器 — 解析核心（純規則，瀏覽器與 node 共用）
 * 輸入：menu JSON（見 menu_greenspace.json）＋ LINE 對話文字
 * 輸出：{ orders:[{person,item,category,choice,variant,qty,price,confidence,raw}], unmatched:[{person,raw,reason}], people:[...] }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OrderParser = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  // ── 字元正規化：異體字、全半形、空白 ──
  const VARIANTS = { '鷄': '雞', '雞': '雞', '蕃': '番', '麵': '麵', '面': '麵', '奬': '獎', '菓': '果', '裏': '裡', '着': '著', '妳': '你' };
  const norm = s => (s || '')
    .replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)) // 全形→半形
    .replace(/[　\s]+/g, '')
    .replace(/[（）()\[\]【】「」『』\-—–_~～·•・]/g, '')
    .replace(/./g, ch => VARIANTS[ch] || ch)
    .toLowerCase();

  const CN_NUM = { '一': 1, '二': 2, '兩': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
  const UNIT = '(?:份|個|个|杯|碗|鍋|客|盤|盒|條|塊|支|瓶|罐|包|片|套|人份)';

  // ── 抽數量：×2、x2、*2、2份、兩份、各一 ──
  function extractQty(text) {
    let qty = 1, t = text;
    let m = t.match(/[x×\*＊]\s*(\d+)/i);
    if (m) { qty = +m[1]; t = t.replace(m[0], ''); return { qty, t }; }
    m = t.match(new RegExp('(\\d+)\\s*' + UNIT));
    if (m) { qty = +m[1]; t = t.replace(m[0], ''); return { qty, t }; }
    m = t.match(new RegExp('([一二兩两三四五六七八九十])' + UNIT));
    if (m) { qty = CN_NUM[m[1]] || 1; t = t.replace(m[0], ''); return { qty, t }; }
    m = t.match(/(\d+)\s*$/);
    if (m && +m[1] < 20) { qty = +m[1]; t = t.replace(m[0], ''); }
    return { qty, t };
  }

  // ── bigram Dice 相似度（字串模糊比對）──
  function bigrams(s) { const r = []; for (let i = 0; i < s.length - 1; i++) r.push(s.slice(i, i + 2)); return r; }
  function dice(a, b) {
    if (!a || !b) return 0;
    if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
    const A = bigrams(a), B = new Map();
    bigrams(b).forEach(g => B.set(g, (B.get(g) || 0) + 1));
    let hit = 0; A.forEach(g => { if (B.get(g)) { hit++; B.set(g, B.get(g) - 1); } });
    return 2 * hit / (A.length + b.length - 1);
  }

  // ── 展開菜單成可比對的候選清單 ──
  function compile(menu) {
    const cands = [];
    menu.categories.forEach(cat => {
      (cat.items || []).forEach(item => {
        const names = [item.name, ...(item.aliases || [])].map(norm);
        cands.push({ item, cat, names, choices: item.choices || [], variants: cat.variants || [] });
      });
    });
    return cands;
  }

  // 從文字裡找選項／規格詞（吃掉後回傳剩餘字串）
  function pickWords(text, words) {
    // 所有選項的所有寫法一起依長度排序，最長優先（避免「飯」先吃掉「換拌飯」）
    const all = [];
    words.forEach(w => [w.label || w, ...((w.aliases) || [])].forEach(l => { const n = norm(l); if (n) all.push([n, w.label || w]); }));
    all.sort((a, b) => b[0].length - a[0].length);
    for (const [l, label] of all) if (text.includes(l)) return { hit: label, t: text.replace(l, '') };
    return { hit: null, t: text };
  }

  // ── 單一「品項片段」比對 ──
  const PREFIX_RE = /^(?:我要|我想要|我想吃|想吃|想要|我點|幫我點|幫我|給我|來一份|來一個|來|改成|改為|改|換成|換|點|吃|要|一樣是|是)+/;
  function analyze(q0, c) {
    let q = q0.replace(PREFIX_RE, '');
    // 1) 找最長的品名（含別名）直接包含
    const key = c.names.reduce((a, n) => (n && q.includes(n) && n.length > a.length ? n : a), '');
    let score, rest;
    if (key) { rest = q.replace(key, ''); score = 1; }
    else {
      // 2) 模糊：先剝掉選項／規格／數量再比
      rest = q; let core = q;
      const ch0 = pickWords(core, c.choices); core = ch0.t; const va0 = pickWords(core, c.variants); core = va0.t; core = extractQty(core).t;
      score = 0; c.names.forEach(n => { if (n) score = Math.max(score, dice(core, n) * 0.9); });
      if (!score) return null;
      rest = q.replace(core, '');
    }
    const ch = pickWords(rest, c.choices); rest = ch.t;
    const va = pickWords(rest, c.variants); rest = va.t;
    const { qty, t } = extractQty(rest); rest = t;
    if (rest.length) score -= Math.min(0.4, 0.06 * rest.length); // 剩下無法解釋的字愈多愈扣
    return { c, score, choice: ch.hit, variant: va.hit, qty, leftover: rest };
  }
  function matchItem(fragment, cands) {
    const q0 = norm(fragment);
    if (!q0) return null;
    let best = null;
    cands.forEach(c => { const r = analyze(q0, c); if (r && (!best || r.score > best.score)) best = r; });
    if (!best || best.score < 0.5) return null;
    return best;
  }
  // 片段只是選項／規格詞（要黏到前一個品項）
  function optionOnly(fragment, c) {
    const q = norm(fragment); if (!q) return null;
    const ch = pickWords(q, c.choices); const va = pickWords(ch.t, c.variants);
    const { qty, t } = extractQty(va.t);
    if (t.length === 0 && (ch.hit || va.hit || qty > 1)) return { choice: ch.hit, variant: va.hit, qty: (ch.hit || va.hit) && qty === 1 ? null : qty };
    return null;
  }

  function priceOf(best) {
    const { c, variant } = best;
    const prices = c.item.prices || [];
    if (!c.variants.length) return prices[0] ?? null;
    let idx = variant ? c.variants.findIndex(v => (v.label || v) === variant) : 0;
    if (idx < 0) idx = 0;
    return prices[idx] ?? null;
  }

  // ── 把對話拆成 (person, message) ──
  const TIME_RE = /^\s*(?:\[?\d{4}[\/.\-]\d{1,2}[\/.\-]\d{1,2}\]?\s*)?(?:\[?(?:上午|下午|AM|PM)?\s*\d{1,2}:\d{2}\]?)\s*/i;
  function splitLines(text, cands) {
    const out = [];
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    let pendingName = null;
    for (let raw of lines) {
      let line = raw;
      // LINE 匯出 tab 格式：時間\t名字\t訊息
      const tab = line.split('\t');
      if (tab.length >= 3) { out.push({ person: tab[1].trim(), msg: tab.slice(2).join(' ').trim(), raw }); pendingName = null; continue; }
      // 去掉行首時間戳
      line = line.replace(TIME_RE, '');
      // 名字：訊息
      const m = line.match(/^([^：:]{1,12})[：:]\s*(.+)$/);
      if (m) { out.push({ person: m[1].trim(), msg: m[2].trim(), raw }); pendingName = null; continue; }
      // 兩行式：上一行是名字、這一行是訊息
      if (pendingName) { out.push({ person: pendingName, msg: line, raw: pendingName + ' / ' + raw }); pendingName = null; continue; }
      // 「名字 訊息」空白分隔（名字 ≤4 字且後段能對到菜單）
      const sp = line.match(/^(\S{1,4})\s+(.+)$/);
      if (sp && matchItem(sp[2], cands)) { out.push({ person: sp[1], msg: sp[2], raw }); continue; }
      // 這一行本身像品項 → 無名氏（讓主揪補）；否則當作名字暫存
      if (matchItem(line, cands)) out.push({ person: '', msg: line, raw });
      else if (line.length <= 6) pendingName = line;
      else out.push({ person: '', msg: line, raw, noise: true });
    }
    return out;
  }

  const CANCEL_RE = /(取消|不用了|不要了|不吃|刪掉|退)/;
  const ADD_RE = /^(\+|加|再|另外|多)/;
  const SAME_RE = /^(同上|一樣|\+1|跟.*一樣)/;

  function parse(menu, text) {
    const cands = compile(menu);
    const msgs = splitLines(text, cands);
    const orders = [], unmatched = [], byPerson = new Map();
    let last = null;
    msgs.forEach(m => {
      if (m.noise) { unmatched.push({ person: m.person, raw: m.raw, reason: '看起來不是點餐' }); return; }
      const person = m.person || '（未署名）';
      if (CANCEL_RE.test(m.msg) && !matchItem(m.msg.replace(CANCEL_RE, ''), cands)) {
        for (let i = orders.length - 1; i >= 0; i--) if (orders[i].person === person) orders.splice(i, 1);
        return;
      }
      if (SAME_RE.test(norm(m.msg)) && last) {
        orders.push({ ...last, person, raw: m.raw, confidence: Math.min(last.confidence, 0.8) }); return;
      }
      const append = ADD_RE.test(m.msg);
      // 一則訊息可含多品項：、,，/ 和 跟 及 +
      const parts = m.msg.replace(ADD_RE, '').split(/[、,，;；\/]|\s+和\s*|\s*跟\s*|\s*及\s*|\s*\+\s*|\s+/).map(s => s.trim()).filter(Boolean);
      const found = [];
      // 若整句直接能對到，就不要拆（避免「鄉村南瓜鍋-牛肉」被空白拆散）
      const whole = matchItem(m.msg.replace(ADD_RE, ''), cands);
      const candidatesParts = (whole && whole.score >= 0.85) ? [m.msg.replace(ADD_RE, '')] : parts;
      candidatesParts.forEach(p => {
        const b = matchItem(p, cands);
        if (!b && found.length) { // 純選項片段（換拌飯／牛肉／x2）→ 黏到前一個品項
          const prev = found[found.length - 1], c = cands.find(x => x.item.name === prev.item);
          const o = optionOnly(p, c);
          if (o) { if (o.choice) { prev.choice = o.choice; prev.choiceMissing = false; } if (o.variant) { prev.variant = o.variant; prev.variantAssumed = false; prev.price = priceOf({ c, variant: o.variant }); } if (o.qty) prev.qty = o.qty; prev.raw += ' ' + p; return; }
        }
        if (b) found.push({ person, item: b.c.item.name, category: b.c.cat.name, choice: b.choice, variant: b.variant || (b.c.variants[0] ? (b.c.variants[0].label || b.c.variants[0]) : null),
          variantAssumed: !b.variant && !!b.c.variants.length, choiceMissing: b.c.choices.length > 0 && !b.choice,
          qty: b.qty, price: priceOf(b), confidence: Math.round(b.score * 100) / 100, raw: p });
        else unmatched.push({ person, raw: p, reason: '對不到菜單品項' });
      });
      if (!found.length) return;
      if (!append) { // 同一人再次點餐＝覆蓋前一筆
        for (let i = orders.length - 1; i >= 0; i--) if (orders[i].person === person) orders.splice(i, 1);
      }
      found.forEach(f => orders.push(f));
      last = found[found.length - 1];
    });
    const people = [...new Set(orders.map(o => o.person))];
    return { orders, unmatched, people };
  }

  // ── 彙整輸出 ──
  function summarize(result) {
    const perPerson = new Map(), perItem = new Map();
    result.orders.forEach(o => {
      const label = o.item + (o.choice ? `（${o.choice}）` : '') + (o.variant && !o.variantAssumed ? `・${o.variant}` : '');
      const amt = (o.price || 0) * o.qty;
      const pp = perPerson.get(o.person) || { lines: [], total: 0 };
      pp.lines.push(`${label}${o.qty > 1 ? ' ×' + o.qty : ''}${o.price ? ' $' + amt : ''}`); pp.total += amt; perPerson.set(o.person, pp);
      const pi = perItem.get(label) || { qty: 0, who: [] }; pi.qty += o.qty; pi.who.push(o.person + (o.qty > 1 ? '×' + o.qty : '')); perItem.set(label, pi);
    });
    const grand = [...perPerson.values()].reduce((a, p) => a + p.total, 0);
    const forLine = ['📋 點餐整理', ...[...perPerson].map(([p, v]) => `${p}：${v.lines.join('、')}${v.total ? `（$${v.total}）` : ''}`), '', `共 ${perPerson.size} 人${grand ? `，合計 $${grand}` : ''}`].join('\n');
    const forShop = ['🧾 給店家', ...[...perItem].sort((a, b) => b[1].qty - a[1].qty).map(([k, v]) => `${k} ×${v.qty}`), '', `共 ${result.orders.reduce((a, o) => a + o.qty, 0)} 份`].join('\n');
    return { forLine, forShop, perPerson: Object.fromEntries(perPerson), perItem: Object.fromEntries(perItem), grand };
  }

  // ── 文字菜單 → menu JSON ──
  // 格式（一行一項）：
  //   「## 風味火鍋」或「【風味火鍋】」或「風味火鍋：」＝分類
  //   「規格：白飯/冬粉/換拌飯」＝這個分類的多價規格（之後品項的價格依序對應）
  //   「鄉村南瓜鍋（豬肉/牛肉） 450/450/490」＝品項（括號內＝選項，斜線或空白分隔多價）
  //   「日式豬排套餐 450」；「三杯雞=杏鮑菇三杯雞」可在品項後用「｜別名1/別名2」補別名
  function menuFromText(text, name) {
    const menu = { name: name || '菜單', categories: [] };
    let cat = null;
    const ensure = () => { if (!cat) { cat = { name: '品項', items: [] }; menu.categories.push(cat); } return cat; };
    text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).forEach(line => {
      let m;
      if ((m = line.match(/^(?:##\s*|【)(.+?)(?:】)?\s*$/)) || (m = line.match(/^([^\d（(]{1,12})[：:]\s*$/))) { cat = { name: m[1].trim(), items: [] }; menu.categories.push(cat); return; }
      if ((m = line.match(/^(?:規格|尺寸|大小|份量)[：:]\s*(.+)$/))) { ensure().variants = m[1].split(/[\/／、,，\s]+/).filter(Boolean).map(v => ({ label: v })); return; }
      let aliases = []; const al = line.split(/[｜|]/); if (al.length > 1) { line = al[0].trim(); aliases = al.slice(1).join('/').split(/[\/／、,，]/).map(s => s.trim()).filter(Boolean); }
      let choices = []; const cm = line.match(/[（(]([^）)]*[\/／][^）)]*)[）)]/); if (cm) { choices = cm[1].split(/[\/／、,，]/).map(s => s.trim()).filter(Boolean); line = line.replace(cm[0], ' '); }
      const pm = line.match(/^(.*?)[\s：:$＄]*((?:NT\$?|nt\$?|\$)?\s*\d+(?:\s*[\/／\s]\s*(?:NT\$?|\$)?\s*\d+)*)\s*$/);
      let nm = line, prices = [];
      if (pm && pm[1].trim()) { nm = pm[1].trim(); prices = pm[2].split(/[\/／\s]+/).map(x => parseInt(x.replace(/[^\d]/g, ''), 10)).filter(n => !isNaN(n)); }
      nm = nm.replace(/[\s：:]+$/, '').trim(); if (!nm) return;
      const item = { name: nm, prices: prices.length ? prices : [null] }; if (aliases.length) item.aliases = aliases; if (choices.length) item.choices = choices;
      ensure().items.push(item);
    });
    return menu;
  }
  function menuToText(menu) {
    const out = [];
    (menu.categories || []).forEach(c => {
      out.push('## ' + c.name);
      if (c.variants && c.variants.length) out.push('規格：' + c.variants.map(v => v.label || v).join('/'));
      (c.items || []).forEach(it => out.push(it.name + (it.choices ? '（' + it.choices.join('/') + '）' : '') + ' ' + (it.prices || []).map(p => p ?? '').join('/') + (it.aliases ? '｜' + it.aliases.join('/') : '')));
    });
    return out.join('\n');
  }

  return { parse, summarize, norm, matchItem, compile, analyze, menuFromText, menuToText };
});
