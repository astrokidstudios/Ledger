// First-guess categories for payees Ledger hasn't learned yet. A learned rule
// (from you sorting a payment) always wins over these. Each hint names a
// category by its name, and is skipped if you've renamed or deleted it.

const SOFTWARE = /\b(adobe|apple\.com\/bill|godaddy|ecamm|oneup|uppbeat|anthropic|claude|openai|chatgpt|lovable|canva|intuit|qbooks|quickbooks|xero|blackmagic|signature hound|google|gsuite|workspace|microsoft|notion|dropbox|figma|github|frame\.io|vimeo|epidemic sound|artlist|musicbed|squarespace|wix|webflow|zoom|slack|capcut|descript)\b/i;
const GROCERIES = /\b(lidl|aldi|tesco|sainsbury|asda|morrisons|waitrose|co-?op|iceland|m&s food|biedronka|żabka|zabka|carrefour|auchan|kaufland|netto|dino|lewiatan)\b/i;
const EATING = /\b(cafe|café|coffee|costa|starbucks|pret|greggs|restaurant|bar|pub|deliveroo|uber \*?eats|just eat|mcdonald|kfc|nando|pizza|kawiarnia|restauracja)\b/i;
const SUBS = /\b(netflix|spotify|disney|prime video|youtube premium|now tv|apple music|audible)\b/i;
const TRANSPORT = /\b(uber(?! \*?eats)|bolt|tfl|trainline|lner|avanti|shell|bp |esso|texaco|jet |orlen|parking|ringgo)\b/i;

export function hintCategory({ description = '', amount = 0, type = '' }, account, categories) {
  const by = (name) => categories.find((c) => c.name === name);
  const d = `${description} ${type}`;
  const biz = account?.scope === 'business';
  const pick = (name) => by(name) || null;

  if (/own account transfer|savings account|between accounts|przelew własny|przelew wewnętrzny|pot transfer/i.test(d)) return pick('Transfer between accounts');
  if (biz) {
    if (/\bfee\b|opłata|prowizja/i.test(d) && /ref: .*fee|bank|tide|mbank|transaction of/i.test(d)) return pick('Bank fees');
    if (amount < 0 && /dividend|dywidend/i.test(d)) return pick('Dividend paid out');
    if (amount < 0 && /salary|wynagrodzenie|board pay|payroll/i.test(d)) return pick('Owner board pay');
    if (SOFTWARE.test(d)) return pick('Software & tools');
    if (amount > 0 && !/refund/i.test(d)) return pick('Client income');
    return null; // leave other business spending for you to sort (deductible or not)
  }
  if (amount > 0 && /dividend|salary|wynagrodzenie|payroll/i.test(d)) return pick('Salary / dividends');
  if (SUBS.test(d)) return pick('Subscriptions');
  if (GROCERIES.test(d)) return pick('Groceries');
  if (EATING.test(d)) return pick('Eating out');
  if (TRANSPORT.test(d)) return pick('Transport');
  return null;
}
