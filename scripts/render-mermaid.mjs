#!/usr/bin/env node
// Renders Mermaid as Unicode box-drawing art with simonw/tools' grok-mermaid.wasm
// (the Grok CLI renderer compiled to WASM). No dependencies beyond Node >= 18.
//
//   render-mermaid.mjs [file]  render a bare diagram or a Markdown doc's ```mermaid blocks (stdin if no file)
//   render-mermaid.mjs --hook  MessageDisplay hook: show each ```mermaid block as its drawing
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WASM = readFileSync(new URL('./grok-mermaid.wasm', import.meta.url));
const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*mermaid\b[^\n]*\n([\s\S]*?)^ {0,3}\1[ \t]*$/gm;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// The module is built with panic=abort: a panic traps and leaves the instance unusable, so each render gets its own.
function renderHtml(src, maxWidth) {
  const { exports: wasm } = new WebAssembly.Instance(new WebAssembly.Module(WASM));
  const bytes = encoder.encode(src);
  const ptr = wasm.wasm_alloc(bytes.length);
  new Uint8Array(wasm.memory.buffer, ptr, bytes.length).set(bytes);
  const len = wasm.wasm_render_html(ptr, bytes.length, maxWidth);
  return decoder.decode(new Uint8Array(wasm.memory.buffer, wasm.wasm_result_ptr(), len));
}

const toPlain = (html) =>
  html.replace(/<\/?span[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trimEnd();

// A diagram that is unsupported, unparseable or wider than maxWidth comes back as the framed source,
// whose header is the only run tagged "t". The reader already has the source, so that is a miss.
export function render(src, maxWidth = 0) {
  try {
    const html = renderHtml(src, maxWidth);
    if (!html.trim()) return { error: 'empty diagram' };
    if (!html.includes('class="t"')) return { art: toPlain(html) };
    if (maxWidth > 0 && !renderHtml(src, 0).includes('class="t"')) return { error: `wider than ${maxWidth} columns` };
    return { error: 'unsupported diagram type or syntax error' };
  } catch (err) {
    return { error: `renderer crashed (${err.message})` };
  }
}

export const mermaidBlocks = (markdown) => [...markdown.matchAll(FENCE)].map((m) => m[2]);

// Hooks run without a terminal on stdout; the controlling tty, when there is one, still knows the width.
function terminalWidth() {
  const fromEnv = Number(process.env.RENDER_MERMAID_WIDTH || process.env.COLUMNS);
  if (fromEnv > 0) return fromEnv;
  try {
    const cols = Number(execFileSync('stty', ['size'], { stdio: ['/dev/tty', 'pipe', 'ignore'] }).toString().split(' ')[1]);
    if (cols > 0) return cols - 4;
  } catch {}
  return 0;
}

// Replaces each block's lines on screen with the drawing (or the untouched block if it cannot be drawn).
// Lines arrive in batches, so an open block is held back, and kept in a state file between calls.
export function displayBatch(state, delta, final, width) {
  let out = '';
  for (const line of delta.split(/(?<=\n)/)) {
    if (!state.close) {
      const open = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*mermaid\b/i);
      if (open) Object.assign(state, { close: `^ {0,3}${open[1][0]}{${open[1].length},}[ \\t]*$`, raw: line, src: '' });
      else out += line;
    } else if (new RegExp(state.close).test(line.replace(/\n$/, ''))) {
      const { art, error } = render(state.src, width);
      out += art ? `\`\`\`\n${art}\n\`\`\`\n` : `${state.raw}${line}\n_Mermaid not rendered: ${error}_\n`;
      state.close = null;
    } else {
      state.raw += line;
      state.src += line;
    }
  }
  if (final && state.close) out += state.raw;
  return out;
}

function hook() {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const dir = join(tmpdir(), 'render-mermaid');
  const file = join(dir, `${input.session_id}-${input.message_id}.json`.replace(/[^\w.-]/g, '_'));
  let state = {};
  try {
    state = JSON.parse(readFileSync(file, 'utf8'));
  } catch {}
  // Fast path: nothing mermaid in flight or arriving, show the batch as is.
  if (!state.close && !/mermaid/i.test(input.delta)) return;
  const displayContent = displayBatch(state, input.delta, input.final, terminalWidth());
  if (input.final) rmSync(file, { force: true });
  else {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(state));
  }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'MessageDisplay', displayContent } }));
}

function cli(path) {
  const text = readFileSync(path ?? 0, 'utf8');
  const blocks = mermaidBlocks(text);
  let failed = false;
  for (const src of blocks.length ? blocks : [text]) {
    const { art, error } = render(src, terminalWidth());
    if (art) console.log(`${art}\n`);
    else {
      console.error(`not rendered: ${error}`);
      failed = true;
    }
  }
  process.exitCode = failed ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // A hook must never break the turn, whatever the input.
  if (process.argv[2] === '--hook') {
    try {
      hook();
    } catch {}
  } else cli(process.argv[2]);
}
