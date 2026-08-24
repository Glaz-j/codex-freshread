<div align="center">

# FreshRead

**面向 Codex 的文件上下文新鲜度防护插件**

当 Codex 可靠读取过的受支持本地文件发生变化时，FreshRead 会检测到上下文过期，
并在 Codex 重新读取当前内容之前阻止受支持的编辑操作。

[English](README.md) · 简体中文

</div>

> [!IMPORTANT]
> FreshRead 是一个保守的工具级防护层。它保护下文明确列出的读取和写入路径；
> 它不是操作系统级文件监控器，也不宣称覆盖整个工作区。

## 为什么需要 FreshRead

编程 Agent 会根据对话上下文中已经读取过的文件内容做判断。但在读取之后，用户、
格式化工具、构建步骤、Git 操作或其他进程都可能再次修改文件，使模型记住的内容过期。

如果没有新鲜度检查，后续编辑可能悄悄覆盖这些更新。FreshRead 在 Codex 生命周期边界
加入确定性的内容检查：

```text
Codex 读取文件
      ↓
FreshRead 记录内容快照
      ↓
文件在读取后发生变化
      ↓
Codex 准备执行受支持的编辑
      ↓
FreshRead 阻止编辑并要求 Codex 重新读取
```

这样任务可以基于文件系统中的真实现状继续，而不是基于已经过期的文件记忆。

## 核心特性

- **自动保护**：正常工作时无需输入任何 FreshRead 命令。
- **基于内容的编辑前判断**：受支持的编辑前检查会强制计算 SHA-256；生命周期扫描
  使用有界元数据快速路径，并在元数据变化时重新计算哈希。
- **同步编辑拦截**：在底层工具真正执行之前拒绝受支持的过期编辑。
- **可观测的变更来源**：通过匹配当前会话中已观测的写入证据进行标记；未匹配的变更
  会被保守归类为外部变更。
- **支持恢复与上下文压缩**：在受支持的生命周期转换中保留会话元数据。
- **完全本地运行**：没有 FreshRead 托管的服务、数据库、遥测或直接网络请求。
- **失败时保守阻断**：状态损坏或受信运行时失败时，不会把受支持的编辑目标误判为新鲜。

## 快速开始

### 环境要求

- 由插件和生命周期 Hook 运行时支持的 Codex 应用或 CLI 会话。IDE 扩展和普通
  ChatGPT「工作」输入框不属于受支持的拦截验证界面。
- Node.js 18.18 或更高版本，并可通过 `node` 使用。
- Windows 上需要 Codex 0.145.0 或更高版本，并使用 PowerShell 支持的 Hook 命令 Shell，
  才能使用受支持的拦截链路。

### 安装

FreshRead 当前以本地个人 Marketplace 构建形式发行；本文档不宣称它已经进入公共插件目录。
在已经把这份源码注册到默认个人 Marketplace 的环境中，可以使用：

```text
codex plugin add freshread@personal
```

请使用受支持的 Codex 0.145.0+ 可执行文件运行该命令，并通过 `codex --version` 核对版本。
即使旧版 0.132.0 Windows Hook 运行器能够发现或列出插件，也不要依赖它执行 FreshRead 拦截。

安装或更新后：

1. 启动一个新的 Codex CLI 会话。
2. 在 CLI 中输入 `/hooks`。
3. 检查、信任并启用六个 FreshRead Hook 定义。
4. 新建 Codex 对话后再测试刚安装的版本。

`/hooks` 是 **Codex CLI 命令**，不是 FreshRead 命令，在 ChatGPT「工作」输入框中不会出现。

Codex 会把信任状态绑定到当前 Hook 定义的哈希。如果更新导致哈希改变，Codex 会跳过
该 Hook，直到用户重新检查并信任它。宿主信任模型请参阅
[Codex Hooks 官方文档](https://learn.chatgpt.com/docs/hooks)。

### 使用

像平时一样工作即可。插件启用且 Hook 已受信后，符合条件的读取和受支持的编辑会自动受到保护。

下面这些可选诊断指令应作为普通提示词发送，不要加 `/`：

```text
freshread status
freshread inspect
freshread inspect src/auth.ts
freshread clear
```

| 提示词 | 用途 |
| --- | --- |
| `freshread status` | 显示当前会话的状态计数。 |
| `freshread inspect` | 列出已跟踪文件及其当前状态。 |
| `freshread inspect <path>` | 检查一个已跟踪路径。 |
| `freshread clear` | 仅清除当前会话的读取集合（Read Set）。 |

正常使用不需要维护这些命令。如果 FreshRead 阻止了一次编辑，请从文件系统重新读取提示中的
文件，然后重试编辑。
不要仅仅为了绕过过期或未知状态而执行 `freshread clear`。

## 状态模型

FreshRead 只跟踪有可靠、完整读取证据的文件。

| 状态 | 含义 | 安全的下一步 |
| --- | --- | --- |
| `FRESH` | 当前内容与最近一次可靠读取一致。 | 可以继续。 |
| `STALE_SELF` | 最近一次读取后，内容通过已观测到的 Codex 写入发生了变化。 | 再次依赖或编辑前重新读取。 |
| `STALE_EXTERNAL` | 内容发生变化，但当前会话中没有与之匹配的 Codex 写入证据。 | 依赖或编辑前重新读取。 |
| `MISSING` | 之前读取过的路径已经不存在。 | 重新确认路径和任务意图。 |
| `UNKNOWN` | 没有可靠快照，或无法证明当前文件身份。 | 按未知处理，不要假设安全。 |

`STALE` 表示模型记住的快照已经过期，并不表示当前代码在语义上一定有错误。

## 工作原理

FreshRead 是一个完全本地的 Codex 插件，由一个 Skill 和六类生命周期 Hook 组成：

- `SessionStart`：检查恢复后的会话状态。
- `UserPromptSubmit`：响应显式诊断请求，并在新一轮对话开始时检查已读集合。
- `PreToolUse`：识别受支持的读取和写入目标，在编辑前阻止不安全操作。
- `PostToolUse`：验证成功的完整读取，记录快照或已观测到的写入证据。
- `PreCompact` 和 `PostCompact`：在上下文压缩前后重新检查持久元数据；来源为 compact
  的 `SessionStart` 会重新注入相关上下文。

对于一次可靠读取，FreshRead 会记录规范路径、SHA-256 内容标识、文件大小、高精度
mtime/ctime 元数据、读取时间和可观测工具来源。持久状态保存在 Codex 提供的
`PLUGIN_DATA` 目录中，不会写入项目源码仓库。

## 支持范围

FreshRead 只接受能够保守绑定到本地文件的证据。

支持的路径包括：

- `apply_patch` 的精确新增、更新、删除和移动目标，以及受支持的结构化 `Edit`、`Write` 目标；
- 使用字面量本地路径、输出完整且非空，并能与规范文件内容精确匹配的单文件 Shell 读取；
- PowerShell 中使用 `Get-Content`/`gc -Raw -Encoding utf8` 的受支持读取；
- 可识别的字面量路径 Shell 写入，例如 `Set-Content`、`Out-File`、重定向、删除、
  复制、移动、重命名、`sed -i` 和 `prettier --write`；
- 对已识别目标进行同步编辑前保护；只有工具结果提供充分证明时，才会保守地归因为自身写入。

以下情况不会被视为可靠快照：

- `head`、`tail`、`rg`、`Select-String`、混合管道等局部、转换或搜索型读取；
- 动态路径、通配符、任意脚本，或在内部打开文件的子进程；
- 无法把交付给模型的字节绑定到稳定本地快照的 MCP、托管、图像或专用工具输出；
- 空输出、截断输出、不支持的编码，以及默认超过 16 MiB 的完整读取；
- 会话工作区之外的文件、指向工作区外部的符号链接、非常规文件，以及默认超过
  256 MiB 的文件；
- 同步编辑前检查与实际写入之间发生的竞态变更；
- 当 Hook 输入没有工具级 `workdir` 或 `cwd` 时，使用相对路径的可观测读取不会进入
  Read Set；此时请使用绝对路径，而可识别的相对 Shell 写入会保守阻断；
- 通过 `write_stdin` 后续写入已经运行的工具进程；宿主不会为这种续写再次触发
  `PreToolUse`，因此需要 FreshRead 保护的写入不要使用持久 Shell 会话；
- 当宿主只暴露父会话标识时，无法可靠实现的子 Agent 隔离。

不支持的读取仍会正常执行，但不会刷新已读集合。完整契约请参阅
[覆盖范围与已知风险](docs/COVERAGE.md)。

## 隐私与安全

- FreshRead 的持久状态只保存哈希和元数据，不保存源文件内容。
- 为支持会话恢复，元数据中包含绝对路径和会话标识。
- 绝对路径、哈希和标识符仍可能属于敏感信息，请妥善保护 Codex 插件数据目录。
- Codex 读取到的文件字节仍遵循 Codex 正常的工具输出和数据处理链路。
- FreshRead 不发起直接网络请求，也没有托管后端。
- 状态写入使用会话级锁、大小限制、平台支持时的限制性权限，以及临时文件替换。
- 显示给模型的路径和诊断信息会中和控制字符及双向文本格式字符。
- 启动器会拒绝不安全的 Node 解析和工作区内运行时；Windows 上还会拒绝含糊别名及
  不支持的重解析点或驱动器布局。

FreshRead V0 不会自动清理旧的会话状态文件。`freshread clear` 只清除当前会话。
如需删除全部 FreshRead 保留元数据，请关闭 Codex 后显式删除插件的 Codex 数据目录。
卸载插件会停止 Hook，但除非当前 Codex 版本明确确认，否则不要假设卸载会一并清除历史数据。

## 发布验证

发布测试会对同一份过期上下文任务分别运行未启用 FreshRead 和启用 FreshRead 的版本。

| 结果 | Baseline | FreshRead |
| --- | ---: | ---: |
| 用户的外部修改得到保留 | 否 | 是 |
| 在受保护编辑前重新读取 | 否 | 是 |
| 不安全的过期编辑成功落盘 | 是 | 否 |
| 第三次过期编辑尝试 | 已执行 | 在执行前被阻止 |

性能门禁覆盖 100/1000 文件扫描、读取注册增长、冷启动 Hook，以及在已填充
1000 文件状态上的真实配置 Hook。绝对延迟与相对 Baseline 增量必须同时通过。
总体发布资格还要求确定性报告和真实报告绑定到同一份源码摘要。当前签入的匹配报告中，
确定性、安全、性能和真实 Codex app-server 门禁均已通过。

- [最新确定性 Benchmark](benchmarks/results/latest.md)
- [最新真实 Codex A/B](benchmarks/results/live-latest.md)
- [Benchmark 契约](docs/BENCHMARK.md)

这些证据只证明经过刻意规范化的受支持工作流，并不代表整个工作区或操作系统级审计覆盖率。
当前真实发布证据基于 Windows；其他平台启动器尚不具备同等级别的端到端真实 A/B 资格声明。
恢复与上下文压缩场景仍属于确定性/合成协议证据，除非具体报告明确标注为真实测试。

## 开发

FreshRead 直接发行可运行的 CommonJS 文件，没有编译或 `dist/` 步骤。Node.js 负责语法检查
并直接执行插件。

```text
npm run check
npm test
npm run benchmark
```

只有在安装了完全一致的源码版本、信任了当前 Hook，并启动新 Codex 会话后，才运行真实门禁：

```text
npm run benchmark:live
```

项目结构：

```text
.codex-plugin/plugin.json   插件身份与界面元数据
skills/freshread/           面向模型的工作流说明
hooks/hooks.json            生命周期注册配置
scripts/                    跨平台启动器与 Hook 入口
src/                        状态机、命令分析与证据逻辑
tests/                      单元、契约、边界与安全加固测试
benchmarks/                 确定性与真实 A/B 发布门禁
docs/                       详细覆盖范围与 Benchmark 契约
```

更新已安装的本地版本时，应修改开发源码、完成校验、更新 Manifest cachebuster、从
Marketplace 重新安装并新建对话。不要直接修改安装缓存。

## 故障排查

| 现象 | 检查方法 |
| --- | --- |
| FreshRead 看起来没有生效 | 确认插件已启用，新建会话，并在 Codex CLI 中使用 `/hooks` 检查 Hook。 |
| `/hooks` 显示“无命令” | 你可能正在 ChatGPT「工作」输入框中；请打开 Codex CLI 检查 Hook。 |
| 编辑被阻止 | 从文件系统重新读取提示中的每一个目标后再重试；不要绕过 `UNKNOWN` 状态。 |
| 状态被报告为损坏 | 仅将 `freshread clear` 作为明确的恢复操作，然后重新读取任务所需的全部文件。 |
| Windows 上 Hook 启动失败 | 检查 Node.js 18.18+ 和受支持的 Codex 0.145.0+；在 Hook 恢复前视为防护不可用。 |
| 更新后仍是旧行为 | 重新安装插件并新建对话；Codex 运行的是安装缓存副本。 |

## 许可证

[MIT](LICENSE) © 2026 FreshRead contributors。
