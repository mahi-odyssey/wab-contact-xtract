// export.js — one-time, read-only export of 1:1 WhatsApp Web chats to CSV + JSON.
// Paste into DevTools Console on https://web.whatsapp.com (logged in, chats loaded).
// Stop early (and still download what's done) with:  window.__waExportStop = true
(async () => {
  const OFFSET = 0;              // skip this many chats (for batching big accounts)
  const LIMIT = Infinity;        // export at most this many chats per run, e.g. 500
  const MAX_PAGES_PER_CHAT = 40; // how many "load older messages" pages to fetch to reach the first (ad) message
  const DELAY_MS = 400;          // pause between history pages — keeps it gentle

  const req = (name) => { try { return window.require(name); } catch { return null; } };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  if (typeof window.require !== 'function') { console.error('[export] window.require unavailable — run probe.js and report.'); return; }
  const Collections = req('WAWebCollections');
  const LoadMsgs = req('WAWebChatLoadMessages');
  const ApiContact = req('WAWebApiContact');
  if (!Collections?.Chat) { console.error('[export] Chat store not found — run probe.js and report.'); return; }
  if (!LoadMsgs?.loadEarlierMsgs) console.warn('[export] cannot load older messages; ad info only for already-loaded history.');

  const attrs = (m) => (typeof m?.serialize === 'function' ? m.serialize() : m?.attributes) || {};
  const iso = (t) => (t ? new Date(t * 1000).toISOString() : '');
  const safeJson = (v) => { try { return JSON.stringify(v); } catch { return ''; } };
  const tryCall = (fn) => { try { return fn(); } catch { return null; } };

  // Walk a message: the ad context object (ctwaContext / externalAdReply) plus any
  // ad-related scalar keys anywhere, keyed by lowercase name (first hit wins).
  const AD_OBJ = /ctwacontext|externaladreply|adreply/i;
  const AD_SCALAR = /^(ctwaclid|sourceid|sourceurl|sourcetype|conversionsource|entrypointconversionsource|entrypointconversionapp)$/i;
  const findAd = (root) => {
    let ctx = null;
    const flat = {};
    const seen = new WeakSet();
    const walk = (obj, depth) => {
      if (!obj || typeof obj !== 'object' || depth > 6 || seen.has(obj)) return;
      if (obj instanceof ArrayBuffer || ArrayBuffer.isView(obj)) return;
      seen.add(obj);
      for (const [k, v] of Object.entries(obj)) {
        if (v == null || v === '') continue;
        if (!ctx && AD_OBJ.test(k) && typeof v === 'object') ctx = v;
        if (AD_SCALAR.test(k) && typeof v !== 'object') flat[k.toLowerCase()] ??= String(v);
        if (typeof v === 'object') walk(v, depth + 1);
      }
    };
    walk(root, 0);
    if (!ctx && !flat.ctwaclid && !flat.sourceid && !flat.sourceurl) return null;
    const pick = (...keys) => {
      for (const k of keys) {
        const hit = ctx && Object.keys(ctx).find((ck) => ck.toLowerCase() === k);
        if (hit && ctx[hit] != null && typeof ctx[hit] !== 'object') return String(ctx[hit]);
      }
      for (const k of keys) if (flat[k]) return flat[k];
      return '';
    };
    return {
      ad_title: pick('title', 'headline'),
      ad_body: pick('description', 'body'),
      ad_url: pick('sourceurl'),
      ad_id: pick('sourceid'),
      ad_source_type: pick('sourcetype'),
      ctwa_clid: pick('ctwaclid'),
      conversion_source: pick('conversionsource', 'entrypointconversionsource'),
      ad_raw: ctx ? safeJson(ctx).slice(0, 2000) : safeJson(flat),
    };
  };

  const resolveIds = (chat, contact) => {
    const wid = chat.id;
    let phone = '', lid = '';
    if (wid.server === 'c.us') {
      phone = wid.user;
      lid = tryCall(() => ApiContact?.getCurrentLid?.(wid)?.user) || '';
    } else if (wid.server === 'lid') {
      lid = wid.user;
      phone = contact?.phoneNumber?.user || tryCall(() => ApiContact?.getPhoneNumber?.(wid)?.user) || '';
    }
    return { phone, lid };
  };

  const loadToStart = async (chat) => {
    if (!LoadMsgs?.loadEarlierMsgs) return;
    for (let i = 0; i < MAX_PAGES_PER_CHAT && !chat.msgs?.msgLoadState?.noEarlierMsgs; i++) {
      const got = await LoadMsgs.loadEarlierMsgs(chat).catch(() => null);
      if (!got || !got.length) break;
      await sleep(DELAY_MS);
    }
  };

  const all = Collections.Chat.getModelsArray()
    .filter((c) => ['c.us', 'lid'].includes(c.id?.server))
    .sort((a, b) => a.id._serialized.localeCompare(b.id._serialized));
  const chats = all.slice(OFFSET, OFFSET + LIMIT);
  console.log(`[export] ${all.length} 1:1 chats found; exporting ${chats.length} (offset ${OFFSET})`);

  window.__waExportStop = false;
  const rows = [];
  for (const [i, chat] of chats.entries()) {
    if (window.__waExportStop) { console.warn('[export] stopped by user'); break; }
    try {
      await loadToStart(chat);
      const contact = chat.contact || Collections.Contact.get(chat.id);
      const msgs = chat.msgs?.getModelsArray?.() || [];
      let ad = null;
      for (const m of msgs) {
        if (m.id?.fromMe) continue;
        ad = findAd(attrs(m));
        if (ad) break;
      }
      rows.push({
        chat_id: chat.id._serialized,
        ...resolveIds(chat, contact),
        push_name: contact?.pushname || '',
        saved_name: contact?.name || '',
        verified_name: contact?.verifiedName || '',
        is_business: contact?.isBusiness ? 1 : 0,
        first_msg_at: iso(msgs[0]?.t),
        last_msg_at: iso(chat.t),
        msgs_loaded: msgs.length,
        history_complete: chat.msgs?.msgLoadState?.noEarlierMsgs ? 1 : 0,
        from_ad: ad ? 1 : 0,
        ad_title: '', ad_body: '', ad_url: '', ad_id: '', ad_source_type: '', ctwa_clid: '', conversion_source: '', ad_raw: '',
        ...(ad || {}),
      });
    } catch (e) {
      console.warn('[export] failed on', chat.id?._serialized, e);
    }
    if ((i + 1) % 25 === 0) console.log(`[export] ${i + 1}/${chats.length} — ${rows.filter((r) => r.from_ad).length} from ads so far`);
  }

  const cols = Object.keys(rows[0] || { chat_id: '' });
  const esc = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
  const stamp = `${new Date().toISOString().slice(0, 10)}_${OFFSET}-${OFFSET + rows.length}`;
  const download = (name, text, type) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  download(`wa_contacts_${stamp}.csv`, '﻿' + csv, 'text/csv;charset=utf-8');
  download(`wa_contacts_${stamp}.json`, JSON.stringify(rows, null, 2), 'application/json');

  const incomplete = rows.filter((r) => !r.history_complete && !r.from_ad).length;
  console.log(`[export] done: ${rows.length} contacts, ${rows.filter((r) => r.from_ad).length} from ads, ` +
    `${rows.filter((r) => !r.phone).length} without phone (hidden number), ` +
    `${incomplete} where the chat start wasn't reached (raise MAX_PAGES_PER_CHAT if needed).`);
})();
