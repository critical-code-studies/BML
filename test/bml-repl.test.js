// The REPL as a program, not as a set of functions.
//
// Everything else in test/ imports the interpreter and calls it. This file
// spawns `node bin/bml.js` and talks to it over a pipe, because the things
// that break in a REPL are the things a direct call cannot reach: argument
// parsing, exit codes, whether the prompt survives an error, and whether the
// session carries bindings from one line to the next.

import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BML = new URL('../bin/bml.js', import.meta.url).pathname;

// Run the REPL with `lines` on stdin and return everything it printed. Exit
// status comes back in `.status` rather than throwing, so a test can assert on
// a failing run.
function bml(lines, args = []) {
  const r = { out: '', status: 0 };
  try {
    r.out = execFileSync('node', [BML, ...args], {
      input: Array.isArray(lines) ? `${lines.join('\n')}\n` : lines,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    r.out = `${e.stdout || ''}${e.stderr || ''}`;
    r.status = e.status;
  }
  return r;
}

function tmp(name, text) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bml-')), name);
  fs.writeFileSync(p, text);
  return p;
}

test('repl echoes a value the way Standard ML does', () => {
  const { out } = bml(['3 + 4', ':quit']);
  assert.match(out, /val it = 7 : int/);
});

test('bindings persist from one line to the next', () => {
  const { out } = bml(['val x = 10', 'x * x', ':quit']);
  assert.match(out, /val it = 100 : int/);
});

test('a declaration made on one line is callable on the next', () => {
  const { out } = bml(['fun double n = n * 2', 'double 21', ':quit']);
  assert.match(out, /val it = 42 : int/);
});

test('an infix declaration at the prompt changes how later lines parse', () => {
  const { out } = bml(['fun plus (a, b) = a + b', 'infix 6 plus', '2 plus 3', ':quit']);
  assert.match(out, /val it = 5 : int/);
});

test('strict is the default: an ill-typed line is refused', () => {
  const { out } = bml(['val x : int = "hello"', 'x', ':quit']);
  assert.match(out, /ERR:/);
  // Refused means not bound. The follow-up line must not find an x.
  assert.doesNotMatch(out, /val it = hello/);
});

test('--sloppy honours the same line and names the clash', () => {
  const { out } = bml(['val x : int = "hello"', ':quit'], ['--sloppy']);
  // v1.290: Standard ML prints a string WITH its quotes, and the REPL asks the
  // language for SML's shape. The game keeps bare strings; see `printing`.
  assert.match(out, /val x = "hello"/);
});

test('the prompt survives an error and keeps going', () => {
  const { out } = bml(['1 + "a"', '2 + 2', ':quit']);
  assert.match(out, /ERR:/);
  assert.match(out, /val it = 4 : int/);
});

test(':t reports a type without evaluating', () => {
  const { out } = bml([':t fn x => x', ':quit']);
  assert.match(out, /'a -> 'a/);
  assert.doesNotMatch(out, /val it/);
});

test('a file given on the command line runs and exits 0', () => {
  const f = tmp('ok.ml', 'fun fact 0 = 1\n  | fact n = n * fact (n - 1)\n\nval answer = fact 5\n');
  const { out, status } = bml('', [f]);
  assert.equal(status, 0);
  assert.match(out, /val answer = 120 : int/);
});

test('a file that fails stops there and exits non-zero', () => {
  const f = tmp('bad.ml', 'val a = 1\n\n1 + "a"\n\nval b = 2\n');
  const { out, status } = bml('', [f]);
  assert.notEqual(status, 0);
  assert.match(out, /stopped in/);
  assert.doesNotMatch(out, /val b/);   // nothing after the error was run
});

test('-i runs the file and then hands over the prompt', () => {
  const f = tmp('lib.ml', 'val greeting = 6 * 7\n');
  const { out } = bml(['greeting', ':quit'], ['-i', f]);
  assert.match(out, /val it = 42 : int/);
});

test('use "file" reads a file in from the prompt', () => {
  const f = tmp('used.ml', 'val fromFile = 99\n');
  const { out } = bml([`use "${f}";`, 'fromFile', ':quit']);
  assert.match(out, /val it = 99 : int/);
});

test('a missing file is reported, not thrown', () => {
  const { out, status } = bml('', ['/nonexistent/nope.ml']);
  assert.match(out, /cannot read/);
  assert.notEqual(status, 0);
});

test('--help prints the credit and exits 0', () => {
  const { out, status } = bml('', ['--help']);
  assert.equal(status, 0);
  assert.match(out, /David M\. Berry/);
  assert.match(out, /Milner/);
});

test('the prelude is loaded before the first line', () => {
  const { out } = bml(['List.map (fn x => x + 1) [1,2,3]', ':quit']);
  assert.match(out, /\[2, 3, 4\]/);
});

// ---- the banner, help, and a closed pipe (v0.1.0) ----------------------------

test('the banner says who made it, where, and which build', () => {
  // A screenshot of a session should carry its own provenance.
  const { out } = bml([':quit']);
  assert.match(out, /BML \d+\.\d+\.\d+, a little Standard ML/);
  assert.match(out, /David M\. Berry, University of Sussex, 2026/);
  assert.match(out, /Milner, Mads Tofte and Robert Harper/);
  assert.match(out, /strict: a line that does not typecheck will not run/);
});

test('--sloppy says so in the banner rather than leaving you to guess', () => {
  const { out } = bml([':quit'], ['--sloppy']);
  assert.match(out, /advisory: a clash is named and the line runs anyway/);
});

test('help works, and it is not a language expression', () => {
  // In the game the console intercepts `help` before evaluation, and that
  // interception lives in the game's adapter. Out here `help` was an unbound
  // variable until v0.1.0.
  for (const word of ['help', ':help', '?']) {
    const { out } = bml([word, ':quit']);
    assert.doesNotMatch(out, /unbound variable/, `${word} should be understood`);
    assert.match(out, /DECLARATIONS/);
    assert.match(out, /AT THE PROMPT/);
  }
});

test('help lists forms the language actually has', () => {
  const { out } = bml(['help', ':quit']);
  for (const form of ['datatype', 'signature', 'functor', 'handle', 'infix', 'ListPair']) {
    assert.match(out, new RegExp(form), `help should mention ${form}`);
  }
});

test('a closed pipe is not an error', () => {
  // `bml | head -1` shuts stdout while readline is still writing a prompt, and
  // node turned that into an unhandled EPIPE and a stack trace.
  const out = execFileSync('sh', ['-c', `printf ':quit\\n' | node ${BML} 2>&1 | head -1`], { encoding: 'utf8' });
  assert.doesNotMatch(out, /EPIPE|Unhandled|at Socket/);
  assert.match(out, /BML/);
});
