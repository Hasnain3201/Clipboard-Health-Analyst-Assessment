import { ORIGIN } from './source.mjs';

const labels = {
  update: 'Account correction', create: 'New account', chow: 'Ownership change',
  duplicate: 'Duplicate', absent: 'Missing from site', ambiguous: 'Unverified match',
};

const fields = {
  name: 'Account name', parent_id: 'Parent account', billing_street: 'Billing street',
  billing_city: 'City', billing_state: 'State', billing_zip: 'ZIP', care_type: 'Care type',
  status: 'Status', phone: 'Phone', note: 'Note', duplicate_of_account: 'Duplicate of',
};

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);
const money = value => typeof value === 'number' ? new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', maximumFractionDigits: 0,
}).format(value) : 'Unavailable';
const locationAddress = location => [location.street, location.city, location.state + ' ' + location.zip].join(', ');
const accountAddress = account => [account.billing_street, account.billing_city, account.billing_state + ' ' + account.billing_zip].join(', ');
const accountLink = id => '/crm-record/' + encodeURIComponent(id);
const isOpen = row => ['Pending', 'Applying', 'Failed'].includes(row.status);

function evidence(row) {
  const item = row.proposal;
  const { location, account, alternatives } = item;
  const source = location ? `
  <div class="evidence-block website"><h3>Bellhaven website</h3><strong>${escape(location.name)}</strong>
  <p>${escape(locationAddress(location))}</p><p>${escape(location.care.join(' · '))}</p>
  <p>${escape([location.phone, location.administrator].filter(Boolean).join(' · '))}</p>
  <a href="${escape(location.url)}" target="_blank" rel="noreferrer">${escape(location.discovery)} ↗</a></div>` : `
  <div class="evidence-block website"><h3>Bellhaven website</h3>
  <strong>No matching listing</strong><p>${item.coverage.locations} locations across ${item.coverage.pages}
  directory pages and the homepage.</p><a href="${ORIGIN}/communities" target="_blank" rel="noreferrer">Open directory ↗</a></div>`;
  const crm = account ? `<div class="evidence-block crm"><h3>CRM record at scan</h3><strong>${escape(account.name)}</strong>
  <p>${escape(accountAddress(account))}</p><p>${escape(account.parent_name || 'No parent')} · ${escape(account.status)}</p>
  <p>${escape(account.phone)} · ${escape(account.care_type)}</p>
  <a href="${accountLink(account.account_id)}" target="_blank" rel="noreferrer">Open current account ↗</a></div>` :
  `<div class="evidence-block crm"><h3>CRM search</h3><strong>${alternatives.length ? 'Potential matches below' : 'No plausible account'}</strong>
  <p>The scan included accounts under other operators and accounts without a parent.</p></div>`;
  const cards = alternatives.map(candidate => `<li><div><a href="${accountLink(candidate.id)}"
  target="_blank" rel="noreferrer">${escape(candidate.name)} ↗</a><small>${escape(candidate.parent || 'No parent')}</small></div>
  <p>${escape(candidate.address)} · ${escape(candidate.phone || 'No phone')}</p>
  <small>${escape(candidate.signals.join(' · '))}</small></li>`).join('');
  return `<section><h2>Supporting evidence</h2><div class="evidence">${source}${crm}</div>
  ${cards ? `<details ${item.kind === 'ambiguous' || item.kind === 'duplicate' ? 'open' : ''}>
  <summary>CRM candidates <span>${alternatives.length}</span></summary><ul class="candidates">${cards}</ul></details>` : ''}</section>`;
}

function change(item) {
  if (!item.payload) return '<section><h2>Proposed decision</h2><p>Decline to link this community to any candidate based on the available evidence.</p></section>';
  const creating = item.kind === 'create' || item.kind === 'chow';
  const lines = Object.entries(item.payload).map(([field, value]) => {
    let next = value;
    if (field === 'parent_id') next = item.context.name;
    if (field === 'duplicate_of_account') next = item.survivor.name + ' (' + value + ')';
    const before = field === 'parent_id' ? item.account?.parent_name : item.account?.[field];
    return `<tr><th>${escape(fields[field] || field)}</th>${creating ? '' : `<td>${escape(before || 'None')}</td>`}
      <td class="next-value">${escape(next || 'None')}</td></tr>`;
  }).join('');
  const heading = creating ? 'New CRM record' : 'Proposed changes';
  const billing = item.account && (item.kind === 'chow' || 'parent_id' in item.payload) ?
    `<div class="billing"><div><span>Lifetime revenue</span><strong>${money(item.account.lifetime_revenue)}</strong></div>
    <div><span>Outstanding AR</span><strong>${money(item.account.outstanding_ar)}</strong></div>
    <p>${item.kind === 'chow' ?
    'The existing parent, balance, and other business fields stay in place. The historical account receives the CHOW link to the new account.' :
    'The billing rule allows an in-place parent change.'}</p></div>` : '';
  return `<section><h2>${heading}</h2>${billing}<div class="table-wrap"><table>
  <thead><tr><th>Field</th>${creating ? '' : '<th>Current</th>'}<th>Proposed</th></tr></thead>
  <tbody>${lines}</tbody></table></div></section>`;
}

function controls(row, csrf) {
  const item = row.proposal;
  if (!isOpen(row)) {
    const current = row.result ? `<a class="button primary" target="_blank" rel="noreferrer"
      href="${accountLink(row.result.accountId)}">View verified CRM record ↗</a>` : '';
    const history = row.result?.historicalAccountId ? `<a class="button ghost" target="_blank" rel="noreferrer"
      href="${accountLink(row.result.historicalAccountId)}">View historical account ↗</a>` : '';
    return `<section class="decision"><strong>${row.status}${row.result ? ' · Verified in CRM' : ''}</strong>
      ${row.reviewer_note ? `<p>${escape(row.reviewer_note)}</p>` : ''}
      <div class="buttons">${current}${history}</div></section>`;
  }
  return `<section class="decision"><form method="post" action="/review/${item.id}">
    <input type="hidden" name="csrf" value="${csrf}">
    <label for="review-note">Review note <span>Optional</span></label>
    <textarea id="review-note" name="note" maxlength="1000" rows="2" placeholder="Document the reason for your decision"></textarea>
    <div class="buttons">
    ${item.kind === 'ambiguous' ? '' : `<button class="primary" name="decision" value="approve">${row.status === 'Pending' ? 'Approve and write to CRM' : 'Retry verification or approved write'}</button>`}
    ${row.status === 'Pending' ? `<button class="ghost" name="decision" value="reject">${item.kind === 'ambiguous' ? 'Reject proposed link' : 'Reject'}</button>` : ''}
    </div></form></section>`;
}

function queueView(rows, selected, csrf, view) {
  if (!rows.length) return '<div class="empty"><h2>No items in this view</h2><p>Run a scan to compare the website with the CRM.</p></div>';
  const row = rows.find(entry => entry.id === selected) || rows[0];
  const item = row.proposal;
  const options = rows.map(entry => `<a class="queue-row ${entry.id === row.id ? 'selected' : ''}"
    ${entry.id === row.id ? 'aria-current="page"' : ''} href="/?view=${view}&amp;id=${entry.id}">
    <span>${escape(entry.proposal.title)}</span><small>${labels[entry.proposal.kind]} · ${entry.status}</small></a>`).join('');
  return `<div class="layout"><aside aria-label="Proposals"><div class="list-head"><h2>${view === 'history' ? 'Decisions' : 'Proposals'}</h2><b>${rows.length}</b></div><div class="list-body">${options}</div></aside><article>
    <div class="article-head"><div class="article-meta"><span class="pill ${item.kind}">${labels[item.kind]}</span><small>${escape([item.location?.city || item.account?.billing_city, item.location?.state || item.account?.billing_state].filter(Boolean).join(', '))}</small></div>
    <h2>${escape(item.title)}</h2><p>${escape(item.reason)}</p>
    ${row.error ? `<p class="alert">${escape(row.error)}</p>` : ''}</div>
    ${item.payload ? change(item) + evidence(row) : evidence(row) + change(item)}${controls(row, csrf)}</article></div>`;
}

function inventoryView(matches) {
  return `<div class="inventory"><table><thead><tr><th>Community</th><th>Location</th><th>Match outcome</th><th>CRM account</th></tr></thead>
   <tbody>${matches.map(match => `<tr><td><a href="${escape(match.location.url)}" target="_blank" rel="noreferrer">${escape(match.location.name)} ↗</a></td>
   <td>${escape(locationAddress(match.location))}</td><td>${escape(match.outcome)}</td>
   <td>${match.accountId ? `<a href="${accountLink(match.accountId)}" target="_blank" rel="noreferrer">View account ↗</a>` : 'Unlinked'}</td></tr>`).join('')}</tbody></table></div>`;
}

export function dashboard(state, { csrf, view, id, message = '' }) {
  const pending = state.rows.filter(isOpen);
  const history = state.rows.filter(row => !isOpen(row));
  const source = state.summary;
  const info = source ? new Date(source.time).toLocaleString('en-US', {
    timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short',
  }) + ' ET' : 'Waiting for first scan';
  const approved = history.filter(row => row.status === 'Approved').length;
  const rejected = history.length - approved;
  const total = pending.length + history.length;
  const percent = total ? Math.round(100 * history.length / total) : 0;
  const tabs = [['queue', 'Review queue'], ['history', 'Decision history'], ['inventory', 'Location inventory']];
  const content = view === 'inventory' ? inventoryView(source?.matches ?? []) :
    queueView(view === 'history' ? history : pending, id, csrf, view);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="review-token" content="${csrf}"><title>Bellhaven | CRM Review</title><link rel="stylesheet" href="/style.css">
    </head><body><a class="skip" href="#review">Skip to records</a>
    <header class="masthead"><div class="container mast-inner">
    <div class="identity"><span class="brandmark" aria-hidden="true"></span><strong>Bellhaven</strong><span class="product">Ownership workspace</span></div>
    <form method="post" action="/scan"><input type="hidden" name="csrf" value="${csrf}"><button class="scan" type="submit"><span aria-hidden="true">↻</span> Run live scan</button></form>
    </div></header><main class="container"><div class="overview"><div class="hero-copy">
    <h1>Ownership review</h1><div class="coverage"><span><b>${source?.locations ?? 0}</b> website locations</span><span><b>${source?.accounts ?? 0}</b> CRM accounts</span></div>
    <p class="timestamp">Last scan · ${escape(info)}</p></div>
    <div class="progress-panel"><div class="progress-header"><span>Review progress</span><strong>${percent}<small>%</small></strong></div>
    <progress max="100" value="${percent}" aria-label="Decisions completed"></progress>
    <div class="legend"><span><i class="pending-dot"></i>${pending.length} pending</span><span><i class="approved-dot"></i>${approved} approved</span><span><i class="rejected-dot"></i>${rejected} rejected</span></div></div></div>
    ${message ? `<p class="alert" role="status">${escape(message)}</p>` : ''}
    <nav id="review" aria-label="Workspace views">${tabs.map(([tab, label]) => `<a href="/?view=${tab}" ${view === tab ? 'aria-current="page"' : ''}>${label}<b>${tab === 'queue' ? pending.length : tab === 'history' ? history.length : source?.locations ?? 0}</b></a>`).join('')}</nav>
    ${content}</main></body></html>`;
}
