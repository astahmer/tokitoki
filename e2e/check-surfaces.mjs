import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export function checkSurfaces(out, invocations, interactions) {
  const read = name => JSON.parse(fs.readFileSync(path.join(out, `surface-${name}.json`), 'utf8'));
  const payloadCalls = invocations.filter(args => args[0] === 'widget-payload');
  assert.ok(payloadCalls[0].includes('--cached'), 'initial quota read must use the cache');
  assert.ok(payloadCalls.some(args => args.includes('--skip-scan') && !args.includes('--cached')), 'later UI refresh must poll live quotas without scanning sessions');
  assert.ok(payloadCalls.some(args => !args.includes('--skip-scan') && !args.includes('--cached')), 'Refresh & scan must request a full refresh');
  const baseline = read('baseline');
  const account = 'claude-code@default';
  const globalAccount = 'codex@openai:personal';
  const without = (ids, id) => ids.filter(value => value !== id);
  assert.equal(baseline.limits.length, 4);
  const hidden = read('bar-hidden');
  assert.deepEqual(hidden.quotas, baseline.quotas, 'bar-only hiding must preserve quota cards');
  assert.deepEqual(hidden.bar, without(baseline.bar, account), 'bar-only hiding must remove just its strip account');
  assert.deepEqual(hidden.hidden, [], 'bar-only hiding must not create globally hidden accounts');
  assert.deepEqual(hidden.ui.barHiddenAccounts, [account]);
  assert.equal(hidden.hiddenOverride, null, 'payload readback must clear the optimistic visibility override');
  const restored = read('bar-restored');
  assert.deepEqual(restored.bar, baseline.bar);
  assert.deepEqual(restored.quotas, baseline.quotas);
  const quotaOrder = read('quota-order');
  const expectedQuotas = [...baseline.quotas];
  [expectedQuotas[0], expectedQuotas[1]] = [expectedQuotas[1], expectedQuotas[0]];
  assert.deepEqual(quotaOrder.quotas, expectedQuotas, 'quota arrow must move the actual cards');
  assert.deepEqual(quotaOrder.bar, baseline.bar, 'quota arrow must preserve the separate bar order');
  assert.equal(quotaOrder.quotaOverride, null);
  assert.equal(quotaOrder.barOverride, null, "bar order seed must be persisted with the first quota reorder");
  assert.deepEqual(quotaOrder.strip, baseline.strip);
  assert.deepEqual(quotaOrder.ui.accountOrder, expectedQuotas);
  const barOrder = read('bar-order');
  const expectedBar = baseline.strip.flatMap(group => group.accounts);
  [expectedBar[1], expectedBar[2]] = [expectedBar[2], expectedBar[1]];
  assert.deepEqual(barOrder.bar, expectedBar, 'bar arrow must move a Codex account within its vendor group');
  assert.deepEqual(barOrder.quotas, expectedQuotas, 'bar arrow must preserve the separate quota order');
  assert.equal(barOrder.barOverride, null);
  assert.deepEqual(barOrder.strip.flatMap(group => group.accounts), expectedBar, "bar arrow must change rendered vendor group order");
  assert.deepEqual(barOrder.ui.barAccountOrder, expectedBar);
  for (const name of ['globally-hidden', 'hidden-folded', 'hidden-expanded']) {
    const state = read(name);
    assert.deepEqual(state.quotas, without(expectedQuotas, globalAccount));
    assert.deepEqual(state.bar, without(expectedBar, globalAccount));
    assert.deepEqual(state.hidden, [globalAccount]);
  }
  assert.equal(read('hidden-folded').expanded, false, 'globally hidden rows must start folded');
  assert.equal(read('hidden-expanded').expanded, true, 'pointer click must expand hidden accounts');
  const final = read('globally-restored');
  assert.deepEqual(final.quotas, expectedQuotas);
  assert.deepEqual(final.bar, expectedBar);
  assert.deepEqual(final.hidden, []);
  assert.deepEqual(final.ui.barHiddenAccounts, []);
  const failed = read('refresh-failed');
  assert.deepEqual(failed.limits, final.limits, 'failed exit with valid empty stdout must preserve every old quota');
  assert.match(failed.error, /e2e injected failed refresh/);
  const missing = read('refresh-null');
  assert.deepEqual(missing.limits, final.limits.map(a => ({ ...a, windows: a.windows.map(w => ({...w, status:'stale'})) })),
    'successful null limits must retain previous observations marked stale');
  assert.match(missing.error, /incomplete/);
  assert.deepEqual(read('refresh-empty').limits, [], 'a successful true empty list must be accepted');
  const recovered = read('refresh-valid');
  assert.deepEqual(recovered.limits, final.limits, 'a later valid refresh must restore all quota values');
  assert.equal(recovered.error, '');
  assert.deepEqual(recovered.quotas, expectedQuotas);
  assert.deepEqual(recovered.bar, expectedBar);
  const prefs = read('final-prefs');
  assert.deepEqual(prefs.accountOrder, expectedQuotas);
  assert.deepEqual(prefs.barAccountOrder, expectedBar);
  assert.deepEqual(prefs.menubarHidden, []);
  assert.deepEqual(prefs.barHiddenAccounts, []);
  for (const flag of ['--account-order', '--bar-account-order', '--hide', '--show']) {
    assert.ok(invocations.some(args => args[0] === 'ui' && args[1] === flag), `missing CLI UI write ${flag}`);
  }
  assert.ok(invocations.some(args => args[0] === 'ui' && args[1] === '--account-order' && args.includes('--bar-account-order')), 'quota reorder must seed the previous bar order in the same CLI write');
  assert.ok(invocations.some(args => args[0] === 'config' && args[2] === 'ui.previewHiddenAccounts' && args[3] === JSON.stringify([account])));
  for (const interaction of ['account-bar-hide', 'account-bar-restore', 'account-quota-order', 'account-bar-order', 'account-global-hide', 'account-hidden-expand', 'account-global-restore', 'refresh-failed', 'refresh-null', 'refresh-empty', 'refresh-valid']) {
    assert.ok(interactions.includes(interaction), `missing surface interaction ${interaction}`);
  }
  for (const name of ['baseline', 'bar-hidden', 'bar-restored', 'quota-order', 'bar-order', 'globally-hidden', 'hidden-folded', 'hidden-expanded', 'globally-restored', 'refresh-failed', 'refresh-null', 'refresh-empty', 'refresh-valid']) {
    assert.ok(fs.statSync(path.join(out, `surface-${name}.png`)).size > 1000);
    assert.ok(fs.statSync(path.join(out, 'previews', `surface-${name}.png`)).size > 1000);
  }
  console.log('PASS independent bar/quota ordering, visibility, hidden restore, failed/null/empty/recovered refresh');
}
