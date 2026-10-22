'use strict';
// Logbook Collections (0.4.4): named aggregators of existing logbooks, plus the shared scope resolver.
//
// Terminology (see README): a "Logbook" is a Cloudlog station location (what the rest of the code calls a station /
// logbook_id); a "Logbook Collection" is a named grouping of logbooks. A collection is only a *view* over logbooks: it
// stores logbook ids and nothing else. No QSO, queued QSO or QSO-to-logbook association is ever read-modified here -
// this module never touches the QSO database, and everything that does (qso-cache.js, logbook.js) only receives the
// plain `logbookIds` array that resolveScope() produces.
//
// Persistence: settings.json, key `logbookCollections`:
//   { collections: [ { id, name, members: [ logbookId, ... ] } ],
//     active: null | { kind: 'collection' | 'logbook', id } }
// `active` is the explicit "Active collection" selection. null means "follow the Active logbook" (the fallback), which
// is resolved on every call so it always tracks the current Active logbook (settings.cloudlog.currentStationId).

const crypto = require('crypto');

const KINDS = ['collection', 'logbook'];
const NAME_MAX = 60;

const str = (v) => (v === undefined || v === null ? '' : String(v));
const cleanName = (v) => str(v).replace(/\s+/g, ' ').trim();

/** The persisted shape for a settings file that has never had collections. */
function emptyState() { return { collections: [], active: null }; }

function cleanId(v) { const s = str(v).trim(); return s || null; }

/** A selection is {kind, id} with a known kind and a non-empty id, or null. Names are never part of it. */
function normalizeSelection(sel) {
  if (!sel || typeof sel !== 'object') return null;
  const id = cleanId(sel.id);
  if (!KINDS.includes(sel.kind) || !id) return null;
  return { kind: sel.kind, id };
}

/**
 * Bring `data.logbookCollections` into the documented shape, in place. Idempotent: running it again changes nothing.
 * Settings written before 0.4.4 have no such key; they get an empty one, which resolves to the Active logbook.
 * It never validates against the logbook list (that can be offline/empty at startup) and never writes an explicit
 * `active` selection on its own - the fallback is computed, not stored.
 */
function migrateCollections(data) {
  const src = data.logbookCollections && typeof data.logbookCollections === 'object' ? data.logbookCollections : {};
  const seen = new Set();
  const collections = [];
  for (const c of Array.isArray(src.collections) ? src.collections : []) {
    if (!c || typeof c !== 'object') continue;
    const id = cleanId(c.id);
    const name = cleanName(c.name);
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    const members = [];
    for (const m of Array.isArray(c.members) ? c.members : []) {
      const mid = cleanId(m);
      if (mid && !members.includes(mid)) members.push(mid); // a membership relationship exists at most once
    }
    collections.push({ id, name, members });
  }
  data.logbookCollections = { collections, active: normalizeSelection(src.active) };
  return data;
}

/** The live collections block (normalized only if it is missing or malformed, so callers can mutate what they get). */
function state(data) {
  const lc = data.logbookCollections;
  if (!lc || typeof lc !== 'object' || !Array.isArray(lc.collections) || !('active' in lc)) migrateCollections(data);
  return data.logbookCollections;
}

// ---- what exists --------------------------------------------------------------------------------------------------

const stationList = (data) => ((data.cloudlog && Array.isArray(data.cloudlog.stations)) ? data.cloudlog.stations : []);
const currentLogbookId = (data) => cleanId(data.cloudlog && data.cloudlog.currentStationId);

/** Ids of every logbook the app knows: the cached station list plus the Active logbook (which may be typed in by hand). */
function knownLogbookIds(data) {
  const ids = new Set(stationList(data).map((s) => str(s.id)));
  const cur = currentLogbookId(data);
  if (cur) ids.add(cur);
  return ids;
}

function logbookName(data, id) {
  const s = stationList(data).find((x) => str(x.id) === str(id));
  return s && s.name ? String(s.name) : `Logbook #${id}`;
}

// ---- scope resolution ---------------------------------------------------------------------------------------------

/**
 * A scope is always an explicit, finite list of logbook ids. There is deliberately no "all logbooks" scope: an empty
 * scope (`logbookIds: []`, `empty: true`) matches nothing, and every query function treats an empty list as "no rows"
 * without running SQL. `unrestricted` exists only so callers and tests can assert that it is never true.
 *   kind        'logbook' | 'collection' | 'none' (no valid Active logbook either: unconfigured)
 *   source      'requested' (a page-level temporary choice) | 'explicit' (Settings > Active collection) | 'fallback'
 *   staleMembers  members that point at logbooks that no longer exist (ignored, left in the settings file)
 */
function makeScope(data, kind, id, source) {
  if (kind === 'collection') {
    const col = state(data).collections.find((c) => c.id === id);
    const known = knownLogbookIds(data);
    const logbookIds = col.members.filter((m) => known.has(m));
    return { kind, id, name: col.name, source, logbookIds, empty: logbookIds.length === 0, unconfigured: false, unrestricted: false, staleMembers: col.members.length - logbookIds.length };
  }
  return { kind: 'logbook', id, name: logbookName(data, id), source, logbookIds: [id], empty: false, unconfigured: false, unrestricted: false, staleMembers: 0 };
}

const NONE = Object.freeze({ kind: 'none', id: null, name: '', source: 'fallback', logbookIds: Object.freeze([]), empty: true, unconfigured: true, unrestricted: false, staleMembers: 0 });

/** The selection {kind,id} if it names something that exists right now, else null. */
function validSelection(data, sel) {
  const s = normalizeSelection(sel);
  if (!s) return null;
  if (s.kind === 'collection') return state(data).collections.some((c) => c.id === s.id) ? s : null;
  return knownLogbookIds(data).has(s.id) ? s : null;
}

/**
 * Resolve what to show:
 *   1. `requested` (a page's temporary choice), if it is valid;
 *   2. the explicit Active collection selection, if it is valid;
 *   3. the Active logbook, tracked live (never a stored copy of an old id);
 *   4. nothing - an empty "unconfigured" scope, never "everything".
 * A valid but empty collection stays selected and resolves to an empty scope; it does NOT fall through to step 3.
 */
function resolveScope(data, requested = null) {
  const req = validSelection(data, requested);
  if (req) return makeScope(data, req.kind, req.id, 'requested');
  const exp = validSelection(data, state(data).active);
  if (exp) return makeScope(data, exp.kind, exp.id, 'explicit');
  const cur = currentLogbookId(data);
  return cur ? makeScope(data, 'logbook', cur, 'fallback') : { ...NONE, logbookIds: [] };
}

/** A scope for one logbook id, as given (used by the older single-logbook calls). */
const logbookScope = (data, id) => (cleanId(id) ? makeScope(data, 'logbook', cleanId(id), 'requested') : { ...NONE, logbookIds: [] });

/** Stable key for cursor/caches: the same set of logbooks always gives the same key, whatever kind of scope it came from. */
const scopeKey = (scope) => [...new Set(scope.logbookIds)].sort().join(',');

/** What the renderer is told about a scope (no member list needed beyond the ids). */
const scopeMeta = (scope) => ({ kind: scope.kind, id: scope.id, name: scope.name, source: scope.source, empty: scope.empty, unconfigured: scope.unconfigured, logbookIds: [...scope.logbookIds], staleMembers: scope.staleMembers });

// ---- editing (metadata only) --------------------------------------------------------------------------------------

function checkName(data, name, exceptId = null) {
  const n = cleanName(name);
  if (!n) throw new Error('Enter a name for the collection');
  if (n.length > NAME_MAX) throw new Error(`Collection names can be at most ${NAME_MAX} characters`);
  if (state(data).collections.some((c) => c.id !== exceptId && c.name.toLowerCase() === n.toLowerCase())) throw new Error(`There is already a collection called "${n}"`);
  return n;
}

function checkMembers(data, members) {
  if (!Array.isArray(members)) throw new Error('Members must be a list of logbooks');
  const known = knownLogbookIds(data);
  const out = [];
  for (const m of members) {
    const id = cleanId(m);
    if (!id) continue;
    if (!known.has(id)) throw new Error(`Unknown logbook ${id}`);
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

const findCollection = (data, id) => {
  const c = state(data).collections.find((x) => x.id === id);
  if (!c) throw new Error('That collection no longer exists');
  return c;
};

function createCollection(data, name, members = []) {
  const st = state(data);
  const col = { id: `col-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`, name: checkName(data, name), members: checkMembers(data, members) };
  st.collections.push(col);
  return col;
}

function renameCollection(data, id, name) {
  const col = findCollection(data, id);
  col.name = checkName(data, name, id);
  return col;
}

/**
 * Replace a collection's members. Members that are no longer known logbooks are dropped here (so editing is also the
 * clean-up for stale entries); an unknown id in the request is refused.
 */
function setMembers(data, id, members) {
  const col = findCollection(data, id);
  col.members = checkMembers(data, members);
  return col;
}

/** Remove the collection and its memberships only. If it was the explicit Active collection, the selection is cleared. */
function deleteCollection(data, id) {
  const st = state(data);
  findCollection(data, id);
  st.collections = st.collections.filter((c) => c.id !== id);
  if (st.active && st.active.kind === 'collection' && st.active.id === id) st.active = null;
  return st;
}

/** Set the explicit Active collection ({kind,id}), or null to follow the Active logbook. Never touches the Active logbook. */
function setActive(data, sel) {
  const st = state(data);
  if (sel === null || sel === undefined) { st.active = null; return st; }
  const s = normalizeSelection(sel);
  if (!s) throw new Error('Choose a collection or a logbook');
  if (!validSelection(data, s)) throw new Error(s.kind === 'collection' ? 'That collection no longer exists' : 'That logbook is not in your list');
  st.active = s;
  return st;
}

// ---- the two read paths behind log:query / log:stats (kept here so they can be tested without Electron) ------------------

/** Browse QSOs for a page's temporary scope, an older single stationId, or (neither given) the effective Active collection. */
function queryScoped(log, data, params = {}) {
  const scope = params.scope ? resolveScope(data, params.scope)
    : params.stationId ? logbookScope(data, params.stationId)
      : resolveScope(data);
  const { scope: _s, stationId: _id, ...rest } = params;
  return { ...log.query({ ...rest, logbookIds: scope.logbookIds }), scope: scopeMeta(scope) };
}

/** Dashboard numbers, recent QSOs and queued-QSO counts for the effective Active collection. */
function statsScoped(log, data) {
  const scope = resolveScope(data);
  return { ...log.stats(scope.logbookIds), scope: scopeMeta(scope) };
}

module.exports = {
  queryScoped, statsScoped,
  KINDS, NAME_MAX, emptyState, normalizeSelection, migrateCollections, knownLogbookIds, logbookName,
  validSelection, resolveScope, logbookScope, scopeKey, scopeMeta,
  createCollection, renameCollection, setMembers, deleteCollection, setActive,
};
