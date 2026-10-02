'use strict';

/**
 * Normalised lookup outcome handed to the renderer. Only these fields ever cross the IPC boundary.
 *   status: ok | not_found | limited | disabled | not_configured | offline | invalid |
 *           auth_failed | rate_limited | unavailable | error
 *   name / qth / grid: only present (non-empty) when the provider returned a value.
 */
function makeResult(status, { provider = 'none', label = '', call = '', message, name = '', qth = '', grid = '' } = {}) {
  const messages = {
    ok: '',
    disabled: '',
    invalid: 'Enter a valid callsign to look up.',
    offline: 'Offline mode: callbook lookup skipped.',
    not_found: `Callsign not found${label ? ` on ${label}` : ''}.`,
    limited: `${label || 'The provider'} returned limited data for this callsign.`,
    auth_failed: `${label || 'The provider'} rejected the saved login. Check Settings > Callbook Lookup.`,
    rate_limited: `${label || 'The provider'} is limiting lookups right now. Try again later.`,
    unavailable: `${label || 'The provider'} could not be reached. Lookup skipped.`,
    error: `${label || 'The provider'} sent an unexpected reply. Lookup skipped.`,
    not_configured: `Configure ${label || 'a callbook provider'} in Settings to enable callsign lookup.`,
  };
  return {
    status, provider, call,
    message: message !== undefined ? message : (messages[status] || ''),
    name, qth, grid,
  };
}

const missingConfigMessage = (label) => `Configure ${label} username and password in Settings to enable ${label} callsign lookup.`;

module.exports = { makeResult, missingConfigMessage };
