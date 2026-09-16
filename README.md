# claude-code-mermaid

Claude Code plugin that draws Mermaid diagrams as Unicode box-drawing art in the terminal, fully offline.

- **MessageDisplay hook**: every ```` ```mermaid ```` block in Claude's replies is replaced on screen by its drawing as it streams. The block is held back until its closing fence arrives. A diagram rejected by the bundled renderer or wider than the terminal stays as source with a one-line reason. Rendering is a preview, not strict Mermaid syntax validation: malformed or unsupported constructs may be partially ignored. Display-only: the transcript and what Claude sees keep the original text.
- **Skill** `claude-code-mermaid`: tells Claude when to draw diagrams and how to check one (or render a file) before replying.

Supported: flowchart/graph, sequenceDiagram, stateDiagram, classDiagram, erDiagram.

## Install

```bash
claude plugin marketplace add gecm0/claude-code-mermaid
claude plugin install claude-code-mermaid@claude-code-mermaid
```

Restart Claude Code afterwards. Requires Node >= 18 and a Claude Code version with the `MessageDisplay` hook event (2.1.273 tested).

Try it without installing: clone the repo and run `claude --plugin-dir ./claude-code-mermaid`.

## CLI

```bash
node scripts/claude-code-mermaid.mjs diagram.mmd   # a bare diagram
node scripts/claude-code-mermaid.mjs notes.md      # every mermaid fence in a Markdown file
```

Width comes from `CLAUDE_CODE_MERMAID_WIDTH`, then `COLUMNS`, then the controlling terminal; with none of them the width is unlimited.

## Tests

```bash
node --test scripts/claude-code-mermaid.test.mjs
```

## Credits

`scripts/grok-mermaid.wasm` is the prebuilt module from [simonw/tools `grok-mermaid`](https://github.com/simonw/tools/tree/main/grok-mermaid): the Mermaid renderer from [xai-org/grok-build](https://github.com/xai-org/grok-build) compiled to WebAssembly, Copyright 2023-2026 SpaceXAI, Apache-2.0. The module is redistributed unmodified; see `NOTICE` and `LICENSE`.

Pairs well with HumanLayer's [show-me](https://www.skills.sh/humanlayer/skills/show-me) skill.

## License

Apache-2.0.
