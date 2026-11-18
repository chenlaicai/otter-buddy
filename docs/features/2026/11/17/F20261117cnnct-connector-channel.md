---
title: connector 通道与会话层（阶段 4 C1）
id: F20261117cnnct
date: 2026-11-17
module: session
change_type: feature
summary: |
  落实 #1868 阶段 4 C1（connector 通道与会话层）：devices/online_sessions/pairing_codes
  三表（每 device 至多一 online 行的 partial unique index 库层兜底）+ 配对全链（一次性码
  原子核销/撤销即 token 失效）+ WSS 网关（upgrade 阶段 Bearer 鉴权拒升级 + 协议 v1
  hello/heartbeat/offline + sid 会话代际旧帧丢弃 + 先库后内存 fail-closed + 心跳 90s
  判死 + 启动清扫 hub-restart）+ Registry unregister/replace 顶替语义 + connector
  独立进程入口（tsconfig.connector.json 独立构建 + 依赖闭包硬断言）。B1 依赖搬家前置
  （otterInvokeStorage 抽独立小模块）。执行通道（action.request/result）归 C2。
intent:
  problem: "恢复链与执行机抽象就绪后，远程执行缺通道与会话基础设施——设备身份、执行授权会话、传输协议都无从谈起；execution 侧公共执行器抽包被 model-runtime-registry 的 agent 全家桶依赖阻塞"
  expected_effect: "connector demo 进程可配对、握手上线（Registry list 可见）、心跳保活、主动下线（库表 offline + 投影注销）；未配对/错 token 在 upgrade 阶段被拒；旧会话代际帧一律丢弃；中枢重启后 stale online 行被清扫"
  verify_by:
    type: behavior_check
    evidence:
      - "tests/frameworks/execution/connector-ws-gateway.test.ts：协议状态机端到端（鉴权拒/上线投影/旧 sid 丢弃/下线收尾/重连新会话）"
      - "tests/usecases/execution/connector-registry-repo.test.ts：库层三态（核销/顶替/唯一索引/幂等/清扫）"
      - "npm run build:connector：构建闭包硬断言零违禁节点"
capability_test: "tests/frameworks/execution/connector-ws-gateway.test.ts"
---

# F20261117cnnct：connector 通道与会话层（阶段 4 C1）

## 背景

#1868 阶段 4 第一切片。方案 v3（stage4-connector-plan.md，经 dspro+kimi 双体检视
17 条意见全吸收 + 搭档裁决「按功能做、不往后甩」四项修正）：本 PR 承载通道与会话；
执行通道（RemoteExecutionMachine/remote_action_requests/动作幂等）归 C2；下线总闸
在途动作收尾归 C3。

## 交付

### B1 依赖搬家（纯移动，前置）

`OtterInvokeContext` + `otterInvokeStorage` 自 model-runtime-registry 抽至
`entities/execution/otter-invoke-context.ts`（纯 AsyncLocalStorage + contract 类型）；
registry 转发导出（agent 侧 5 个既有 import 点零改动）；execution 侧两文件直连新模块
——公共执行器抽包（C2 给 connector 复用）闭包从此干净。定向 40 测试不变。

### 数据层（三表 + repo）

- `devices`：配对身份（pair_token 唯一）；撤销 = 删行级联清除会话史（身份+token+会话
  同灭；动作审计归 C2 remote_action_requests）
- `online_sessions`：执行授权会话——总闸唯一事实源；**partial unique index**
  `ON (device_id) WHERE status='online'`（每 device 至多一 online 行，绕过应用层的
  并发双上线被库层拒绝）；disconnect_reason 枚举四值
- `pairing_codes`：一次性码（原子核销：时效内未核销才 UPDATE 命中；过期/重放/不存在
  统一 false——防探测不区分原因）
- repo 语义：顶替上线（事务先关旧行再插新行）、幂等下线（先到 reason 不被改写）、
  `sweepStaleOnlineSessions`（启动清扫）

### WSS 网关（ConnectorWsGateway）

- **upgrade 阶段 Bearer 鉴权**（搭档裁决「不往后甩」）：缺 token/错 token/已撤销
  → 401 拒升级；对 token 放行并把设备身份挂 request 上下文
- 协议 v1：`hello`（版本区间）→ 取交集最高、无交集拒连（error/version + 关通道）→
  `hello.ack` 下发 **sid 会话代际**；此后所有帧必带正确 sid——旧 sid 帧静默丢弃 +
  计数（模块 C 红线「重连≠恢复」的实现依据）
- 心跳：15s 间隔（connector 侧）/ 90s 判死（中枢侧扫描，容忍 3 间隔+抖动）
- 上下线状态机：**先库后内存**（库写失败 fail-closed 关通道，宁误下线不误放行）；
  上线 Registry.replace 投影（C1 占位 ConnectorMachineProjection，run 抛「C2 落地」）；
  下线（offline 帧/断线/停服）库表落 offline + reason + 投影注销 + 通道关
- 启动清扫：所有 online 行落 offline/hub-restart（bootstrap 装配时 await）

### 配对全链

- CLI `scripts/connector-pair.mjs`：生成一次性码（8 位去混淆字母表，10 分钟有效）/
  列设备 / 撤销（--unpair）
- HTTP `POST /api/connector/pair`（码即秘密，无登录态——connector 无浏览器）：
  原子核销 → 建设备 → 返 deviceId + pairToken
- connector 首启 `--pair <码> --name <名>`：HTTP 换 token 存 `~/.otter/connector/device.json`
  → 之后凭 token WSS 连接

### Registry 扩展

`unregister`（幂等——总闸撤栅栏内存侧）+ `replace`（顶替语义：设备重上线投影刷新，
原子化避免注销-注册窗口）。

### connector 独立进程

`src/connector/main.ts` + `tsconfig.connector.json`（独立构建入口）+ 
`scripts/check-connector-closure.mjs`（产物 import 图硬断言：零 agent/llm/embedding/
memory/pi-ai 节点 + 相对路径逃逸检查）+ `npm run build:connector`（tsc → tsc-alias →
闭包断言）挂进 check 聚合。C1 客户端：配对/连接/hello/心跳/SIGINT 主动 offline。

### 装配

app.ts：repo → gateway（占位投影工厂）→ 启动清扫 → pairController 挂 plumbing；
BuiltApp.connectorGateway 字段（dispose 链 hub-restart 收尾）；server.ts listen()
可选 WsUpgradeHandler（同端口 upgrade，非 connector 路径销毁）；main.ts 接线。

## 设计取舍

| 取舍 | 决策 | 被否替代 | 理由 |
|---|---|---|---|
| upgrade 鉴权时机 | upgrade 阶段 Bearer 校验拒升级 | 裸 upgrade + hello 帧验 token | 搭档裁决「按功能做」——鉴权是协议设计不是部署强化；未认证连接不应消耗 hello 状态机 |
| 总闸事实源 | online_sessions 表唯一事实源，Registry 投影缓存，先库后内存 | 内存为主定期落库 | 库写失败收敛 fail-closed（宁误下线不误放行）；双状态源不一致窗口消除（dspro S1） |
| sid 会话代际 | hello.ack 下发，旧 sid 帧静默丢弃+计数 | 时间戳判定 | 显式代际无歧义；模块 C「晚到回执不恢复执行」的帧级依据（dspro P1） |
| 设备撤销 | CASCADE 级联清除会话史 | 保留会话史 | 动作审计归 C2 remote_action_requests（真正需要追溯的执行记录）；会话史随身份同灭=干净撤销 |
| 配对码安全 | 一次性+时效+原子核销，不区分拒绝原因 | 区分原因返回 | 防探测；本机阶段码即秘密（TLS 证书属阶段 6 部署切换功能——依赖域名/签发环境） |
| connector 构建 | 同仓 tsconfig project 隔离 + 闭包硬断言 | npm workspaces 独立包 | issue「独立进程/包」实质=独立构建产物+依赖图受控；workspaces 是分发形态（阶段 6） |

## 机制识别检查点

- 新增持久化存储：是（三表，schema.ts 单点登记 #506 幂等）
- 新增状态生命周期：是（pairing code 待核销→已核销；session online→offline 四种 reason）
- 新增信号/消息格式：是（WSS 协议 v1 帧类型）
- 新增决策分支：是（upgrade 鉴权/版本协商/sid 校验/上下线状态机）
- 新增跨模块路径：是（WSS 网关 ↔ repo ↔ Registry 投影；main.ts ↔ gateway）

结论：修法决策树②既有机制内扩展（执行机 Registry 复用 + DDD 分层内新增网关），传输层为新机制（协议设计从零，issue 阶段 4 明确要求）。

## 验收标准

| 场景 | 预期 |
|---|---|
| 未配对/错 token 连接 | upgrade 401 拒升级（不进 hello） |
| 配对码过期/重放 | 核销 false → HTTP 403（不区分原因） |
| 配对成功 | 一次性核销 + devices 行 + token 返回 |
| hello 版本协商 | 交集最高选定；无交集 error/version + 关通道 |
| 上线 | 库表 online（唯一事实源）+ Registry list 可见 + sid 下发 |
| 心跳 | ack + last_seen 前移；90s 无心跳判断开 |
| 旧 sid 帧 | 静默丢弃 + 计数（正确 sid 不受影响） |
| 主动下线 | offline 帧 → 库 offline/device-offline + 投影注销 + 通道关 |
| 断线 | socket 断 → heartbeat-timeout 收尾 + 投影注销 |
| 重连 | 新 sid 新会话；旧会话行 offline |
| 顶替上线 | 旧 online 行落 offline/device-offline |
| 并发双上线（绕过事务） | partial unique index 库层拒绝 |
| 启动清扫 | 残留 online 行落 offline/hub-restart（幂等） |
| connector 产物闭包 | 零 agent/llm/embedding/memory 节点（build:connector 硬断言） |
| 本机行为不变 | 全量回归全绿（local 机器与恢复链零改动） |

## Verification

| 验证 | 结果 |
|---|---|
| `npx tsc --noEmit` | PASS |
| repo/Registry 单测（connector-registry-repo） | PASS：10 用例（核销三态/顶替/唯一索引/幂等下线/撤销级联/清扫幂等/unregister/replace） |
| 网关端到端（connector-ws-gateway，真 http+ws 双端） | PASS：8 用例（鉴权拒/上线投影/版本拒/心跳/旧 sid 丢弃/主动下线/断线收尾/重连新会话） |
| `npm run build:connector` | PASS：tsc → tsc-alias → 闭包断言（import 图零违禁+无逃逸） |
| `npm run check` | PASS（check 聚合已挂 build:connector） |
| `npm test` | 全量回归（local 机器与恢复链零改动） |
| alpha 实启端到端（hub :3114 + 独立 connector 进程） | PASS：配对全链（码核销/devices/token）/WSS 上线（sid+库行+中枢日志）/心跳（last_seen 持续前移）/SIGTERM 主动下线（库 offline/device-offline；竞态时 close 兜底 heartbeat-timeout）/断线自动重连（新会话顶替旧行）——证据见 PR comment |
| GitHub CI | PR 创建后运行（见 PR checks） |

## Rollback

Revert 本 PR：三表为新增表（无既有数据依赖，留存无害）；WSS 端点/listen upgrade
参数移除后无升级请求路径；B1 搬家可独立保留（纯搬家无行为变化）。connector 进程
为独立产物，删除 dist/connector + scripts 即可。
