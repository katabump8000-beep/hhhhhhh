// منفذ HTTP أولاً: بعض المنصات تعتبر المشروع حياً فقط إذا استمع لمنفذ
require('http').createServer((req, res) => { res.writeHead(200); res.end('ok'); }).listen(process.env.PORT || 3000);

process.on('unhandledRejection', (e) => console.error('unhandled', e && e.message));
process.on('uncaughtException', (e) => console.error('uncaught', e && e.message));

try {
  require('./handlers');
  require('./shim').start().catch((e) => console.error('start failed:', e && e.message));
} catch (e) {
  // لا نُسقط العملية: نبقيها حيّة لتظهر الرسالة في السجل ويمكن إضافة المفتاح ثم إعادة التشغيل
  console.error('تعذر التشغيل:', e && e.message);
}
