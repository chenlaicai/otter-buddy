
## 10. S4 补丁批（自检发现的偏差与遗漏修复）

自检（搭档令）对照设计文档/阻尼清单/会议裁决，发现 2 偏差 + 2 遗漏：

| 项 | 类型 | 修复 |
|----|------|------|
| 偏差1 | 设计文档 §2 核心语义未同步 S4a 判据清零 | §2 更新为最终版（无 sender 类型特例） |
| 偏差2 | S1 承诺的观测端点缺失 | GET /api/conversations/:id/pending-count（裸探针，机器可读） |
| 遗漏1 | 阻尼#4 dissolve 事务销账未做 | DissolveOtter 可选 deps settlePendingForOtter → failAllInProgressForOtter |
| 遗漏2 | 阻尼#5 yield 未解析墓碑未做 | 拆出（依赖 yield 写入路径改造，独立 PR——见 §11） |

## 11. 阻尼#5 拆出说明

yield 未解析目标（点名不存在的獭）写「跳过」墓碑——需改 yield 工具的写入路径
（tool-factory），与 dissolve 销账（otter 生命周期路径）是不同面。当前被
pendingClause 的 dissolved 过滤罩住（哑火侧安全），拆出独立排期不阻塞本批。
