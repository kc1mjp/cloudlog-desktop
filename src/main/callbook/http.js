'use strict';
const { MAX_REPLY_CHARS } = require('./text');

/**
 * Failure that carries only a coarse status - never the URL, request body, headers or reply,
 * all of which can contain credentials or session keys.
 */
class CallbookError extends Error {
  constructor(status) {
    super(status);
    this.name = 'CallbookError';
    this.status = status; // unavailable | rate_limited | auth_failed | error
  }
}

/**
 * One HTTPS request through the injected fetch. Resolves the reply text; rejects with a CallbookError.
 * Credentials in `form` are sent in the request body (POST) - or in `query` when a provider only documents GET.
 */
async function request(fetchImpl, url, { method = 'GET', form, timeoutMs = 8000 } = {}) {
  let res;
  try {
    res = await fetchImpl(url, {
      method,
      headers: {
        Accept: 'application/xml, text/xml, */*',
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error', // a callbook API has no reason to redirect; never follow one with credentials attached
    });
  } catch {
    throw new CallbookError('unavailable'); // network failure, TLS problem, timeout, redirect...
  }
  if (res.status === 429) throw new CallbookError('rate_limited');
  if (res.status >= 500 || res.status === 408) throw new CallbookError('unavailable');
  if (res.status >= 400) throw new CallbookError('error');
  const len = Number(res.headers && res.headers.get && res.headers.get('content-length'));
  if (Number.isFinite(len) && len > MAX_REPLY_CHARS * 4) throw new CallbookError('error');
  let text;
  try { text = await res.text(); } catch { throw new CallbookError('unavailable'); }
  if (text.length > MAX_REPLY_CHARS) throw new CallbookError('error');
  return text;
}

module.exports = { CallbookError, request };
