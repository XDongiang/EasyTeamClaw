# EasyTeamClaw

EasyTeamClaw 是基于 NanoClaw 演进的新项目，当前定位为 **本地 WebUI + 多模型提供商配置中心**。

## 与 NanoClaw 的继承关系

本项目直接继承 NanoClaw 的核心能力，并在此基础上做了产品方向调整：

1. 继承内容：
- 容器执行架构（`src/container-runner.ts` + `container/agent-runner`）
- Setup 分步框架（`setup/*.ts`）
- 安全边界与挂载策略（`mount allowlist`）
- Skills 机制与工具链

2. 当前方向：
- 优先 WebUI 本地使用
- 多 Provider（Claude / DeepSeek / Kimi / GLM / OpenAI-compatible）配置
- 自动模型列表刷新
- Skill 市场搜索与安装

3. 代码迁移说明：
- 已将本项目所需脚本与运行骨架迁移到仓库根目录。
- `nanoclaw/` 目录目前保留为上游参考副本，方便对照与后续同步。

## 项目结构（当前）

- `setup-webui.sh`: 一键 WebUI 安装脚本（推荐）
- `setup.sh`: bootstrap 依赖安装脚本
- `setup/`: 分步 setup 实现（environment/container/mounts/webui/verify 等）
- `src/`: 主程序与 WebUI API
- `container/`: 容器执行器与 agent-runner
- `.claude/skills/`: skills 目录

## 快速安装（推荐）

```bash
./setup-webui.sh
```

无人值守安装：

```bash
./setup-webui.sh --yes --with-service
```

可选参数：

```bash
./setup-webui.sh --help
```

## 启动与使用

1. 启动 WebUI：

```bash
npm run web
```

2. 打开：

- `http://localhost:3000`

3. 在界面中完成：

- 添加 Provider（URL + API Key）
- 刷新可用模型并设置默认模型
- 选择 Provider/Model 后发起对话
- 在 Skill 市场搜索并安装技能

## 常用验证命令

```bash
npx tsx setup/index.ts --step webui
npx tsx setup/index.ts --step verify -- --mode webui
```

## 日志

- `logs/setup-webui.log`
- `logs/setup.log`
- 运行日志见 `logs/` 与 `groups/*/logs/`
