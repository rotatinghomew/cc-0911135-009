import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSite } from '../src/site.mjs';
import { collect, loadCoverage } from '../src/collector.mjs';
import {
  chooseSplit, latticeSteps, recount, runCoverage, splitAxis, createCoverage, restoreCoverage,
} from '../src/coverage.mjs';
import { verify } from '../lib/verify.mjs';
import { SnapshotExpiredError } from '../src/client.mjs';

const DOMAIN = { xmin: 0, xmax: 4, ymin: 0, ymax: 4, from: 0, until: 4 };
const GEOMETRY = { minSpatial: 0.25, minTemporal: 1 };

async function withSite(operation) {
  const site = await createSite();
  try { return await operation(site); } finally { await site.close(); }
}

async function control(site, value) {
  await fetch(site.url + '/_control', { method: 'POST', body: JSON.stringify(value) });
}

async function directory() {
  return mkdtemp(path.join(tmpdir(), 'plot-coverage-'));
}

function queryPaths(site) {
  return site.audit.filter(entry => entry.path.startsWith('/query'));
}

test('闭区间拆分：两个孩子都包含中点，宽度不低于最小精度', () => {
  const [left, right] = splitAxis(DOMAIN, 'x', GEOMETRY);
  assert.deepEqual(left, { ...DOMAIN, xmax: 2 });
  assert.deepEqual(right, { ...DOMAIN, xmin: 2 });
  assert.equal(left.xmax, 2);
  assert.equal(right.xmin, 2);
  // 分界线上的点 x=2 同时属于两个孩子：这是有意的重叠。
  assert.ok(left.xmin <= 2 && left.xmax >= 2);
  assert.ok(right.xmin <= 2 && right.xmax >= 2);

  const [first, second] = splitAxis(DOMAIN, 't', GEOMETRY);
  assert.deepEqual(first, { ...DOMAIN, until: 2 });
  assert.deepEqual(second, { ...DOMAIN, from: 2 });
  assert.equal(first.from, 0);
  assert.equal(second.from, 2);
});

test('达到最小精度后不再拆分，避免生成退化区间或空转', () => {
  const minX = { ...DOMAIN, xmin: 1, xmax: 1.25 };
  assert.equal(splitAxis(minX, 'x', GEOMETRY), null);
  const minT = { ...DOMAIN, from: 2, until: 3 };
  assert.equal(splitAxis(minT, 't', GEOMETRY), null);
  assert.equal(chooseSplit({ ...DOMAIN, xmin: 1, xmax: 1.25, ymin: 1, ymax: 1.25, from: 2, until: 3 }, GEOMETRY), null);
  assert.equal(latticeSteps(DOMAIN, 'x', GEOMETRY), 16);
  assert.equal(latticeSteps(DOMAIN, 't', GEOMETRY), 4);
});

test('拆分维度按最小精度归一化跨度选择，并写入候选方案', () => {
  // 4x4 空间是 16 个最小步，4 秒是 4 个最小步：先拆空间。
  const plan = chooseSplit(DOMAIN, GEOMETRY);
  assert.equal(plan.dimension, 'spatialX');
  assert.deepEqual(plan.candidates.map(candidate => candidate.dimension), ['spatialX', 'spatialY', 'temporal']);
  // 时间更长时先拆时间。
  const temporal = chooseSplit({ ...DOMAIN, from: 0, until: 20 }, GEOMETRY);
  assert.equal(temporal.dimension, 'temporal');
});

test('足够预算 + 足够 cap：23 条唯一记录全部入账且可证明完整', async () => withSite(async site => {
  await control(site, { cap: 30 });
  const out = await directory();
  const coverage = await collect({ base: site.url, directory: out, budget: 40, retryDelay: 0 });
  verify(coverage);
  assert.equal(coverage.complete, true);
  assert.equal(coverage.stopReason, 'complete');
  assert.equal(coverage.records.length, 23);
  assert.equal(new Set(coverage.records.map(record => record.id)).size, 23);
  // 边界点 x=0/4、y=0/4、time=0/4 都必须在 records 中。
  for (const id of ['OBS-00', 'OBS-02', 'OBS-06', 'OBS-08', 'OBS-09', 'OBS-17']) {
    assert.ok(coverage.records.some(record => record.id === id), `缺少边界记录 ${id}`);
  }
  // 根节点直接未截断：请求数只含 /snapshot 与一次 /query。
  assert.equal(coverage.requestsUsed, 2);
  const saved = await loadCoverage(out);
  verify(saved);
}));

test('默认 cap=3：不能伪装完整；热点到最小粒度仍截断被明确列失败', async () => withSite(async site => {
  const out = await directory();
  const coverage = await collect({ base: site.url, directory: out, budget: 500, retryDelay: 0 });
  verify(coverage);
  assert.equal(coverage.complete, false);
  assert.equal(coverage.stopReason, 'incomplete');
  assert.equal(coverage.snapshotValid, true);
  // 所有普通边界记录仍然一条不少（边界闭合且去重）。
  const ids = coverage.records.map(record => record.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ['OBS-00', 'OBS-01', 'OBS-02', 'OBS-03', 'OBS-04', 'OBS-05', 'OBS-06', 'OBS-07',
    'OBS-08', 'OBS-09', 'OBS-10', 'OBS-11', 'OBS-12', 'OBS-13', 'OBS-14', 'OBS-15', 'OBS-16', 'OBS-17']) {
    assert.ok(ids.includes(id), `边界/普通记录 ${id} 不应丢失`);
  }
  // 热点记录不能以截断前缀形式入账（否则会伪称收全）。
  assert.ok(!ids.includes('HOT-0'));
  assert.ok(coverage.duplicateRecords > 0, '闭合边界应在分界线上产生重复命中并去重');
  // 未解决热点必须在最小粒度叶子上，并带明确原因。
  const incomplete = coverage.leaves.filter(leaf => leaf.status === 'incomplete');
  assert.ok(incomplete.length > 0);
  for (const leaf of incomplete) {
    assert.equal(leaf.evidence.truncated, true);
    assert.equal(leaf.split.reason, 'at-minimum-precision');
    assert.equal(leaf.evidence.reason, 'min-granularity-truncated');
    assert.ok(leaf.bounds.xmax - leaf.bounds.xmin <= GEOMETRY.minSpatial + 1e-9);
    assert.ok(leaf.bounds.ymax - leaf.bounds.ymin <= GEOMETRY.minSpatial + 1e-9);
    assert.ok(leaf.bounds.until - leaf.bounds.from <= GEOMETRY.minTemporal);
  }
  // 每个失败叶子都能在 failures 中找到对应原因。
  for (const leaf of incomplete) {
    assert.ok(coverage.failures.some(failure => failure.node === leaf.id && failure.code === 'hotspot-unresolvable'));
  }
}));

test('不足预算：requestsUsed 不越限，覆盖树保留待办与原因，续跑不重查已完成叶子', async () => withSite(async site => {
  const out = await directory();
  const first = await collect({ base: site.url, directory: out, budget: 25, retryDelay: 0 });
  verify(first);
  assert.equal(first.complete, false);
  assert.equal(first.stopReason, 'budget-exhausted');
  assert.equal(first.requestsUsed, 25);
  assert.ok(first.leafCounts.pending > 0);
  assert.ok(first.leafCounts.complete > 0);
  const completedIds = first.leaves.filter(leaf => leaf.status === 'complete').map(leaf => leaf.id);
  assert.ok(completedIds.length > 0);

  const before = queryPaths(site).length;
  const second = await collect({ base: site.url, directory: out, budget: 500, retryDelay: 0 });
  verify(second);
  assert.equal(second.resumed, true);
  assert.ok(second.requestsUsed > first.requestsUsed);
  assert.equal(second.requestsUsed <= second.budget, true);
  // 续跑只查询第一轮未完成的叶子；已完成区域不能重新出现。
  const newQueries = queryPaths(site).slice(before);
  assert.ok(newQueries.length > 0);
  // 已完成叶子不应出现在续跑的查询边界里：它们的证据时间/请求次数保持不变。
  const seenBounds = new Set();
  for (const entry of newQueries) {
    const params = new URLSearchParams(entry.path.split('?')[1]);
    seenBounds.add(['xmin', 'xmax', 'ymin', 'ymax', 'from', 'until']
      .map(key => `${key}=${params.get(key)}`).join('&'));
  }
  for (const id of completedIds) {
    const beforeLeaf = first.leaves.find(leaf => leaf.id === id);
    const afterLeaf = second.leaves.find(leaf => leaf.id === id);
    assert.deepEqual(afterLeaf.evidence, beforeLeaf.evidence, `已完成叶子 ${id} 不应被重新查询`);
    const signature = ['xmin', 'xmax', 'ymin', 'ymax', 'from', 'until']
      .map(key => `${key}=${beforeLeaf.bounds[key]}`).join('&');
    assert.equal(seenBounds.has(signature), false, `已完成叶子 ${id} 的边界不应再次被查询`);
  }
  // 续跑后的结论必须与一次性足够预算运行一致（都因热点无法证明完整）。
  assert.equal(second.complete, false);
  assert.equal(second.stopReason, 'incomplete');
  assert.equal(second.records.length, 18);
}));

test('预算在请求前耗尽时仍留下一致的覆盖树，且绝不发超额请求', async () => withSite(async site => {
  const out = await directory();
  const coverage = await collect({ base: site.url, directory: out, budget: 1, retryDelay: 0 });
  verify(coverage);
  assert.equal(coverage.requestsUsed, 1);
  assert.equal(coverage.complete, false);
  assert.equal(coverage.stopReason, 'budget-exhausted');
  assert.equal(coverage.leafCounts.total, 1);
  assert.equal(coverage.leafCounts.pending, 1);
  assert.equal(queryPaths(site).length, 0);
}));

test('重试也计入实际请求预算，attempts 与 requestsUsed 一致', async () => withSite(async site => {
  const out = await directory();
  let failures = 0;
  const flaky = async (url, options) => {
    if (new URL(url).pathname === '/query' && failures < 2) {
      failures += 1;
      return new Response('upstream down', { status: 503 });
    }
    return fetch(url, options);
  };
  const coverage = await collect({ base: site.url, directory: out, budget: 20, retryDelay: 0, fetchImpl: flaky });
  verify(coverage);
  assert.equal(failures, 2);
  // 根节点收到 2 次 503 后第 3 次成功：证据里 attempts 必须反映真实尝试次数。
  assert.equal(coverage.tree.status, 'split');
  assert.equal(coverage.tree.evidence.attempts, 3);
  assert.equal(coverage.tree.evidence.requests, 3);
  // /snapshot(1) + 树中每个节点的查询尝试数 = requestsUsed，且不超预算。
  const queryAttempts = (function sum(node) {
    return node.evidence.requests + node.children.reduce((total, child) => total + sum(child), 0);
  })(coverage.tree);
  assert.equal(coverage.requestsUsed, 1 + queryAttempts);
  assert.equal(coverage.requestsUsed <= coverage.budget, true);
}));

test('快照失效：放弃该代完整性，不混入新快照，且拒绝在同文件续跑', async () => withSite(async site => {
  await control(site, { cap: 3 });
  const out = await directory();
  const first = await collect({ base: site.url, directory: out, budget: 25, retryDelay: 0 });
  assert.equal(first.snapshot, 'plot-1');
  await control(site, { generation: 2 });
  const second = await collect({ base: site.url, directory: out, budget: 500, retryDelay: 0 });
  verify(second);
  assert.equal(second.snapshot, 'plot-1');
  assert.equal(second.complete, false);
  assert.equal(second.snapshotValid, false);
  assert.equal(second.stopReason, 'snapshot-expired');
  assert.ok(second.failures.some(failure => failure.code === 'snapshot-expired'));
  assert.ok(second.leaves.every(leaf => leaf.snapshot === 'plot-1'));
  assert.ok(second.records.every(record => record.id !== undefined));
  await assert.rejects(
    collect({ base: site.url, directory: out, budget: 100, retryDelay: 0 }),
    /已失效/,
  );
  // 新的一代必须显式 fresh，快照改变，不能与旧代记录拼接。
  const fresh = await collect({ base: site.url, directory: out, budget: 40, fresh: true, retryDelay: 0 });
  assert.equal(fresh.snapshot, 'plot-2');
  assert.equal(fresh.records.some(record => record.id.startsWith('OBS')), true);
}));

test('用户中止后可从持久化树续跑', async () => withSite(async site => {
  const out = await directory();
  const controller = new AbortController();
  let queries = 0;
  const stopping = async (url, options) => {
    if (new URL(url).pathname === '/query' && ++queries === 3) controller.abort();
    return fetch(url, options);
  };
  const first = await collect({
    base: site.url, directory: out, budget: 500, retryDelay: 0,
    fetchImpl: stopping, signal: controller.signal,
  });
  verify(first);
  assert.equal(first.complete, false);
  assert.equal(first.stopReason, 'aborted');
  assert.ok(first.leafCounts.pending > 0);
  const second = await collect({ base: site.url, directory: out, budget: 500, retryDelay: 0 });
  verify(second);
  assert.equal(second.resumed, true);
  assert.equal(second.stopReason, 'incomplete');
  assert.equal(second.records.length, 18);
}));

test('校验拒绝各类证明篡误', () => {
  const base = () => ({
    snapshot: 's', budget: 5, requestsUsed: 2, complete: false, snapshotValid: true,
    snapshotInfo: { domain: DOMAIN },
    records: [{ id: 'a', x: 1, y: 1, time: 1 }],
    tree: {
      id: 'root', snapshot: 's', status: 'complete',
      bounds: DOMAIN, evidence: { truncated: false },
      children: [],
    },
  });
  // 截断叶子标 complete。
  const truncated = base();
  truncated.tree.evidence = { truncated: true };
  assert.throws(() => verify(truncated), /没有未截断证据/);
  // 整体 complete 但 claimedComplete 不一致。
  const claimed = base();
  claimed.complete = true;
  claimed.claimedComplete = false;
  assert.throws(() => verify(claimed), /claimedComplete/);
  // 树混入不同快照。
  const mixed = base();
  mixed.tree.snapshot = 'other';
  assert.throws(() => verify(mixed), /不同快照/);
  // 重复记录 id。
  const duplicated = base();
  duplicated.records.push({ id: 'a', x: 1, y: 1, time: 1 });
  assert.throws(() => verify(duplicated), /唯一/);
  // requestsUsed 超预算。
  const overspent = base();
  overspent.requestsUsed = 6;
  assert.throws(() => verify(overspent), /不得超出/);
  // leaves 与树不一致。
  const inconsistent = base();
  inconsistent.leaves = [{ id: 'root', status: 'incomplete', evidence: { truncated: true } }];
  assert.throws(() => verify(inconsistent), /状态与树不一致/);
});

test('恢复时拒绝混合快照与重复节点 id', () => {
  const snapshotInfo = {
    snapshot: 'plot-1', cap: 3, domain: DOMAIN, minSpatial: 0.25, minTemporal: 1,
  };
  const coverage = createCoverage(snapshotInfo, 10, () => 'now');
  coverage.tree.status = 'split';
  coverage.tree.children = [
    { ...createCoverage(snapshotInfo, 10, () => 'now').tree, id: 'a' },
    { ...createCoverage(snapshotInfo, 10, () => 'now').tree, id: 'a' },
  ];
  assert.throws(() => restoreCoverage(coverage), /id 重复/);
  recount(createCoverage(snapshotInfo, 10, () => 'now'));
});

test('直接运行 runCoverage 遇到快照失效时保留已完成的叶子证据并停止', async () => withSite(async site => {
  const opened = await (await fetch(site.url + '/snapshot')).json();
  const coverage = createCoverage({
    snapshot: opened.snapshot, cap: opened.cap, domain: opened.domain,
    minSpatial: opened.minSpatial, minTemporal: opened.minTemporal,
  }, 100, () => 'now');
  let calls = 0;
  const client = {
    query: async () => {
      calls += 1;
      throw new SnapshotExpiredError({ error: 'snapshot-expired', generation: 2 });
    },
  };
  await runCoverage({ coverage, client, now: () => 'now', persist: async () => {} });
  assert.equal(calls, 1);
  assert.equal(coverage.complete, false);
  assert.equal(coverage.snapshotValid, false);
  assert.equal(coverage.stopReason, 'snapshot-expired');
  assert.ok(coverage.failures.some(failure => failure.code === 'snapshot-expired'));
}));
