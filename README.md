# plot-coverage-planner

田间观测 API 的矩形时间查询客户端，服务端对每次结果设置硬上限。

## 环境与命令

Node.js 22.23.4，依赖使用 package-lock.json 固定。准备阶段运行 `npm ci`。


```bash
npm run build
npm test
npm run demo
npm start
```

`npm start` 输出本次监听地址，另一个终端可运行 `npm run probe -- http://127.0.0.1:端口`。服务只监听本机。`PORT` 可指定端口，Ctrl-C 结束。

`npm run build` 检查所有模块的 JavaScript 语法，无需生成打包文件；`npm test` 检查源端协议、正常及异常响应。

## 数据与运行边界

GET /snapshot 获取快照、domain、cap、minSpatial 和 minTemporal。查询 /query?xmin=...&xmax=...&ymin=...&ymax=...&from=...&until=... 必须传 X-Snapshot。所有上下界均包含，时间为整数秒，空间坐标精度下限 0.25。空区间不允许。响应 truncated 表示真正截断，lowerBound 仅给记录数下界，不能当总数使用。仅有 HTTP 200 或恰好达到 cap 不能证明完整。

POST /_control {"generation":2} 使旧快照失效，旧请求返回 409；cap 可改为较大值以演练足够容量的源。数据含边界点及空间时间完全重合的热点，热点在默认 cap 下不可继续分解，必须报告不完整。预算计入 /snapshot 与 /query 的每次尝试，不含演练准备控制请求。

coverage.json 含 snapshot、budget、requestsUsed、complete、records、tree。tree 节点包含 bounds、snapshot、status、children；叶子 evidence.truncated=false 才能完成，非叶完成要求所有孩子完成。状态 incomplete/pending/blocked 均不能支持整体 complete。

接口的完整字段及演练开关见 `docs/protocol.md`。业务编号均为合成值，不对应真实研究材料；服务没有外网依赖。`/_audit` 查看源端请求证据，`/_control` 只用于运行演练情景，不属于业务采集入口。

现有客户端只进行单次协议查看；尚不提供自动采集与持久运行调度。原始服务可单独运行，以便采集端在重启时保持源端状态。

## 数据校验

`npm run verify -- coverage.json` 检查本地结果的基本业务不变量，缺少文件时返回非零状态。该命令不生成采集结果，也不替代网络交互和恢复测试。`npm run demo` 在临时本地服务上真实发起请求并完整打印响应，随后退出。日常演练均不需要安装依赖或访问研究站。
