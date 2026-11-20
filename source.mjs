import { readFile } from 'node:fs/promises';

export const ORIGIN = 'https://analyst-assessment-production.up.railway.app';
export const DIRECTORY = '/communities';

export async function configuration() {
  const file = await readFile(new URL('./.env', import.meta.url), 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return '';
  });
  const key = file.match(/^BELLHAVEN_TOKEN=(.+)$/m)?.[1]?.trim();
  const token = process.env.BELLHAVEN_TOKEN || key;
  if (!token) throw new Error('Set BELLHAVEN_TOKEN in .env or the environment.');
  return { token };
}

export function transport(token, fetcher = fetch) {
  return async (path, { method = 'GET', body } = {}) => {
    const url = new URL(path, ORIGIN);
    if (url.origin !== ORIGIN) throw new Error('Unexpected Bellhaven origin.');
    const api = url.pathname.startsWith('/api/v1/');
    const headers = api ? { Authorization: 'Bearer ' + token, Accept: 'application/json' } : {};
    if (body) headers['Content-Type'] = 'application/json';
    let response;
    try {
      response = await fetcher(url, {
        method, headers, body: body && JSON.stringify(body),
        redirect: 'error', signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw new Error(method + ' ' + url.pathname + ' could not reach Bellhaven (' +
        (error.cause?.code || error.name) + ').');
    }
    if (!response.ok) {
      const detail = api ? await response.json().catch(() => ({})) : {};
      const message = typeof detail.detail === 'string' ? ' · ' + detail.detail : '';
      throw new Error(method + ' ' + url.pathname + ' returned HTTP ' + response.status + message);
    }
    return api ? response.json() : response.text();
  };
}

const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function plain(markup) {
  return markup.replace(/<[^>]*>/g, '').replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
    (_, entity) => entity[0] === '#'
      ? String.fromCodePoint(entity[1].toLowerCase() === 'x'
        ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1)))
      : entities[entity.toLowerCase()]
  ).replace(/\s+/g, ' ').trim();
}

function communityLinks(html) {
  const links = new Set();
  for (const match of html.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["']/gi)) {
    const target = new URL(plain(match[1]), ORIGIN);
    if (target.origin === ORIGIN && /^\/communities\/[^/]+\/?$/.test(target.pathname)) {
      links.add(target.pathname.replace(/\/$/, ''));
    }
  }
  return links;
}

export function parseCommunity(html, path) {
  const name = plain(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? '');
  const definition = new Map(Array.from(html.matchAll(/<dt\b[^>]*>(.*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi),
    ([, label, value]) => [plain(label).toLowerCase(), value]));
  const addressLines = (definition.get('address') || '').split(/<br\s*\/?\s*>/i).map(plain).filter(Boolean);
  const [street, cityLine] = [addressLines.slice(0, -1).join(', '), addressLines.at(-1) || ''];
  const locality = cityLine.match(/^(.+),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/);
  const careMarkup = definition.get('care offerings') || '';
  const care = Array.from(careMarkup.matchAll(/<span\b[^>]*>(.*?)<\/span>/gi), match => plain(match[1])).filter(Boolean);
  if (!care.length && plain(careMarkup)) care.push(plain(careMarkup));
  if (!name || !street || !locality || !care.length) throw new Error('Incomplete community page: ' + path);
  return {
    path, url: new URL(path, ORIGIN).href, name, street,
    city: locality[1], state: locality[2], zip: locality[3], care,
    phone: plain(definition.get('phone') || ''),
    administrator: plain(definition.get('administrator') || ''),
  };
}

export async function scrape(get) {
  const [home, first] = await Promise.all([get('/'), get(DIRECTORY)]);
  const metadata = html => html.match(/Page\s+(\d+)\s+of\s+(\d+)\s*·\s*(\d+)\s+communities listed/i)?.slice(1).map(Number);
  const [page, pageCount, listed] = metadata(first) || [];
  if (page !== 1 || !pageCount || !listed || pageCount > 100) throw new Error('Directory pagination could not be verified.');
  const directory = communityLinks(first);
  for (let current = 2; current <= pageCount; current++) {
    const html = await get(DIRECTORY + '?page=' + current);
    const check = metadata(html);
    if (check?.[0] !== current || check[1] !== pageCount || check[2] !== listed) {
      throw new Error('Directory changed or returned the wrong page. Run again.');
    }
    for (const path of communityLinks(html)) directory.add(path);
  }
  if (listed !== directory.size) throw new Error('Directory advertised ' + listed + ' locations and returned ' + directory.size + '.');
  const featured = communityLinks(home);
  const urls = Array.from(new Set([...directory, ...featured]));
  const expected = plain(home).match(/(?:serve|serving)\s+(\d+)\s+communities\b/i)?.[1];
  if (expected && urls.length < Number(expected)) {
    throw new Error('The homepage advertises ' + expected + ' communities but only ' + urls.length + ' links were found.');
  }
  const locations = [];
  for (let index = 0; index < urls.length; index += 8) {
    locations.push(...await Promise.all(urls.slice(index, index + 8)
      .map(async url => ({ ...parseCommunity(await get(url), url),
        discovery: directory.has(url) ? 'Community directory' : 'Homepage feature' }))));
  }
  return { locations, pages: pageCount, listed, featuredOnly: urls.length - listed };
}

async function listRecords(request, collection, idField) {
  const accounts = new Map();
  let total;
  for (let page = 1; total === undefined || accounts.size < total; page++) {
    const data = await request('/api/v1/' + collection + '?page_size=100&page=' + page);
    if (!Array.isArray(data.data) || !Number.isInteger(data.total) || data.page !== page ||
      (total !== undefined && data.total !== total) || (!data.data.length && data.total > 0)) {
      throw new Error('CRM pagination changed or returned an unexpected response.');
    }
    total = data.total;
    for (const account of data.data) {
      if (!account[idField] || accounts.has(account[idField])) throw new Error('Duplicate or missing ID in CRM pagination.');
      accounts.set(account[idField], account);
    }
    if (accounts.size > total) throw new Error('CRM account count disagrees with the list response.');
  }
  return Array.from(accounts.values());
}

export const listAccounts = request => listRecords(request, 'accounts', 'account_id');
export const listContacts = request => listRecords(request, 'contacts', 'contact_id');
