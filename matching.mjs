import { createHash } from 'node:crypto';

export const PARENT_NAME = 'Bellhaven Senior Living (Parent Account)';
const ABSENCE = 'Bellhaven directory reconciliation:';
const CARE_TYPES = {
  'Assisted Living': 'Assisted Living',
  'Memory Support': 'Memory Care',
  'Short-Term Rehabilitation & Nursing': 'Skilled Nursing',
};
const STREET_WORDS = {
  avenue: 'ave', boulevard: 'blvd', drive: 'dr', highway: 'hwy', lane: 'ln',
  road: 'rd', street: 'st', court: 'ct', circle: 'cir', terrace: 'ter',
  place: 'pl', pike: 'pk', parkway: 'pkwy',
  north: 'n', south: 's', east: 'e', west: 'w',
  northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw',
};

const identityFields = [
  'name', 'parent_id', 'billing_street', 'billing_city', 'billing_state',
  'billing_zip', 'phone', 'care_type', 'status', 'chow_current_account', 'duplicate_of_account',
];

export function normalize(value = '') {
  return String(value ?? '').normalize('NFKD').toLowerCase()
    .replace(/\p{Diacritic}/gu, '').replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

export function street(value) {
  return normalize(value).split(' ').map(word => STREET_WORDS[word] || word).join(' ');
}

const phone = value => String(value || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
const zip = value => String(value || '').match(/^\d{5}/)?.[0] || '';
const leadsWithBox = value => /^(p o|po|post office) box\b/.test(normalize(value));
const namesEqual = (a, b) => normalize(a) === normalize(b);
const meaningful = value => new Set(normalize(value).split(' ').filter(word =>
  word && !['of', 'at', 'the', 'and', 'bellhaven', 'senior', 'living', 'care', 'center', 'centre'].includes(word)));
const same = (a, b) => Boolean(a && b && a === b);

export function protectedBilling(account) {
  return Number(account.lifetime_revenue) > 0 && Number(account.outstanding_ar) > 0;
}

export function identity(account) {
  return Object.fromEntries(identityFields.map(field => [field, account[field] ?? '']));
}

function appendNote(previous, text) {
  return [previous?.trim(), text].filter(Boolean).join('\n');
}

function adminIndex(contacts) {
  const index = new Map();
  for (const contact of contacts) {
    if (!contact.is_active || !/\badministrator\b/i.test(contact.title)) continue;
    const names = index.get(contact.account_id) ?? new Set();
    names.add(normalize(contact.name));
    index.set(contact.account_id, names);
  }
  return index;
}

function evidence(location, account, admins) {
  const name = same(normalize(location.name), normalize(account.name));
  const city = same(normalize(location.city), normalize(account.billing_city));
  const state = same(normalize(location.state), normalize(account.billing_state));
  const locality = city && state;
  const postal = same(zip(location.zip), zip(account.billing_zip));
  const address = same(street(location.street), street(account.billing_street));
  const telephone = same(phone(location.phone), phone(account.phone));
  const administrator = Boolean(location.administrator &&
    admins.get(account.account_id)?.has(normalize(location.administrator)));
  const care = location.care.some(type => same(CARE_TYPES[type] || type, account.care_type));
  const premises = address && locality && (postal || telephone || administrator);
  const strong = premises && (name || telephone || administrator || care) ||
    locality && name && (telephone || administrator);
  const words = meaningful(location.name);
  const otherWords = meaningful(account.name);
  const shared = [...words].filter(word => otherWords.has(word)).length;
  const loose = locality && shared >= 2;
  const relevant = premises || name || (locality && (address || telephone || administrator || loose));
  const signals = [
    [name, 'Same normalized name'], [address, 'Same normalized street'],
    [locality, 'Same city and state'], [postal, 'Same ZIP'],
    [telephone, 'Same phone'], [administrator, 'Same active administrator'],
    [care, 'Compatible care type'],
  ].filter(([matched]) => matched).map(([, signal]) => signal);
  return { account, name, locality, premises, telephone, administrator, strong, relevant, signals };
}

function resolve(candidates) {
  const atSite = candidates.filter(candidate => candidate.premises);
  const strong = candidates.filter(candidate => candidate.strong);
  if (strong.length === 1 && atSite.length <= 1) return { winner: strong[0], duplicates: [] };
  const byName = strong.filter(candidate => candidate.name);
  const corroborated = strong.filter(candidate => candidate.telephone || candidate.administrator);
  if (byName.length === 1 && corroborated.every(candidate => candidate === byName[0])) {
    return { winner: byName[0], duplicates: [] };
  }
  if (corroborated.length === 1 && byName.length === 0) return { winner: corroborated[0], duplicates: [] };
  if (byName.length > 1 && byName.length === atSite.length &&
    byName.every(candidate => candidate.account.parent_id === byName[0].account.parent_id)) {
    const withBilling = byName.filter(({ account }) =>
      Number(account.lifetime_revenue) > 0 || Number(account.outstanding_ar) > 0);
    if (withBilling.length > 1) return {};
    const winner = withBilling[0] || (corroborated.length === 1 && byName.includes(corroborated[0]) && corroborated[0]);
    if (winner && winner.account.status !== 'Inactive') {
      return { winner, duplicates: byName.filter(candidate => candidate !== winner) };
    }
  }
  return {};
}

function candidateDetails(candidates) {
  return candidates.map(({ account, signals }) => ({
    id: account.account_id, name: account.name, parent: account.parent_name,
    address: [account.billing_street, account.billing_city, account.billing_state, account.billing_zip].filter(Boolean).join(', '),
    phone: account.phone, care: account.care_type, signals,
  }));
}

function newFields(location, parent, note = '') {
  return {
    name: location.name, parent_id: parent.account_id, billing_street: location.street,
    billing_city: location.city, billing_state: location.state, billing_zip: location.zip,
    care_type: CARE_TYPES[location.care[0]] || location.care[0],
    phone: location.phone, status: 'Active',
    note: appendNote(note, 'Bellhaven site care offerings: ' + location.care.join(', ') + '.'),
  };
}

function makeProposal(kind, { account, location, parent, payload, reason, candidates = [], survivor, coverage }) {
  const context = { name: parent.name, id: parent.account_id };
  const alternatives = candidateDetails(candidates);
  const stateBefore = account ? {
    ...identity(account),
    ...(Object.hasOwn(payload || {}, 'note') ? { note: account.note || '' } : {}),
    ...(kind === 'chow' || (kind === 'update' && Object.hasOwn(payload, 'parent_id')) ? {
      protectedBilling: protectedBilling(account),
    } : {}),
  } : null;
  const key = {
    kind, account: account?.account_id, location: location?.path,
    stateBefore, payload, survivor: survivor?.account_id,
    ...(kind === 'ambiguous' ? { candidates: alternatives.sort((a, b) => a.id.localeCompare(b.id)) } : {}),
  };
  const id = createHash('sha256').update(JSON.stringify(key)).digest('hex').slice(0, 24);
  return { id, kind, location, context, account, stateBefore, payload, reason, alternatives, survivor, coverage,
    title: location?.name || account?.name };
}

export function proposals(scraped, accounts, contacts = []) {
  const parents = accounts.filter(account => namesEqual(account.name, PARENT_NAME) && !account.parent_id);
  if (parents.length !== 1 || parents[0].status !== 'Active') throw new Error('Could not verify the active Bellhaven parent account.');
  const [parent] = parents;
  const admins = adminIndex(contacts);
  const suspects = accounts.filter(account => !/\(parent account\)\s*$/i.test(account.name) &&
    !account.chow_current_account && !account.duplicate_of_account);
  const evaluated = scraped.locations.map(location => {
    const candidates = suspects.map(account => evidence(location, account, admins)).filter(item => item.relevant);
    return { location, candidates, ...resolve(candidates) };
  });
  const claimed = new Map();
  for (const entry of evaluated) {
    for (const candidate of [entry.winner, ...(entry.duplicates || [])].filter(Boolean)) {
      const id = candidate.account.account_id;
      claimed.set(id, (claimed.get(id) || 0) + 1);
    }
  }
  const linked = new Set();
  const queue = [];
  const matches = [];
  for (const { location, candidates, winner, duplicates } of evaluated) {
    const pool = candidates.filter(candidate => candidate.premises || candidate.strong || candidate.name && candidate.locality);
    for (const candidate of pool) linked.add(candidate.account.account_id);
    if (!winner || [winner, ...duplicates].some(candidate => claimed.get(candidate.account.account_id) > 1)) {
      if (pool.length) {
        queue.push(makeProposal('ambiguous', { location, parent, candidates, payload: null,
          reason: 'The evidence does not safely identify one CRM account. Confirm the facility identity before linking or creating an account.' }));
        matches.push({ location, outcome: 'Ambiguous' });
      } else {
        const payload = newFields(location, parent);
        queue.push(makeProposal('create', { location, parent, payload, candidates,
          reason: 'No existing account has corroborating identity evidence in the complete CRM snapshot.' }));
        matches.push({ location, outcome: 'Missing' });
      }
      continue;
    }
    const { account, signals } = winner;
    const payload = {};
    if (account.name !== location.name) payload.name = location.name;
    if (account.parent_id !== parent.account_id) payload.parent_id = parent.account_id;
    const sameAddress = same(street(location.street), street(account.billing_street));
    if (sameAddress && winner.telephone && winner.locality && zip(location.zip) !== zip(account.billing_zip)) {
      payload.billing_zip = location.zip;
    }
    const mappedCare = CARE_TYPES[location.care[0]];
    if (mappedCare && !account.care_type) payload.care_type = mappedCare;
    const sourceMarked = account.note?.split('\n').some(line => line.startsWith(ABSENCE));
    if (sourceMarked && account.status === 'Needs Review') {
      payload.status = 'Active';
      payload.note = account.note.split('\n').filter(line => !line.startsWith(ABSENCE)).join('\n');
    }
    const split = payload.parent_id && protectedBilling(account);
    const basis = signals.join(' · ') + '.';
    const collision = candidates.filter(candidate => candidate.premises && candidate !== winner && !duplicates.includes(candidate));
    const context = collision.length ? ' Other accounts share this address. The name or corroborating contact identifies the Bellhaven record.' : '';
    let outcome = 'Confirmed';
    if (split) {
      queue.push(makeProposal('chow', { account, location, parent, candidates,
        payload: newFields(location, parent, 'Change of ownership from CRM account ' + account.account_id + '.'),
        reason: basis + ' Revenue history and outstanding AR require a new account and a CHOW link on the historical account.' }));
      outcome = 'CHOW';
    } else if (Object.keys(payload).length) {
      queue.push(makeProposal('update', { account, location, parent, payload, candidates, reason: basis + context }));
      outcome = 'Needs correction';
    }
    matches.push({ location, accountId: account.account_id, outcome,
      signals, alternatives: candidateDetails(candidates), retainedBillingBox: leadsWithBox(account.billing_street) });
    for (const duplicate of duplicates) {
      queue.push(makeProposal('duplicate', {
        account: duplicate.account, location, parent, candidates, survivor: account,
        payload: { duplicate_of_account: account.account_id, status: 'Inactive',
          note: appendNote(duplicate.account.note, 'Duplicate of CRM account ' + account.account_id +
            '. Same facility name and normalized street address. Existing contacts remain on their current accounts.') },
        reason: 'Both records have the same name, normalized premises, and parent. The survivor is backed by billing history or the published phone or administrator.',
      }));
    }
  }
  for (const account of suspects) {
    if (account.parent_id !== parent.account_id || linked.has(account.account_id) || account.status === 'Inactive' ||
      account.note?.split('\n').some(line => line.startsWith(ABSENCE))) continue;
    const addressAlternates = suspects.filter(other => other.account_id !== account.account_id &&
      street(other.billing_street) && street(other.billing_street) === street(account.billing_street) &&
      namesEqual(other.billing_city, account.billing_city) && namesEqual(other.billing_state, account.billing_state));
    const alternateNote = addressAlternates.length ? ' Another CRM account shares the street address, so confirm ownership independently.' : '';
    queue.push(makeProposal('absent', {
      account, parent, coverage: {
        pages: scraped.pages, locations: scraped.locations.length, directory: scraped.listed, featuredOnly: scraped.featuredOnly,
      }, candidates: addressAlternates.map(other => ({ account: other, signals: ['Same normalized street and locality'] })),
      payload: { status: 'Needs Review', note: appendNote(account.note,
        ABSENCE + ' No matching community appeared in the complete public website scan. Verify current ownership before changing the parent.' + alternateNote) },
      reason: 'The complete website scan contains no corroborating listing. Flag for ownership follow-up.' + alternateNote,
    }));
  }
  return { matches, queue, parent };
}
