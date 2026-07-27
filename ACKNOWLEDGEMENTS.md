# 鸣谢与参考说明

Eternal Chat 计划以开源项目发布。本文记录对产品设计和工程判断产生直接帮助的参考项目，同时明确“借鉴思想”和“复制实现”的边界。

## NBSearch

特别感谢 `NBSearch-feat-tauri-migration` 项目及其作者/维护者提供的公开参考实现。它对 Eternal Chat 的以下设计产生了直接启发：

- Grok 长思考与网络搜索的流式展示。
- reasoning、tool usage、tool result、source、response id 和计时的结构化建模。
- 搜索查询、信源、引用和完成后历史详情的交互组织。
- 断流、恢复、pending message 和 response anchor 的工程思路。

Eternal Chat 会基于自己的领域模型、协议 profile/codec、数据结构和 UI 从零实现这些能力。当前参考快照根目录未发现许可证文件，因此不会复制其源码、样式、SVG、品牌素材或其他受版权保护的表达。

发布版根 README 必须保留对 NBSearch 的鸣谢，并链接本文件。

## Cherry Studio

Cherry Studio 的用户文档与开发者 `docs` 是 Eternal Chat 长期的主要外部参考之一：前者帮助校准用户流程、配置说明和功能发现，后者帮助校准 AI 主链、流式生命周期、数据边界、Provider 解析、测试和诊断。Eternal Chat 同时把用户实际遇到的工具结果跨轮丢失风险、长对话性能和模型目录能力门控问题作为必须独立验证的反面约束。

参考快照使用 GNU AGPL v3。Eternal Chat 只研究通用产品思路、公开协议和可观察行为，不复制 Cherry Studio 的源码、组件、图标、素材或品牌。

## 非隶属声明

Eternal Chat 与上述项目及其作者不存在隶属、赞助或官方合作关系。项目名称和商标归各自权利人所有。

## 开源发布前待办

- 由项目所有者明确选择 Eternal Chat 的开源许可证。
- 在仓库根目录加入对应 `LICENSE`。
- 生成并审阅第三方依赖许可证与 NOTICE/attribution 清单。
- 确认 README、安装包、About 页面和发行归档中的鸣谢与许可文本一致。
- 对所有参考来源进行一次发布前复核，确认没有误复制无授权源码或素材。

在许可证由项目所有者确定前，仓库文档可以公开讨论开源计划，但不得把项目描述成已经按某一许可证授权发布。
