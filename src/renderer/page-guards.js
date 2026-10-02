'use strict';
/*
 * Small lifecycle helpers shared by the Live QSO, Quick log and Contest pages.
 *
 * Every page mounts into the same long-lived #page element, so a listener attached to that element
 * outlives the page unless it is removed on unmount. These helpers make that cleanup explicit and keep
 * the "log on Enter" path single-shot.
 *
 * Plain JavaScript with no DOM or Electron dependencies, so the renderer loads it as a classic <script>
 * (window.PageGuards) and the node:test suites can require() it.
 */
(function factory(root, build) {
  const api = build();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PageGuards = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  /**
   * Runs one async task at a time. A call made while a task is in progress is ignored (returns
   * undefined); the guard is released when the task settles, whether it succeeded or threw.
   */
  function createSingleFlight() {
    let busy = false;
    return {
      get busy() { return busy; },
      async run(task) {
        if (busy) return undefined;
        busy = true;
        try { return await task(); } finally { busy = false; }
      },
    };
  }

  /** Collects teardown callbacks so everything a page's mount() registers is undone by its unmount(). */
  function createDisposer() {
    let undo = [];
    return {
      get size() { return undo.length; },
      listen(target, type, handler, options) {
        target.addEventListener(type, handler, options);
        undo.push(() => target.removeEventListener(type, handler, options));
      },
      dispose() {
        const fns = undo;
        undo = [];
        for (const fn of fns.reverse()) fn();
      },
    };
  }

  /**
   * True for a fresh Enter keypress that should log. Ignores key auto-repeat (holding Enter down),
   * IME composition, and Enter on a button (the browser turns that into the button's own click).
   */
  function isLogEnter(e) {
    return !!e && e.key === 'Enter' && !e.repeat && !e.isComposing && !(e.target && e.target.tagName === 'BUTTON');
  }

  return { createSingleFlight, createDisposer, isLogEnter };
});
