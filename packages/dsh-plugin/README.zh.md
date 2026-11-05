# @hiai-gg/dsh-docsmint

[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/hiai-gg/dsh-docsmint)

[English](./README.md) | 简体中文

在 DeepSeek Harness 左侧边栏中浏览 DocsMint 工作区，并让智能体通过四个工具搜索、读取、创建和更新文档。

## 安装稳定版

```bash
dsh plugin --profile web add @hiai-gg/dsh-docsmint
dsh --profile web --dump-config
dsh --profile web
```

当前稳定版为 **1.0.0**。也可通过 Harness 的 `plugin_manager install_bundle` 安装，目标为 `@hiai-gg/dsh-docsmint`。安装后打开左侧 DocsMint 图标。

## 连接方式

- **DocsMint Cloud**：MCP 模式通过 DocsMint OAuth 登录（PKCE），API 模式使用 API 密钥。可用功能取决于账户方案和实际授权。
- **自托管 DocsMint OSS**：API 模式连接实例 REST API。MCP 模式要求该实例提供以 Bearer 密钥认证的 Streamable HTTP `POST /mcp`；仅提供 stdio 的旧实例应使用 API 模式。

授权范围由服务器决定。工作区密钥不会因切换筛选器而获得其他工作区权限；分类密钥只能访问已授权分类。多工作区连接必须选择实际获得授权的工作区。

## 面板和工具

- 按工作区、分类、文件夹筛选，并按更新时间、标题或创建时间排序。
- 每页 50 个文档，点击“显示更多”追加下一页并去重；筛选变更重置分页。如果传输忽略页码且不返回新文档，将停止继续加载，同时保留真实总数。
- 显示最近一次成功加载的时间，失败不会标记为成功刷新。
- 创建分类、文件夹和文档，编辑文档标题与 Markdown 正文，在 DocsMint 网页中打开原文。

| 工具 | 用途 |
| --- | --- |
| `docsmint_search` | 搜索已授权文档 |
| `docsmint_get_document` | 读取文档及链接 |
| `docsmint_create_document` | 创建文档 |
| `docsmint_update_document` | 更新标题或正文 |

这四个是插件提供给智能体的工具，不是 DocsMint MCP 服务端完整工具目录。

## 隐私和凭据

API 密钥和 OAuth 令牌保存在 Harness 凭据存储中，不发送到浏览器页面。没有可用凭据存储时，先启用它再连接。不要将密钥、令牌或回调 URL 粘贴到聊天、截图或问题报告中。

插件不添加遥测或分析，仅与配置的 DocsMint 服务通信。Host 配置、环境变量和无头运行方式见 [英文配置说明](./README.md#configuration)。

## 兼容性和故障排查

要求 Node.js 22 或更新版本，DSH `>=0.2.1-rc.5 <0.3.0`。CI 覆盖 Node 22/24；发布验收还使用了独立 Harness 0.2.2-rc.1 配置。目录是否收录或验证，以各目录自己的结果为准。

- 看不到图标：确认启动的是安装插件的同一 profile，然后重启该 profile。
- 自托管连接失败：检查实例 URL、传输模式和密钥权限。
- 列表范围不符：检查工作区、分类和文件夹，不要通过扩大密钥权限解决筛选问题。
- 报告问题时提供插件和 Harness 版本、脱敏错误，不提供凭据。

## 升级和移除

用同一 profile 的安装命令升级，也可指定精确版本，例如 `@hiai-gg/dsh-docsmint@1.0.0`。

```bash
dsh plugin --profile web remove @hiai-gg/dsh-docsmint
```

移除插件不删除 DocsMint 文档；如有需要，先断开该插件自己的授权，不影响其他连接。

## 源码和支持

[插件镜像](https://github.com/HiAi-gg/dsh-docsmint)供安装与目录发现使用，源码修改和 npm 发布来自 [DocsMint 主仓库](https://github.com/HiAi-gg/docsmint/tree/main/packages/dsh-plugin)。请勿直接修改自动镜像。

欢迎自愿为[插件镜像](https://github.com/HiAi-gg/dsh-docsmint)或[主仓库](https://github.com/HiAi-gg/docsmint)加星；这不是使用条件，也不代表第三方安全认证。

许可证：[Apache-2.0](./LICENSE)。
