// Content of the setup guide, and the small helpers it needs.
// Text in `backticks` is shown as a code chip (the exact words to type or tap).

// 24 random bytes -> 32 URL-safe characters. Used for the two keys.
export function generateKey() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// "masroofi.me.workers.dev" -> "https://masroofi.me.workers.dev". Returns null when it is not a usable address.
export function normalizeWorkerUrl(text) {
  let t = String(text ?? '').trim();
  if (!t) return null;
  if (!/^https?:\/\//i.test(t)) t = `https://${t}`;
  try {
    const u = new URL(t);
    if (u.protocol !== 'https:' || !u.hostname.includes('.')) return null;
    return u.origin;
  } catch {
    return null;
  }
}

export const CLOUDFLARE_NOTE = 'أسماء الأزرار في الخطوات 4 و5 و6 وزر `Create application` طابقتها مع وثائق Cloudflare الرسمية. أما قالب `Hello World` وزر `Edit code` فمن معرفتي ولم تؤكدها الوثائق، فإن ما لقيتهما صوّر لي الشاشة. أسماء القوائم تتغير أحياناً، فابحث عن أقرب معنى.';

export const CLOUDFLARE_STEPS = [
  'سجّل حساباً مجانياً في موقع `cloudflare.com` (ما تأكدت إن كان التسجيل يطلب بطاقة).',
  'من لوحة التحكم افتح `Workers & Pages` ثم `Create application`. اختر القالب `Hello World` (أبسط قالب)، سمّه `masroofi` واضغط `Deploy`.',
  'اضغط `Edit code`، امسح كل الموجود، والصق كود الصندوق (زر النسخ أعلاه)، ثم اضغط `Deploy`.',
  'افتح صفحة `Workers KV` واضغط `Create instance`، سمّها `masroofi-inbox` ثم `Create`.',
  'ارجع للـWorker وافتح تبويب `Bindings` ثم `Add binding` ثم `KV namespace`. في `Variable name` اكتب `INBOX` بالضبط، واختر المساحة اللي أنشأتها، ثم `Add binding`.',
  'في الـWorker افتح `Settings` ثم `Variables and Secrets` ثم `Add`. أضف سرّين من نوع `Secret`: الاسم `INGEST_KEY` وقيمته مفتاح الإرسال، والاسم `PULL_KEY` وقيمته مفتاح السحب. ثم اضغط `Deploy` (السر ما يشتغل قبلها).',
  'انسخ عنوان الصندوق (ينتهي بـ `workers.dev`) والصقه في الخانة أدناه.',
];

export const SMS_NOTE = 'ما اختبرت هذه الخطوات على جوالك. شكل `Shortcut Input` يختلف بين نسخ iOS، فجرّبها بالاختبار في آخر الدليل.';

export const SMS_STEPS = [
  'افتح تطبيق الاختصارات ثم `Automation` ثم `+` ثم `Message`.',
  'في `Message Contains` اكتب `شراء` واترك المرسل فارغاً.',
  'اختر `Run Immediately` ثم `Next`.',
  'أضف الإجراء `Get Contents of URL`.',
  'الرابط هو رابط الإرسال الظاهر أعلاه. اضغط السهم لإظهار الخيارات واجعل `Method` = `POST`.',
  'في `Headers` أضف `Authorization` وقيمته `Bearer ` ثم مفتاح الإرسال.',
  'في `Request Body` اختر `JSON` وأضف حقلين نصيين: `source` = `sms`، و`text` = المتغير `Shortcut Input` (إن ظهر لك خيار `Content` فاختره).',
  'احفظ. ما تحتاج حقل تاريخ، الصندوق يسجل وقت الوصول.',
];

export const WALLET_NOTE = 'هذي الأتمتة طبقة ثانية: تظهر العملية فوراً «معلّقة» وتتأكد لما تصل رسالة البنك. تشتغل أيضاً مع العمليات المرفوضة، لذلك ما تدخل الحساب قبل رسالة البنك.';

export const WALLET_STEPS = [
  'في `Automation` اضغط `+` ثم `Transaction`.',
  'اختر البطاقات اللي تدفع بها ثم `Run Immediately`.',
  'أضف `Get Contents of URL` بنفس الرابط، و`POST`، ونفس الرأس `Authorization`.',
  'الجسم `JSON` بأربعة حقول: `source` = `wallet`، و`merchant` = `Merchant` من `Shortcut Input`، و`amount` = `Amount`، و`card` = `Card or Pass`.',
  'احفظ.',
];

export const TEST_STEPS = [
  'اضغط «أرسل اختباراً» أدناه. يرسل رسالة غير مرئية تمر على الصندوق وتنسحب وتنحذف. إذا نجحت فالصندوق والمفاتيح سليمة.',
  'أرسل لنفسك رسالة نصية فيها كلمة `شراء`. إذا ظهرت في المراجعة تحت «رسائل ما فهمتها» فاختصار الرسائل يشتغل. احذفها بعدها بزر «تجاهل».',
  'ادفع بـ Apple Pay. يجب أن تظهر عملية «معلّقة» ثم تتأكد برسالة البنك.',
];

// The body the in-app test sends. The app recognises a verification-code text and drops it silently,
// so the test checks the whole path (key, inbox, pull, delete) without creating a transaction.
export const TEST_MESSAGE = 'رمز التحقق 000000 (اختبار الاتصال من مصروفي)';
