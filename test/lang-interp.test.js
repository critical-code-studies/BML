// createInterpreter: the language's one entry point, tested without the game.
//
// Everything here imports src/lang/index.js and nothing else. That is the
// point: if this file ever needs a game import, the seam M3 cut has leaked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInterpreter, smlEcho, BML_NAME, BML_VERSION, BML_CREDIT } from '../src/lang/index.js';

test('an interpreter with no host at all still runs Standard ML', () => {
  const bml = createInterpreter();
  assert.equal(bml.run('3 + 4').text, '7');
  bml.run('fun sq x = x * x');
  assert.equal(bml.run('sq 5').text, '25');
});

test('the session carries bindings, fixity and datatypes between lines', () => {
  const bml = createInterpreter();
  bml.run('datatype colour = Red | Green');
  assert.equal(bml.run('Red').text, 'Red');
  bml.run('fun plus (a, b) = a + b');
  bml.run('infix 6 plus');
  assert.equal(bml.run('1 plus 2 plus 3').text, '6');
});

test('strict is the default, and refuses rather than reports', () => {
  const bml = createInterpreter();
  const r = bml.run('val x : int = "hello"');
  assert.equal(r.ok, false);
  assert.match(r.text, /not the same type/);
  // Refused means not bound.
  assert.match(bml.run('x').text, /unbound variable|no such/);
});

test('report runs the line and off does not check at all', () => {
  const rep = createInterpreter({ typecheck: 'report' });
  assert.equal(rep.run('val x : int = "hello"').ok, true);
  assert.match(String(rep.typeReport('3 + 4')), /int/);

  const off = createInterpreter({ typecheck: 'off' });
  assert.equal(off.run('val x : int = "hello"').ok, true);
  assert.equal(off.typeReport('3 + 4'), null, 'off means the checker never runs');
});

test('two interpreters do not share a session', () => {
  // The reason createInterpreter exists rather than a module-level global: the
  // game needs four at once, and a test needs one that nothing else has touched.
  const a = createInterpreter();
  const b = createInterpreter();
  // A PLAIN name: the bare-word check skips anything with an underscore or a
  // dot, because a node id (OB_XXXX) and a filename (foo.ml) are legitimate
  // values in the game and must stay atoms.
  a.run('val mine = 1');
  assert.equal(a.run('mine').text, '1');
  assert.equal(b.run('mine').ok, false, "b must not see a's binding");
});

test('the host supplies builtins, and they receive the host ctx untouched', () => {
  const seen = [];
  const bml = createInterpreter({
    typecheck: 'off',
    builtins: {
      shout: { arity: 1, fn: ([v], ctx) => { seen.push(ctx.who); return { tag: 'str', v: `${v.v}!` }; } },
    },
  });
  // Quoted, because an interpreter prints Standard ML's shape unless told not to.
  assert.equal(bml.run('shout "hi"', { who: 'tester' }).text, '"hi!"');
  assert.deepEqual(seen, ['tester'], 'the host ctx reaches the builtin');
});

test('unknownName is a question the language asks, not a table it reads', () => {
  const asked = [];
  const bml = createInterpreter({
    typecheck: 'off',
    hooks: { unknownName: (name) => { asked.push(name); return `${name} is not a thing here`; } },
  });
  assert.equal(bml.run('wibble').text, 'ERR: wibble is not a thing here');
  assert.deepEqual(asked, ['wibble']);
});

test('unknownName answering null lets a bare word through as a value', () => {
  // This is what a machine's own program needs: `patrol` is the intent it chose,
  // not a typo.
  const bml = createInterpreter({ typecheck: 'off', hooks: { unknownName: () => null } });
  assert.equal(bml.run('patrol').ok, true);
});

test('with no hook at all the language uses its own words', () => {
  const bml = createInterpreter({ typecheck: 'off' });
  assert.match(bml.run('wibble').text, /unbound variable: wibble/);
});

test('loadPrelude puts the library in, written in the language', () => {
  const bml = createInterpreter({ typecheck: 'off' });
  assert.equal(bml.run('List.find (fn x => x > 1) [1,2,3]').ok, false, 'not there yet');
  bml.loadPrelude();
  assert.equal(bml.run('List.find (fn x => x > 1) [1,2,3]').text, 'SOME 2');
  assert.equal(bml.run('(fn x => x + 1) o (fn y => y * 2)').ok, true, 'o is infix from the prelude');
});

test('run never returns the raw value, because a closure holds its own env', () => {
  // Added and removed the same day: `{ok, text, value}` made every result
  // unstringifiable as soon as the value was a function.
  const bml = createInterpreter({ typecheck: 'off' });
  const r = bml.run('fn x => x');
  assert.equal('value' in r, false);
  assert.doesNotThrow(() => JSON.stringify(r));
});

test('smlEcho puts SML\'s own shape round an answer', () => {
  assert.deepEqual(smlEcho('7', 'int'), ['val it = 7 : int']);
  assert.deepEqual(smlEcho('val f = <fn>', 'int -> int'), ['val f = <fn> : int -> int']);
  assert.deepEqual(smlEcho('', 'int'), []);
});

test('the language names and credits itself', () => {
  assert.equal(BML_NAME, 'BML');
  assert.match(BML_VERSION, /^\d+\.\d+$/);
  assert.match(BML_CREDIT.join(' '), /David M\. Berry/);
  assert.match(BML_CREDIT.join(' '), /Milner.*Tofte.*Harper/);
});
