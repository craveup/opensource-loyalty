# LIP Agent Skills

Installable [Agent Skills](https://agentskills.io/) for Loyalty Interchange
Protocol. Gives coding agents specialized knowledge for restaurant loyalty
integrations.

## Install

From a clone of this repo:

```bash
npx skills add .
```

Or install from the public repository without cloning:

```bash
npx skills add craveup/opensource-loyalty
```

Install one skill:

```bash
npx skills add . --skill lip-checkout
```

Works with Cursor, Claude Code, Codex, Windsurf, GitHub Copilot, and other
agents that support the skills format.

## Connect the MCP server

The repo includes an official LIP MCP server for accurate spec lookups and
validation. In Cursor, enable the root [`mcp.json`](../mcp.json) or add:

```json
{
  "mcpServers": {
    "lip": {
      "command": "npx",
      "args": ["tsx", "packages/mcp/src/server.ts"],
      "cwd": "/path/to/craveup-loyalty"
    }
  }
}
```

## Skills

| Skill | When to use |
| --- | --- |
| `lip` | **Router** — start here |
| `lip-cli` | `lip serve`, `doctor`, `test`, `validate` |
| `lip-sdk` | `LipClient`, idempotency, errors |
| `lip-checkout` | evaluate → reserve → accrue → capture → refund |
| `lip-webhooks` | signed CloudEvents, receivers |
| `lip-bff` | customer app + backend-for-frontend |
| `lip-conformance` | doctor, test, e2e patterns |

## Docs

- [Using LIP with AI](../docs/using-lip-with-ai.md)
- [AI prompts](../docs/ai-prompts.md)
- [`llms.txt`](../llms.txt)
