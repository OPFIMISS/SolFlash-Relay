# Adapter Manifest

Use this shape for a custom Agent definition:

```json
{
  "id": "my-agent",
  "label": "My Agent",
  "role": "executor",
  "transport": "custom-cli",
  "enabled": true,
  "command": "my-agent",
  "models": ["small", "large"],
  "defaultModel": "small",
  "args": ["run", "--cwd", "{workdir}", "--model", "{model}", "--session", "{sessionId}"],
  "resumeArgs": ["resume", "{sessionId}", "--cwd", "{workdir}", "--model", "{model}"],
  "outputFormat": "jsonl",
  "promptTransport": "stdin"
}
```

Supported placeholders: `{prompt}`, `{workdir}`, `{sessionId}`, `{model}`, `{title}`.

`outputFormat` accepts `stream-json`, `jsonl`, or `text`. Structured formats should emit a session ID and effective model whenever the Agent supports them.

## Built-in transports

- `claude-cli`: uses `claude --print`, stream JSON, explicit model, session ID, resume, and the task workdir.
- `opencode-cli`: uses `opencode run --format json --dir <workdir>`, with model, title, and session options.
- `reasonix-cli`: uses Reasonix non-interactive approval, model, and resume options. Output is treated as text unless the installed version exposes a structured format.
- `haha-sidecar`: uses the installed Claude Code Haha sidecar. Relay maps Haha provider model IDs to their Claude-compatible slot aliases and checks the returned model.

Planner-only Agents use `transport: "host"`; they call Relay through MCP and are never spawned as executors.
