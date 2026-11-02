// يحاكي onValueCreated الخاص بدوال Firebase باستخدام Admin SDK على سيرفر عادي (بدون خطة Blaze)
const admin = require('firebase-admin');
const fs = require('fs');

const DB_URL = process.env.DB_URL || 'https://slaw-3a991-default-rtdb.europe-west1.firebasedatabase.app';
let raw = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!raw && fs.existsSync(`${__dirname}/service-account.json`)) raw = fs.readFileSync(`${__dirname}/service-account.json`, 'utf8');
if (!raw) throw new Error('ضع مفتاح الخدمة في المتغير FIREBASE_SERVICE_ACCOUNT');
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)), databaseURL: DB_URL });
const db = admin.database();

const CH = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
// أول 8 رموز من مفتاح Firebase = الوقت بالمللي ثانية
function keyAt(ms) {
  let s = '';
  for (let i = 0; i < 8; i++) { s = CH.charAt(ms % 64) + s; ms = Math.floor(ms / 64); }
  return s;
}

async function shallow(path) {
  const t = await admin.app().options.credential.getAccessToken();
  const r = await fetch(`${DB_URL}/${path}.json?shallow=true&access_token=${t.access_token}`);
  if (!r.ok) return [];
  const v = await r.json();
  return v && typeof v === 'object' ? Object.keys(v) : [];
}

const registry = new Map(); // pattern -> [handlers]
function onValueCreated(opts, handler) {
  const p = opts.ref.replace(/^\//, '');
  if (!registry.has(p)) registry.set(p, []);
  registry.get(p).push(handler);
}

const NONTIME = new Set(['friendReq/{to}/{from}', 'banned/{uid}', 'delQueue/{uid}', 'susp/{h}', 'reports/{rid}']);
const attached = new Set();
const seen = new Set();
const startKey = keyAt(Date.now() - 120000);

async function walk(segs, i, prefix, params, handlers, pat) {
  if (i === segs.length) return;
  const s = segs[i];
  const isParam = s.startsWith('{');
  const name = isParam ? s.slice(1, -1) : '';
  const last = i === segs.length - 1;
  if (!isParam) return walk(segs, i + 1, prefix ? `${prefix}/${s}` : s, params, handlers, pat);
  if (last) {
    const id = `${pat}|${prefix}`;
    if (attached.has(id)) return;
    attached.add(id);
    // مفاتيح غير زمنية (معرّفات مستخدمين/أجهزة): نسجّل الموجود حالياً كمُعالَج حتى لا يُعاد إرسال إشعارات قديمة
    const q = NONTIME.has(pat) ? db.ref(prefix) : db.ref(prefix).orderByKey().startAt(startKey);
    if (NONTIME.has(pat)) {
      const ex = await db.ref(prefix).once('value');
      ex.forEach((c) => { seen.add(`${pat}|${c.ref.toString()}`); });
    }
    q.on('child_added', (snap) => {
      const uniq = `${pat}|${snap.ref.toString()}`;
      if (seen.has(uniq)) return;
      seen.add(uniq);
      if (seen.size > 50000) seen.clear();
      for (const h of handlers) {
        Promise.resolve(h({ data: snap, params: { ...params, [name]: snap.key } })).catch((e) => console.error(pat, e && e.message));
      }
    });
    return;
  }
  for (const k of await shallow(prefix)) await walk(segs, i + 1, `${prefix}/${k}`, { ...params, [name]: k }, handlers, pat);
}

async function refresh() {
  for (const [pat, handlers] of registry) {
    try { await walk(pat.split('/'), 0, '', {}, handlers, pat); } catch (e) { console.error('walk', pat, e.message); }
  }
}

async function start() {
  await refresh();
  setInterval(refresh, 60000); // يلتقط المستخدمين والنقابات الجدد
  console.log('push server يعمل — يراقب', [...registry.keys()].length, 'مسارات');
}

module.exports = { onValueCreated, start };
