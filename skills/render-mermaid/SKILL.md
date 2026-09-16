---
name: render-mermaid
description: Draw or preview Mermaid diagrams (flowchart, sequence, state, class, ER) as Unicode art in the terminal. Use when explaining architecture, flows, state machines or data models, or when the user asks to render, preview or check a Mermaid diagram or a .mmd/.md file containing one.
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/render-mermaid.mjs *)
---

# Render Mermaid

Any ```` ```mermaid ```` block you write in a reply is replaced on the user's screen by its drawing (this plugin's MessageDisplay hook). To show a diagram, write the fence. Nothing else is needed. You keep seeing the source; the user sees the art.

Supported: `graph`/`flowchart` (TD, BT, LR, RL, subgraphs), `sequenceDiagram`, `stateDiagram`/`stateDiagram-v2`, `classDiagram`, `erDiagram`. Other types (gantt, pie, mindmap, …) are not drawn; do not pick them for terminal output.

The terminal is narrow. Prefer `TD` over `LR` for long chains and keep labels short, otherwise the user gets the source plus "wider than N columns" instead of a drawing.

To check a diagram before sending it, or to render a file:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/render-mermaid.mjs path/to/file.md   # or a bare .mmd file
```

Exit code 1 plus `not rendered: <reason>` on stderr means fix the diagram (syntax, type, width) before using it.
