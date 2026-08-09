---
name: agent-adapter
description: Integrate another coding Agent or CLI with SolFlash Relay, including Claude Code desktop/CLI, OpenCode, Reasonix, and custom local agents. Use when adding, repairing, or validating a planner/executor Agent, its model selection, project-path binding, session resume behavior, or adapter manifest.
---

# Agent Adapter

Integrate the existing authenticated Agent installation. Do not move API keys into Relay.

1. Run the target Agent's local `--help` and version commands. Prefer official documentation when local help is incomplete.
2. Determine whether it is a planner, executor, or both.
3. Use a built-in transport when possible: `claude-cli`, `opencode-cli`, or `reasonix-cli`. Use `custom-cli` only when none matches.
4. Preserve the exact absolute `workdir` supplied by the planner. Never substitute Relay's own directory or a temporary directory for a production task.
5. Pass the requested model explicitly. Capture the effective model from structured output when available; surface a warning when it differs.
6. Give a new task a stable session ID and resume the same ID for follow-up work.
7. Keep the prompt transport on stdin when supported. Use `{prompt}` in an argument only when the CLI requires it.
8. Register the sanitized adapter definition through Relay settings. Never place credentials, authorization headers, provider JSON, or environment secrets in the definition.
9. Validate with a disposable repository and one allowed output file. Confirm project path, changed-file scope, model, exit status, and session resume before enabling real work.

Read [references/adapter-manifest.md](references/adapter-manifest.md) for the manifest fields and built-in examples.

Reject the integration when the Agent cannot run non-interactively, cannot bind to a caller-supplied workdir, or silently ignores the selected model without reporting the effective one.
