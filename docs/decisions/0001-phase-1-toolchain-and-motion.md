# Phase 1 工具链与交互动效选择

- 状态：`accepted`
- 日期：2026-07-27
- 适用范围：Phase 1 工程脚手架与质量门禁

## 背景

Phase 1 需要建立可在 Windows 运行的 Tauri 2 + React 19 + TypeScript + Vite 最小工作区，锁定工具链，配置主题、shadcn/ui、路径别名和交互 spike，并提供统一质量命令。当前阶段不得加入真实 Provider、SQLite schema、网络传输或聊天业务。

## 决定

- Node.js 锁定为 `24.18.0`，pnpm 锁定为 `11.9.0`。
- Rust 锁定为 `1.97.1`，包含 `rustfmt` 与 `clippy`。
- Tauri 直接 crate 锁定为 `2.11.5`，Tauri CLI 锁定为 `2.11.4`。
- React 锁定为 `19.2.8`，TypeScript 使用与当前 lint 工具兼容的 `5.9.3`，Vite 锁定为 `8.1.5`。
- 采用 Motion `12.42.2` 完成右侧 sheet 的可中断 spring、拖拽关闭、速度投影和 reduced-motion 等价路径。
- `DesktopBridge` 在 Phase 1 保持泛型平台端口，避免提前锁定 Phase 2 的 `PipeRequest` / `PipeEvent` 线协议；当前只提供 fake，不调用 Tauri IPC。
- 根工作区只建立实际使用的职责目录，不为未来功能预建空文件。

## 备选方案

- 只用 CSS transition：无法在拖拽过程中连续接管并保留速度，不满足已确认的可中断交互要求。
- 手写完整 spring 求解器：Phase 1 没有足够收益，测试和维护成本高于小型成熟依赖。
- 在 Phase 1 定义完整流式请求类型：会抢占 Phase 2 的线协议设计，并扩大当前改动范围。

## 影响

- Windows 本地构建需要 WebView2、Rustup 和 Visual Studio Build Tools 的 MSVC C++ 工作负载；VS Code 仍只是编辑器，不替代编译器和 Windows SDK。
- Motion 进入初始前端包，因此增加了初始 bundle；`pnpm test:performance` 对 JavaScript/CSS 原始大小和 gzip 大小建立初始门禁。
- Eternal Chat 自身许可证仍未决定；本决定不添加或宣称项目许可证。

## Cherry 参考与差异

- 实际读取：`docs/references/architecture-overview.md`、`main-process-architecture.md`、`renderer-architecture.md`、`shared-layer-architecture.md`、`ui-semantic-contract.md`、`guides/test-plan.md`。
- 共同契约：明确职责边界、依赖方向、稳定 `data-ui` / `data-slot`、测试从语义边界和无障碍角色定位。
- Eternal Chat 差异：使用 Tauri + 小型 `DesktopBridge`，不采用 Electron 主进程、IoC、自动 DOM token 推断、Cherry 业务模块或发布分支制度。
- 本次采用：显式语义 token、最小目录、平台边界 fake 和行为级质量门禁。
- 本次拒绝或后续：AI 主链、数据层、stream manager、Provider 与消息树均按后续 Phase 处理。
- 在线状态：本次未引入新的 Cherry 在线结论；沿用项目基线于 2026-07-27 记录的在线 `main` 核对状态。

## 验证

- `pnpm verify`
- `pnpm tauri build --debug`
- Windows 真实窗口启动，验证 1280x800 与 900x700、light/dark、sheet 拖拽和 reduced motion。
