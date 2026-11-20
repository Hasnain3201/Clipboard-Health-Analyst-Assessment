import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listAccounts, listContacts, scrape } from './source.mjs';
import { identity, proposals, protectedBilling } from './matching.mjs';

export const databasePath = fileURLToPath(new URL('./.state/review.sqlite', import.meta.url));

export function openStore(path = databasePath) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY, data TEXT NOT NULL, status TEXT NOT NULL,
      attempted_create INTEGER DEFAULT 0, created_id TEXT, result TEXT,
      error TEXT, decided_at TEXT, reviewer_note TEXT
    );
    CREATE TABLE IF NOT EXISTS latest_scan (id INTEGER PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS metadata (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL);
    INSERT OR IGNORE INTO metadata VALUES (1, 0);
  `);
  return db;
}

const readRow = (db, id) => db.prepare('SELECT * FROM reviews WHERE id = ?').get(id);
const clock = () => new Date().toISOString();
const revision = db => db.prepare('SELECT revision FROM metadata WHERE id = 1').get().revision;
const bump = db => db.exec('UPDATE metadata SET revision = revision + 1 WHERE id = 1');
const accountPath = id => '/api/v1/accounts/' + encodeURIComponent(id);
const contains = (account, fields) => Object.entries(fields).every(([name, value]) => (account[name] ?? '') === value);

class ProposalChanged extends Error {}

function transaction(db, action) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

async function liveModel(request) {
  const [website, accounts, contacts] = await Promise.all([
    scrape(request), listAccounts(request), listContacts(request),
  ]);
  return { website, accounts, ...proposals(website, accounts, contacts) };
}

export async function scan(db, request) {
  const version = revision(db);
  const { website, accounts, parent, matches, queue } = await liveModel(request);
  const summary = {
    time: clock(), pages: website.pages, directory: website.listed,
    featuredOnly: website.featuredOnly, locations: website.locations.length,
    accounts: accounts.length, parent, matches,
  };
  transaction(db, () => {
    if (revision(db) !== version || db.prepare("SELECT 1 FROM reviews WHERE status = 'Applying' LIMIT 1").get()) {
      throw new Error('A review was applied during this scan. Run the scan again.');
    }
    db.exec("UPDATE reviews SET status = 'Superseded' WHERE status = 'Pending'");
    const save = db.prepare(`
      INSERT INTO reviews (id, data, status) VALUES (?, ?, 'Pending')
      ON CONFLICT(id) DO UPDATE SET status = 'Pending', data = excluded.data
      WHERE reviews.status = 'Superseded'
    `);
    for (const item of queue) save.run(item.id, JSON.stringify(item));
    db.prepare('INSERT OR REPLACE INTO latest_scan VALUES (1, ?)').run(JSON.stringify(summary));
  });
  return { locations: summary.locations, accounts: summary.accounts,
    pending: db.prepare("SELECT count(*) AS count FROM reviews WHERE status = 'Pending'").get().count };
}

export function reviewState(db) {
  const result = db.prepare('SELECT data FROM latest_scan WHERE id = 1').get();
  return {
    summary: result ? JSON.parse(result.data) : null,
    rows: db.prepare("SELECT * FROM reviews WHERE status <> 'Superseded' ORDER BY rowid").all()
      .map(({ data, result, ...row }) => ({ ...row, proposal: JSON.parse(data), result: result ? JSON.parse(result) : null })),
  };
}

async function revalidate(request, item) {
  const model = await liveModel(request);
  if (!model.queue.some(proposal => proposal.id === item.id)) {
    throw new ProposalChanged('The CRM or website evidence changed. Run a new scan and review the updated proposal.');
  }
}

function assertCurrent(item, current) {
  if (!contains(identity(current), identity(item.account)) ||
    (Object.hasOwn(item.stateBefore, 'note') && (current.note || '') !== item.stateBefore.note)) {
    throw new ProposalChanged('The CRM record changed. Run a new scan and review the updated proposal.');
  }
  if (Object.hasOwn(item.stateBefore, 'protectedBilling') &&
    protectedBilling(current) !== item.stateBefore.protectedBilling) {
    throw new ProposalChanged('Billing eligibility changed. Run a new scan and review the new ownership action.');
  }
}

async function applyPatch(request, item) {
  const path = accountPath(item.account.account_id);
  const previous = await request(path);
  if (!contains(previous, item.payload)) {
    await revalidate(request, item);
    assertCurrent(item, await request(path));
    await request(path, { method: 'PATCH', body: item.payload });
  }
  const current = await request(path);
  if (!contains(current, item.payload)) throw new Error('The CRM did not retain every approved field.');
  return { accountId: current.account_id, verified: item.payload };
}

async function createOrRecover(db, request, row, item) {
  const marker = 'Reconciliation reference: ' + item.id;
  const body = { ...item.payload, note: item.payload.note + '\n' + marker };
  let id = row.created_id;
  if (!id && row.attempted_create) {
    const accounts = await listAccounts(request);
    const marked = accounts.filter(account => account.note?.split('\n').includes(marker));
    if (marked.length !== 1) {
      throw new Error('The earlier create has no unique CRM receipt. Check the account list before attempting any new create.');
    }
    id = marked[0].account_id;
  }
  if (!id) {
    await revalidate(request, item);
    if (item.kind === 'chow') assertCurrent(item, await request(accountPath(item.account.account_id)));
    db.prepare('UPDATE reviews SET attempted_create = 1 WHERE id = ?').run(item.id);
    const account = await request('/api/v1/accounts', { method: 'POST', body });
    if (!account.account_id) throw new Error('The CRM create response did not provide an account ID.');
    id = account.account_id;
  }
  db.prepare('UPDATE reviews SET created_id = ? WHERE id = ?').run(id, item.id);
  const created = await request(accountPath(id));
  if (!contains(created, body)) throw new Error('The created account does not contain every approved field. Inspect it before retrying.');
  return id;
}

async function applyChow(request, item, createdId) {
  const path = accountPath(item.account.account_id);
  const before = await request(path);
  if (before.chow_current_account && before.chow_current_account !== createdId) {
    throw new Error('The historical account now points to a different CHOW account. Inspect both records.');
  }
  if (!before.chow_current_account) {
    if (!contains(identity(before), identity(item.account))) {
      throw new Error('The original CRM record changed after creation. Reconcile both accounts before linking.');
    }
    await request(path, { method: 'PATCH', body: { chow_current_account: createdId } });
  }
  const after = await request(path);
  const fields = Object.keys(before).filter(key => !['chow_current_account', 'updated_at'].includes(key));
  if (after.chow_current_account !== createdId || fields.some(key => before[key] !== after[key])) {
    throw new Error('The historical account changed unexpectedly. Inspect it before proceeding.');
  }
  return { accountId: createdId, historicalAccountId: before.account_id, verified: { chow_current_account: createdId } };
}

export function reviewer(db, request) {
  let applying = false;
  return async (id, decision, note = '') => {
    if (applying) throw new Error('A decision is still being applied. Wait for it to finish.');
    const row = readRow(db, id);
    if (!row || !['Pending', 'Failed', 'Applying'].includes(row.status)) {
      throw new Error('This proposal is no longer available for review.');
    }
    const item = JSON.parse(row.data);
    const reason = note.trim() || null;
    if (decision === 'reject' && row.status === 'Pending') {
      transaction(db, () => {
        const saved = db.prepare("UPDATE reviews SET status = 'Rejected', decided_at = ?, reviewer_note = ? WHERE id = ? AND status = 'Pending'").run(clock(), reason, id);
        if (!saved.changes) throw new Error('This proposal was already decided.');
        bump(db);
      });
      return { status: 'Rejected' };
    }
    if (decision !== 'approve' || item.kind === 'ambiguous') throw new Error('This evidence cannot support an approved CRM write.');
    applying = true;
    try {
      transaction(db, () => {
        const saved = db.prepare("UPDATE reviews SET status = 'Applying', decided_at = ?, reviewer_note = COALESCE(?, reviewer_note), error = NULL WHERE id = ? AND status = ?")
          .run(clock(), reason, id, row.status);
        if (!saved.changes) throw new Error('This proposal was already decided.');
        bump(db);
      });
      let result;
      if (item.kind === 'create' || item.kind === 'chow') {
        const created = await createOrRecover(db, request, row, item);
        result = item.kind === 'chow' ? await applyChow(request, item, created) : { accountId: created, verified: item.payload };
      } else {
        result = await applyPatch(request, item);
      }
      transaction(db, () => {
        db.prepare("UPDATE reviews SET status = 'Approved', result = ? WHERE id = ?").run(JSON.stringify(result), id);
        bump(db);
      });
      return { status: 'Approved', result };
    } catch (error) {
      transaction(db, () => {
        const status = error instanceof ProposalChanged ? 'Superseded' : 'Failed';
        db.prepare("UPDATE reviews SET status = ?, error = ? WHERE id = ? AND status = 'Applying'").run(status, error.message, id);
        bump(db);
      });
      throw error;
    } finally {
      applying = false;
    }
  };
}
