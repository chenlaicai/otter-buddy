# 真 LLM 非劣证据

此目录只存放 `compare-capability-live.mjs` 生成的自包含 comparison JSON。PR 中的
`真 LLM: PASS` 必须引用其中文件；`check-capability-change.mjs` 会内嵌重算两侧 run，
并校验当前 HEAD、merge-base、协议与场景结论。手写 `outcome: PASS` 或改动原始计数会红。

## 边界

仓库当前没有真 LLM GitHub Actions secret。证据由本地运行器生成，包含日志/Vitest JSON
哈希、源码与 harness 指纹、模型配置指纹，但**本地 JSON 并非不可伪造**。独立审视必须
核对原始日志和 `attempts.jsonl` 是否包含全部尝试；机器闸负责结构、可比性、预注册轮数
和统计重算，无法发现运行者另行藏匿的目录，真实性不能由 PR 文本自证。

原始日志包含模型回复，默认留在工作区/运行证据目录，不提交仓库。comparison 只含聚合计数，
不包含 API key 或完整回复。
