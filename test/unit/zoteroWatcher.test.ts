import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ZoteroWatcher, parseRetryPending } from '../../src/zoteroWatcher.ts';

test('parseRetryPending reads the last RETRY_PENDING marker from sync output', () => {
  assert.equal(parseRetryPending(''), 0);
  assert.equal(parseRetryPending('INFO Done. indexed=3 failed=0 pending=0'), 0);
  const out = [
    '2026-11-27 17:33:30 INFO PENDING a.pdf (renamed or moved by Zotero during sync); will retry',
    '2026-11-27 17:33:31 INFO Done. indexed=12 failed=0 pending=2 metadata_refreshed=4 total=870',
    '2026-11-27 17:33:31 INFO RETRY_PENDING 2',
  ].join('\n');
  assert.equal(parseRetryPending(out), 2);
  assert.equal(parseRetryPending('RETRY_PENDING 5\n...\nRETRY_PENDING 1\n'), 1);
});

function harness() {
  let sig: string | undefined = 'm1';
  let t = 0;
  let calls = 0;
  let onChangeHook: (() => void) | undefined;
  const w = new ZoteroWatcher({
    zoteroDir: '/z',
    quietMs: 3000,
    signature: async () => sig,
    now: () => t,
    onChange: async () => {
      calls++;
      onChangeHook?.();
    },
  });
  return {
    w,
    set: (s: string | undefined) => (sig = s),
    advance: (ms: number) => (t += ms),
    calls: () => calls,
    duringSync: (fn: () => void) => (onChangeHook = fn),
  };
}

test('ZoteroWatcher ignores the initial state and stays idle when nothing changes', async () => {
  const h = harness();
  for (let i = 0; i < 10; i++) {
    await h.w.tick();
    h.advance(1000);
  }
  assert.equal(h.calls(), 0);
});

test('ZoteroWatcher fires once after storage changes and stays quiet for the debounce window', async () => {
  const h = harness();
  await h.w.tick(); // baseline
  h.set('m2');
  h.advance(1000);
  await h.w.tick(); // change seen, quiet window starts
  h.set('m3');
  h.advance(1000);
  await h.w.tick(); // still changing: window restarts
  h.advance(2000);
  await h.w.tick();
  assert.equal(h.calls(), 0, 'not yet quiet for 3s');
  h.advance(1000);
  await h.w.tick();
  assert.equal(h.calls(), 1);
  h.advance(5000);
  await h.w.tick();
  assert.equal(h.calls(), 1, 'no repeat without a new change');
});

test('ZoteroWatcher re-triggers for papers added while a sync is running', async () => {
  const h = harness();
  await h.w.tick();
  h.set('m2');
  await h.w.tick();
  h.advance(3000);
  h.duringSync(() => h.set('m3')); // new PDF lands mid-sync
  await h.w.tick();
  assert.equal(h.calls(), 1);
  h.duringSync(() => {});
  h.advance(1000);
  await h.w.tick(); // sees m3
  h.advance(3000);
  await h.w.tick();
  assert.equal(h.calls(), 2);
});
