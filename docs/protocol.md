# 服务端协议与覆盖结果约定

## 快照

`GET /snapshot` 返回：

```json
{
  "snapshot": "plot-1",
  "domain": { "xmin": 0, "xmax": 4, "ymin": 0, "ymax": 4, "from": 0, "until": 4 },
  "cap": 3,
  "minSpatial": 0.25,
  "minTemporal": 1
}
```

`cap` 是单次查询最多返回的记录数。`minSpatial` / `minTemporal` 是允许继续
拆分的最小粒度：空间坐标以 0.25 为步长，时间为整数秒。

## 查询

`GET /query?xmin=...&xmax=...&ymin=...&ymax=...&from=...&until=...`，必须带
`X-Snapshot: <snapshot>`。

- **所有上下界都包含**（`record.x >= xmin && record.x <= xmax`，时间同理）。
- 空区间（`xmin > xmax` 等）不允许。
- 响应：

```json
{
  "snapshot": "plot-1",
  "bounds": { "xmin": 0, "xmax": 4, "ymin": 0, "ymax": 4, "from": 0, "until": 4 },
  "records": [ ... ],
  "truncated": true,
  "lowerBound": 4
}
```

`truncated=true` 表示结果被服务端截断，`records` 只是任意前缀；`lowerBound`
只是该区间记录数的下界，不能当总数。HTTP 200 或恰好 `cap` 条都不代表完整，
必须看 `truncated`。

## 演练控制（仅本地沙箱）

`POST /_control {"generation":2}`：切换到新快照代，旧快照请求返回 409。

`POST /_control {"cap":30}`：调整单次结果上限，用于演练容量充足的源。

控制请求不计入采集预算。

## 预算

预算按**实际 HTTP 尝试次数**计：`/snapshot` 与每次 `/query` 都算，重试也算。
演练准备用的 `/_control` 不算。

## coverage.json 结构

```json
{
  "version": 1,
  "snapshot": "plot-1",
  "snapshotInfo": { "snapshot": "plot-1", "cap": 3, "domain": { ... }, "minSpatial": 0.25, "minTemporal": 1 },
  "strategy": { "dimensionSelection": "largest-normalized-span", "boundary": "closed-intervals-shared-boundary-with-id-dedup", "order": [...] },
  "budget": 64,
  "requestsUsed": 40,
  "complete": false,
  "claimedComplete": false,
  "snapshotValid": true,
  "stopReason": "incomplete",
  "stopDetail": { ... },
  "failures": [ { "node": "...", "status": "incomplete", "code": "hotspot-unresolvable", "bounds": { ... }, "detail": "..." } ],
  "leafCounts": { "total": 60, "complete": 52, "pending": 0, "incomplete": 8, "blocked": 0 },
  "records": [ { "id": "OBS-00", "x": 0, "y": 0, "time": 0, "value": 0.1 } ],
  "leaves": [ { "path": [0, 0], "id": "root.0.0", "snapshot": "plot-1", "bounds": { ... }, "status": "complete", "split": null, "evidence": { ... } } ],
  "tree": {
    "id": "root",
    "snapshot": "plot-1",
    "bounds": { ... },
    "status": "split",
    "split": { "dimension": "spatialX", "candidates": [ { "dimension": "spatialX", "steps": 16 } ], "at": "..." },
    "evidence": { "queried": true, "truncated": true, "returned": 3, "lowerBound": 4, "attempts": 1, "requests": 1 },
    "children": [ ... ]
  }
}
```

树节点字段：

| 字段 | 含义 |
|---|---|
| `bounds` | 查询矩形，闭区间 |
| `snapshot` | 该节点查询所用快照，必须与顶层一致 |
| `status` | `pending` / `split` / `complete` / `incomplete` / `blocked` |
| `split` | 拆分维度、候选评分、原因；叶子为 `null` |
| `evidence` | `queried`、`truncated`、`returned`、`lowerBound`、`attempts`、`requests`、`addedRecords`、`reason`、`detail` |
| `children` | 子节点；无孩子即为叶子 |

完整性规则：

- 叶子 `complete` 要求 `evidence.truncated === false`。
- 非叶 `complete` 要求所有孩子 `complete`。
- `incomplete`（到最小粒度仍截断）、`pending`（预算/中止）、`blocked`
  （请求失败或快照失效）都不能支持整体 `complete`。
- 整体 `complete` 还要求 `snapshotValid === true` 且 `claimedComplete === complete`。

## 失败原因代码

| code | 含义 | 可否同快照续跑 |
|---|---|---|
| `budget-exhausted` | 实际请求预算耗尽 | 可以，pending 叶子保留 |
| `aborted` | 用户 SIGINT/SIGTERM | 可以 |
| `snapshot-expired` | 409，旧快照被拒绝 | 不可以，需新的一代 |
| `snapshot-mismatch` | 响应快照与请求不一致 | 不可以 |
| `http-status` | 非 200/409 的 HTTP 错误 | 可以重试该叶子 |
| `transport` | 网络/超时 | 可以重试该叶子 |
| `hotspot-unresolvable` | 最小粒度仍截断 | 不可消除，完整性必须为 false |
