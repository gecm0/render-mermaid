#!/usr/bin/env node
// Renders Mermaid as Unicode box-drawing art with simonw/tools' grok-mermaid.wasm
// (the Grok CLI renderer compiled to WASM). No dependencies beyond Node >= 18.
//
//   claude-code-mermaid.mjs [file]  render a bare diagram or a Markdown doc's ```mermaid blocks (stdin if no file)
//   claude-code-mermaid.mjs --hook  MessageDisplay hook: show each ```mermaid block as its drawing
import { execFileSync } from 'node:child_process';
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WASM = readFileSync(new URL('./grok-mermaid.wasm', import.meta.url));
const FENCE = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)(?:\r?\n)?$/;
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

const parseFence = (line) => {
  const match = line.match(FENCE);
  if (!match || (match[1][0] === '`' && match[2].includes('`'))) return null;
  return { marker: match[1][0], length: match[1].length, info: match[2] };
};

const closesFence = (fence, open) =>
  fence && fence.marker === open.marker && fence.length >= open.length && /^[ \t]*$/.test(fence.info);

const isMermaid = (info) => /^[ \t]*mermaid\b/i.test(info);

export function mermaidBlocks(markdown) {
  const blocks = [];
  let open;
  let src = '';
  for (const line of markdown.split(/(?<=\n)/)) {
    const fence = parseFence(line);
    if (!open) {
      if (fence) {
        open = { ...fence, mermaid: isMermaid(fence.info) };
        src = '';
      }
    } else if (closesFence(fence, open)) {
      if (open.mermaid) blocks.push(src);
      open = null;
    } else if (open.mermaid) {
      src += line;
    }
  }
  return blocks;
}

// Hooks run without a terminal on stdout; the controlling tty, when there is one, still knows the width.
function terminalWidth() {
  const fromEnv = Number(process.env.CLAUDE_CODE_MERMAID_WIDTH || process.env.COLUMNS);
  if (fromEnv > 0) return fromEnv;
  try {
    const tty = openSync('/dev/tty', 'r');
    try {
      const cols = Number(execFileSync('stty', ['size'], { stdio: [tty, 'pipe', 'ignore'] }).toString().trim().split(/\s+/)[1]);
      if (cols > 0) return cols - 4;
    } finally {
      closeSync(tty);
    }
  } catch {}
  return 0;
}

// Replaces each block's lines on screen with the drawing (or the untouched block if it cannot be drawn).
// Lines arrive in batches, so an open block is held back, and kept in a state file between calls.
const clearFence = (state) => {
  delete state.open;
  delete state.raw;
  delete state.src;
};

export function displayBatch(state, delta, final, width) {
  let out = '';
  for (const line of delta.split(/(?<=\n)/)) {
    const fence = parseFence(line);
    if (!state.open) {
      if (!fence) {
        out += line;
        continue;
      }
      state.open = { marker: fence.marker, length: fence.length, mermaid: isMermaid(fence.info) };
      if (state.open.mermaid) Object.assign(state, { raw: line, src: '' });
      else out += line;
    } else if (closesFence(fence, state.open)) {
      if (state.open.mermaid) {
        const { art, error } = render(state.src, width);
        out += art ? `\`\`\`\n${art}\n\`\`\`\n` : `${state.raw}${line}\n_Mermaid not rendered: ${error}_\n`;
      } else {
        out += line;
      }
      clearFence(state);
    } else if (state.open.mermaid) {
      state.raw += line;
      state.src += line;
    } else {
      out += line;
    }
  }
  if (final) {
    if (state.open?.mermaid) out += state.raw;
    clearFence(state);
  }
  return out;
}

const stateDirectory = () => join(tmpdir(), `claude-code-mermaid-${process.getuid?.() ?? 'user'}`);

function validateStateDirectory(dir) {
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error(`unsafe state directory: ${dir}`);
  }
}

function saveState(dir, file, state) {
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  validateStateDirectory(dir);
  chmodSync(dir, 0o700);
  writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
  chmodSync(file, 0o600);
}

function removeState(dir, file) {
  try {
    rmSync(file, { force: true });
  } catch (err) {
    console.error(`Mermaid state cleanup failed for ${file}: ${err.message}`);
    try {
      saveState(dir, file, {});
    } catch (sanitizeError) {
      console.error(`Mermaid state sanitization failed for ${file}: ${sanitizeError.message}`);
    }
  }
}

function hook() {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const dir = stateDirectory();
  const file = join(dir, `${input.session_id}-${input.message_id}.json`.replace(/[^\w.-]/g, '_'));
  let state = {};
  try {
    validateStateDirectory(dir);
    try {
      state = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error(`Mermaid state load failed for ${file}: ${err.message}`);
        removeState(dir, file);
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (!state.open && !/^ {0,3}(`{3,}|~{3,})/m.test(input.delta)) {
    if (input.final) removeState(dir, file);
    return;
  }
  let displayContent = displayBatch(state, input.delta, input.final, terminalWidth());
  if (input.final || !state.open) {
    removeState(dir, file);
  } else {
    try {
      saveState(dir, file, state);
    } catch (err) {
      console.error(`Mermaid state save failed for ${file}: ${err.message}`);
      if (state.open.mermaid) displayContent += state.raw;
      clearFence(state);
      removeState(dir, file);
    }
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

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMain()) {
  // A hook must never break the turn, whatever the input.
  if (process.argv[2] === '--hook') {
    try {
      hook();
    } catch (err) {
      console.error(`Mermaid hook failed: ${err.message}`);
    }
  } else cli(process.argv[2]);
}
