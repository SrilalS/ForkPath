/**
 * Best-effort start date from a free-form period label, as a fractional year (negative = BC).
 * Handles "1863", "1863-1870", "June 1914", "Spring 1940", "late 1960s", "1990s", "48 BC", "AD 60",
 * "15th century", "c. 1500". Returns null when no date can be found.
 */
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const PARTS: [RegExp, number][] = [
  [/\bearly\b/, 0.1],
  [/\bspring\b/, 0.25],
  [/\b(mid|middle|summer)\b/, 0.5],
  [/\b(autumn|fall)\b/, 0.75],
  [/\blate\b/, 0.8],
  [/\bwinter\b/, 0.9],
];

export function parsePeriodStart(period: string): number | null {
  // En and em dashes (written as escapes) count as range separators.
  const p = period.toLowerCase().replace(/[\u2013\u2014]/g, '-').trim();
  if (!p) return null;
  const bc = /\b(bc|bce|b\.c\.?)\b/.test(p);
  const sign = bc ? -1 : 1;

  // "15th century", "3rd century bc"
  const century = p.match(/\b(\d{1,2})(st|nd|rd|th)\s+century\b/);
  if (century) {
    const c = Number(century[1]);
    const part = PARTS.find(([re]) => re.test(p))?.[1] ?? 0;
    return bc ? -(c * 100) + part * 100 : (c - 1) * 100 + part * 100;
  }

  // First 3-4 digit number, or any number next to an era marker ("ad 60", "60 ad", "48 bc").
  const m =
    p.match(/\b(\d{3,4})(s)?\b/) ??
    p.match(/\b(?:ad|ce)\s*(\d{1,4})\b/) ??
    p.match(/\b(\d{1,4})\s*(?:ad|ce|bc|bce|b\.c\.?)/) ??
    p.match(/^(?:c\.?\s*|circa\s*)?(\d{1,4})$/);
  if (!m) return null;
  const year = Number(m[1]) * sign;
  const decade = m[2] === 's';

  let frac = 0;
  const month = MONTHS.findIndex((mo) => new RegExp(`\\b${mo}`).test(p));
  if (month >= 0) frac = month / 12;
  else {
    const part = PARTS.find(([re]) => re.test(p))?.[1];
    // For a decade the part scales to years: "late 1960s" -> 1968.
    if (part !== undefined) frac = decade ? part * 10 : part;
  }
  return year + frac;
}

export function formatYear(y: number): string {
  const whole = Math.floor(y);
  return whole < 0 ? `${-whole} BC` : String(whole);
}
