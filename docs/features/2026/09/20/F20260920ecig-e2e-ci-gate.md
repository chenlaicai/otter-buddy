---
id: F20260920ecig
title: e2e 冒烟进 CI 闸门
summary: SPA e2e 测试从「手动跑、截图硬编码」升级为「CI 拦合入、产物进 artifact」——新增 playwright.config 单一真相源、scripts/e2e-server.sh 冒烟流水线（CI/本地同构）、config.e2e.yaml 零机密占位服务配置；两个 spec 脱硬编码（相对 URL + testInfo.outputPath）。直接动因：#1057 四轮对抗循环三次实证「静态检查绿 ≠ 运行时没崩」（D1 TS 编译过但设置页白屏、D3 断言改了但恒假），真机验证必须进 CI。
change_type: feature
capability_test: "n/a: 纯 CI/测试基建，无运行时代码变更（golden gate 无对应场景）"
created_in_conversation: 2006bca9-d162-40b6-b8e1-11ec3807300d
tags: [ci, e2e, playwright, web, testing, infra]
modules: [".github/workflows/ci.yml", "web/playwright.config.ts", "web/e2e/spa-verification.spec.ts", "web/e2e/spa-screenshot-verification.spec.ts", "scripts/e2e-server.sh", "config/config.e2e.yaml", ".gitignore"]
causal_links:
  - "#1058（issue：e2e 无 CI 闸门 + 截图路径硬编码）"
  - "from F20260920spag（SPA 全量化主 PR #1057，对抗循环暴露的方法学缺口由本特性补）"
created_at: 2026-09-20
---

# e2e 冒烟进 CI 闸门（F20260920ecig）

## 背景

PR #1057（Web 全量 SPA 化）四轮对抗循环中三次踩中同一类坑——**静态证据链 ≠ 运行时事实**：

| 事件 | 静态证据 | 运行时事实 |
|------|----------|------------|
| S3/D1 | useBlocker 修复后 TypeScript 编译通过 | 组件式 BrowserRouter 下 `useBlocker must be used within a data router` throw，点设置 tab = SPA 白屏 |
| D3 | e2e 断言升级为 elementHandle identity（代码存在） | `toBe` 比较 Node 侧包装对象恒假——断言在任何健康应用上都红，但 e2e 从未跑过所以无人知 |

根因：e2e 测试无 CI 闸门（改坏要等下一次手动跑才暴露）+ 截图路径硬编码对话工作区（换环境失效、不可复现）。issue #1058 立项，搭档拍板提 P1 趁热开工。

## 设计取舍

### 机制识别检查点判定

本特性为修法排序④新增机制（CI 新增 e2e job——此前不存在任何 e2e 自动化闸门），四问：

1. **新增了什么机制？** CI e2e 冒烟 job：起极简服务实例 → Playwright 真机跑 17 用例 → 截图进 artifact。基础设施机制，非业务机制。
2. **为什么不能在既有语义内修？** 此前 e2e 完全游离于 CI 之外，没有「既有语义」可修——check job 只跑单测/构建，真机路径零覆盖。
3. **更小代价替代？** 曾考虑只加 playwright.config 不进 CI（零 CI 成本）——被否：D3 恰恰证明「测试存在但不跑」等于不存在，闸门必须在合入路径上。
4. **后续机制？** 无后续依赖。e2e job 独立于 check/golden-selftest，互不阻塞；失败即拦合入。

### 关键决策

**① CI/本地完全同构（`scripts/e2e-server.sh run` 一条命令）**
CI 步骤与本地命令是同一入口：start（构建+起服务+等健康）→ playwright → stop（trap 保证失败路径也清理）。避免「CI 一套逻辑、本地另一套」的漂移。

**② 极简占位服务（`config/config.e2e.yaml`，入库零机密）**
e2e 冒烟只验证 SPA 路由/静态资源/前端渲染，不跑 agent/LLM 路径。两个关键配置发现：
- **embedding 模型缺失不阻塞启动**（`src/bootstrap/database.ts` 的 `ensureBgeM3Model` 失败走 FTS-only 降级）——CI 无需下载 1.2GB bge-m3，冷启动 <10s
- **LLM 占位必须走自定义 provider 路径**（`apiBaseUrl: http://127.0.0.1:9` 触发 `needsCustomProvider`）——默认 openai 工厂用内置白名单（OPENAI_MODELS），假模型名会 `LLM model not found` 启动即炸（实测踩过）；自定义路径任意 model id 可注册且启动时不连远端

**③ 端口 3199**：3100-3198 偶数段是 alpha.sh 专属（scripts/alpha.sh 端口宪法），取段外尾数避免冲突。

**④ 截图产物**：`testInfo.outputPath()` → playwright outputDir（`web/test-results/`，gitignore）→ CI 上传 artifact（保留 7 天）。彻底移除对话工作区绝对路径依赖。

### 踩坑记录（负面向验收：本次变更绕过了什么/破坏了什么旧约定）

- **bash 3.2（macOS 自带）在 echo 混合文本上下文里解析嵌套命令替换失败**：`echo "...(pid $(cat "${F}"))..."` 语法解析报 `unexpected EOF while looking for matching`（CI 的 ubuntu bash 5 没问题但本地直接跑不了）。注意边界：`pid="$(cat "${X}")"` 赋值上下文的同款嵌套在 bash 3.2 是**合法的**（复核獭实测纠正），触发条件是命令替换嵌在「双引号字符串 + 周围有字面文本」的 echo 上下文。修复：先取值再插值（`running_pid=...; echo "... ${running_pid}"`），两种上下文都稳。
- **相对路径在 `cd web` 后漂移**（实测孤儿进程根因）：cmd_run 里 `cd web` 跑 playwright，EXIT trap 触发 cmd_stop 时 `./data/e2e/server.pid` 解析到 `web/data/e2e/` 下——pid 文件找不到 → 跳过 kill → 服务孤儿 + 数据残留。修复：所有路径锚定 `REPO_ROOT="$(git rev-parse --show-toplevel)"`。守卫拦截组合杀进程时印证了「服务清理要走受控脚本」的既有约定。
- **破坏的旧约定**：e2e spec 原本依赖「跑测试前手动起 alpha 实例」的隐性前置——现在 config 自带 + 脚本自动起停，该隐性前置作废（alpha 实例仍可用于交互式验证，但 e2e 不再依赖它）。

## 改动清单

| 文件 | 类型 | 说明 |
|------|------|------|
| `web/playwright.config.ts` | 新增 | baseURL（env E2E_BASE_URL / 默认 alpha 端口）单一真相源、outputDir、CI 重试 |
| `web/e2e/spa-verification.spec.ts` | 修改 | goto 相对路径化，删除 BASE 常量 |
| `web/e2e/spa-screenshot-verification.spec.ts` | 修改 | 相对路径 + `testInfo.outputPath()`，删除对话工作区绝对路径 |
| `scripts/e2e-server.sh` | 新增 | start/stop/run 三命令；run=build→serve→playwright→清理（trap 兜底） |
| `config/config.e2e.yaml` | 新增 | 零机密占位服务配置（端口 3199、临时库、FTS-only、占位 LLM） |
| `.github/workflows/ci.yml` | 修改 | 新增 e2e job：装 chromium → `e2e-server.sh run` → 截图 artifact |
| `.gitignore` | 修改 | `data/e2e/`（运行时产物） |

## 验证

- **本地全链路**（`scripts/e2e-server.sh run`）：17/17 passed（7.8s），服务零孤儿（`ps`/`lsof :3199` 双确认）、`data/e2e/` 清理干净
- **孤儿修复专项**：bash -x 复现根因（cmd_stop 在 web/ cwd 下找不到 pid 文件）→ 锚定 REPO_ROOT 后连续两轮 run 零残留
- **回归**：web 单测 55 文件 498 用例全绿；`npm run check` 0 errors（7 warnings 为存量）
- **CI 验证**：PR 创建后 `gh run watch` 盯 e2e job 首跑（见 PR）
- 最简实现检查：已过——服务起停复用项目自身 `node dist/src/main.js --config`（无新服务代码）；playwright.config 只用官方配置面；未引入 mock server（真服务冒烟的证明力 > mock）

## 后续

- CI e2e job 首跑时长基线记录（预计 ~4-5min：npm ci × 2 + 构建 × 2 + 17 用例 ~8s）；若超预期再评估缓存优化
- 截图 artifact 保留期 7 天，按需调
