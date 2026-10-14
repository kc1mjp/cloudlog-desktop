'use strict';
/*
 * Callbook enrichment: the one place that decides which contact fields a lookup may fill, and how.
 *
 * Two independent categories, each with a "new QSO" switch and an "on upload" switch (settings.callbook.enrich):
 *   metadata  NAME, STATE, CNTY, COUNTRY   - "Add Lookup Data to QSO Log Event"
 *   grid      GRIDSQUARE                   - "Add Lookup Grid if QSO Grid is Missing"
 * Both phases (a QSO being created/accepted, and a queued QSO about to be uploaded) use the same rules:
 *   - a field is "missing" when it is absent, null, '' or whitespace only (a number such as 0 is a value)
 *   - a lookup only ever fills a missing field; existing values are never replaced and nothing is ever cleared
 *   - only an 'ok' lookup result is used, and only its non-empty, valid values
 *   - one lookup serves every category that needs data
 *   - nothing here throws: a failed, skipped or slow lookup just means the contact is used as it is
 */
const { cleanGrid } = require('./text');
const { normalizeCall, isValidCallsign } = require('../../renderer/callbook-shared');
const { resolveEnrich } = require('./config');

/** category -> [ADIF field, key in the normalised lookup result] */
const CATEGORIES = {
  metadata: { newKey: 'metadataOnNew', uploadKey: 'metadataOnUpload', fields: [['NAME', 'name'], ['STATE', 'state'], ['CNTY', 'county'], ['COUNTRY', 'country']] },
  grid: { newKey: 'gridOnNew', uploadKey: 'gridOnUpload', fields: [['GRIDSQUARE', 'grid']] },
};
const CATEGORY_IDS = Object.keys(CATEGORIES);

/** Absent, null, empty or whitespace-only. Numbers (including 0) and other identifiers are real values. */
function isMissing(v) {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (typeof v === 'number') return Number.isNaN(v);
  return false;
}

/** Categories switched on for a phase ('new' | 'upload'), from the stored callbook settings. */
function enabledCategories(callbookSettings, phase) {
  const e = resolveEnrich(callbookSettings && callbookSettings.enrich);
  return CATEGORY_IDS.filter((c) => e[phase === 'upload' ? CATEGORIES[c].uploadKey : CATEGORIES[c].newKey]);
}

/** ADIF CNTY for the US is "ST,County"; anything else (or an already-qualified value) is left as the provider gave it. */
function formatCounty(county, state, country) {
  if (county.includes(',')) return county;
  const st = String(state == null ? '' : state).trim().toUpperCase();
  return /^united states/i.test(country || '') && /^[A-Z]{2}$/.test(st) ? `${st},${county}` : county;
}

function usableValue(field, v) {
  if (typeof v !== 'string' || v.trim() === '') return '';
  if (field === 'GRIDSQUARE') return cleanGrid(v); // Maidenhead 4/6/8 characters, canonical case, or '' when it is not one
  const t = v.trim();
  return field === 'STATE' && /^[a-z]{2}$/i.test(t) ? t.toUpperCase() : t;
}

/**
 * Fill the missing fields of `fields` (restricted to `cats`) from a lookup result. Returns a new object plus the list
 * of ADIF fields that were filled; `fields` itself is never modified.
 */
function mergeLookup(fields, result, cats) {
  const out = { ...fields };
  const filled = [];
  if (!result || result.status !== 'ok') return { fields: out, filled };
  // A county belongs to the state the provider returned it with. If the contact already has a different state (a
  // portable or mobile QSO, say) the provider's county would be paired with the wrong state, so it is not used.
  const stateClash = !isMissing(out.STATE) && !!usableValue('STATE', result.state) && String(out.STATE).trim().toUpperCase() !== usableValue('STATE', result.state);
  for (const cat of cats) {
    for (const [field, key] of CATEGORIES[cat].fields) {
      if (!isMissing(out[field])) continue;
      if (field === 'CNTY' && stateClash) continue;
      const v = usableValue(field, result[key]);
      if (!v) continue;
      out[field] = v;
      filled.push(field);
    }
  }
  if (filled.includes('CNTY')) out.CNTY = formatCounty(out.CNTY, out.STATE, out.COUNTRY);
  return { fields: out, filled };
}

class CallbookEnricher {
  /**
   * @param {object} o
   * @param {()=>object} o.getSettings  the app settings (reads settings.callbook.enrich)
   * @param {(call:string)=>Promise<object>} o.lookup  the existing callbook service (provider, credentials, cache, offline mode)
   * @param {number} [o.newQsoBudgetMs]  longest a QSO being created waits for a lookup before it is logged without it
   */
  constructor({ getSettings, lookup, newQsoBudgetMs = 6000, logger = console }) {
    Object.assign(this, { getSettings, lookup, newQsoBudgetMs, logger });
  }

  categories(phase) { return enabledCategories(this.getSettings().callbook, phase); }

  /**
   * What a lookup would have to supply for these fields: { call, cats } for the enabled categories that still have a
   * missing field, or null when no lookup is needed (everything switched off, everything already filled, no usable callsign).
   */
  plan(fields, phase) {
    const cats = this.categories(phase).filter((c) => CATEGORIES[c].fields.some(([f]) => isMissing(fields[f])));
    if (!cats.length) return null;
    const call = normalizeCall(fields.CALL);
    return isValidCallsign(call) ? { call, cats } : null;
  }

  /** One lookup through the existing service; null (never an exception) when it could not be done. */
  async fetch(plan) {
    try {
      const r = await this.lookup(plan.call);
      return r && typeof r === 'object' ? r : null;
    } catch {
      return null;
    }
  }

  merge(fields, result, cats) { return mergeLookup(fields, result, cats); }

  /** A QSO being created or accepted: returns the fields to store (the same fields when nothing could be added). */
  async enrichNew(fields) {
    try {
      const plan = this.plan(fields, 'new');
      if (!plan) return fields;
      let timer;
      const budget = new Promise((resolve) => { timer = setTimeout(() => resolve(null), this.newQsoBudgetMs); if (timer.unref) timer.unref(); });
      const result = await Promise.race([this.fetch(plan), budget]);
      clearTimeout(timer);
      return result ? mergeLookup(fields, result, plan.cats).fields : fields;
    } catch {
      return fields;
    }
  }
}

module.exports = { CATEGORIES, CATEGORY_IDS, isMissing, enabledCategories, formatCounty, mergeLookup, CallbookEnricher };
