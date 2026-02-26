# EasyTeamClaw

[中文说明](README_zh.md)

EasyTeamClaw is an evolution of NanoClaw focused on a **local WebUI + multi-provider model configuration center**.

## Relationship to NanoClaw

This project inherits NanoClaw's core architecture and refocuses product behavior toward local-first usage.

1. Inherited foundation:
- Container execution architecture (`src/container-runner.ts` + `container/agent-runner`)
- Step-based setup framework (`setup/*.ts`)
- Security boundaries and mount allowlist model
- Skills mechanism and tooling

2. Current direction:
- WebUI-first local operation
- Multi-provider config (Claude / DeepSeek / Kimi / GLM / OpenAI-compatible)
- Automatic model list refresh from provider APIs
- Skill market search and install

3. Migration note:
- Required scripts and runtime skeleton have been moved to this repository root.
- This repo is now the active project home.

## Project Layout

- `setup-webui.sh`: Robust one-command WebUI setup (recommended)
- `setup.sh`: Bootstrap dependency installer
- `setup/`: Step-based setup implementation (environment/container/mounts/webui/verify)
- `src/`: App runtime and WebUI API
- `container/`: Container runtime and agent-runner
- `.claude/skills/`: Skills directory

## Setup (Recommended)

```bash
./setup-webui.sh
```

Unattended install:

```bash
./setup-webui.sh --yes
```

Service is enabled by default. To skip service registration:

```bash
./setup-webui.sh --no-service
```

Show options:

```bash
./setup-webui.sh --help
```

## Run and Use

1. Open:

- `http://localhost:3000`

2. If you installed with `--no-service`, start manually:

```bash
npm run web
```

3. In WebUI:
- Add provider endpoint + API key
- Refresh available model list and set defaults
- Choose provider/model and chat
- Search/install skills from the skill market

## Service Control

- Linux (systemd user):
  `systemctl --user status easyteamclaw-webui`
  `systemctl --user restart easyteamclaw-webui`
- macOS (launchd):
  `launchctl list | grep com.easyteamclaw-webui`
  `launchctl kickstart -k gui/$(id -u)/com.easyteamclaw-webui`

## Verification

```bash
npx tsx setup/index.ts --step webui
npx tsx setup/index.ts --step verify -- --mode webui
```

## Logs

- `logs/setup-webui.log`
- `logs/setup.log`
- Runtime logs under `logs/` and `groups/*/logs/`
