import path from 'node:path';
import { collect, loadCoverage } from './collector.mjs';
import { recount } from './coverage.mjs';
import { verify } from '../lib/verify.mjs';

function parse(argv) {
  const options = { directory: 'var/coverage', fresh: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined) throw new Error(`${argument} 缺少参数值`);
      index += 1;
      return next;
    };
    if (argument === '--base') options.base = value();
    else if (argument === '--out') options.directory = value();
    else if (argument === '--budget') options.budget = Number(value());
    else if (argument === '--fresh') options.fresh = true;
    else if (argument === '--retries') options.retries = Number(value());
    else if (argument === '--status') options.status = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`未知参数：${argument}`);
  }
  return options;
}

function summary(coverage) {
  return {
    snapshot: coverage.snapshot,
    complete: coverage.complete,
    stopReason: coverage.stopReason,
    snapshotValid: coverage.snapshotValid,
    budget: coverage.budget,
    requestsUsed: coverage.requestsUsed,
    records: coverage.records.length,
    leaves: coverage.leafCounts,
    resumed: coverage.resumed ?? false,
    failures: coverage.failures.map(failure => ({
      node: failure.node, status: failure.status, code: failure.code, bounds: failure.bounds,
    })),
  };
}

const options = parse(process.argv.slice(2));
if (options.help) {
  console.log(`用法：node src/cli.mjs --base http://127.0.0.1:端口 [--out 目录] [--budget N] [--fresh] [--status]

  --base    源端地址（必填，除非只查看 --status）
  --out     结果目录，默认 var/coverage；写入 coverage.json 与 records.jsonl
  --budget  本次运行允许的实际 HTTP 尝试次数（含重试与 /snapshot）；新采集默认 64，续跑默认沿用原预算
  --fresh   忽略旧 coverage.json，按当前源端代重新开始
  --status  只读取并校验已有 coverage.json，不发任何请求
  --retries 单次查询的重试次数，默认 2（每次重试都计入预算）`);
  process.exit(0);
}

if (options.status) {
  const coverage = await loadCoverage(options.directory);
  recount(coverage);
  verify(coverage);
  console.log(JSON.stringify(summary(coverage), null, 2));
  process.exit(coverage.complete ? 0 : 2);
}

if (!options.base) throw new Error('缺少 --base；只查看已有结果请用 --status');

const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    console.error(`收到 ${signal}，保存当前覆盖树后退出`);
    controller.abort();
  });
}

console.error(`开始采集 ${options.base} → ${path.resolve(options.directory)}` +
  (options.budget === undefined ? '（沿用已有预算或默认 64 次请求）' : `（预算 ${options.budget} 次请求）`));
// collect 会把中止视为可续跑的停止原因并落盘，而不是抛出。
const coverage = await collect({
  base: options.base,
  directory: options.directory,
  budget: options.budget,
  fresh: options.fresh,
  retries: options.retries,
  signal: controller.signal,
});
verify(coverage);
console.log(JSON.stringify(summary(coverage), null, 2));

// 退出码：0=已证明完整；2=未证明完整但可续跑；3=快照失效需重新开始一代。
if (coverage.complete) process.exit(0);
if (coverage.snapshotValid === false) process.exit(3);
process.exit(2);
