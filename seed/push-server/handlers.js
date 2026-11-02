// إشعارات فورية (FCM) لتطبيق FIR — تصل والتطبيق مغلق، مع عدّاد على أيقونة التطبيق
const { onValueCreated } = require('./shim');
const admin = require('firebase-admin');
const db = admin.database();

const OPT = { instance: 'slaw-3a991-default-rtdb', region: 'europe-west1' };
const val = async (p) => (await db.ref(p).get()).val();

async function nameOf(uid) {
  try { return (await val(`profiles/${uid}/name`)) || 'عضو'; } catch (_) { return 'عضو'; }
}

// يرسل إشعاراً لمستخدم + يزيد عدّاد الأيقونة
async function push(uid, { title, body, tag, gid, mid }) {
  // المستخدم أوقف الإشعارات كلياً أو كتم هذه النقابة
  if (await val(`notifOff/${uid}`)) return;
  if (gid && (await val(`notifMute/${uid}/${gid}`))) return;
  const tk = await val(`fcmTokens/${uid}`);
  if (!tk) return;
  const tokens = Object.keys(tk);
  if (!tokens.length) return;
  const r = await db.ref(`badge/${uid}`).transaction((n) => (typeof n === 'number' ? n : 0) + 1);
  const count = (r.snapshot && r.snapshot.val()) || 1;
  const res = await admin.messaging().sendEachForMulticast({
    tokens,
    notification: { title, body },
    data: { gid: gid || '', mid: mid || '' },
    android: {
      priority: 'high',
      ttl: 3600 * 1000,
      notification: {
        channelId: 'fir_main',
        tag: tag || undefined,
        notificationCount: count,
        defaultSound: true,
        defaultVibrateTimings: true,
        visibility: 'public',
        notificationPriority: 'PRIORITY_MAX',
      },
    },
  });
  const bad = [];
  res.responses.forEach((x, i) => {
    const c = x.error && x.error.code;
    if (c === 'messaging/registration-token-not-registered' || c === 'messaging/invalid-registration-token') bad.push(tokens[i]);
  });
  await Promise.all(bad.map((t) => db.ref(`fcmTokens/${uid}/${t}`).remove()));
}

const clip = (s, n = 110) => (s || '').toString().replace(/\s+/g, ' ').slice(0, n);

// 1) إشعارات الجرس: منشن، @الكل، صداقة، تحويل، دعم ...
exports.onNotif = onValueCreated({ ...OPT, ref: '/notifs/{uid}/{nid}' }, async (e) => {
  const n = e.data.val();
  if (!n) return;
  const who = await nameOf(n.from);
  const g = n.m || '';
  const T = {
    men: ['📣 هناك من ذكر اسمك', `${who} ذكرك في «${g}»: ${clip(n.tx, 70)}`],
    all: ['📢 نداء للجميع', `${who} في «${g}»: ${clip(n.tx, 70)}`],
    frq: ['👥 طلب صداقة جديد', `${who} أرسل لك طلب صداقة — افتح التطبيق للقبول`],
    fok: ['✅ تم قبول صداقتك', `${who} قبل طلب صداقتك`],
    tr: ['💰 وصلك رصيد', `${who} حوّل لك رصيداً`],
    sup: ['🛟 رسالة ابلاغ', clip(n.tx) || 'رسالة ابلاغ من أحد الأعضاء'],
    add: ['➕ تمت إضافتك', `تمت إضافتك إلى «${g}»`],
    kick: ['⛔ تم طردك', `تم طردك من «${g}»`],
    mute: ['🔇 تم كتمك', `تم كتمك في «${g}»`],
    role: ['🎖 تغيّرت رتبتك', `تغيّرت رتبتك في «${g}»`],
    susp: ['⚠️ ايها المطور!', 'هناك دخيل يستعمل نسخ لتطبيقكم!'],
  };
  const t = T[n.t] || ['FIR', clip(n.tx) || 'لديك إشعار جديد'];
  const tag = n.mid ? n.mid : n.t === 'frq' ? `frq_${n.from}` : undefined;
  await push(e.params.uid, { title: t[0], body: t[1], tag, gid: n.g, mid: n.mid });
});

// 2) طلب صداقة (حتى لو لم يجمعهما قروب)
exports.onFriendReq = onValueCreated({ ...OPT, ref: '/friendReq/{to}/{from}' }, async (e) => {
  const who = await nameOf(e.params.from);
  await push(e.params.to, { title: '👥 طلب صداقة جديد', body: `${who} أرسل لك طلب صداقة — افتح التطبيق للقبول`, tag: `frq_${e.params.from}` });
});

// 3) (أُلغي) إشعار لكل رسالة في النقابة — استُبدل بإشعار «كثرة الرسائل» في onChatter أدناه

// 4) إعلان حرب: إشعار لأعضاء النقابتين (المهاجِمة والمُهاجَمة) حتى والتطبيق مغلق
exports.onWar = onValueCreated({ ...OPT, ref: '/warFeed/{wid}' }, async (e) => {
  const w = e.data.val();
  if (!w) return;
  const send = async (gid, title, body) => {
    const mem = (await val(`members/${gid}`)) || {};
    const ids = Object.keys(mem).filter((u) => mem[u] === true).slice(0, 400);
    await Promise.all(ids.map((u) => push(u, { title, body, tag: `war_${e.params.wid}` }).catch(() => {})));
  };
  await Promise.all([
    send(w.dg, '⚔️ تتعرضون لهجوم!', `نقابة ${w.an} تعلن الحرب على نقابتكم ${w.dn} — ادخل وجهّز نفسك`),
    send(w.ag, '⚔️ بدأت الحرب!', `نقابتكم ${w.an} تشنّ حرباً على ${w.dn} — ادخل وشارك`),
  ]);
});

// 5) رسائل الأصدقاء الخاصة
exports.onFriendDm = onValueCreated({ ...OPT, ref: '/fdm/{a}/{b}/{mid}' }, async (e) => {
  const m = e.data.val();
  if (!m) return;
  const to = m.from === e.params.a ? e.params.b : e.params.a;
  const who = await nameOf(m.from);
  await push(to, { title: `💬 ${who}`, body: clip(m.text), tag: `dm_${m.from}` });
});

// 6) مراسلة الإمبراطور
exports.onEmpMsg = onValueCreated({ ...OPT, ref: '/emp/msg/{uid}/{mid}' }, async (e) => {
  const m = e.data.val();
  if (!m) return;
  const emp = await val('config/emperorUid');
  const to = m.from === e.params.uid ? emp : e.params.uid;
  if (!to) return;
  await push(to, { title: '👑 رسالة من الإمبراطور', body: clip(m.text), tag: `emp_${e.params.uid}` });
});

// 7) بلاغات الأعضاء على الدردشات: إشعار فوري لكل المطورين والإمبراطور
exports.onReport = onValueCreated({ ...OPT, ref: '/reports/{rid}' }, async (e) => {
  const r = e.data.val();
  if (!r) return;
  const who = await nameOf(r.u);
  const roles = (await val('roles')) || {};
  const emp = await val('config/emperorUid');
  const ids = new Set(Object.keys(roles).filter((u) => roles[u] === 'dev'));
  if (emp) ids.add(emp);
  ids.delete(r.u);
  await Promise.all(
    [...ids].map((u) =>
      push(u, { title: '🚩 بلاغ جديد على دردشة', body: `${who}: ${clip(r.r, 90)}`, tag: `rep_${e.params.rid}` }).catch(() => {})
    )
  );
});

// 8) حذف عضو نهائياً (من شاشة «حظر / حذف عضو»): يمسح الحساب وكل أثره
exports.onDelMember = onValueCreated({ ...OPT, ref: '/delQueue/{uid}' }, async (e) => {
  const uid = e.params.uid;
  const q = db.ref(`delQueue/${uid}`);
  try {
    const by = (e.data.val() || {}).by;
    const emp = await val('config/emperorUid');
    const byRole = by ? await val(`roles/${by}`) : null;
    const allowed = by && (by === emp || byRole === 'dev') && uid !== emp;
    const targetDev = (await val(`roles/${uid}`)) === 'dev';
    if (!allowed || (targetDev && by !== emp)) { await q.remove(); return; }

    const up = {};
    const own = ['profiles', 'wallets', 'pw', 'pdata', 'avatars', 'seen', 'flags', 'presence', 'tamper', 'pride', 'prideTs',
      'likeCount', 'wins', 'msgTotal', 'fcmTokens', 'badge', 'notifs', 'friends', 'supportOpen', 'restricted', 'joinLog',
      'refClaims', 'refPaid', 'pubCount', 'pwSwap', 'spin', 'gift', 'roles', 'devs', 'banned', 'mod', 'myStickers', 'welcomed'];
    for (const k of own) up[`${k}/${uid}`] = null;
    const pid = await val(`pdata/${uid}/pid`);
    if (pid) up[`pids/${pid}`] = null;
    const dev = await val(`deviceOf/${uid}`);
    if (dev) up[`devices/${dev}`] = null;
    up[`deviceOf/${uid}`] = null;

    const members = (await val('members')) || {};
    for (const g of Object.keys(members)) {
      if (members[g] && members[g][uid] !== undefined) up[`members/${g}/${uid}`] = null;
      up[`stats/${g}/${uid}`] = null;
      up[`groupAdmins/${g}/${uid}`] = null;
    }
    const idx = (await val('nameIdx')) || {};
    for (const g of Object.keys(idx)) for (const k of Object.keys(idx[g] || {})) if (idx[g][k] === uid) up[`nameIdx/${g}/${k}`] = null;
    const al = (await val('pwAlias')) || {};
    for (const k of Object.keys(al)) if (al[k] && al[k].u === uid) up[`pwAlias/${k}`] = null;
    const fr = (await val(`friends/${uid}`)) || {};
    for (const f of Object.keys(fr)) up[`friends/${f}/${uid}`] = null;

    await db.ref().update(up);
    try { await admin.auth().deleteUser(uid); } catch (_) {}
  } catch (err) {
    console.error('onDelMember', err);
  } finally {
    try { await q.remove(); } catch (_) {}
  }
});

// 9) كثرة الكلام: كل 10 رسائل متتالية (بفواصل أقل من 5 دقائق) في نقابة يصل إشعار واحد لأعضائها
exports.onChatter = onValueCreated({ ...OPT, ref: '/messages/{gid}/{mid}' }, async (e) => {
  const m = e.data.val();
  if (!m || m.type === 'sys') return;
  const gid = e.params.gid;
  const g = await val(`groups/${gid}`);
  if (!g || g.kind !== 'main') return;
  const now = Date.now();
  const r = await db.ref(`chatCnt/${gid}`).transaction((c) => {
    if (!c || typeof c !== 'object' || now - (c.t || 0) > 300000) return { n: 1, t: now };
    return { n: (c.n || 0) + 1, t: now };
  });
  const c = r.snapshot && r.snapshot.val();
  if (!c || c.n % 10 !== 0) return;
  const mem = (await val(`members/${gid}`)) || {};
  const banned = (await val('banned')) || {};
  const ids = Object.keys(mem).filter((u) => mem[u] === true && !banned[u]).slice(0, 400);
  await Promise.all(ids.map((u) => push(u, { title: `💬 ${g.name || 'نقابتك'}`, body: 'هناك الكثير من الرسائل الجديدة في نقابتك — ادخل وشارك', tag: `chat_${gid}`, gid }).catch(() => {})));
});

// 10) إشعار الحظر
exports.onBan = onValueCreated({ ...OPT, ref: '/banned/{uid}' }, async (e) => {
  await push(e.params.uid, { title: '⛔ تم حظرك', body: 'تم حظرك من قبل أحد المطورين. افتح التطبيق للتواصل معهم.', tag: 'ban' }).catch(() => {});
});

// 11) مراقبة شات النقابات: كلمات غير لائقة → حذف الرسالة + حظر متدرج (يعمل حتى لو تجاوز أحدهم فحص التطبيق)
const nb = (t) => (t || '').toString()
  .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
  .replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
  .toLowerCase().replace(/(.)\1+/g, '$1');
const BAD_EXACT = new Set(['كس', 'كسك', 'كسم', 'كسمك', 'طيز', 'طيزك', 'زب', 'زبي', 'زبك', 'نيك', 'انيك', 'نيكني', 'عرص', 'عرصه'].map(nb));
const BAD_PART = ['شرموط', 'شراميط', 'منيك', 'منيوك', 'قحبه', 'قحاب', 'متناك', 'كسمك', 'كسختك', 'كساختك', 'كسامك', 'fuck'].map(nb);
const MILD = new Set(['كلب', 'كلاب', 'حمار', 'حمير', 'خرا', 'خره', 'تيس', 'حيوان', 'كلبه'].map(nb));

function levelOf(text) {
  let lv = 0;
  for (const w of nb(text).split(/[^\u0621-\u064Aa-zA-Z0-9]+/)) {
    if (!w) continue;
    if (BAD_EXACT.has(w)) return 2;
    if (BAD_PART.some((b) => w.includes(b))) return 2;
    if (MILD.has(w)) lv = 1;
  }
  return lv;
}

exports.onModerate = onValueCreated({ ...OPT, ref: '/messages/{gid}/{mid}' }, async (e) => {
  const m = e.data.val();
  if (!m || m.type !== 'text' || !m.from) return;
  const lv = levelOf(m.text);
  if (!lv) return;
  const g = await val(`groups/${e.params.gid}`);
  if (!g || g.kind !== 'main') return;
  const uid = m.from;
  const emp = await val('config/emperorUid');
  const high = uid === emp || (await val(`roles/${uid}`)) === 'dev';
  const cur = (await val(`mod/${uid}`)) || {};
  const n = typeof cur.n === 'number' ? cur.n : 0;
  const key = lv === 2 ? 'b' : 'a';
  let dur; let warn = false;
  if (high) { dur = [0, 1, 5, 30][Math.min(n, 3)]; warn = dur === 0; }
  else {
    const c = typeof cur[key] === 'number' ? cur[key] : 0;
    dur = Math.min((lv === 2 ? 420 : 5) * Math.pow(2, Math.min(c, 12)), 20160);
  }
  const next = { ...cur, n: n + 1, [key]: (typeof cur[key] === 'number' ? cur[key] : 0) + 1, until: dur ? Date.now() + dur * 60000 : 0 };
  await db.ref(`mod/${uid}`).set(next);
  try { await e.data.ref.remove(); } catch (_) {}
  const txt = dur >= 1440 ? `${Math.round(dur / 1440)} يوم` : dur >= 60 ? `${Math.round(dur / 60)} ساعة` : `${dur} دقيقة`;
  await push(uid, {
    title: warn ? '⚠️ تحذير' : '⛔ تم تقييدك من الشات',
    body: warn ? 'رجاءً لا تخالف القوانين، وإلا سيتم حظرك دقيقة في المرة القادمة.' : `بسبب كلمات غير لائقة — المدة: ${txt}`,
    tag: 'mod',
  }).catch(() => {});
});

// 12) جلسة مشبوهة جديدة (نسخة مستنسخة): إشعار للمطورين والإمبراطور + جرس داخل التطبيق
exports.onSusp = onValueCreated({ ...OPT, ref: '/susp/{h}' }, async (e) => {
  const roles = (await val('roles')) || {};
  const emp = await val('config/emperorUid');
  const ids = new Set(Object.keys(roles).filter((u) => roles[u] === 'dev'));
  if (emp) ids.add(emp);
  const ts = Date.now();
  await Promise.all([...ids].map(async (u) => {
    await db.ref(`notifs/${u}/${db.ref().push().key}`).set({ t: 'susp', from: 'system', ts, tx: 'جلسة مشبوهة' }).catch(() => {});
  }));
});
