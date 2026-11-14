import assert from 'node:assert/strict';

const BOUND_KEYS = ['xmin', 'xmax', 'ymin', 'ymax', 'from', 'until'];
const STATUSES = new Set(['pending', 'split', 'complete', 'incomplete', 'blocked']);

function assertBounds(bounds, label) {
  assert.ok(bounds && typeof bounds === 'object', `${label} 缺少 bounds`);
  for (const key of BOUND_KEYS) {
    assert.ok(Number.isFinite(bounds[key]), `${label} bounds.${key} 不是有限数字`);
  }
  assert.ok(bounds.xmin <= bounds.xmax, `${label} x 下界大于上界`);
  assert.ok(bounds.ymin <= bounds.ymax, `${label} y 下界大于上界`);
  assert.ok(bounds.from <= bounds.until, `${label} 时间下界大于上界`);
}

function assertEvidence(evidence, label) {
  assert.ok(evidence && typeof evidence === 'object', `${label} 缺少 evidence`);
  assert.equal(typeof evidence.truncated === 'boolean' || evidence.truncated === null, true,
    `${label} evidence.truncated 必须是布尔值或 null`);
}

function leavesOf(tree) {
  const out = [];
  (function walk(node) {
    if (node.children && node.children.length) for (const child of node.children) walk(child);
    else out.push(node);
  })(tree);
  return out;
}

/**
 * 校验 coverage.json 的业务不变量：
 * - 顶层快照、预算与实际请求数自洽；
 * - 记录 id 唯一（跨子区重复只入账一次）；
 * - 树中每个节点使用同一快照，边界有效；
 * - complete 叶子必须带 truncated=false 的证据；
 * - 非叶 complete 要求所有孩子完成；整体 complete 要求全部叶子完成
 *   且 snapshotValid=true；
 * - claimedComplete 必须与 complete 一致，避免“宣称完整”与证据脱节。
 */
export function verify(value) {
  assert.ok(value && typeof value === 'object', '结果不是对象');
  assert.ok(typeof value.snapshot === 'string' && value.snapshot.length > 0, '缺少 snapshot');
  assert.ok(Number.isInteger(value.budget) && value.budget >= 0, 'budget 必须是非负整数');
  assert.ok(Number.isInteger(value.requestsUsed) && value.requestsUsed >= 0, 'requestsUsed 必须是非负整数');
  assert.ok(value.requestsUsed <= value.budget, 'requestsUsed 不得超出 budget');
  assert.equal(typeof value.complete, 'boolean', 'complete 必须是布尔值');
  if (value.claimedComplete !== undefined) {
    assert.equal(value.claimedComplete, value.complete, 'claimedComplete 与 complete 不一致');
  }
  if (value.snapshotValid === false) assert.equal(value.complete, false, '快照失效时不能声明 complete');
  if (value.snapshotInfo?.domain) assertBounds(value.snapshotInfo.domain, 'snapshotInfo.domain');

  assert.ok(Array.isArray(value.records), 'records 必须是数组');
  const identifiers = value.records.map(record => {
    assert.ok(record && typeof record.id === 'string' && record.id.length > 0, '记录缺少 id');
    return record.id;
  });
  assert.equal(new Set(identifiers).size, identifiers.length, '记录 id 必须唯一');
  const domain = value.snapshotInfo?.domain;
  if (domain) {
    for (const record of value.records) {
      assert.ok(Number.isFinite(record.x) && record.x >= domain.xmin && record.x <= domain.xmax,
        `记录 ${record.id} 的 x 超出快照范围`);
      assert.ok(Number.isFinite(record.y) && record.y >= domain.ymin && record.y <= domain.ymax,
        `记录 ${record.id} 的 y 超出快照范围`);
      assert.ok(Number.isFinite(record.time) && record.time >= domain.from && record.time <= domain.until,
        `记录 ${record.id} 的 time 超出快照范围`);
    }
  }

  assert.ok(value.tree && typeof value.tree === 'object', '缺少 tree');
  const nodeIds = new Set();
  function visit(node, label) {
    assert.ok(node && typeof node === 'object', `${label} 节点无效`);
    assert.ok(STATUSES.has(node.status), `${label} 状态 ${node.status} 不可识别`);
    assert.ok(typeof node.id === 'string' && node.id.length > 0, `${label} 节点缺少 id`);
    assert.equal(nodeIds.has(node.id), false, `覆盖树节点 id 重复：${node.id}`);
    nodeIds.add(node.id);
    assert.equal(node.snapshot, value.snapshot, `${label} 使用了不同快照`);
    assertBounds(node.bounds, label);
    assertEvidence(node.evidence, label);
    const children = node.children || [];
    assert.ok(Array.isArray(children), `${label} children 必须是数组`);
    if (children.length === 0) {
      if (node.status === 'complete') {
        assert.equal(node.evidence.truncated, false, `${label} 标为 complete 但没有未截断证据`);
      }
      return node.status === 'complete' && node.evidence.truncated === false;
    }
    const complete = children.map((child, index) => visit(child, `${label}.${index}`)).every(Boolean);
    if (node.status === 'complete') {
      assert.ok(complete, `${label} 非叶 complete 要求所有孩子完成`);
    }
    return node.status === 'complete' && complete;
  }
  const proven = visit(value.tree, 'tree');
  if (value.complete) {
    assert.ok(proven, '整体 complete 缺少完整的叶子证据');
    assert.equal(value.snapshotValid === false, false, '快照失效时不能声明 complete');
  }

  const treeLeaves = leavesOf(value.tree);
  if (value.leaves !== undefined) {
    assert.ok(Array.isArray(value.leaves), 'leaves 必须是数组');
    assert.equal(value.leaves.length, treeLeaves.length, 'leaves 数量与树叶子不一致');
    for (const [index, leaf] of value.leaves.entries()) {
      const node = treeLeaves[index];
      assert.equal(leaf.id, node.id, 'leaves 顺序或内容与树不一致');
      assert.equal(leaf.status, node.status, `叶子 ${node.id} 状态与树不一致`);
      assert.deepEqual(leaf.evidence, node.evidence, `叶子 ${node.id} 证据与树不一致`);
      if (leaf.status === 'complete') {
        assert.equal(leaf.evidence.truncated, false, `叶子 ${node.id} 标为 complete 但被截断`);
      }
    }
    const completedLeaves = treeLeaves.filter(node => node.status === 'complete' && node.evidence.truncated === false).length;
    if (value.complete) assert.equal(completedLeaves, treeLeaves.length, '整体 complete 但存在未完成叶子');
  }
  if (value.leafCounts && typeof value.leafCounts === 'object') {
    assert.equal(value.leafCounts.total, treeLeaves.length, 'leafCounts.total 与树叶子不一致');
    assert.equal(value.leafCounts.complete, treeLeaves.filter(node => node.status === 'complete').length,
      'leafCounts.complete 与树叶子不一致');
  }
  return proven;
}
