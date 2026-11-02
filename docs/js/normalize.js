// Cleans raw SMS text before parsing:
// - removes invisible bidi/format marks (banks insert U+061C etc. before dates)
// - converts Arabic-Indic / Persian digits and separators to ASCII
// - collapses whitespace and drops empty lines
// The tatweel (U+0640) is kept on purpose: "بـ" and "لـ" use it as a prefix marker.

const INVISIBLES = /[؜​-‏‪-‮⁦-⁩﻿]/g;
const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const PERSIAN = '۰۱۲۳۴۵۶۷۸۹';

export function normalizeSms(text) {
  return String(text ?? '')
    .replace(INVISIBLES, '')
    .replace(/[٠-٩]/g, (d) => String(ARABIC_INDIC.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String(PERSIAN.indexOf(d)))
    .replace(/٫/g, '.')
    .replace(/٬/g, ',')
    .replace(/ /g, ' ')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}
