# akari-panel/proto — 控制协议正本

`agent.proto`（package `akari.v1`）是面板↔agent 的**唯一**契约正本；akari-agent 保存 vendor 副本。

改契约流程：
1. 只在这里改，保持 proto3 向后兼容（新增字段用新编号，不复用、不改类型）。
2. `cargo build`（build.rs 用 protox 重新生成 Rust 绑定）。
3. `make -C ../akari-agent sync-proto`（拷贝 + `buf generate`），再 `check-proto` 确认无漂移。
4. 两侧代码一起改，跑 `make smoke`。

语义要点：
- `Hello.session_id` 应在 agent 计数器重置（xray 实例重建）后更新；面板用它重置流量基线。**目前 agent 重建后不会重发 Hello**（见 REVIEW）。
- `ConfigSnapshot` 是完整期望状态；`UserDelta` 已定义但面板从未发送。
- gRPC 方法名不可叫 `Connect`（与 tonic 客户端构造函数撞名）。
