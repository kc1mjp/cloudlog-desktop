'use strict';

/**
 * Store contacts received over TCP, UDP or multicast, one at a time and in order, so a lookup in progress for one
 * record never lets the next overtake it. Each goes through LogService.addQsoWithLookup (the same enrichment as
 * Live QSO and Quick log) and is de-duplicated against what is already stored. A record that cannot be stored is
 * reported in `errors` and never stops the rest.
 */
async function ingestRecords(log, recs, source) {
  const errors = [];
  let count = 0;
  for (const r of recs) {
    try { if (await log.addQsoWithLookup(r, { source, dedupe: true })) count++; } catch (e) { errors.push(`${r.CALL}: ${e.message}`); }
  }
  return { count, errors };
}

/**
 * Store a QSO submitted from one of the app's own forms. Only Live QSO looks the callsign up as the QSO is created
 * (it already does so for the form itself). Quick log and Contest entries are stored exactly as entered; a lookup,
 * if the "On upload" switches ask for one, happens when they are uploaded.
 */
async function storeFormQso(log, fields, source) {
  return source === 'Live QSO' ? log.addQsoWithLookup(fields, { source }) : log.addQso(fields, { source });
}

module.exports = { ingestRecords, storeFormQso };
