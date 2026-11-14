# plot-coverage-planner

田间观测 API 的覆盖采集器。给定空间矩形与时间段，它用一个固定快照递归
拆分查询，只把 `truncated=false` 的叶子当作完整证据，并输出可审计的
`coverage.json` 与去重记录。超出服务端上限时自动在空间与时间之间选择
拆分轴；到最小粒度仍截断的热点会明确列为不可证明完整。

## 环境与命令

Node.js 22.23.4，依赖使用 package-lock.json 固定。准备阶段运行 `npm ci`。

```bash
npm start              # 启动本地源端（打印监听地址），另一个终端执行下面的命令
npm run collect -- --base http://127.0.0.1:端口 --budget 64
npm run collect -- --out var/coverage --status   # 只读取并校验已有结果，不发请求
npm run verify -- var/coverage/coverage.json     # 校验业务不变量
npm test               # 源端协议 + 覆盖采集、拆分、去重、续跑、快照失效
npm run demo           # 对本地源端打印一次快照与查询响应
npm run drill          # 边界点/热点/预算/续跑/快照失效完整演练（var/drill）
npm run build          # 全部模块语法检查
```

采集器默认续跑：若输出目录已有同一快照的 `coverage.json`，只查询
`pending` 叶子，已完成叶子不会重查。`--fresh` 忽略旧结果并按当前源端代
重新开始。

## 协议要点（详见 docs/protocol.md）

- `GET /snapshot` 返回 `snapshot`、`domain`、`cap`、`minSpatial`、`minTemporal`。
- `GET /query?...` 必须带 `X-Snapshot`；**所有上下界均包含**，时间为整数秒，
  空间坐标精度下限 0.25。
- `truncated=true` 表示响应只是任意前缀，`lowerBound` 只是记录数下界。
  HTTP 200、恰好 `cap` 条都不能证明完整。
- 旧快照返回 409；预算计入 `/snapshot` 与 `/query` 的**每次实际尝试**，含重试。

## 采集策略

1. 取一次快照，记录 `cap`、最小空间/时间粒度。
2. 查询根矩形。未截断 -> 该叶子 complete；截断且仍可拆 -> 拆分。
3. 拆分维度按“最小精度归一化跨度”选择（`largest-normalized-span`）：
   4×4 域、0.25 最小空间精度是 16 步，4 秒、1 秒粒度是 4 步，因此先拆
   空间；某轴到最小粒度后自动只用其余轴。每个节点的候选步数写入
   `tree.split.candidates`，便于解释。
4. **闭区间拆分**：`[lo, hi]` 拆成 `[lo, mid]` 与 `[mid, hi]`，中点同时属于
   两个孩子。分界线上的记录会在两个子区重复出现，按 `record.id` 去重，
   只入账一次；不会因半开区间漏点。`duplicateRecords` 记录被去重的命中数。
5. 每组拆分都保证孩子宽度不低于最小精度；空间/时间都到最小粒度仍截断时，
   该叶子标 `incomplete`，`split.reason=at-minimum-precision`，
   `evidence.reason=min-granularity-truncated`，并汇总到 `failures`。
6. 截断响应中的记录**不入账**（它们只是服务端排序后的前缀）。只有未截断
   响应才进入 `records`。
7. 遇到 409 或响应快照不一致：立即停止，`snapshotValid=false`，
   `stopReason=snapshot-expired|snapshot-mismatch`，该代不再声明完整；
   同一文件拒绝续跑，需 `--fresh` 重新开始一代，不会把新快照数据拼进来。

### 持久化与恢复

- 每次实际 HTTP 尝试**发请求前**先增加 `requestsUsed` 并原子写
  `coverage.json`（临时文件 + rename），所以预算耗尽、Ctrl-C、进程被杀后
  磁盘状态都不超记或少记请求。
- `coverage.json` 的 `leaves[]` 是扁平索引，与 `tree` 中每个叶子的
  `status`、`evidence` 完全一致；`leafCounts` 汇总 complete/pending/
  incomplete/blocked。
- 续跑只发 `pending` 查询；`blocked` 叶子在续跑时重置为 `pending` 重试，
  上一次失败原因保留在 `evidence.previousFailure`。
- `budget` 是本次运行的总上限（含 `/snapshot`），续跑时若不传则沿用原值；
  新预算小于 `requestsUsed` 会被拒绝。

## 输出文件

| 文件 | 内容 |
|---|---|
| `coverage.json` | `snapshot`、`snapshotInfo`、`strategy`、`budget`、`requestsUsed`、`complete`、`claimedComplete`、`snapshotValid`、`stopReason`、`failures`、`records`、`leaves`、`tree` |
| `records.jsonl` | 去重后的观测记录，每行一条 |

`complete=true` 的充要条件（`lib/verify.mjs` 强制）：

- `snapshotValid=true`；
- `tree` 中所有节点使用同一 `snapshot`；
- 每个叶子 `status=complete` 且 `evidence.truncated=false`；
- 非叶 `complete` 要求所有孩子完成；
- `records[].id` 唯一，`claimedComplete === complete`；
- `requestsUsed <= budget`。

`pending`、`incomplete`、`blocked` 任一存在都不能支持整体 `complete`。

## 退出码（CLI）

| 退出码 | 含义 |
|---|---|
| 0 | 已证明完整 |
| 2 | 未证明完整，但可按同一快照续跑（预算不足/存在热点） |
| 3 | 快照失效，需 `--fresh` 开始新的一代 |

## 演练

`npm run drill` 在本地源端真实发请求，覆盖：

- 默认 `cap=3`：边界点 `x/y ∈ {0,4}`、`time ∈ {0,4}` 全部入账，热点在
  0.25/1 秒最小粒度仍截断，结论为不完整；
- `cap=30`：2 次请求证明完整，23 条唯一记录；
- 预算 20 -> 续跑到 400：第一轮已完成叶子证据不变，续跑只查剩余叶子；
- `generation=2`：该代完整性作废并拒绝同文件续跑，`--fresh` 才进入新代。

结果写入 `var/drill/summary.json` 与各场景的 `coverage.json`；每个场景都
经过 `lib/verify.mjs` 校验。`npm run demo` 只做一次协议查看。
