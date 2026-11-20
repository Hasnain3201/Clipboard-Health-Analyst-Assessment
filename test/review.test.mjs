import assert from 'node:assert/strict';
import test from 'node:test';
import { openStore, reviewer, reviewState, scan } from '../review.mjs';
import { scrape } from '../source.mjs';
import { PARENT_NAME } from '../matching.mjs';

const directory = '<h1>Our Communities</h1><p>Page 1 of 1 · 1 communities listed</p><a href="/communities/example">Example</a>';
const community = '<h1>Bellhaven of Example</h1><dl><dt>Address</dt><dd>100 Main Street<br>Example, OH 43001</dd><dt>Phone</dt><dd>(614) 555-2000</dd><dt>Care Offerings</dt><dd><span>Assisted Living</span><span>Memory Support</span></dd></dl>';
const parent = { account_id: 'PARENT', name: PARENT_NAME, parent_id: '', status: 'Active' };
const historical = {
  account_id: 'ORIGINAL', name: 'Bellhaven of Example', parent_id: 'CEDAR', status: 'Active',
  billing_street: '100 Main St', billing_city: 'Example', billing_state: 'OH', billing_zip: '43001',
  phone: '(614) 555-2000', care_type: 'Assisted Living', lifetime_revenue: 5000,
  outstanding_ar: 120, chow_current_account: '', duplicate_of_account: '', note: 'Billing history',
};

function sandbox(records, { lostReply = false } = {}) {
  const accounts = new Map(records.map(account => [account.account_id, { ...account }]));
  const writes = [];
  const request = async (path, { method = 'GET', body } = {}) => {
    if (path === '/') return 'Bellhaven serves 1 communities';
    if (path === '/communities') return directory;
    if (path === '/communities/example') return community;
    if (path.startsWith('/api/v1/contacts?')) return { data: [], total: 0, page: 1 };
    if (path.startsWith('/api/v1/accounts?')) return { data: Array.from(accounts.values()), total: accounts.size, page: 1 };
    if (path === '/api/v1/accounts' && method === 'POST') {
      writes.push([method, path, body]);
      const created = { ...body, account_id: 'NEW', chow_current_account: '', duplicate_of_account: '' };
      accounts.set(created.account_id, created);
      if (lostReply) throw new Error('Connection lost after POST');
      return { ...created };
    }
    const current = accounts.get(path.split('/').at(-1));
    if (!current) throw new Error('Unknown fixture route ' + path);
    if (method === 'PATCH') {
      writes.push([method, path, body]);
      Object.assign(current, body);
    }
    return { ...current };
  };
  return { request, writes, accounts };
}

test('scraper includes a homepage feature and refuses incomplete directory coverage', async () => {
  const request = async path => ({
    '/': '<p>We serve 2 communities.</p><a href="/communities/featured">Featured</a>',
    '/communities': directory,
    '/communities/example': community,
    '/communities/featured': community.replace('Bellhaven of Example', 'Featured Facility'),
  })[path];
  const snapshot = await scrape(request);
  assert.equal(snapshot.locations.length, 2);
  assert.equal(snapshot.featuredOnly, 1);
  assert.deepEqual(snapshot.locations[0].care, ['Assisted Living', 'Memory Support']);
  await assert.rejects(scrape(async path => path === '/communities'
    ? directory.replace('1 communities listed', '2 communities listed')
    : request(path)), /advertised 2 locations and returned 1/);
});

test('protected CHOW changes only the historical pointer and reruns do not reopen it', async () => {
  const { request, writes, accounts } = sandbox([parent, historical]);
  const db = openStore(':memory:');
  try {
    assert.equal((await scan(db, request)).pending, 1);
    assert.equal(writes.length, 0);
    const [{ id, proposal }] = reviewState(db).rows;
    assert.equal(proposal.kind, 'chow');
    const result = await reviewer(db, request)(id, 'approve');
    assert.equal(result.status, 'Approved');
    assert.deepEqual(accounts.get('ORIGINAL'), { ...historical, chow_current_account: 'NEW' });
    assert.equal(accounts.get('NEW').parent_id, 'PARENT');
    assert.deepEqual(writes[1][2], { chow_current_account: 'NEW' });
    assert.equal((await scan(db, request)).pending, 0);
    assert.equal(writes.length, 2);
  } finally {
    db.close();
  }
});

test('a lost POST response can be recovered without another create', async () => {
  const { request, writes, accounts } = sandbox([parent, historical], { lostReply: true });
  const db = openStore(':memory:');
  try {
    await scan(db, request);
    const [{ id }] = reviewState(db).rows;
    const decide = reviewer(db, request);
    await assert.rejects(decide(id, 'approve'), /Connection lost/);
    assert.equal(reviewState(db).rows[0].status, 'Failed');
    assert.equal(accounts.get('ORIGINAL').chow_current_account, '');
    await decide(id, 'approve');
    assert.equal(writes.filter(([method]) => method === 'POST').length, 1);
    assert.equal(accounts.get('ORIGINAL').chow_current_account, 'NEW');
  } finally {
    db.close();
  }
});

test('changed billing eligibility blocks an old approval and rejections remain decided', async () => {
  const { request, writes, accounts } = sandbox([parent, { ...historical, outstanding_ar: 0 }]);
  const db = openStore(':memory:');
  try {
    await scan(db, request);
    const [first] = reviewState(db).rows;
    assert.equal(first.proposal.kind, 'update');
    accounts.get('ORIGINAL').outstanding_ar = 100;
    const decide = reviewer(db, request);
    await assert.rejects(decide(first.id, 'approve'), /evidence changed/);
    assert.equal(writes.length, 0);
    await scan(db, request);
    const next = reviewState(db).rows.find(row => row.status === 'Pending');
    assert.equal(next.proposal.kind, 'chow');
    await decide(next.id, 'reject');
    assert.equal((await scan(db, request)).pending, 0);
    assert.equal(reviewState(db).rows.find(row => row.id === next.id).status, 'Rejected');
    assert.equal(writes.length, 0);
  } finally {
    db.close();
  }
});
