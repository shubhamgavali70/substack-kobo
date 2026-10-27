// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional XML control-char filter
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

export function xmlText(value: string): string {
  return value
    .replace(INVALID_XML, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function xmlAttr(value: string): string {
  return xmlText(value).replace(/"/g, '&quot;');
}

/** Formats a Date as the second-precision UTC form required by dcterms:modified. */
export function w3cdtf(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function formatHumanDate(iso: string | null, locale = 'en'): string | null {
  if (!iso) return null;
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return null;
  try {
    return new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(time));
  } catch {
    return new Date(time).toISOString().slice(0, 10);
  }
}
