# 项目规则

## 开工前

- 调用 `agent-memory` skill 读取与当前任务相关的开发记忆。
- 调用 `agent-docs` skill 建立与当前任务相关的项目文档上下文。

## 开发收尾

- 派 `memory-writer` 子代理沉淀值得长期保留的开发记忆。
- 需要写或修改产品文档与项目地图时，派 `doc-writer` 子代理维护。
