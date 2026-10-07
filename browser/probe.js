// probe.js — read-only check of what this WhatsApp Web page exposes.
// Paste into DevTools Console on https://web.whatsapp.com (logged in, chats loaded).
// Sends nothing; only reads what the tab already has in memory.
(async () => {
  const ONLY = '';             // e.g. '8801712345678' to inspect one chat you know came from an ad
  const SAMPLE_CHATS = 5;      // otherwise: how many recent 1:1 chats to inspect
  const MAX_PAGES = 30;        // how far back to load history per sampled chat
  const AD_KEY = /ctwa|adreply|externalad|referral|conversion|sourceur[il]|sourceid|sourcetype|entrypoint/i;

  const req = (name) => { try { return window.require(name); } catch { return null; } };

  if (typeof window.require !== 'function') {
    console.error('[probe] window.require is not available — WhatsApp Web changed its loader. Send this message to the developer.');
    return;
  }
  const Collections = req('WAWebCollections');
  const LoadMsgs = req('WAWebChatLoadMessages');
  const ApiContact = req('WAWebApiContact');
  console.log('[probe] modules:', {
    WAWebCollections: !!Collections,
    'Chat store': !!Collections?.Chat,
    'Contact store': !!Collections?.Contact,
    WAWebChatLoadMessages: !!LoadMsgs?.loadEarlierMsgs,
    WAWebApiContact: !!ApiContact,
  });
  if (!Collections?.Chat) { console.error('[probe] Chat store not found — stop here and report.'); return; }

  const safeJson = (v) => { try { return JSON.stringify(v).slice(0, 300); } catch { return String(v); } };
  const attrs = (m) => (typeof m?.serialize === 'function' ? m.serialize() : m?.attributes) || {};

  // Every path in an object whose key looks ad/referral related.
  const findAdPaths = (obj, path = '', seen = new WeakSet(), depth = 0, out = []) => {
    if (!obj || typeof obj !== 'object' || depth > 6 || seen.has(obj)) return out;
    seen.add(obj);
    for (const [k, v] of Object.entries(obj)) {
      const p = path ? `${path}.${k}` : k;
      if (AD_KEY.test(k) && v != null && v !== '') out.push([p, typeof v === 'object' ? safeJson(v) : v]);
      if (v && typeof v === 'object' && !(v instanceof ArrayBuffer) && !ArrayBuffer.isView(v)) findAdPaths(v, p, seen, depth + 1, out);
    }
    return out;
  };

  const chats = Collections.Chat.getModelsArray()
    .filter((c) => ['c.us', 'lid'].includes(c.id?.server))
    .filter((c) => !ONLY || c.id.user === ONLY.replace(/\D/g, ''))
    .slice(0, SAMPLE_CHATS);
  console.log(`[probe] total chats in store: ${Collections.Chat.getModelsArray().length}; sampling ${chats.length} 1:1 chats`);

  for (const chat of chats) {
    if (LoadMsgs?.loadEarlierMsgs) {
      for (let i = 0; i < MAX_PAGES && !chat.msgs?.msgLoadState?.noEarlierMsgs; i++) {
        const got = await LoadMsgs.loadEarlierMsgs(chat).catch(() => null);
        if (!got || !got.length) break;
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    const msgs = chat.msgs?.getModelsArray?.() || [];
    const contact = chat.contact || Collections.Contact.get(chat.id);
    let pn = null;
    try { pn = ApiContact?.getPhoneNumber?.(chat.id)?._serialized ?? null; } catch {}

    console.groupCollapsed(`[probe] ${chat.id._serialized} — ${chat.formattedTitle || chat.name || ''}`);
    console.log('contact fields:', {
      id: contact?.id?._serialized,
      pushname: contact?.pushname,
      savedName: contact?.name,
      verifiedName: contact?.verifiedName,
      isBusiness: contact?.isBusiness,
      phoneNumberField: contact?.phoneNumber?._serialized,
      lidToPhone: pn,
    });
    console.log('messages loaded:', msgs.length, '| reached start of chat:', !!chat.msgs?.msgLoadState?.noEarlierMsgs);
    const first = msgs[0];
    if (first) console.log('first message keys:', Object.keys(attrs(first)).sort().join(', '));
    const hits = msgs.slice(0, 20).flatMap((m, i) => findAdPaths(attrs(m)).map(([p, v]) => [`msg[${i}].${p}`, v]));
    if (hits.length) console.table(hits.map(([path, value]) => ({ path, value })));
    else console.log('no ad/referral fields in the first 20 messages of this chat');
    console.groupEnd();
  }
  console.log('[probe] done. Open a chat you KNOW came from an ad and check its group above for ad fields.');
})();
