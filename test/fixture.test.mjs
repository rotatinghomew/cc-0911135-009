import test from 'node:test';
import assert from 'node:assert/strict';
import { createSite } from '../src/site.mjs';
import { verify } from '../lib/verify.mjs';

async function withSite(operation) {
  const site = await createSite();
  try { await operation(site); } finally { await site.close(); }
}
async function control(site, value) {
  return fetch(site.url + '/_control', { method: 'POST', body: JSON.stringify(value) });
}

test('200 仍可能截断且总数只给下界', async () => withSite(async site => {
  const snapshot = await (await fetch(site.url + '/snapshot')).json();
  const response = await fetch(site.url + '/query?xmin=0&xmax=4&ymin=0&ymax=4&from=0&until=4', { headers: { 'x-snapshot': snapshot.snapshot } });
  assert.equal(response.status, 200);
  const result = await response.json(); assert.equal(result.truncated, true); assert.equal(result.records.length, 3); assert.equal(result.lowerBound, 4);
}));
test('分界点包含且旧快照明确失败', async () => withSite(async site => {
  const result = await (await fetch(site.url + '/query?xmin=0&xmax=0&ymin=0&ymax=0&from=0&until=0', { headers: { 'x-snapshot': 'plot-1' } })).json();
  assert.equal(result.records[0].id, 'OBS-00');
  await control(site, { generation: 2 });
  assert.equal((await fetch(site.url + '/query?xmin=0&xmax=4&ymin=0&ymax=4&from=0&until=4', { headers: { 'x-snapshot': 'plot-1' } })).status, 409);
}));
test('截断叶子不能证明覆盖', () => assert.throws(() => verify({ snapshot: 's', budget: 1, requestsUsed: 1, complete: true, records: [], tree: { snapshot: 's', status: 'complete', evidence: { truncated: true } } })));

test('同位同秒热点无法用继续缩小范围解除截断', async () => withSite(async site => {
  const hotspot = await (await fetch(site.url + '/query?xmin=1&xmax=1&ymin=1&ymax=1&from=2&until=2', { headers: { 'x-snapshot': 'plot-1' } })).json();
  assert.equal(hotspot.truncated, true);
  await control(site, { cap: 30 });
  const all = await (await fetch(site.url + '/query?xmin=0&xmax=4&ymin=0&ymax=4&from=0&until=4', { headers: { 'x-snapshot': 'plot-1' } })).json();
  assert.equal(all.records.length, 23); assert.equal(all.truncated, false);
}));
