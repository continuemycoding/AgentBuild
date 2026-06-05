# AgentBuild

GitHub Action：在**你的项目仓库**里自动生成 `build.yml`，构建失败时用 Cursor 修复 CI 配置。

## 这是什么

- **本仓库（AgentBuild）**：发布 Action，包含 `action.yml` + 运行逻辑
- **你的项目**：只需加一条 workflow，通过 `uses:` 调用本 Action

## 接入（在你的项目里）

**1. 添加 Secret**

`CURSOR_API_KEY` — 在 [Cursor Dashboard](https://cursor.com/dashboard/integrations) 创建

**2. 新建 workflow**

把 [`examples/workflow.yml`](examples/workflow.yml) 复制到你的项目：

```text
你的项目/.github/workflows/agentbuild.yml
```

把其中的 `your-org/AgentBuild@v1` 改成你实际发布的地址，例如：

```yaml
- uses: lin/AgentBuild@v1
```

**3. 运行**

Actions → AgentBuild → Run workflow（首次会 bootstrap 生成 `Build` workflow 并开 PR）

之后 `Build` 失败会自动触发 fix。

## 示例 workflow

```yaml
steps:
  - uses: actions/checkout@v4

  - uses: your-org/AgentBuild@v1
    with:
      mode: auto
    env:
      CURSOR_API_KEY: ${{ secrets.CURSOR_API_KEY }}
```

注意：

- `checkout` 在你的项目 workflow 里做，Action 操作的是**你的代码仓库**
- 不要用 `uses: ./`，那是 Action 作者本地调试用的

## 发布本 Action

发布前先构建并提交 `dist/`（消费者运行时依赖它）：

```bash
npm run build
git add dist/
git tag v1.0.0
git push origin v1.0.0
```

## 开发（本仓库）

```bash
npm ci && npm run typecheck && npm run build
```
