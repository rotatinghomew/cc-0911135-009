# 业务演练

全部演练由 `npm run drill` 在本地源端真实发请求完成，输出到 `var/drill/`。
每个场景都调用 `lib/verify.mjs`，结论必须与每个叶子的证据一致。

| 情景 | 查询约束 | 实测结论 |
|---|---|---|
| 截断 | 默认 cap=3 | 200 且 `truncated=true` 不算完整；自动按空间/时间继续拆分 |
| 边界点 | 坐标 0、2、4，时间 0..4 | 闭区间拆分让分界线上的记录同时命中两子区，按 id 去重后一条不漏 |
| 足够容量 | cap=30 | `/snapshot` + 1 次 `/query` 即 `truncated=false`，23 条唯一记录，`complete=true` |
| 密集热点 | 默认 cap，五条同空间同时间 | 到 0.25 / 1 秒最小粒度仍截断，8 个热点叶子标 `incomplete`，整体结论不完整 |
| 预算不足 | budget=20 | 用满 20 次即停；树里保留 6 个 complete、6 个 pending、1 个 incomplete；不发第 21 次 |
| 中断 | SIGINT/SIGTERM 或 AbortSignal | `stopReason=aborted`，覆盖树已落盘，可按同一快照续跑 |
| 快照过期 | `/_control {generation:2}` | 旧代 `snapshotValid=false`、`stopReason=snapshot-expired`，拒绝同文件续跑，`--fresh` 才进入 plot-2 |
| 证明篡误 | 任一截断叶子标 complete | `lib/verify.mjs` 拒绝；`npm run verify` 返回非零 |

## 演练实测摘要

来自 `var/drill/summary.json`（`npm run drill` 生成）：

| 场景 | complete | requestsUsed | 唯一记录 | 叶子 complete/incomplete/pending/blocked |
|---|---|---|---|---|
| 默认 cap=3 | false | 120 | 18 | 52 / 8 / 0 / 0 |
| cap=30 | true | 2 | 23 | 1 / 0 / 0 / 0 |
| 预算 20（首轮） | false | 20 | 2 | 6 / 1 / 6 / 0 |
| 预算 20 → 续跑 400 | false | 120 | 18 | 52 / 8 / 0 / 0 |
| 快照失效 | false | 26 | 2 | 8 / 1 / 6 / 1 |
| 新代 `--fresh` | false（预算 40 用尽） | 40 | 3 | 15 / 3 / 4 / 0 |

说明：

- 默认 cap 下 23 条数据里的 5 条同日同秒热点无法被任何查询装下，因此
  `complete` 只能为 false；普通 18 条全部入账。8 个 `incomplete` 叶子是
  同一热点在相邻格子的重叠命中——闭区间拆分让热点落在 8 个最小粒度
  格子的交叠处，每个格子都仍截断，因此都被如实标记。
- 续跑首轮已完成 6 个叶子，证据（含 `queriedAt`、`requests`、`attempts`）
  在第二轮保持不变，第二轮只发出 100 次 `/query`（首轮已完成的边界不会
  再次出现在查询审计里）。
- 快照失效发生在续跑第一次 `/query`；此后不再发请求，树中已有 complete
  叶子保留为旧代证据，但整体 `complete=false`、`snapshotValid=false`。
- 新代 `--fresh` 会重新取 `/snapshot` 得到 `plot-2`，旧代的 `coverage.json`
  被新树替换；`plot-1` 的记录不会进入 `plot-2` 的完整性声明。
- 预算 40 的新代演练本身没有跑完，因此同样 `complete=false`——演练证明
  的是“新快照下重新开始一代”，不是“换快照后立刻完整”。

