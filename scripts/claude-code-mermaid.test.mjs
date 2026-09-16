import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { displayBatch, mermaidBlocks, render } from './claude-code-mermaid.mjs';

const script = fileURLToPath(new URL('./claude-code-mermaid.mjs', import.meta.url));
const stableEnv = (env = {}) => ({
  ...process.env,
  CLAUDE_CODE_MERMAID_WIDTH: '200',
  COLUMNS: '200',
  ...(env.TMPDIR && { TEMP: env.TMPDIR, TMP: env.TMPDIR }),
  ...env,
});
const run = (args, { env = {}, ...options } = {}) =>
  spawnSync(process.execPath, args, { encoding: 'utf8', ...options, env: stableEnv(env) });
const hook = (payload, env = {}) => {
  const result = run([script, '--hook'], { input: payload, env });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};
const tempDir = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-code-mermaid-test-'));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  return dir;
};
const hookStateDir = (root) => join(root, `claude-code-mermaid-${process.getuid?.() ?? 'user'}`);

test('draws a flowchart with unescaped labels', () => {
  const { art } = render('graph TD\n  A[a & b] --> B[<end>]');
  assert.match(art, /a & b/);
  assert.match(art, /<end>/);
  assert.match(art, /▼/);
});

test('reports unsupported types and overly wide diagrams instead of the framed source', () => {
  assert.equal(render('pie\n "a": 1').error, 'unsupported diagram type or syntax error');
  const wide = `graph LR\n${Array.from({ length: 12 }, (_, i) => `  N${i}[node ${i}] --> N${i + 1}[node ${i + 1}]`).join('\n')}`;
  assert.equal(render(wide, 40).error, 'wider than 40 columns');
  assert.ok(render(wide).art);
});

test('extracts only mermaid fences, tilde or backtick', () => {
  const md = '```js\nx\n```\n```mermaid\ngraph TD\nA-->B\n```\n~~~~ mermaid\nsequenceDiagram\nA->>B: hi\n~~~~\n';
  assert.deepEqual(mermaidBlocks(md), ['graph TD\nA-->B\n', 'sequenceDiagram\nA->>B: hi\n']);
});

test('replaces a block split across batches with its drawing, holding it back meanwhile', () => {
  const state = {};
  assert.equal(displayBatch(state, 'Plan:\n```mermaid\ngraph TD\n', false, 80), 'Plan:\n');
  const out = displayBatch(state, 'A[Start]-->B[End]\n```\nDone.\n', true, 80);
  assert.match(out, /^```\n[\s\S]*Start[\s\S]*End[\s\S]*\n```\nDone\.\n$/);
  assert.doesNotMatch(out, /-->/);
});

test('keeps the source when the block cannot be drawn or never closes', () => {
  const bad = displayBatch({}, '```mermaid\npie\n "a": 1\n```\n', true, 80);
  assert.match(bad, /^```mermaid\npie\n "a": 1\n```\n\n_Mermaid not rendered: unsupported/);
  assert.equal(displayBatch({}, '```mermaid\ngraph TD\nA-->B', true, 80), '```mermaid\ngraph TD\nA-->B');
});

test('hook passes through text without mermaid and survives bad input', () => {
  assert.equal(hook(JSON.stringify({ session_id: 's', message_id: 'm', index: 0, final: true, delta: 'hi\n' })), '');
  assert.equal(hook('not json'), '');
  const out = JSON.parse(
    hook(JSON.stringify({ session_id: 's', message_id: 'm2', index: 0, final: true, delta: '```mermaid\ngraph TD\nA-->B\n```\n' })),
  );
  assert.equal(out.hookSpecificOutput.hookEventName, 'MessageDisplay');
  assert.match(out.hookSpecificOutput.displayContent, /┌/);
});

test('ignores literal mermaid fences nested in a larger fenced block', () => {
  const literal = '````text\n```mermaid\ngraph TD\nA-->B\n```\n````\n';
  assert.deepEqual(mermaidBlocks(literal), []);

  const state = {};
  assert.equal(displayBatch(state, '````text\n```mermaid\ngraph TD\n', false, 80), '````text\n```mermaid\ngraph TD\n');
  assert.equal(displayBatch(state, 'A-->B\n```\n````\n', true, 80), 'A-->B\n```\n````\n');
});

test('accepts a closing mermaid fence longer than its opener', () => {
  const markdown = '```mermaid\ngraph TD\nA[Open]-->B[Closed]\n````\n';
  assert.deepEqual(mermaidBlocks(markdown), ['graph TD\nA[Open]-->B[Closed]\n']);

  const out = displayBatch({}, markdown, true, 80);
  assert.match(out, /Open/);
  assert.match(out, /Closed/);
  assert.doesNotMatch(out, /-->/);
});

test('does not close a mermaid block with a fence carrying info', () => {
  const markdown = '```mermaid\ngraph TD\nA-->B\n```text\n```\n';
  assert.deepEqual(mermaidBlocks(markdown), ['graph TD\nA-->B\n```text\n']);

  const state = {};
  assert.equal(displayBatch(state, '```mermaid\ngraph TD\nA-->B\n```text\n', false, 80), '');
  assert.match(displayBatch(state, '```\n', true, 80), /A[\s\S]*B/);
});

test('requires ASCII whitespace on a closing fence', () => {
  const markdown = '```mermaid\ngraph TD\nA-->B\n```\u00a0\nC-->D\n```\n';
  assert.deepEqual(mermaidBlocks(markdown), ['graph TD\nA-->B\n```\u00a0\nC-->D\n']);
});

test('does not treat inline backticks as a fenced block', () => {
  const markdown = '```mermaid``` is inline text\n```mermaid\ngraph TD\nA-->B\n```\n';
  assert.deepEqual(mermaidBlocks(markdown), ['graph TD\nA-->B\n']);
  assert.match(displayBatch({}, markdown, true, 80), /^```mermaid``` is inline text\n[\s\S]*A[\s\S]*B/);
});

test('renders sequence, state, class, and ER diagrams', () => {
  const diagrams = {
    sequence: ['sequenceDiagram\nAlice->>Bob: hello', /Alice/],
    state: ['stateDiagram-v2\n[*] --> Ready\nReady --> [*]', /Ready/],
    class: ['classDiagram\nAnimal <|-- Duck', /Animal/],
    er: ['erDiagram\nCUSTOMER ||--o{ ORDER : places', /CUSTOMER/],
  };
  for (const [type, [source, label]] of Object.entries(diagrams)) {
    const { art, error } = render(source);
    assert.ok(art, `${type}: ${error}`);
    assert.match(art, label);
  }
});

test('hook processes keep message streams isolated in their TMPDIR', (t) => {
  const root = tempDir(t);
  const env = { TMPDIR: root };
  const firstStart = JSON.parse(
    hook(JSON.stringify({ session_id: 'shared', message_id: 'first', index: 0, final: false, delta: '```mermaid\ngraph TD\n' }), env),
  );
  assert.equal(firstStart.hookSpecificOutput.displayContent, '');
  assert.ok(existsSync(join(hookStateDir(root), 'shared-first.json')));

  const second = JSON.parse(
    hook(JSON.stringify({ session_id: 'shared', message_id: 'second', index: 0, final: true, delta: '```mermaid\ngraph TD\nC[Second]-->D[Done]\n```\n' }), env),
  );
  assert.match(second.hookSpecificOutput.displayContent, /Second/);

  const firstEnd = JSON.parse(
    hook(JSON.stringify({ session_id: 'shared', message_id: 'first', index: 1, final: true, delta: 'A[First]-->B[Done]\n```\n' }), env),
  );
  assert.match(firstEnd.hookSpecificOutput.displayContent, /First/);
  assert.doesNotMatch(firstEnd.hookSpecificOutput.displayContent, /Second/);
});

test('removes completed hook state', (t) => {
  const root = tempDir(t);
  const env = { TMPDIR: root };
  const stateFile = join(hookStateDir(root), 'cleanup-message.json');
  hook(JSON.stringify({ session_id: 'cleanup', message_id: 'message', index: 0, final: false, delta: '```mermaid\ngraph TD\n' }), env);
  assert.ok(existsSync(stateFile));

  const out = JSON.parse(
    hook(JSON.stringify({ session_id: 'cleanup', message_id: 'message', index: 1, final: true, delta: 'A-->B\n```\n' }), env),
  );
  assert.match(out.hookSpecificOutput.displayContent, /┌/);
  assert.equal(existsSync(stateFile), false);
});

test('removes state as soon as a streamed block closes', (t) => {
  const root = tempDir(t);
  const env = { TMPDIR: root };
  const stateFile = join(hookStateDir(root), 'cleanup-early.json');
  hook(JSON.stringify({ session_id: 'cleanup', message_id: 'early', index: 0, final: false, delta: '```mermaid\ngraph TD\n' }), env);

  const closed = JSON.parse(
    hook(JSON.stringify({ session_id: 'cleanup', message_id: 'early', index: 1, final: false, delta: 'A-->B\n```\n' }), env),
  );
  assert.match(closed.hookSpecificOutput.displayContent, /┌/);
  assert.equal(existsSync(stateFile), false);
  assert.equal(hook(JSON.stringify({ session_id: 'cleanup', message_id: 'early', index: 2, final: true, delta: '' }), env), '');
});

test('stores unfinished hook state in private POSIX paths', (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX permission bits are unavailable on Windows');
    return;
  }
  const root = tempDir(t);
  const env = { TMPDIR: root };
  const dir = hookStateDir(root);
  const file = join(dir, 'private-state.json');
  hook(JSON.stringify({ session_id: 'private', message_id: 'state', index: 0, final: false, delta: '```mermaid\ngraph TD\n' }), env);

  assert.equal(statSync(dir).mode & 0o077, 0);
  assert.equal(statSync(dir).mode & 0o700, 0o700);
  assert.equal(statSync(file).mode & 0o077, 0);
  assert.equal(statSync(file).mode & 0o600, 0o600);
});

test('emits rendered output when state cleanup fails', (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) {
    t.skip('requires non-root POSIX directory permissions');
    return;
  }
  const root = tempDir(t);
  const env = { TMPDIR: root };
  const dir = hookStateDir(root);
  const file = join(dir, 'locked-state.json');
  hook(JSON.stringify({ session_id: 'locked', message_id: 'state', index: 0, final: false, delta: '```mermaid\ngraph TD\n' }), env);
  chmodSync(dir, 0o500);

  try {
    const result = run([script, '--hook'], {
      input: JSON.stringify({ session_id: 'locked', message_id: 'state', index: 1, final: true, delta: 'A[Visible]-->B[Done]\n```\n' }),
      env,
    });
    assert.equal(result.status, 0);
    assert.match(JSON.parse(result.stdout).hookSpecificOutput.displayContent, /Visible/);
    assert.match(result.stderr, /Mermaid state cleanup failed/);
    assert.equal(readFileSync(file, 'utf8'), '{}');
  } finally {
    chmodSync(dir, 0o700);
  }
});

test('falls back to buffered source when state persistence fails', (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) {
    t.skip('requires non-root POSIX file permissions');
    return;
  }
  const root = tempDir(t);
  const env = { TMPDIR: root };
  const dir = hookStateDir(root);
  const file = join(dir, 'locked-save.json');
  mkdirSync(dir, { mode: 0o700 });
  writeFileSync(file, '{}', { mode: 0o400 });

  const result = run([script, '--hook'], {
    input: JSON.stringify({
      session_id: 'locked',
      message_id: 'save',
      index: 0,
      final: false,
      delta: 'Before\n```mermaid\ngraph TD\n',
    }),
    env,
  });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.displayContent, 'Before\n```mermaid\ngraph TD\n');
  assert.match(result.stderr, /Mermaid state save failed/);
  assert.equal(existsSync(file), false);
});

test('removes corrupt state and reports the load failure', (t) => {
  const root = tempDir(t);
  const env = { TMPDIR: root };
  const dir = hookStateDir(root);
  const file = join(dir, 'corrupt-state.json');
  mkdirSync(dir, { mode: 0o700 });
  writeFileSync(file, '{', { mode: 0o600 });

  const result = run([script, '--hook'], {
    input: JSON.stringify({ session_id: 'corrupt', message_id: 'state', index: 1, final: true, delta: 'Done\n' }),
    env,
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Mermaid state load failed/);
  assert.equal(existsSync(file), false);
});

test('rejects a symlinked hook state directory', (t) => {
  if (process.platform === 'win32') {
    t.skip('directory symlink creation may require privileges on Windows');
    return;
  }
  const root = tempDir(t);
  const target = join(root, 'target');
  mkdirSync(target);
  symlinkSync(target, hookStateDir(root), 'dir');

  const result = run([script, '--hook'], {
    input: JSON.stringify({ session_id: 'unsafe', message_id: 'state', index: 0, final: false, delta: '```mermaid\ngraph TD\n' }),
    env: { TMPDIR: root },
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Mermaid hook failed: unsafe state directory/);
  assert.equal(existsSync(join(target, 'unsafe-state.json')), false);
});

test('CLI renders valid Markdown blocks, reports unsupported blocks, and fails', () => {
  const result = run([script], {
    input: '```mermaid\ngraph TD\nA[Valid]-->B[Diagram]\n```\n\n```mermaid\npie\n "a": 1\n```\n',
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Valid/);
  assert.equal(result.stderr, 'not rendered: unsupported diagram type or syntax error\n');
});

test('CLI uses an explicit render width instead of ambient width variables', () => {
  const wide = `graph LR\n${Array.from({ length: 12 }, (_, i) => `N${i}[node ${i}] --> N${i + 1}[node ${i + 1}]`).join('\n')}`;
  const result = run([script], {
    input: wide,
    env: { CLAUDE_CODE_MERMAID_WIDTH: '40', COLUMNS: '200' },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'not rendered: wider than 40 columns\n');
});

test('module import tolerates a nonexistent argv entry path', () => {
  const result = run([
    '--input-type=module',
    '--eval',
    `await import(${JSON.stringify(pathToFileURL(script).href)})`,
    'missing-entry-path',
  ]);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
});

test('CLI runs from a copied scripts directory with a space in its path', (t) => {
  const root = tempDir(t);
  const copiedDir = join(root, 'scripts with spaces');
  mkdirSync(copiedDir);
  copyFileSync(script, join(copiedDir, 'claude-code-mermaid.mjs'));
  copyFileSync(join(dirname(script), 'grok-mermaid.wasm'), join(copiedDir, 'grok-mermaid.wasm'));

  const result = run([join(copiedDir, 'claude-code-mermaid.mjs')], { input: 'graph TD\nA[Copied]-->B[Works]\n' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Copied/);
  assert.equal(result.stderr, '');
});
