import {
  BudgetExhaustedError, HttpStatusError, ProtocolError, RequestAbortedError,
  SnapshotExpiredError, SnapshotMismatchError, TransportError,
} from './client.mjs';

const BOUND_KEYS = ['xmin', 'xmax', 'ymin', 'ymax', 'from', 'until'];
const PRECISION = 1e-9;

export function walkLeaves(node, path = [], out = []) {
  const children = node.children || [];
  if (children.length === 0) out.push({ node, path });
  else for (const [index, child] of children.entries()) walkLeaves(child, [...path, index], out);
  return out;
}

function round(value) {
  return Math.round(value * 1e12) / 1e12;
}

function copyBounds(bounds) {
  return Object.fromEntries(BOUND_KEYS.map(key => [key, bounds[key]]));
}

/** 某个轴按最小精度归一化后可再分的步数。 */
export function latticeSteps(bounds, axis, geometry) {
  const [startKey, endKey] = axis === 't' ? ['from', 'until'] : axis === 'x' ? ['xmin', 'xmax'] : ['ymin', 'ymax'];
  const precision = axis === 't' ? geometry.minTemporal : geometry.minSpatial;
  return Math.floor(round((bounds[endKey] - bounds[startKey]) / precision) + PRECISION);
}

/**
 * 所有上下界都是闭区间。把 [lo, hi] 按中点切成 [lo, mid] 与 [mid, hi]：
 * 两个孩子都包含中点，分界线上的记录会同时命中两个孩子，由采集器按 id
 * 去重。中点以 lo 为锚点取最小精度的整数步，保证孩子宽度不低于最小精度。
 */
export function splitAxis(bounds, axis, geometry) {
  const [startKey, endKey] = axis === 't' ? ['from', 'until'] : axis === 'x' ? ['xmin', 'xmax'] : ['ymin', 'ymax'];
  const precision = axis === 't' ? geometry.minTemporal : geometry.minSpatial;
  const steps = latticeSteps(bounds, axis, geometry);
  if (steps < 2) return null;
  const leftSteps = Math.floor(steps / 2);
  const rightSteps = steps - leftSteps;
  if (leftSteps < 1 || rightSteps < 1) return null;
  const mid = round(bounds[startKey] + leftSteps * precision);
  if (!(mid > bounds[startKey] && mid < bounds[endKey])) return null;
  return [
    { ...copyBounds(bounds), [endKey]: mid },
    { ...copyBounds(bounds), [startKey]: mid },
  ];
}

export function splitCandidates(bounds, geometry) {
  const axes = [
    { axis: 't', dimension: 'temporal' },
    { axis: 'x', dimension: 'spatialX' },
    { axis: 'y', dimension: 'spatialY' },
  ];
  return axes
    .map(({ axis, dimension }) => ({ axis, dimension, steps: latticeSteps(bounds, axis, geometry) }))
    .filter(candidate => candidate.steps >= 2 && splitAxis(bounds, candidate.axis, geometry) !== null);
}

/**
 * 拆分维度策略：选择按最小精度归一化后跨度最大的轴，使空间与时间同步
 * 收敛；并列时固定顺序 temporal → spatialX → spatialY，结果可复现。
 * 返回的可选方案写入 coverage.json，便于解释为什么拆这一轴。
 */
export function chooseSplit(bounds, geometry) {
  const candidates = splitCandidates(bounds, geometry);
  if (candidates.length === 0) return null;
  const priority = { temporal: 0, spatialX: 1, spatialY: 2 };
  const ranked = [...candidates].sort((a, b) => b.steps - a.steps || priority[a.dimension] - priority[b.dimension]);
  const chosen = ranked[0];
  return {
    dimension: chosen.dimension,
    candidates: ranked.map(candidate => ({ dimension: candidate.dimension, steps: candidate.steps })),
    halves: splitAxis(bounds, chosen.axis, geometry),
  };
}

export function createNode(id, bounds, snapshot) {
  return {
    id,
    snapshot,
    bounds: copyBounds(bounds),
    status: 'pending',
    split: null,
    evidence: {
      queried: false,
      truncated: null,
      returned: 0,
      lowerBound: null,
      attempts: 0,
      requests: 0,
    },
    children: [],
  };
}

export function createCoverage(snapshotInfo, budget, now) {
  return {
    version: 1,
    snapshot: snapshotInfo.snapshot,
    snapshotInfo: {
      snapshot: snapshotInfo.snapshot,
      cap: snapshotInfo.cap,
      domain: copyBounds(snapshotInfo.domain),
      minSpatial: snapshotInfo.minSpatial,
      minTemporal: snapshotInfo.minTemporal,
    },
    strategy: {
      dimensionSelection: 'largest-normalized-span',
      boundary: 'closed-intervals-shared-boundary-with-id-dedup',
      order: ['temporal', 'spatialX', 'spatialY'],
    },
    budget,
    requestsUsed: 0,
    complete: false,
    claimedComplete: false,
    snapshotValid: true,
    stopReason: 'in-progress',
    records: [],
    failures: [],
    leaves: [],
    leafCounts: null,
    tree: createNode('root', snapshotInfo.domain, snapshotInfo.snapshot),
    startedAt: now(),
    updatedAt: now(),
  };
}

/** 校验磁盘上的覆盖树可继续，并拒绝混合快照、重复 id 等损坏状态。 */
export function restoreCoverage(value) {
  if (!value || typeof value !== 'object') throw new ProtocolError('coverage.json 不是对象');
  if (value.version !== 1) throw new ProtocolError('不支持的 coverage.json version');
  if (typeof value.snapshot !== 'string' || !value.snapshot) throw new ProtocolError('coverage.json 缺少 snapshot');
  if (!value.snapshotInfo || typeof value.snapshotInfo !== 'object') throw new ProtocolError('coverage.json 缺少 snapshotInfo');
  if (!Number.isInteger(value.budget) || value.budget < 1) throw new ProtocolError('coverage.json budget 无效');
  if (!Number.isInteger(value.requestsUsed) || value.requestsUsed < 0 || value.requestsUsed > value.budget) {
    throw new ProtocolError('coverage.json requestsUsed 无效');
  }
  if (!Array.isArray(value.records)) throw new ProtocolError('coverage.json records 无效');
  if (!value.tree || typeof value.tree !== 'object') throw new ProtocolError('coverage.json 缺少 tree');
  const recordIds = new Set();
  for (const record of value.records) {
    if (!record || typeof record.id !== 'string' || !record.id) throw new ProtocolError('coverage.json 记录缺少 id');
    if (recordIds.has(record.id)) throw new ProtocolError(`coverage.json 含重复记录 ${record.id}`);
    recordIds.add(record.id);
  }
  const treeIds = new Set();
  (function visit(node, depth) {
    if (!node || typeof node !== 'object') throw new ProtocolError('覆盖树节点无效');
    if (node.snapshot !== value.snapshot) throw new ProtocolError('覆盖树混合了不同快照');
    if (typeof node.id !== 'string' || !node.id) throw new ProtocolError('覆盖树节点缺少 id');
    if (treeIds.has(node.id)) throw new ProtocolError(`覆盖树节点 id 重复 ${node.id}`);
    treeIds.add(node.id);
    if (depth > 80) throw new ProtocolError('覆盖树嵌套过深');
    if (!Array.isArray(node.children)) throw new ProtocolError('覆盖树 children 无效');
    for (const child of node.children) visit(child, depth + 1);
  })(value.tree, 0);
  return value;
}

export function recount(coverage) {
  const leaves = walkLeaves(coverage.tree);
  coverage.leaves = leaves.map(({ node, path }) => ({
    path,
    id: node.id,
    snapshot: node.snapshot,
    bounds: copyBounds(node.bounds),
    status: node.status,
    split: node.split,
    evidence: node.evidence,
  }));
  const counts = { total: 0, complete: 0, pending: 0, incomplete: 0, blocked: 0 };
  for (const { node } of leaves) {
    counts.total += 1;
    counts[node.status] = (counts[node.status] || 0) + 1;
  }
  coverage.leafCounts = counts;
  coverage.failures = leaves
    .filter(({ node }) => node.status === 'incomplete' || node.status === 'blocked')
    .map(({ node, path }) => ({
      node: node.id,
      path,
      bounds: copyBounds(node.bounds),
      status: node.status,
      code: node.status === 'incomplete' ? 'hotspot-unresolvable' : node.evidence.reason,
      detail: node.evidence.detail,
    }));
  coverage.complete = coverage.snapshotValid === true &&
    counts.total > 0 && counts.complete === counts.total &&
    leaves.every(({ node }) => node.status === 'complete' && node.evidence?.truncated === false);
  coverage.claimedComplete = coverage.complete;
  return coverage;
}

function classify(error) {
  if (error instanceof SnapshotExpiredError) {
    return { code: 'snapshot-expired', fatal: true, detail: error.detail ?? { message: error.message } };
  }
  if (error instanceof SnapshotMismatchError) {
    return { code: 'snapshot-mismatch', fatal: true, detail: { expected: error.expected, received: error.received } };
  }
  if (error instanceof RequestAbortedError) {
    return { code: 'aborted', fatal: true, detail: { message: error.message } };
  }
  if (error instanceof BudgetExhaustedError) {
    return { code: 'budget-exhausted', fatal: false, detail: { used: error.used, budget: error.budget }, pending: true };
  }
  if (error instanceof HttpStatusError) {
    return { code: 'http-status', fatal: false, detail: { status: error.status, retryable: error.retryable }, blocked: true };
  }
  if (error instanceof TransportError) {
    return { code: 'transport', fatal: false, detail: { message: error.message }, blocked: true };
  }
  return { code: error?.code || 'error', fatal: false, detail: { message: error?.message || String(error) }, blocked: true };
}

/**
 * 在固定快照内递归覆盖。覆盖树、去重记录与预算计数在每次请求前都会由
 * persist 落盘（见 collector.mjs 的 beforeAttempt），因此预算耗尽、中止或
 * 进程被杀后仍能看出已完成叶子、待办区域与失败原因。
 */
export async function runCoverage({ coverage, client, now, persist }) {
  const recordIds = new Set(coverage.records.map(record => record.id));
  const geometry = { minSpatial: coverage.snapshotInfo.minSpatial, minTemporal: coverage.snapshotInfo.minTemporal };
  let fatal = null;
  let budgetHit = false;

  const touch = async () => {
    coverage.updatedAt = now();
    recount(coverage);
    await persist(coverage);
  };

  while (!fatal) {
    const next = walkLeaves(coverage.tree).find(({ node }) => node.status === 'pending');
    if (!next) break;
    if (coverage.requestsUsed >= coverage.budget) {
      budgetHit = true;
      // 待办叶子保留在树里，并标出停止原因，便于离线判断哪些区域尚未处理。
      for (const { node } of walkLeaves(coverage.tree)) {
        if (node.status === 'pending' && !node.evidence.reason) {
          node.evidence.reason = 'budget-exhausted';
          node.evidence.detail = { message: '未被查询，预算已耗尽；可按同一快照续跑' };
        }
      }
      break;
    }
    const { node } = next;
    const before = coverage.requestsUsed;
    let response;
    try {
      response = await client.query(node.bounds, coverage.snapshot);
    } catch (error) {
      const failure = classify(error);
      node.evidence.attempts += error?.attempts ?? 0;
      node.evidence.requests += coverage.requestsUsed - before;
      node.evidence.reason = failure.code;
      node.evidence.detail = failure.detail;
      if (failure.fatal && failure.code !== 'budget-exhausted') {
        fatal = failure;
        node.status = 'blocked';
        if (failure.code === 'snapshot-expired' || failure.code === 'snapshot-mismatch') {
          coverage.snapshotValid = false;
        }
      } else if (failure.pending) {
        // 预算在发请求前耗尽：该叶子尚未得到任何响应，保持 pending。
        budgetHit = true;
      } else {
        node.status = 'blocked';
      }
      await touch();
      if (fatal || budgetHit) break;
      continue;
    }
    const added = [];
    let duplicates = 0;
    // 截断响应只是服务端排序后的任意前缀，不能作为观测记录入账；子区查全
    // 后会再次返回这些记录。只有未截断响应才进入去重记录集。
    if (!response.truncated) {
      for (const record of response.records) {
        if (!record || typeof record.id !== 'string' || !record.id) throw new ProtocolError('源端记录缺少 id');
        if (recordIds.has(record.id)) { duplicates += 1; continue; }
        recordIds.add(record.id);
        coverage.records.push(record);
        added.push(record.id);
      }
      coverage.duplicateRecords = (coverage.duplicateRecords || 0) + duplicates;
    }
    node.evidence = {
      queried: true,
      truncated: response.truncated,
      returned: response.records.length,
      lowerBound: response.lowerBound,
      attempts: node.evidence.attempts + response.attempts,
      requests: node.evidence.requests + coverage.requestsUsed - before,
      addedRecords: added,
      duplicateRecords: duplicates,
      reason: null,
      detail: null,
      queriedAt: now(),
    };
    if (!response.truncated) {
      node.status = 'complete';
      node.split = null;
      node.children = [];
    } else {
      const plan = chooseSplit(node.bounds, geometry);
      if (plan) {
        node.status = 'split';
        node.split = { dimension: plan.dimension, candidates: plan.candidates, at: now() };
        node.children = plan.halves.map((bounds, index) => createNode(`${node.id}.${index}`, bounds, coverage.snapshot));
        node.evidence.note = '截断响应只是任意前缀，未入账；由子区重新查询并按 id 去重。';
      } else {
        node.status = 'incomplete';
        node.split = { dimension: null, candidates: [], reason: 'at-minimum-precision', at: now() };
        node.evidence.reason = 'min-granularity-truncated';
        node.evidence.detail = `达到 minSpatial=${geometry.minSpatial} 与 minTemporal=${geometry.minTemporal} 后仍截断：` +
          `返回 ${response.records.length} 条，下界 ${response.lowerBound}；该区域无法证明完整。`;
        node.evidence.partialIds = response.records.map(record => record.id);
      }
    }
    await touch();
  }

  recount(coverage);
  if (fatal) {
    coverage.stopReason = fatal.code;
    coverage.stopDetail = fatal.detail;
  } else if (budgetHit || coverage.requestsUsed >= coverage.budget) {
    const pending = coverage.leafCounts.pending;
    coverage.stopReason = pending > 0 ? 'budget-exhausted' : coverage.complete ? 'complete' : 'incomplete';
    coverage.stopDetail = pending > 0
      ? { message: '请求预算耗尽，待办叶子保留在覆盖树中', used: coverage.requestsUsed, budget: coverage.budget, pending }
      : null;
  } else if (coverage.leafCounts.pending === 0) {
    coverage.stopReason = coverage.complete ? 'complete' : 'incomplete';
    coverage.stopDetail = coverage.complete ? null : { message: '仍有无法证明完整的叶子', counts: coverage.leafCounts };
  } else {
    coverage.stopReason = 'incomplete';
    coverage.stopDetail = { message: '仍有未完成叶子', counts: coverage.leafCounts };
  }
  await touch();
  return coverage;
}

export function requestAbort(error) {
  return error instanceof RequestAbortedError;
}

/**
 * 续跑前准备：同一快照下把 blocked 叶子重新置为 pending 重试；已 complete
 * 的叶子保持不动，不会被重新查询。快照已失效时拒绝续跑。
 */
export function prepareResume(coverage, budget) {
  if (coverage.snapshotValid === false) {
    throw new ProtocolError(`覆盖结果标记快照 ${coverage.snapshot} 已失效；不能与新快照拼接，请重新开始一代采集`);
  }
  if (budget !== undefined) {
    if (!Number.isInteger(budget) || budget < coverage.requestsUsed) {
      throw new ProtocolError(`新预算 ${budget} 不能小于 requestsUsed=${coverage.requestsUsed}`);
    }
    coverage.budget = budget;
  }
  for (const { node } of walkLeaves(coverage.tree)) {
    if (node.status === 'blocked') {
      node.evidence.previousFailure = { reason: node.evidence.reason, detail: node.evidence.detail };
      node.evidence.reason = null;
      node.evidence.detail = null;
      node.status = 'pending';
    } else if (node.status === 'pending' && node.evidence.reason) {
      // 上次因预算耗尽/中止没拿到响应，保留原因到上一轮证据，不在续跑时误读。
      node.evidence.previousFailure = { reason: node.evidence.reason, detail: node.evidence.detail };
      node.evidence.reason = null;
      node.evidence.detail = null;
    }
  }
  coverage.complete = false;
  coverage.claimedComplete = false;
  coverage.stopReason = 'in-progress';
  coverage.stopDetail = null;
  // 续跑尚未发请求：把“已用完的预算”理解为新上限，requestsUsed 保持不变。
  recount(coverage);
  return coverage;
}
