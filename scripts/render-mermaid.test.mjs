import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { displayBatch, mermaidBlocks, render } from './render-mermaid.mjs';

const script = new URL('./render-mermaid.mjs', import.meta.url).pathname;
const hook = (payload, env = {}) =>
  execFileSync('node', [script, '--hook'], { input: payload, env: { ...process.env, ...env } }).toString();

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
