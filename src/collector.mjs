import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BudgetExhaustedError, PlotClient } from './client.mjs';
import {
  createCoverage, prepareResume, recount, requestAbort, restoreCoverage, runCoverage, walkLeaves,
} from './coverage.mjs';

export const COVERAGE_FILE = 'coverage.json';
export const RECORDS_FILE = 'records.jsonl';

/** 原子写：先写临时文件再 rename，进程在任意时刻被杀也不会留下半个 JSON。 */
export async function writeJsonAtomic(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.part`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await rename(temporary, filename);
}

async function readJson(filename) {
  return JSON.parse(await readFile(filename, 'utf8'));
}

/** coverage.json 是完整结果；records.jsonl 是去重后的记录（每行一条）。 */
export async function writeOutputs(directory, coverage) {
  await mkdir(directory, { recursive: true });
  await writeJsonAtomic(path.join(directory, COVERAGE_FILE), coverage);
  const lines = coverage.records.map(record => JSON.stringify(record)).join('\n');
  await writeFile(path.join(directory, RECORDS_FILE), lines ? lines + '\n' : '', 'utf8');
}

export async function loadCoverage(directory) {
  return restoreCoverage(await readJson(path.join(directory, COVERAGE_FILE)));
}

function budgetedClient(base, coverage, options, persist, now) {
  return new PlotClient(base, {
    fetchImpl: options.fetchImpl,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    retries: options.retries,
    retryDelay: options.retryDelay,
    // 每次实际尝试（含重试）在发请求前扣预算并落盘；崩溃/被杀也不会少记。
    beforeAttempt: async ({ path: requestPath }) => {
      if (coverage.requestsUsed >= coverage.budget) {
        throw new BudgetExhaustedError(coverage.requestsUsed, coverage.budget);
      }
      coverage.requestsUsed += 1;
      coverage.lastAttempt = { path: requestPath, at: now(), used: coverage.requestsUsed, budget: coverage.budget };
      await persist(coverage);
    },
  });
}

export async function openSnapshot(base, options = {}) {
  const budget = options.budget;
  if (!Number.isInteger(budget) || budget < 1) throw new Error('budget 必须是至少为 1 的整数');
  const retries = options.retries ?? 2;
  let used = 0;
  let lastError;
  const client = new PlotClient(base, {
    fetchImpl: options.fetchImpl,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    retries: 0,
    beforeAttempt: async () => {
      if (used >= budget) throw new BudgetExhaustedError(used, budget);
      used += 1;
    },
  });
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return { snapshotInfo: await client.snapshot(), requestsUsed: used };
    } catch (error) {
      lastError = error;
      if (error instanceof BudgetExhaustedError || error.code === 'aborted' || error.code === 'snapshot-expired') break;
      if (attempt < retries && options.retryDelay > 0) {
        await new Promise(resolve => setTimeout(resolve, options.retryDelay));
      }
    }
  }
  throw new Error(`获取快照失败：${lastError?.message || lastError}`);
}

/**
 * 从零开始或从已有覆盖树继续。已有结果在快照仍有效时只查询 pending/blocked
 * 叶子，已 complete 的叶子不会重查。快照已失效、预算小于已用请求数时拒绝续跑。
 * fresh=true 会忽略已有 coverage.json 并重新取快照（新的一代）。
 */
export async function collect({
  base,
  directory,
  budget,
  fresh = false,
  resume = true,
  retries = 2,
  retryDelay = 40,
  timeoutMs = 10_000,
  signal,
  fetchImpl,
  now = () => new Date().toISOString(),
  save,
} = {}) {
  if (!base) throw new Error('缺少源端地址');
  if (!directory) throw new Error('缺少输出目录');
  await mkdir(directory, { recursive: true });
  const filename = path.join(directory, COVERAGE_FILE);
  const options = { retries, retryDelay, timeoutMs, signal, fetchImpl };

  const persist = async value => {
    await writeOutputs(directory, value);
    await save?.(value);
  };

  let coverage = null;
  let resumed = false;
  if (resume && !fresh) {
    try {
      coverage = restoreCoverage(await readJson(filename));
      resumed = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  if (coverage) {
    if (coverage.snapshotValid === false) {
      throw new Error(`覆盖结果标记快照 ${coverage.snapshot} 已失效，不能按同一快照继续；请使用 fresh 开始新的一代`);
    }
    if (budget !== undefined && (!Number.isInteger(budget) || budget < coverage.requestsUsed)) {
      throw new Error(`新预算 ${budget} 不能小于 requestsUsed=${coverage.requestsUsed}`);
    }
    // prepareResume 内部还会再校验一次，这里提前给出更直白的错误。
    prepareResume(coverage, budget);
  } else {
    if (budget === undefined) budget = 64;
    if (!Number.isInteger(budget) || budget < 1) throw new Error('budget 必须是至少为 1 的整数');
    const opened = await openSnapshot(base, { ...options, budget });
    coverage = createCoverage(opened.snapshotInfo, budget, now);
    coverage.requestsUsed = opened.requestsUsed;
    coverage.lastAttempt = { path: '/snapshot', at: now(), used: opened.requestsUsed, budget };
    resumed = false;
  }
  const completedBefore = walkLeaves(coverage.tree).filter(({ node }) => node.status === 'complete').length;
  const pendingBefore = walkLeaves(coverage.tree).filter(({ node }) => node.status === 'pending').length;
  coverage.resumed = resumed;
  coverage.completedLeavesBeforeRun = completedBefore;
  coverage.pendingLeavesBeforeRun = pendingBefore;
  coverage.base = base;
  recount(coverage);
  await persist(coverage);

  const client = budgetedClient(base, coverage, options, persist, now);
  try {
    await runCoverage({ coverage, client, now, persist });
  } catch (error) {
    if (!requestAbort(error)) throw error;
    coverage.stopReason = 'aborted';
    coverage.stopDetail = { message: '用户中止采集；覆盖树已保存，可按同一快照续跑' };
    coverage.complete = false;
    coverage.claimedComplete = false;
  } finally {
    recount(coverage);
    await persist(coverage);
  }
  return coverage;
}
