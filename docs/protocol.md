GET /snapshot 获取快照、domain、cap、minSpatial 和 minTemporal。查询 /query?xmin=...&xmax=...&ymin=...&ymax=...&from=...&until=... 必须传 X-Snapshot。所有上下界均包含，时间为整数秒，空间坐标精度下限 0.25。空区间不允许。响应 truncated 表示真正截断，lowerBound 仅给记录数下界，不能当总数使用。仅有 HTTP 200 或恰好达到 cap 不能证明完整。

POST /_control {"generation":2} 使旧快照失效，旧请求返回 409；cap 可改为较大值以演练足够容量的源。数据含边界点及空间时间完全重合的热点，热点在默认 cap 下不可继续分解，必须报告不完整。预算计入 /snapshot 与 /query 的每次尝试，不含演练准备控制请求。

coverage.json 含 snapshot、budget、requestsUsed、complete、records、tree。tree 节点包含 bounds、snapshot、status、children；叶子 evidence.truncated=false 才能完成，非叶完成要求所有孩子完成。状态 incomplete/pending/blocked 均不能支持整体 complete。
