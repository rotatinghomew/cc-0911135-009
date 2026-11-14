import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createSite } from '../src/site.mjs';
import { collect, loadCoverage } from '../src/collector.mjs';
import { verify } from '../lib/verify.mjs';
import { walkLeaves } from '../src/coverage.mjs';

const root = path.resolve('var/drill');
// 每次演练从空目录开始，避免旧 coverage.json 影响结论。
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });

async function control(site, value) {
  await fetch(site.url + '/_control', { method: 'POST', body: JSON.stringify(value) });
}

function tree(node, depth = 0) {
  const pad = '  '.repeat(depth);
  const dims = node.split?.dimension ? ` split=${node.split.dimension}` : '';
  const reason = node.split?.reason ? ` (${node.split.reason})` : '';
  const evidence = node.evidence?.truncated === null || node.evidence?.truncated === undefined
    ? '' : ` truncated=${node.evidence.truncated} returned=${node.evidence.returned}`;
  const lines = [`${pad}${node.id} ${node.status}${dims}${reason}${evidence} ${JSON.stringify(node.bounds)}`];
  for (const child of node.children) lines.push(tree(child, depth + 1));
  return lines.join('\n');
}

function innerSplits(node, out = []) {
  if (node.children.length === 0) return out;
  if (node.split?.dimension) {
    out.push({ id: node.id, bounds: node.bounds, dimension: node.split.dimension, candidates: node.split.candidates });
  }
  for (const child of node.children) innerSplits(child, out);
  return out;
}

function summarise(coverage) {
  return {
    snapshot: coverage.snapshot,
    complete: coverage.complete,
    claimedComplete: coverage.claimedComplete,
    snapshotValid: coverage.snapshotValid,
    stopReason: coverage.stopReason,
    budget: coverage.budget,
    requestsUsed: coverage.requestsUsed,
    uniqueRecords: coverage.records.length,
    duplicateHits: coverage.duplicateRecords || 0,
    leaves: coverage.leafCounts,
    leafEvidenceConsistent: coverage.leaves.every(leaf =>
      leaf.status !== 'complete' || leaf.evidence.truncated === false),
  };
}

const report = {};

// ---------------------------------------------------------------------------
// 1. 默认 cap=3、预算充足：边界点全部入账，热点在最小粒度仍截断。
// ---------------------------------------------------------------------------
{
  const site = await createSite();
  try {
    const out = path.join(root, 'default-cap');
    const coverage = await collect({ base: site.url, directory: out, budget: 400, retryDelay: 0 });
    verify(coverage);
    report.defaultCap = summarise(coverage);
    report.defaultCap.splitDecisions = innerSplits(coverage.tree).slice(0, 6);
    report.defaultCap.hotspots = coverage.failures.map(failure => ({
      bounds: failure.bounds, status: failure.status, code: failure.code, detail: failure.detail,
    }));
    report.defaultCap.boundaryRecords = ['OBS-00', 'OBS-02', 'OBS-06', 'OBS-08', 'OBS-09', 'OBS-17']
      .map(id => coverage.records.find(record => record.id === id))
      .filter(Boolean);
    report.defaultCap.treeSample = tree(coverage.tree).split('\n').filter(line =>
      /root\.[01](\.[01])? /.test(line) || /incomplete/.test(line)).slice(0, 14);

    assert.equal(coverage.complete, false);
    assert.equal(coverage.stopReason, 'incomplete');
    assert.equal(coverage.records.length, 18);
    assert.ok(coverage.duplicateRecords > 0);
    assert.ok(coverage.failures.length > 0);
    assert.ok(coverage.failures.every(failure => failure.code === 'hotspot-unresolvable'));
    assert.ok(!coverage.records.some(record => record.id.startsWith('HOT-')));
  } finally {
    await site.close();
  }
}

// ---------------------------------------------------------------------------
// 2. 足够容量 cap=30：可以在有限请求内证明完整，全域 23 条唯一记录。
// ---------------------------------------------------------------------------
{
  const site = await createSite();
  try {
    await control(site, { cap: 30 });
    const out = path.join(root, 'generous-cap');
    const coverage = await collect({ base: site.url, directory: out, budget: 40, retryDelay: 0 });
    verify(coverage);
    report.generousCap = summarise(coverage);
    assert.equal(coverage.complete, true);
    assert.equal(coverage.stopReason, 'complete');
    assert.equal(coverage.records.length, 23);
    assert.equal(new Set(coverage.records.map(record => record.id)).size, 23);
  } finally {
    await site.close();
  }
}

// ---------------------------------------------------------------------------
// 3. 预算不足 -> 持久化待办 -> 续跑不重查已完成叶子。
// ---------------------------------------------------------------------------
{
  const site = await createSite();
  try {
    const out = path.join(root, 'resume');
    const first = await collect({ base: site.url, directory: out, budget: 20, retryDelay: 0 });
    verify(first);
    assert.equal(first.complete, false);
    assert.equal(first.stopReason, 'budget-exhausted');
    assert.equal(first.requestsUsed, 20);
    const completed = walkLeaves(first.tree).filter(({ node }) => node.status === 'complete');
    assert.ok(completed.length > 0);
    assert.ok(first.leafCounts.pending > 0);

    const auditBefore = site.audit.filter(entry => entry.path.startsWith('/query')).length;
    const second = await collect({ base: site.url, directory: out, budget: 400, retryDelay: 0 });
    verify(second);
    assert.equal(second.resumed, true);
    assert.equal(second.complete, false);
    assert.equal(second.stopReason, 'incomplete');
    for (const { node } of completed) {
      const after = second.leaves.find(leaf => leaf.id === node.id);
      assert.deepEqual(after.evidence, node.evidence);
    }
    const newQueries = site.audit.filter(entry => entry.path.startsWith('/query')).length - auditBefore;
    report.resume = {
      first: summarise(first),
      second: summarise(second),
      completedLeavesBeforeResume: completed.length,
      queriesAfterResume: newQueries,
      pendingBeforeResume: first.leafCounts.pending,
    };
  } finally {
    await site.close();
  }
}

// ---------------------------------------------------------------------------
// 4. 快照失效：放弃该代完整性；不混入新快照；拒绝同文件续跑。
// ---------------------------------------------------------------------------
{
  const site = await createSite();
  try {
    const out = path.join(root, 'expired');
    const first = await collect({ base: site.url, directory: out, budget: 25, retryDelay: 0 });
    const completedBefore = walkLeaves(first.tree).filter(({ node }) => node.status === 'complete').length;
    await control(site, { generation: 2 });
    const expired = await collect({ base: site.url, directory: out, budget: 400, retryDelay: 0 });
    verify(expired);
    assert.equal(expired.snapshot, 'plot-1');
    assert.equal(expired.snapshotValid, false);
    assert.equal(expired.complete, false);
    assert.equal(expired.stopReason, 'snapshot-expired');
    assert.ok(expired.failures.some(failure => failure.code === 'snapshot-expired'));
    assert.ok(expired.leaves.every(leaf => leaf.snapshot === 'plot-1'));
    await assert.rejects(
      collect({ base: site.url, directory: out, budget: 400, retryDelay: 0 }),
      /已失效/,
    );
    const fresh = await collect({ base: site.url, directory: out, budget: 40, fresh: true, retryDelay: 0 });
    report.expired = {
      before: summarise(first),
      expired: summarise(expired),
      completedLeavesBeforeExpiry: completedBefore,
      freshGeneration: summarise(fresh),
    };
    assert.equal(fresh.snapshot, 'plot-2');
  } finally {
    await site.close();
  }
}

// ---------------------------------------------------------------------------
// 5. 直接读取持久化结果：npm run verify 使用的同一套不变量。
// ---------------------------------------------------------------------------
{
  const persisted = await loadCoverage(path.join(root, 'default-cap'));
  verify(persisted);
  report.persisted = {
    file: path.join(root, 'default-cap', 'coverage.json'),
    complete: persisted.complete,
    leaves: persisted.leafCounts,
    records: persisted.records.length,
  };
}

await writeFile(path.join(root, 'summary.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(report, null, 2));
console.error('\n演练通过：覆盖结论与叶子证据一致；summary.json 已写入', root);
