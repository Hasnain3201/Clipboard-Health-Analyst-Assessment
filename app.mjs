import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configuration, ORIGIN, transport } from './source.mjs';
import { dashboard } from './dashboard.mjs';
import { openStore, reviewer, reviewState, scan } from './review.mjs';

export async function run({ mode = 'serve', port = 4391, dbPath, request, token, owner = '127.0.0.1' } = {}) {
  token = token || (await configuration()).token;
  request = request || transport(token);
  const db = openStore(dbPath);
  if (mode === 'scan') {
    try {
      return await scan(db, request);
    } finally {
      db.close();
    }
  }
  if (mode !== 'serve') throw new Error('Usage: node app.mjs [serve|scan]');
  const decide = reviewer(db, request);
  const csrf = randomBytes(32).toString('hex');
  const css = readFileSync(new URL('./style.css', import.meta.url));
  const hosts = new Set(['127.0.0.1', 'localhost']);
  const statusPage = (res, code, message) => {
    res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(message);
  };
  const navigate = (res, path) => {
    res.writeHead(303, { Location: path });
    res.end();
  };

  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    try {
      const host = new URL('http://' + req.headers.host);
      if (!hosts.has(host.hostname)) return statusPage(res, 403, 'Use the loopback address.');
      const url = new URL(req.url, host);
      const reviewRoute = url.pathname.match(/^\/review\/([0-9a-f]{24})$/);
      const crmRoute = url.pathname.match(/^\/crm-record\/([a-zA-Z0-9]+)$/);
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        const view = ['history', 'inventory'].includes(url.searchParams.get('view')) ? url.searchParams.get('view') : 'queue';
        return res.end(dashboard(reviewState(db), {
          csrf, view, id: url.searchParams.get('id'), message: url.searchParams.get('message'),
        }));
      }
      if (req.method === 'GET' && url.pathname === '/style.css') {
        res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
        return res.end(css);
      }
      if (req.method === 'GET' && crmRoute) {
        return navigate(res, ORIGIN + '/crm/' + encodeURIComponent(token) + '/accounts/' + crmRoute[1]);
      }
      if (req.method === 'POST' && (url.pathname === '/scan' || reviewRoute)) {
        const origin = req.headers.origin;
        if (origin && origin !== host.origin) return statusPage(res, 403, 'Use the review app to submit a decision.');
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 10_000) return statusPage(res, 413, 'Review form is too large.');
        }
        const form = new URLSearchParams(body);
        if (form.get('csrf') !== csrf) return statusPage(res, 403, 'Reload the review app and try again.');
        try {
          if (!reviewRoute) {
            const result = await scan(db, request);
            return navigate(res, '/?message=' + encodeURIComponent(
              'Scan complete. ' + result.pending + ' pending proposals for ' + result.locations + ' locations.'));
          }
          const result = await decide(reviewRoute[1], form.get('decision'), (form.get('note') || '').slice(0, 1000));
          return navigate(res, '/?view=history&id=' + reviewRoute[1] + '&message=' + encodeURIComponent(
            result.status === 'Approved' ? 'Approved and verified in the CRM.' : 'Review decision saved.'));
        } catch (error) {
          return navigate(res, '/?id=' + (reviewRoute?.[1] || '') + '&message=' + encodeURIComponent(error.message));
        }
      }
      return statusPage(res, 404, 'Page not found.');
    } catch (error) {
      return statusPage(res, 500, 'Could not load the review workspace. ' + error.message);
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, owner, resolve);
  }).catch(error => {
    db.close();
    throw error;
  });
  server.once('close', () => db.close());
  return { server, url: 'http://' + owner + ':' + server.address().port + '/', state: () => reviewState(db) };
}

if (globalThis.process?.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await run({ mode: process.argv[2], port: Number(process.env.BELLHAVEN_PORT || 4391) });
    console.log(result.url || JSON.stringify(result));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
