import { cbpReportTime, ageCaltransBorderWaits } from './borderWaits.js';
export { ageCaltransBorderWaits } from './borderWaits.js';

export const CALTRANS_BORDER_URL =
  'https://quickmap.dot.ca.gov/data/border_wait.html';
const text = (html) =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// A bounded table-fragment reader, not a general HTML renderer. Expand both
// spans so the second San Ysidro row cannot become an Otay Mesa observation.
function rows(fragment) {
  const grid = [];
  const matches = [...fragment.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
  if (matches.length > 30) throw new Error('invalid_caltrans_table');
  matches.forEach((match, row) => {
    grid[row] ??= [];
    let col = 0;
    for (const cell of match[1].matchAll(
      /<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/gi,
    )) {
      while (grid[row][col] !== undefined) col++;
      const span = (name) =>
        Number(
          new RegExp(`${name}\\s*=\\s*["']?(\\d+)`, 'i').exec(cell[1])?.[1] ??
            1,
        );
      const height = span('rowspan'),
        width = span('colspan');
      if (height < 1 || height > 5 || width < 1 || width > 5 || col + width > 5)
        throw new Error('invalid_caltrans_span');
      for (let y = row; y < row + height; y++) {
        grid[y] ??= [];
        for (let x = col; x < col + width; x++) grid[y][x] = text(cell[2]);
      }
      col += width;
    }
  });
  return grid;
}

function pacific(date, clock) {
  const c = /^(\d{1,2}:\d{2})\s*(am|pm)$/i.exec(clock ?? '');
  if (!c) return null;
  const candidates = ['PST', 'PDT']
    .map((zone) => cbpReportTime(date, `At ${c[1]} ${c[2]} ${zone}`, Infinity))
    .filter(Boolean);
  return candidates.length === 1 ? candidates[0] : null;
}

/** Parse the fixed Caltrans public fragment, keeping source text and clocks. */
export function parseCaltransBorderWaits(html, now = Date.now()) {
  if (typeof html !== 'string' || html.length > 128 * 1024)
    throw new Error('invalid_caltrans_html');
  const header = rows(
    /<thead\b[^>]*>([\s\S]*?)<\/thead>/i.exec(html)?.[1] ?? '',
  );
  const body = rows(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i.exec(html)?.[1] ?? '');
  if (
    header.length !== 3 ||
    header[0][0] !== 'Autos Southbound Border Wait Time (Minutes)' ||
    header[1][2] !== 'Current' ||
    header[1][3] !== 'Expected' ||
    header[1][4] !== 'Expected'
  )
    throw new Error('invalid_caltrans_header');
  const publicationText =
    /Last updated\s+(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d{1,2}:\d{2}\s*[ap]m)/i.exec(
      text(html),
    );
  const date = publicationText?.[1];
  const publishedAt = pacific(date, publicationText?.[2]);
  const routes = ['I-5', 'I-805'].map((route) => {
    const matches = body.filter(
      (row) => row[0] === 'San Ysidro' && row[1] === route && row.length === 5,
    );
    if (matches.length !== 1) throw new Error('invalid_caltrans_routes');
    const values = matches[0].slice(2).map((value, i) => ({
      text: value,
      minutes: /^\d{1,3}$/.test(value) ? Number(value) : null,
      targetText: header[2][i + 2],
      targetAt: pacific(date, header[2][i + 2]),
      kind: i === 0 ? 'current' : 'expected',
    }));
    return { route, current: values[0], expected: values.slice(1) };
  });
  return ageCaltransBorderWaits(
    {
      direction: 'southbound',
      source: 'Caltrans',
      sourceUrl: CALTRANS_BORDER_URL,
      timezoneAssumption: 'America/Los_Angeles',
      publicationText: publicationText?.[0] ?? null,
      publishedAt,
      sourceStatus: 'available',
      routes,
    },
    now,
  );
}
