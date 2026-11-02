# الجيسي — منصة تشغيل مشاريع Node.js

بدون أي اعتماديات. كلمة سر واحدة للدخول.

## النشر على Render (مجاني، بدون بطاقة)
1. ارفع المجلد كله إلى مستودع GitHub **خاص (Private)**.
2. Render ← New ← Web Service ← اختر المستودع. Runtime: Node. Build: `echo ok`. Start: `npm start`. Plan: Free.
3. Environment:
   - `ADMIN_PASSWORD` = كلمة السر (اختياري؛ الافتراضي مضمَّن كبصمة مشفّرة).
   - `FIREBASE_SERVICE_ACCOUNT` = محتوى ملف JSON لحساب الخدمة (يستلمه push-server تلقائيًا).
4. بعد النشر افتح رابط الخدمة وأدخل كلمة السر.
5. لمنع النوم: أنشئ مراقبًا في UptimeRobot (مجاني) على `https://اسم-خدمتك.onrender.com/healthz` كل 5 دقائق.

## ملاحظات
- تخزين Render المجاني مؤقت. أي مشروع تريده دائمًا ضعه في `seed/<اسم>/` مع `platform.json`؛ يُنسخ ويُشغَّل تلقائيًا عند كل إقلاع. `push-server` مضمَّن هكذا.
- متغيرات المنصة لا تُمرَّر للمشاريع إلا ما ذكرته في `envFrom`.
