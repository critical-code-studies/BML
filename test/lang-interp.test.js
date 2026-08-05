// createInterpreter: the language's one entry point, tested without the game.
//
// Everything here imports src/lang/index.js and nothing else. That is the
// point: if this file ever needs a game import, the seam M3 cut has leaked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInterpreter, smlEcho, flattenSession, BML_NAME, BML_VERSION, BML_CREDIT } from '../src/index.js';

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
  assert.match(BML_VERSION, /^\d+\.\d+\.\d+$/, 'semver, and the package.json must agree');
  assert.match(BML_CREDIT.join(' '), /David M\. Berry/);
  assert.match(BML_CREDIT.join(' '), /Milner.*Tofte.*Harper/);
});

// ---- lexical scope at the top level (v1.291) ---------------------------------

test('a top-level rebinding does not overwrite what a closure captured', () => {
  // The defect this closes. `Lam` always captured its environment correctly and
  // `Let` always opened a scope; the top level wrote straight into the session,
  // so rebinding a name changed the value an existing closure was reading.
  const bml = createInterpreter({ typecheck: 'off' });
  bml.run('val n = 10');
  bml.run('fun addn m = m + n');
  bml.run('val n = 99');
  assert.equal(bml.run('addn 1').text, '11', 'Standard ML says 11, not 100');
  assert.equal(bml.run('n').text, '99', 'and the new binding is what n means now');
});

test('the same holds for a pattern binding', () => {
  const bml = createInterpreter({ typecheck: 'off' });
  bml.run('val (a, b) = (1, 2)');
  bml.run('fun getA () = a');
  bml.run('val (a, b) = (9, 9)');
  assert.equal(bml.run('getA ()').text, '1');
  assert.equal(bml.run('a').text, '9');
});

test('shadowing does not break recursion, which needs the live environment', () => {
  const bml = createInterpreter({ typecheck: 'off' });
  bml.run('fun fact 0 = 1 | fact k = k * fact (k - 1)');
  assert.equal(bml.run('fact 5').text, '120');
  // Redefining it must take effect, and the old one must not be consulted.
  bml.run('fun fact k = 0');
  assert.equal(bml.run('fact 5').text, '0');
});

test('a long chain of rebindings still resolves to the newest', () => {
  const bml = createInterpreter({ typecheck: 'off' });
  for (let i = 0; i < 60; i++) bml.run(`val counter = ${i}`);
  assert.equal(bml.run('counter').text, '59');
});

test('flattenSession keeps every visible binding across the chain', () => {
  const bml = createInterpreter({ typecheck: 'off' });
  bml.run('val a = 1');
  bml.run('val b = 2');
  bml.run('val a = 3');          // pushes a frame; `a` is no longer an own property
  const flat = flattenSession(bml.session);
  assert.equal(flat.a.v, 3, 'the newest value of a rebound name');
  assert.equal(flat.b.v, 2, 'and a name bound on an older frame');
});

test('flattenSession drops what cannot survive a save, and does not throw', () => {
  // A closure holds the env that holds the closure. Serialising a session with a
  // function in it threw, and in NostOS the throw was swallowed by the catch
  // around localStorage, so the game stopped saving without saying so.
  const bml = createInterpreter({ typecheck: 'off' });
  bml.run('val kept = 42');
  bml.run('val f = fn x => x + 1');
  const flat = flattenSession(bml.session);
  assert.doesNotThrow(() => JSON.stringify(flat));
  // Names are stored lower-cased, which is its own departure from Standard ML
  // and not this test's business.
  assert.equal(flat.kept.v, 42, 'ordinary values survive');
  assert.equal('f' in flat, false, 'the closure is left out rather than breaking the save');
});

// ---- qualified names have types (v1.293) -------------------------------------

test('a structure member reports its own type, not a fresh variable', () => {
  // `:t List.partition` answered `'a`. The parser makes `List.partition` ONE
  // Var whose name contains a dot; the checker looked up `list.partition`,
  // missed, and fell through to the fresh-variable case that exists so the
  // game's world-reaching verbs do not have to be typed. Nothing had ever
  // recorded a member's type because `infer` had no case for a structure at all.
  const bml = createInterpreter({ typecheck: 'report' });
  bml.loadPrelude();
  assert.equal(bml.typeReport('List.partition'), "('a -> bool) -> 'a list -> 'a list * 'a list");
  assert.equal(bml.typeReport('List.map'), "('a -> 'b) -> 'a list -> 'b list");
  assert.equal(bml.typeReport('List.filter'), "('a -> bool) -> 'a list -> 'a list");
  assert.equal(bml.typeReport('String.size'), 'string -> int');
});

test('a structure you declare yourself is typed the same way', () => {
  const bml = createInterpreter({ typecheck: 'report' });
  bml.run('structure M = struct fun double x = x * 2 val label = "m" end');
  assert.equal(bml.typeReport('M.double'), 'int -> int');
  assert.equal(bml.typeReport('M.label'), 'string');
});

test('a member that will not type does not stop the rest of the structure', () => {
  // The console reports rather than gates, and a structure is not all-or-nothing.
  const bml = createInterpreter({ typecheck: 'report' });
  bml.run('structure M = struct fun ok x = x + 1 val bad = 1 + "no" fun also y = y end');
  assert.equal(bml.typeReport('M.ok'), 'int -> int');
  assert.match(String(bml.typeReport('M.also')), /->/, 'the member after the bad one is still typed');
});

test('an unknown name still falls back rather than erroring', () => {
  // The fallback is deliberate: the game has verbs that reach into the world and
  // refusing them would make inference a gate rather than a report.
  const bml = createInterpreter({ typecheck: 'report' });
  assert.equal(bml.typeReport('someVerbTheHostSupplies'), "'a");
});
