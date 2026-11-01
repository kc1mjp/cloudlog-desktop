'use strict';
/*
 * The one automatic update check per application launch.
 *
 * - Exactly one startup check is ever *completed* per launch. Until it completes it is "pending"; retrying a pending
 *   check is not a recurring background check. Once it completes (success or a final error) nothing automatic runs again.
 * - Not blocking startup: the first attempt is delayed and asynchronous.
 * - Connectivity is a trigger, never a gate: the first attempt is made whatever the OS says about being online; a network
 *   failure leaves the check pending. A pending check is retried with bounded backoff, then waits (no polling) for an
 *   "online" notification, each of which allows one further attempt, up to a hard cap per launch.
 * - One attempt at a time; manual checks go through the same single-flight in the service and never touch this state.
 * - Master switch off: the pending check is parked (timer cleared); switching it on again resumes it if it has not completed.
 */

const DEFAULTS = Object.freeze({
  initialDelayMs: 3000,
  backoffMs: [5000, 20000, 60000, 180000, 600000],  // delays between consecutive failed attempts
  maxOnlineRetries: 4,                              // extra attempts triggered by "online" events after backoff is exhausted
  minGapMs: 2000,                                   // ignore connectivity flapping faster than this
  maxAttempts: 12,                                  // absolute cap per launch, however often it is toggled
});

class StartupCheckScheduler {
  /**
   * run():       async, one attempt. Resolves 'ok' | 'final' (completed, e.g. a non-retryable error) | 'transient' (try later) | 'skipped'.
   * isEnabled(): the master switch.
   */
  constructor({ run, isEnabled, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, ...opts }) {
    this.run = run; this.isEnabled = isEnabled; this.now = now; this.setTimer = setTimer; this.clearTimer = clearTimer;
    this.cfg = { ...DEFAULTS, ...opts };
    this.started = false;
    this.done = false;
    this.running = false;
    this.timer = null;
    this.attempts = 0;           // attempts made (any trigger)
    this.failures = 0;           // consecutive transient failures, selects the backoff delay
    this.onlineRetries = 0;
    this.lastAttemptAt = 0;
    this.phase = 'idle';         // idle | waiting-timer | waiting-online | running | done | parked
  }

  get status() { return { phase: this.phase, done: this.done, attempts: this.attempts, retryAt: this.retryAt || null }; }

  start() {
    if (this.started) return;
    this.started = true;
    this._arm(this.cfg.initialDelayMs);
  }

  /** The master switch changed. */
  enabledChanged() {
    if (!this.started || this.done) return;
    if (!this.isEnabled()) { this._clear(); if (!this.running) this.phase = 'parked'; return; }
    if (this.running || this.timer) return;                         // already in flight or armed: never a duplicate
    if (this.phase === 'waiting-online') return;                    // still waiting for connectivity, nothing to do
    this._arm(0);
  }

  /** Connectivity (re)appeared. */
  online() {
    if (!this.started || this.done || this.running || !this.isEnabled()) return;
    if (this.phase !== 'waiting-online' && this.phase !== 'waiting-timer') return;
    if (this.now() - this.lastAttemptAt < this.cfg.minGapMs) return;
    if (this.phase === 'waiting-online') {
      if (this.onlineRetries >= this.cfg.maxOnlineRetries) return;
      this.onlineRetries++;
    }
    this._clear();
    this._arm(0);
  }

  _clear() { if (this.timer) { this.clearTimer(this.timer); this.timer = null; } this.retryAt = null; }

  _arm(ms) {
    this._clear();
    this.phase = 'waiting-timer';
    this.retryAt = this.now() + ms;
    this.timer = this.setTimer(() => { this.timer = null; this.retryAt = null; this._attempt(); }, ms);
    if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
  }

  async _attempt() {
    if (this.done || this.running) return;
    if (!this.isEnabled()) { this.phase = 'parked'; return; }
    if (this.attempts >= this.cfg.maxAttempts) { this.phase = 'waiting-online'; return; }
    this.running = true; this.phase = 'running'; this.attempts++; this.lastAttemptAt = this.now();
    let outcome;
    try { outcome = await this.run(); } catch { outcome = 'final'; }
    this.running = false;
    if (outcome === 'ok' || outcome === 'final') { this.done = true; this.phase = 'done'; this._clear(); return; }
    if (outcome === 'skipped' || !this.isEnabled()) { this.phase = 'parked'; return; }
    // transient failure
    this.failures++;
    if (this.failures <= this.cfg.backoffMs.length && this.attempts < this.cfg.maxAttempts) this._arm(this.cfg.backoffMs[this.failures - 1]);
    else this.phase = 'waiting-online';
  }
}

module.exports = { StartupCheckScheduler, DEFAULTS };
