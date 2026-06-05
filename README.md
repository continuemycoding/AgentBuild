# AgentBuild

在本仓库内自动生成 `build.yml`，构建失败时用 Cursor 修复 CI 配置（默认不改源码）。

## 接入

1. 添加 Secret：`CURSOR_API_KEY`
2. 复制 [`.github/workflows/agentbuild.yml`](.github/workflows/agentbuild.yml) 到你的项目
3. Actions → **AgentBuild** → Run workflow（首次生成 `Build` workflow）
4. 之后 `Build` 失败会自动触发修复并开 PR

## 流程

- **bootstrap**：检测 npm/go/rust → 生成 `.github/workflows/build.yml` → 可选 AI 优化 → 开 PR
- **fix**：读取失败日志 → AI 只改 workflow/构建命令 → 开 PR

## 开发

```bash
npm ci && npm run typecheck && npm run build
```
