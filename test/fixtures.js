// The three real messages as pasted by the user. The U+061C before the Al Rajhi date is an
// invisible Arabic letter mark that was present in the original text.

export const BARQ = `محفظه برق
شراء إنترنت
فيزا63.82 SAR
رصيد2.85
لدىHUNGERSTATION
2026-10-31 16:23`;

export const RAJHI = `بنك الراجحي

شراء PoS
عبر:9683;مدى-ابل باي
بـSAR 34.50
لـMCDONALDS
؜31/10/26 02:45`;

export const AHLI = `البنك الاهلي

شراء انترنت
بـ9 SAR
من 7001*
من barq
مدى-ابل *4712
في 10/05/26 16:07`;

export const stripHeader = (text) => text.split('\n').slice(1).join('\n');
