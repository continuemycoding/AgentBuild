import * as core from "@actions/core";
import * as github from "@actions/github";
import { exec } from "@actions/exec";
import { Agent, CursorAgentError, type SDKMessage } from "@cursor/sdk";
import { existsSync } from "node:fs";
import { join } from "node:path";

const BUILD_WORKFLOW = ".github/workflows/build.yml";

type Mode = "bootstrap" | "fix" | "auto";

const BOOTSTRAP_PROMPT = `Scan this repository and create ${BUILD_WORKFLOW}, a GitHub Actions workflow that installs dependencies and builds the project.

How to analyze:
- Read README.md / README.*, CONTRIBUTING, docs, and any setup instructions
- Inspect manifests and tooling: package.json, lockfiles, pyproject.toml, requirements.txt, go.mod, Cargo.toml, pom.xml, build.gradle, Makefile, Dockerfile, etc.
- Infer the correct package manager, runtime versions, and build/test commands from the actual project — do not assume a fixed template

Workflow requirements:
- name: Build
- triggers: push to main/master, and pull_request
- runs-on: ubuntu-latest
- steps: checkout, setup toolchain, install deps, build (and test if the project has them)
- use current official GitHub Actions (actions/checkout@v4, actions/setup-node@v4, etc.)

Constraints:
- Only edit CI/build files (.github/workflows/*, and package.json scripts if needed for build)
- Do not modify src/ or application source code
- Write a complete, runnable workflow — no placeholders`;

function truncate(text: string, max = 500): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function formatToolArgs(name: string, args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const record = args as Record<string, unknown>;
  if (name === "Shell" && typeof record.command === "string") {
    return record.command;
  }
  if (typeof record.path === "string") return record.path;
  if (typeof record.file_path === "string") return record.file_path;
  if (typeof record.target_file === "string") return record.target_file;
  try {
    return truncate(JSON.stringify(args), 200);
  } catch {
    return "";
  }
}

function logAgentEvent(event: SDKMessage): void {
  switch (event.type) {
    case "system":
      if (event.subtype === "init") {
        const model =
          typeof event.model === "object" && event.model && "id" in event.model
            ? String(event.model.id)
            : "unknown";
        core.info(`[agent] initialized (model=${model})`);
      }
      break;
    case "status":
      core.info(
        `[agent] ${event.status}${event.message ? `: ${event.message}` : ""}`,
      );
      break;
    case "thinking":
      core.info(`[agent] thinking: ${truncate(event.text.replace(/\s+/g, " ").trim(), 300)}`);
      break;
    case "assistant":
      for (const block of event.message.content) {
        if (block.type === "text" && block.text.trim()) {
          for (const line of block.text.trim().split("\n")) {
            core.info(`[agent] ${line}`);
          }
        } else if (block.type === "tool_use") {
          const detail = formatToolArgs(block.name, block.input);
          core.info(
            `[agent] tool → ${block.name}${detail ? `: ${truncate(detail, 300)}` : ""}`,
          );
        }
      }
      break;
    case "tool_call": {
      const detail = formatToolArgs(event.name, event.args);
      if (event.status === "running") {
        core.info(
          `[agent] ${event.name}…${detail ? ` ${truncate(detail, 300)}` : ""}`,
        );
      } else if (event.status === "completed") {
        core.info(`[agent] ${event.name} ✓`);
      } else {
        core.info(`[agent] ${event.name} ✗`);
      }
      break;
    }
    case "task":
      if (event.text?.trim()) {
        core.info(`[agent] task: ${truncate(event.text.replace(/\s+/g, " ").trim(), 300)}`);
      }
      break;
  }
}

async function runAgent(
  cwd: string,
  prompt: string,
  apiKey: string,
): Promise<string> {
  core.info("starting Cursor agent...");
  const agent = await Agent.create({
    apiKey,
    model: { id: "composer-2.5" },
    local: { cwd, settingSources: [] },
  });
  try {
    const run = await agent.send(prompt);
    core.info(`agent run started: agentId=${agent.agentId}, runId=${run.id}`);

    for await (const event of run.stream()) {
      logAgentEvent(event);
    }

    const result = await run.wait();
    if (result.status === "error") {
      throw new Error(`Agent run failed: ${result.id}`);
    }
    core.info(
      `agent finished: status=${result.status}, id=${result.id}${result.durationMs != null ? `, duration=${Math.round(result.durationMs / 1000)}s` : ""}`,
    );
    return result.result ?? "";
  } catch (err) {
    if (err instanceof CursorAgentError) {
      throw new Error(`Cursor startup failed: ${err.message}`);
    }
    throw err;
  } finally {
    await agent[Symbol.asyncDispose]();
  }
}

async function fetchFailureLogs(token: string, runId: number): Promise<string> {
  core.info(`fetching failure logs for workflow run ${runId}...`);
  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;
  const jobs = await octokit.rest.actions.listJobsForWorkflowRun({
    owner,
    repo,
    run_id: runId,
  });

  core.info(`found ${jobs.data.jobs.length} job(s) in failed run`);
  const parts: string[] = [];
  for (const job of jobs.data.jobs) {
    core.info(`  job "${job.name}": ${job.conclusion}`);
    parts.push(`Job ${job.name}: ${job.conclusion}`);
    try {
      const logs = await octokit.rest.actions.downloadJobLogsForWorkflowRun({
        owner,
        repo,
        job_id: job.id,
      });
      const text = typeof logs.data === "string" ? logs.data : "";
      parts.push(text.slice(-6000));
    } catch {
      core.warning(`  logs unavailable for job "${job.name}"`);
      parts.push("(logs unavailable)");
    }
  }
  const text = parts.join("\n");
  core.info(`collected ${text.length} chars of failure logs`);
  return text;
}

async function commitPr(
  cwd: string,
  token: string,
  branch: string,
  title: string,
): Promise<string> {
  core.info(`creating PR: branch=${branch}, title="${title}"`);
  core.info(`git cwd: ${cwd}`);

  const logGit = (line: Buffer) => core.info(line.toString().trimEnd());
  await exec("git", ["config", "user.name", "github-actions[bot]"], { cwd });
  await exec(
    "git",
    ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"],
    { cwd },
  );
  core.info(`git checkout -b ${branch}`);
  await exec("git", ["checkout", "-b", branch], { cwd, listeners: { stdout: logGit } });
  core.info("git add -A");
  await exec("git", ["add", "-A"], { cwd });
  core.info(`git commit -m "${title}"`);
  await exec("git", ["commit", "-m", title], {
    cwd,
    listeners: { stdout: logGit, stderr: logGit },
  });
  core.info(`git push --force origin ${branch}`);
  await exec("git", ["push", "--force", "origin", branch], {
    cwd,
    listeners: { stdout: logGit, stderr: logGit },
  });

  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;
  const base =
    github.context.payload?.repository?.default_branch ??
    github.context.ref?.replace("refs/heads/", "") ??
    "main";

  core.info(`opening PR: ${owner}/${repo} ${branch} -> ${base}`);
  const pr = await octokit.rest.pulls.create({
    owner,
    repo,
    title,
    head: branch,
    base,
    body: "Generated by AgentBuild. Please review.",
  });
  core.info(`PR created: ${pr.data.html_url}`);
  return pr.data.html_url;
}

function resolveMode(input: Mode, cwd: string): "bootstrap" | "fix" {
  if (input === "bootstrap" || input === "fix") {
    core.info(`mode resolved from input: ${input}`);
    return input;
  }
  const hasBuild = existsSync(join(cwd, BUILD_WORKFLOW));
  const failed =
    github.context.eventName === "workflow_run" &&
    github.context.payload.workflow_run?.conclusion === "failure";
  core.info(
    `auto mode: hasBuild=${hasBuild}, event=${github.context.eventName}, failed=${failed}`,
  );
  if (!hasBuild) return "bootstrap";
  if (failed) return "fix";
  return "bootstrap";
}

async function run(): Promise<void> {
  const mode = resolveMode(
    (core.getInput("mode") || "auto") as Mode,
    process.env.GITHUB_WORKSPACE || ".",
  );
  const cwd = process.env.GITHUB_WORKSPACE || process.cwd();
  const apiKey = process.env.CURSOR_API_KEY || "";
  const token = process.env.GITHUB_TOKEN || "";

  core.info(`mode: ${mode}`);
  core.info(`workspace: ${cwd}`);
  core.info(`process.cwd: ${process.cwd()}`);
  core.info(`event: ${github.context.eventName}`);
  core.info(`repo: ${github.context.repo.owner}/${github.context.repo.repo}`);
  core.info(`CURSOR_API_KEY: ${apiKey ? "set" : "not set"}`);
  if (token) {
    core.info(
      `GITHUB_TOKEN: set (${token.slice(0, 4)}...${token.slice(-4)} len=${token.length})`,
    );
  } else {
    core.info("GITHUB_TOKEN: not set");
  }

  if (mode === "bootstrap") {
    if (!apiKey) {
      core.setFailed("CURSOR_API_KEY is required for bootstrap mode");
      return;
    }

    core.info("scanning project with AI and generating build workflow...");
    await runAgent(cwd, BOOTSTRAP_PROMPT, apiKey);

    const workflowPath = join(cwd, BUILD_WORKFLOW);
    if (!existsSync(workflowPath)) {
      core.setFailed(`${BUILD_WORKFLOW} was not created by agent`);
      return;
    }
    core.info(`workflow ready: ${workflowPath}`);

    if (token) {
      const url = await commitPr(
        cwd,
        token,
        `agentbuild/bootstrap-${github.context.runId}`,
        "chore(ci): add build workflow",
      );
      core.setOutput("pr-url", url);
    } else {
      core.warning(
        "skipping PR: GITHUB_TOKEN not set (ensure checkout + contents/pull-requests write permissions)",
      );
    }
    core.info("bootstrap finished");
    return;
  }

  if (!apiKey) {
    core.setFailed("CURSOR_API_KEY is required for fix mode");
    return;
  }

  const runId = github.context.payload.workflow_run?.id;
  if (!runId) {
    core.warning("no workflow_run.id in payload; agent will run without logs");
  } else if (!token) {
    core.warning("GITHUB_TOKEN not set; cannot fetch failure logs");
  }
  const logs = runId && token ? await fetchFailureLogs(token, runId) : "";

  await runAgent(
    cwd,
    `Fix the CI build failure. Only edit .github/workflows/* and build commands. Do not modify src/ unless absolutely necessary.\n\nLogs:\n${logs}`,
    apiKey,
  );

  if (token) {
    const url = await commitPr(
      cwd,
      token,
      `agentbuild/fix-${github.context.runId}`,
      "fix(ci): repair build workflow",
    );
    core.setOutput("pr-url", url);
  } else {
    core.warning("skipping PR: GITHUB_TOKEN not set");
  }
  core.info("fix finished");
}

run().catch((err: unknown) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
