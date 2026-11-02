// الجيسي — منصة تشغيل مشاريع Node.js شخصية. بدون أي اعتماديات خارجية.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const PROJ = path.join(DATA, 'projects');
const SEED = path.join(ROOT, 'seed');
const PUB = path.join(ROOT, 'public');
fs.mkdirSync(PROJ, { recursive: true });

/* ---------- كلمة السر ---------- */
// الافتراضي: بصمة scrypt (وليست كلمة السر نفسها). يمكن استبدالها بالمتغير ADMIN_PASSWORD.
const PW_SALT = 'a092700129ef6bf29d88cbdc9b2aeb51';
const PW_HASH = Buffer.from('a99d72877a497037640163bd0884ea56a9b8017c9d1d2aca287dfe7318c88f36', 'hex');
const sha = (s) => crypto.createHash('sha256').update(s).digest();
const checkPw = (pw) => {
  if (process.env.ADMIN_PASSWORD) return crypto.timingSafeEqual(sha(pw), sha(process.env.ADMIN_PASSWORD));
  return crypto.timingSafeEqual(crypto.scryptSync(pw, PW_SALT, 32), PW_HASH);
};
const SECRET = process.env.SESSION_SECRET || sha('jes|' + (process.env.ADMIN_PASSWORD || PW_HASH.toString('hex'))).toString('hex');
const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('hex');
const mkToken = () => { const e = String(Date.now() + 30 * 864e5); return e + '.' + sign(e); };
const okToken = (t) => {
  if (!t) return false; const [e, s] = t.split('.');
  if (!e || !s || Number(e) < Date.now()) return false;
  const a = Buffer.from(sign(e)), b = Buffer.from(s);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const cookie = (req, n) => (req.headers.cookie || '').split(/;\s*/).map((c) => c.split('=')).find((c) => c[0] === n)?.[1];
const fails = new Map();
const limited = (ip) => { const f = (fails.get(ip) || []).filter((t) => t > Date.now() - 6e5); fails.set(ip, f); return f.length >= 8; };

/* ---------- أدوات ---------- */
const json = (res, code, o) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };
const readBody = (req, max = 2e6) => new Promise((ok, no) => {
  let n = 0; const c = [];
  req.on('data', (d) => { n += d.length; if (n > max) { no(new Error('كبير')); req.destroy(); } else c.push(d); });
  req.on('end', () => { try { ok(c.length ? JSON.parse(Buffer.concat(c)) : {}); } catch { no(new Error('JSON')); } });
  req.on('error', no);
});
const safe = (root, rel = '') => {
  const p = path.resolve(root, '.' + path.sep + String(rel).replace(/\\/g, '/'));
  if (p !== root && !p.startsWith(root + path.sep)) throw new Error('مسار غير مسموح');
  return p;
};
const pdir = (id) => { if (!/^[a-z0-9-]{1,48}$/.test(id)) throw new Error('معرّف غير صالح'); return path.join(PROJ, id); };
const getMeta = (id) => { try { return JSON.parse(fs.readFileSync(path.join(pdir(id), '.jes.json'), 'utf8')); } catch { return null; } };
const setMeta = (id, m) => fs.writeFileSync(path.join(pdir(id), '.jes.json'), JSON.stringify(m, null, 2));
const allIds = () => fs.readdirSync(PROJ, { withFileTypes: true }).filter((d) => d.isDirectory() && getMeta(d.name)).map((d) => d.name);
const settingsFile = path.join(DATA, 'settings.json');
const getSettings = () => { try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { return {}; } };

/* ---------- إدارة العمليات ---------- */
const procs = new Map();
const st = (id) => { if (!procs.has(id)) procs.set(id, { child: null, logs: [], subs: new Set(), buf: {}, started: 0, stopping: false, crashes: [], task: null }); return procs.get(id); };
function log(id, s, text) {
  const p = st(id); const key = s; p.buf[key] = (p.buf[key] || '') + text;
  const lines = p.buf[key].split(/\r?\n/); p.buf[key] = lines.pop();
  for (const l of lines) emit(p, { s, l, t: Date.now() });
}
function sys(id, l) { emit(st(id), { s: 'sys', l, t: Date.now() }); }
function emit(p, o) { p.logs.push(o); if (p.logs.length > 1500) p.logs.shift(); for (const r of p.subs) r.write(`data: ${JSON.stringify(o)}\n\n`); }
const parseCmd = (s) => { const o = [], re = /"([^"]*)"|'([^']*)'|(\S+)/g; let m; while ((m = re.exec(s))) o.push(m[1] ?? m[2] ?? m[3]); return o; };
const childEnv = (meta, id) => {
  const e = { PATH: process.env.PATH, HOME: process.env.HOME || DATA, LANG: 'C.UTF-8', NODE_ENV: 'production', TMPDIR: process.env.TMPDIR || '/tmp' };
  for (const k of meta.envFrom || []) if (process.env[k] !== undefined) e[k] = process.env[k];
  e.PORT = String(20000 + (parseInt(crypto.createHash('sha1').update(id).digest('hex').slice(0, 6), 16) % 20000));
  return Object.assign(e, meta.env || {});
};
const rss = (pid) => { try { return Math.round(Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))[1]) / 1024); } catch { return null; } };
const kill = (child, sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch {} } };

function run(id, cmd, opts = {}) {
  const meta = getMeta(id); const cwd = pdir(id); const [bin, ...args] = parseCmd(cmd);
  const c = spawn(bin, args, { cwd, env: childEnv(meta, id), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  c.stdout.on('data', (d) => log(id, 'out', d.toString()));
  c.stderr.on('data', (d) => log(id, 'err', d.toString()));
  c.on('error', (e) => { sys(id, '✖ تعذّر التشغيل: ' + e.message); opts.onExit?.(-1); });
  c.on('close', (code, sig) => { for (const k of ['out', 'err']) { const p = st(id); if (p.buf[k]) { emit(p, { s: k, l: p.buf[k], t: Date.now() }); p.buf[k] = ''; } } opts.onExit?.(code, sig); });
  return c;
}
async function start(id) {
  const meta = getMeta(id); if (!meta) throw new Error('المشروع غير موجود');
  const p = st(id); if (p.child) return;
  p.stopping = false;
  if (!fs.existsSync(path.join(pdir(id), 'node_modules')) && fs.existsSync(path.join(pdir(id), 'package.json'))) {
    const pk = JSON.parse(fs.readFileSync(path.join(pdir(id), 'package.json'), 'utf8'));
    if (Object.keys(pk.dependencies || {}).length) await install(id);
  }
  sys(id, `▶ تشغيل: ${meta.cmd}`);
  p.started = Date.now();
  p.child = run(id, meta.cmd, {
    onExit: (code, sig) => {
      p.child = null; sys(id, `■ توقفت العملية (code=${code}${sig ? ' ' + sig : ''})`);
      if (p.stopping || meta.autorestart === false) return;
      p.crashes = p.crashes.filter((t) => t > Date.now() - 6e4); p.crashes.push(Date.now());
      if (p.crashes.length > 5) return sys(id, '⚠ تكرر الانهيار 5 مرات خلال دقيقة؛ أوقفت إعادة التشغيل التلقائي.');
      sys(id, '↻ إعادة تشغيل تلقائية بعد 3 ثوانٍ'); setTimeout(() => { if (!p.child && !p.stopping) start(id).catch(() => {}); }, 3000);
    },
  });
}
function stop(id) {
  const p = st(id); if (!p.child) return Promise.resolve();
  p.stopping = true; const c = p.child;
  return new Promise((ok) => { const t = setTimeout(() => kill(c, 'SIGKILL'), 5000); c.once('close', () => { clearTimeout(t); ok(); }); kill(c, 'SIGTERM'); });
}
const install = (id) => new Promise((ok) => {
  const p = st(id); if (p.task) return ok(); sys(id, '⬇ npm install ...');
  p.task = run(id, 'npm install --no-audit --no-fund --omit=dev', { onExit: (c) => { p.task = null; sys(id, c === 0 ? '✔ اكتمل تثبيت الحزم' : `✖ فشل تثبيت الحزم (code=${c})`); ok(c === 0); } });
});
const status = (id) => { const m = getMeta(id), p = st(id); return { id, name: m.name, cmd: m.cmd, autostart: !!m.autostart, autorestart: m.autorestart !== false, running: !!p.child, installing: !!p.task, uptime: p.child ? Math.floor((Date.now() - p.started) / 1000) : 0, mem: p.child ? rss(p.child.pid) : null }; };

/* ---------- ملفات ---------- */
function unzip(file, destRoot) {
  const b = fs.readFileSync(file); let e = b.length - 22;
  while (e >= 0 && b.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('ملف ZIP غير صالح');
  const n = b.readUInt16LE(e + 10); let o = b.readUInt32LE(e + 16), total = 0, count = 0;
  for (let i = 0; i < n; i++) {
    if (b.readUInt32LE(o) !== 0x02014b50) throw new Error('ZIP تالف');
    const flag = b.readUInt16LE(o + 8), method = b.readUInt16LE(o + 10), csize = b.readUInt32LE(o + 20), usize = b.readUInt32LE(o + 24);
    const nl = b.readUInt16LE(o + 28), el = b.readUInt16LE(o + 30), cl = b.readUInt16LE(o + 32), lo = b.readUInt32LE(o + 42);
    const name = b.toString('utf8', o + 46, o + 46 + nl).replace(/\\/g, '/'); o += 46 + nl + el + cl;
    if (flag & 1) throw new Error('الملف مشفّر بكلمة سر'); if (name.endsWith('/') || name.startsWith('__MACOSX/')) { if (name.endsWith('/')) fs.mkdirSync(safe(destRoot, name), { recursive: true }); continue; }
    total += usize; if (total > 6e8) throw new Error('حجم الاستخراج كبير جدًا');
    const ds = lo + 30 + b.readUInt16LE(lo + 26) + b.readUInt16LE(lo + 28); const raw = b.subarray(ds, ds + csize);
    const out = method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw) : null; if (!out) throw new Error('نوع ضغط غير مدعوم');
    const t = safe(destRoot, name); fs.mkdirSync(path.dirname(t), { recursive: true }); fs.writeFileSync(t, out); count++;
  }
  return count;
}
const isText = (b) => !b.subarray(0, 4096).includes(0);

/* ---------- المساعد الذكي ---------- */
async function askAI(id, messages, file) {
  const s = getSettings(); const key = s.aiKey || process.env.AI_API_KEY;
  if (!key) throw new Error('أضف مفتاح الذكاء الاصطناعي من الإعدادات أولًا');
  const meta = getMeta(id); const tail = st(id).logs.slice(-70).map((x) => x.l).join('\n');
  let ctx = `أنت مساعد مطوّر داخل منصة استضافة. المشروع: ${meta.name}. أمر التشغيل: ${meta.cmd}.\nأجب بالعربية باختصار ودقة وبأمثلة كود عند اللزوم.\n\nآخر سطور الكونسل:\n${tail || '(فارغ)'}`;
  if (file) { try { ctx += `\n\nالملف المفتوح ${file}:\n` + fs.readFileSync(safe(pdir(id), file), 'utf8').slice(0, 14000); } catch {} }
  const prov = s.aiProvider || 'anthropic';
  if (prov === 'anthropic') {
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: s.aiModel || 'claude-sonnet-4-6', max_tokens: 1500, system: ctx, messages }) });
    const j = await r.json(); if (!r.ok) throw new Error(j.error?.message || 'خطأ من مزوّد الذكاء');
    return j.content.map((c) => c.text || '').join('');
  }
  const r = await fetch(s.aiBase || 'https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key }, body: JSON.stringify({ model: s.aiModel || 'gpt-4o-mini', messages: [{ role: 'system', content: ctx }, ...messages] }) });
  const j = await r.json(); if (!r.ok) throw new Error(j.error?.message || 'خطأ من مزوّد الذكاء');
  return j.choices[0].message.content;
}

/* ---------- الخادم ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'); const p = url.pathname; const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  try {
    if (p === '/healthz') { res.writeHead(200); return res.end('ok'); }
    if (!p.startsWith('/api/')) {
      const f = p === '/' ? 'index.html' : p.slice(1);
      const fp = safe(PUB, f); if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.writeHead(404); return res.end('404'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); return fs.createReadStream(fp).pipe(res);
    }
    if (p === '/api/login' && req.method === 'POST') {
      if (limited(ip)) return json(res, 429, { error: 'محاولات كثيرة، انتظر 10 دقائق' });
      const { password } = await readBody(req, 4096);
      if (typeof password !== 'string' || !checkPw(password)) { fails.get(ip).push(Date.now()); return json(res, 401, { error: 'كلمة السر غير صحيحة' }); }
      const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      res.setHeader('Set-Cookie', `jes=${mkToken()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secure}`); return json(res, 200, { ok: true });
    }
    if (p === '/api/logout') { res.setHeader('Set-Cookie', 'jes=; HttpOnly; Path=/; Max-Age=0'); return json(res, 200, { ok: true }); }
    if (!okToken(cookie(req, 'jes'))) return json(res, 401, { error: 'login' });
    if (p === '/api/me') return json(res, 200, { ok: true });

    if (p === '/api/settings') {
      if (req.method === 'PUT') { const b = await readBody(req); const s = getSettings(); for (const k of ['aiProvider', 'aiModel', 'aiBase']) if (typeof b[k] === 'string') s[k] = b[k].trim(); if (typeof b.aiKey === 'string' && b.aiKey.trim()) s.aiKey = b.aiKey.trim(); fs.writeFileSync(settingsFile, JSON.stringify(s)); }
      const s = getSettings(); return json(res, 200, { aiProvider: s.aiProvider || 'anthropic', aiModel: s.aiModel || '', aiBase: s.aiBase || '', hasKey: !!(s.aiKey || process.env.AI_API_KEY) });
    }
    if (p === '/api/projects' && req.method === 'GET') return json(res, 200, { projects: allIds().map(status), persistent: !!process.env.DATA_DIR });
    if (p === '/api/projects' && req.method === 'POST') {
      const b = await readBody(req); const name = String(b.name || '').trim().slice(0, 48); if (name.length < 2) return json(res, 400, { error: 'اسم المشروع قصير' });
      const id = 'p' + crypto.randomBytes(5).toString('hex'); fs.mkdirSync(pdir(id), { recursive: true });
      setMeta(id, { name, cmd: String(b.cmd || 'npm start').slice(0, 200), autostart: false, autorestart: true, env: {}, envFrom: [], created: Date.now() });
      return json(res, 201, status(id));
    }
    const m = /^\/api\/projects\/([a-z0-9-]+)\/([a-z]+)$/.exec(p) || /^\/api\/projects\/([a-z0-9-]+)()$/.exec(p);
    if (m) {
      const id = m[1], act = m[2]; const meta = getMeta(id); if (!meta) return json(res, 404, { error: 'المشروع غير موجود' });
      const root = pdir(id);
      if (!act && req.method === 'GET') return json(res, 200, status(id));
      if (!act && req.method === 'PATCH') {
        const b = await readBody(req);
        if (typeof b.name === 'string' && b.name.trim().length > 1) meta.name = b.name.trim().slice(0, 48);
        if (typeof b.cmd === 'string' && b.cmd.trim()) meta.cmd = b.cmd.trim().slice(0, 200);
        if (typeof b.autostart === 'boolean') meta.autostart = b.autostart; if (typeof b.autorestart === 'boolean') meta.autorestart = b.autorestart;
        setMeta(id, meta); return json(res, 200, status(id));
      }
      if (!act && req.method === 'DELETE') { await stop(id); fs.rmSync(root, { recursive: true, force: true }); procs.delete(id); return json(res, 200, { ok: true }); }
      if (act === 'start') { await start(id); return json(res, 200, status(id)); }
      if (act === 'stop') { await stop(id); return json(res, 200, status(id)); }
      if (act === 'restart') { await stop(id); await start(id); return json(res, 200, status(id)); }
      if (act === 'install') { install(id); return json(res, 200, status(id)); }
      if (act === 'env') { if (req.method === 'PUT') { const b = await readBody(req); const e = {}; for (const [k, v] of Object.entries(b.env || {})) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) e[k] = String(v); meta.env = e; setMeta(id, meta); } return json(res, 200, { env: meta.env || {}, envFrom: meta.envFrom || [] }); }
      if (act === 'logs') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        const s = st(id); for (const o of s.logs.slice(-400)) res.write(`data: ${JSON.stringify(o)}\n\n`); s.subs.add(res);
        const hb = setInterval(() => res.write(': hb\n\n'), 20000); req.on('close', () => { clearInterval(hb); s.subs.delete(res); }); return;
      }
      if (act === 'clearlogs') { st(id).logs = []; return json(res, 200, { ok: true }); }
      if (act === 'ai') { const b = await readBody(req, 2e5); const msgs = (b.messages || []).slice(-12).map((x) => ({ role: x.role === 'assistant' ? 'assistant' : 'user', content: String(x.content).slice(0, 8000) })); return json(res, 200, { reply: await askAI(id, msgs, b.file) }); }
      if (act === 'files') {
        const rel = url.searchParams.get('path') || ''; const t = safe(root, rel);
        if (rel.split('/').some((x) => x === '.jes.json')) return json(res, 400, { error: 'ملف نظام' });
        if (req.method === 'GET') {
          const s = fs.statSync(t);
          if (s.isDirectory()) return json(res, 200, { items: fs.readdirSync(t, { withFileTypes: true }).filter((d) => d.name !== '.jes.json').map((d) => { const x = fs.statSync(path.join(t, d.name)); return { name: d.name, dir: d.isDirectory(), size: x.size, mtime: x.mtimeMs }; }).sort((a, b) => b.dir - a.dir || a.name.localeCompare(b.name)) });
          if (s.size > 1e6) return json(res, 413, { error: 'الملف كبير للتحرير (أكثر من 1MB)' });
          const buf = fs.readFileSync(t); if (!isText(buf)) return json(res, 415, { error: 'ملف ثنائي لا يمكن تحريره' }); return json(res, 200, { content: buf.toString('utf8') });
        }
        if (req.method === 'PUT') { const b = await readBody(req, 5e6); fs.mkdirSync(path.dirname(t), { recursive: true }); fs.writeFileSync(t, String(b.content ?? '')); return json(res, 200, { ok: true }); }
        if (req.method === 'POST') {
          const b = await readBody(req); const op = url.searchParams.get('op');
          if (op === 'mkdir') { fs.mkdirSync(t, { recursive: true }); return json(res, 200, { ok: true }); }
          if (op === 'delete') { if (t === root) throw new Error('لا يمكن حذف الجذر'); fs.rmSync(t, { recursive: true, force: true }); return json(res, 200, { ok: true }); }
          if (op === 'move') { const d = safe(root, b.to); if (d === root || fs.existsSync(d)) throw new Error('الوجهة موجودة أو غير صالحة'); fs.mkdirSync(path.dirname(d), { recursive: true }); fs.renameSync(t, d); return json(res, 200, { ok: true }); }
          if (op === 'extract') { const d = safe(root, b.to ?? path.dirname(rel)); fs.mkdirSync(d, { recursive: true }); return json(res, 200, { count: unzip(t, d) }); }
        }
        if (req.method === 'PUT' || req.method === 'POST') return json(res, 400, { error: 'عملية غير معروفة' });
      }
      if (act === 'upload' && req.method === 'POST') {
        const t = safe(root, url.searchParams.get('path') || ''); fs.mkdirSync(path.dirname(t), { recursive: true });
        const w = fs.createWriteStream(t); let n = 0, bad = false;
        req.on('data', (d) => { n += d.length; if (n > 3e8 && !bad) { bad = true; req.destroy(); w.destroy(); fs.rmSync(t, { force: true }); } });
        req.pipe(w); w.on('finish', () => json(res, bad ? 413 : 200, bad ? { error: 'الملف أكبر من 300MB' } : { ok: true, size: n })); w.on('error', () => json(res, 500, { error: 'فشل الكتابة' })); return;
      }
    }
    json(res, 404, { error: 'غير موجود' });
  } catch (e) { if (!res.headersSent) json(res, 400, { error: e.message || 'خطأ' }); }
});

/* ---------- البذرة والإقلاع ---------- */
// ذاكرة الخطة المجانية مؤقتة: أي مجلد داخل seed/ يُنسخ عند كل إقلاع إن لم يوجد، ويُشغَّل تلقائيًا.
if (fs.existsSync(SEED)) for (const d of fs.readdirSync(SEED, { withFileTypes: true })) {
  if (!d.isDirectory() || !/^[a-z0-9-]+$/.test(d.name) || fs.existsSync(pdir(d.name))) continue;
  fs.cpSync(path.join(SEED, d.name), pdir(d.name), { recursive: true });
  let conf = {}; try { conf = JSON.parse(fs.readFileSync(path.join(pdir(d.name), 'platform.json'), 'utf8')); } catch {}
  setMeta(d.name, { name: conf.name || d.name, cmd: conf.cmd || 'npm start', autostart: conf.autostart !== false, autorestart: true, env: conf.env || {}, envFrom: conf.envFrom || [], created: Date.now() });
}
const PORT = Number(process.env.PORT || 8080);
server.listen(PORT, () => { console.log('الجيسي يعمل على المنفذ', PORT); for (const id of allIds()) if (getMeta(id).autostart) start(id).catch((e) => sys(id, '✖ ' + e.message)); });
const bye = async () => { await Promise.all(allIds().map(stop)); process.exit(0); };
process.on('SIGTERM', bye); process.on('SIGINT', bye);
process.on('uncaughtException', (e) => console.error('uncaught', e.message)); process.on('unhandledRejection', (e) => console.error('unhandled', e?.message));
