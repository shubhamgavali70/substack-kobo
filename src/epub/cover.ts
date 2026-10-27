import { xmlText } from './xml';

/**
 * Generates a simple SVG cover from the title and publication name. SVG is an
 * EPUB 3 core media type and renders on Kobo inside the book; library-grid
 * thumbnails for SVG covers vary by firmware (see docs/KOBO.md).
 */

const PALETTE = [
  '#1f3a5f',
  '#4a2c40',
  '#2f4f3a',
  '#5a3d2b',
  '#2e3e4e',
  '#4b3b6b',
  '#3b4a2f',
  '#6b2d3c',
];

export function generateCoverSvg(
  title: string,
  publication: string | null,
  author: string | null,
): string {
  const bg = PALETTE[hash(publication ?? title) % PALETTE.length] ?? '#1f3a5f';
  const titleLines = wrap(title, 22, 7);
  const titleSize = titleLines.length > 5 ? 72 : titleLines.length > 3 ? 84 : 96;
  const lineHeight = Math.round(titleSize * 1.18);
  const startY = 760 - Math.round(((titleLines.length - 1) * lineHeight) / 2);

  const titleText = titleLines
    .map(
      (line, i) =>
        `<text x="600" y="${startY + i * lineHeight}" text-anchor="middle" font-size="${titleSize}" font-weight="700" fill="#ffffff">${xmlText(line)}</text>`,
    )
    .join('\n    ');

  const pubLines = publication ? wrap(publication, 30, 2) : [];
  const pubText = pubLines
    .map(
      (line, i) =>
        `<text x="600" y="${220 + i * 56}" text-anchor="middle" font-size="46" letter-spacing="4" fill="#e8e8e8">${xmlText(line.toUpperCase())}</text>`,
    )
    .join('\n    ');

  const authorText = author
    ? `<text x="600" y="1380" text-anchor="middle" font-size="52" font-style="italic" fill="#f2f2f2">${xmlText(wrap(author, 34, 1)[0] ?? '')}</text>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1600" viewBox="0 0 1200 1600">
  <rect width="1200" height="1600" fill="${bg}"/>
  <rect x="60" y="60" width="1080" height="1480" fill="none" stroke="#ffffff" stroke-opacity="0.35" stroke-width="6"/>
  <line x1="300" y1="300" x2="900" y2="300" stroke="#ffffff" stroke-opacity="0.6" stroke-width="4"/>
  <g font-family="Georgia, 'Times New Roman', serif">
    ${pubText}
    ${titleText}
    ${authorText}
  </g>
</svg>
`;
}

export function wrap(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = word.length > maxChars ? `${word.slice(0, maxChars - 1)}…` : word;
    }
  }
  if (current) lines.push(current);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    const last = kept[maxLines - 1] ?? '';
    kept[maxLines - 1] = `${last.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
    return kept;
  }
  return lines;
}

function hash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}
