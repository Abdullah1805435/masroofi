// Starter rules only. The server falls back to the Claude API for merchants not listed here,
// and user corrections should be stored and checked before these rules.

export const CATEGORIES = {
  restaurants: 'مطاعم وكافيهات',
  food_delivery: 'توصيل طعام',
  groceries: 'بقالة وسوبرماركت',
  transport: 'مواصلات',
  fuel: 'وقود',
  bills: 'فواتير واتصالات',
  shopping: 'تسوق',
  health: 'صحة وصيدلية',
  entertainment: 'ترفيه واشتراكات',
  other: 'أخرى', // chosen by the user for merchants that fit nowhere; never assigned automatically
};

// Wallets the user holds. A "purchase" from one of these is a top-up (money moving between
// the user's own accounts), not spending, otherwise the same money is counted twice.
// Only Barq is confirmed by the user; others are added from the settings screen.
export const DEFAULT_OWN_WALLETS = ['barq', 'برق'];

// Order matters: the first match wins, so specific names go before generic ones (UBEREATS before UBER).
const RULES = [
  ['UBEREATS', 'food_delivery'],
  ['HUNGERSTATION', 'food_delivery'],
  ['JAHEZ', 'food_delivery'],
  ['TOYOU', 'food_delivery'],
  ['KEETA', 'food_delivery'],

  ['MCDONALDS', 'restaurants'],
  ['KFC', 'restaurants'],
  ['BURGERKING', 'restaurants'],
  ['HARDEES', 'restaurants'],
  ['ALBAIK', 'restaurants'],
  ['HERFY', 'restaurants'],
  ['KUDU', 'restaurants'],
  ['STARBUCKS', 'restaurants'],
  ['DUNKIN', 'restaurants'],
  ['PIZZAHUT', 'restaurants'],
  ['DOMINOS', 'restaurants'],
  ['SUBWAY', 'restaurants'],

  ['PANDA', 'groceries'],
  ['DANUBE', 'groceries'],
  ['OTHAIM', 'groceries'],
  ['TAMIMI', 'groceries'],
  ['CARREFOUR', 'groceries'],
  ['LULU', 'groceries'],

  ['NAHDI', 'health'],
  ['ALDAWAA', 'health'],

  ['UBER', 'transport'],
  ['CAREEM', 'transport'],
  ['BOLT', 'transport'],

  ['ARAMCO', 'fuel'],
  ['SASCO', 'fuel'],
  ['ALDREES', 'fuel'],

  ['MOBILY', 'bills'],
  ['ZAIN', 'bills'],

  ['NETFLIX', 'entertainment'],
  ['SPOTIFY', 'entertainment'],
  ['SHAHID', 'entertainment'],
  ['YOUTUBE', 'entertainment'],
  ['APPLECOMBILL', 'entertainment'],

  ['AMAZON', 'shopping'],
  ['NOON', 'shopping'],
  ['JARIR', 'shopping'],
  ['IKEA', 'shopping'],
  ['SHEIN', 'shopping'],
];

export function merchantKey(name) {
  return String(name ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9؀-ۿ]/g, '');
}

export function isOwnWallet(name, wallets = DEFAULT_OWN_WALLETS) {
  const key = merchantKey(name);
  if (!key) return false;
  return wallets.map(merchantKey).filter(Boolean).some((w) => key.startsWith(w));
}

export function categorize(name) {
  const key = merchantKey(name);
  const hit = RULES.find(([word]) => key.includes(word));
  return hit ? hit[1] : null;
}
