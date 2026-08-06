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

test('there are two questions about an unknown name, and they are separate', () => {
  // `unknownName` is asked at the TOP LEVEL only: is a bare word typed as a
  // whole line a typo? Answering null means "let it through". That used to be
  // enough, because the evaluator then turned any unbound name into an atom.
  // Since v1.299 it does not — an unbound name is an error, as it is in
  // Standard ML — so a host that wants bare words as values must also say what
  // one IS. NostOS answers both; the language alone answers neither.
  const passesTheTypoCheck = createInterpreter({
    typecheck: 'off', hooks: { unknownName: () => null },
  });
  assert.equal(passesTheTypoCheck.run('patrol').ok, false, 'still unbound: nothing said what it is');
  assert.match(passesTheTypoCheck.run('patrol').text, /unbound variable/);
});

test('an unbound name is an error, which is what Standard ML says', () => {
  // D-55, and the mechanism behind D-04. `val x = notbound` used to bind the
  // typo to an atom of its own spelling and say nothing.
  const bml = createInterpreter({ typecheck: 'off' });
  assert.equal(bml.run('val x = notbound').ok, false);
  assert.match(bml.run('val x = notbound').text, /unbound variable: notbound/);
});

test('a name hidden by an opaque signature is refused, not spelled back', () => {
  // D-04. It came back as the atom `T.hidden`, so `:>` looked like it worked.
  const bml = createInterpreter({ typecheck: 'off' });
  bml.run('signature SIG = sig val v : int end');
  bml.run('structure T :> SIG = struct val v = 1 val hidden = 2 end');
  assert.equal(bml.run('T.v').text, '1', 'what the signature shows is there');
  assert.equal(bml.run('T.hidden').ok, false, 'what it hides is not');
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

test('a multi-argument constructor typechecks in both spellings', () => {
  // `N (a, b, c)` is Standard ML's; `N a b c` is this build's curried form. The
  // evaluator learned both in v1.282 and the checker did not, so a tree program
  // that ran perfectly under advisory was REFUSED by strict — which is the
  // default, so the default mode rejected correct code. It needed fixing on the
  // pattern side too: a clausal `fun` matches before it builds.
  const bml = createInterpreter({ typecheck: 'strict' });
  bml.run('datatype t = L | N of t * int * t');
  assert.equal(bml.run('N (L, 1, L)').ok, true, 'tuple form, as SML writes it');
  assert.equal(bml.run('N L 1 L').ok, true, 'curried form');
  const r = bml.run('fun ins (L, x) = N (L, x, L) | ins (N (l,v,r), x) = N (l, v, r)');
  assert.equal(r.ok, true, `a clausal fun over both: ${r.text}`);
  // `(t * int) -> t` and not `(t * 'a) -> t`: since v1.296 the checker reads the
  // types a constructor was DECLARED to carry, so `N of t * int * t` says what x is.
  assert.equal(bml.typeReport('ins'), '(t * int) -> t');
});

test('andalso binds tighter than orelse, as it does in Standard ML', () => {
  // Reported from the departure register (D-01). Both were parsed at one flat
  // level and therefore purely left to right, so this read as
  // `(true orelse true) andalso false` and answered FALSE. A wrong answer with
  // no error, in the operator anyone writing a guard reaches for.
  const bml = createInterpreter({ typecheck: 'off' });
  assert.equal(bml.run('true orelse true andalso false').text, 'true');
  assert.equal(bml.run('false andalso true orelse true').text, 'true');
  assert.equal(bml.run('true andalso false orelse true').text, 'true');
  assert.equal(bml.run('false orelse false andalso true').text, 'false');
  // `and` is also the separator between simultaneous bindings, and still is.
  assert.equal(bml.run('let val a = 1 and b = 2 in a + b end').text, '3');
});

test('unit has a type', () => {
  // D-40: `()` had no case in the checker and took the fresh-variable fallback.
  const bml = createInterpreter({ typecheck: 'report' });
  assert.equal(bml.typeReport('()'), 'unit');
});

test('a constructor carries the type it was declared to carry', () => {
  // The parser counted a constructor's arguments and threw their types away, so
  // `datatype shape = Circle of real` told the checker only that Circle takes
  // one thing, and `fun area (Rect (w, h)) = w * h` inferred int.
  const bml = createInterpreter({ typecheck: 'report' });
  bml.run('datatype shape = Circle of real | Rect of real * real');
  assert.equal(bml.typeReport('Circle'), 'real -> shape');
  bml.run('fun area (Rect (w, h)) = w * h');
  assert.equal(bml.typeReport('area'), 'shape -> real');
  // A recursive datatype knows its own name.
  bml.run('datatype tree = Leaf | Node of tree * int * tree');
  assert.equal(bml.typeReport('Node'), 'tree -> int -> tree -> tree');
});

test('strings and characters are ordered', () => {
  // D-30 and D-31: comparison was numbers only, so nothing but numbers sorted.
  const bml = createInterpreter({ typecheck: 'off' });
  assert.equal(bml.run('"a" < "b"').text, 'true');
  assert.equal(bml.run('"abc" < "abd"').text, 'true');
  assert.equal(bml.run('"b" <= "b"').text, 'true');
  assert.equal(bml.run('"z" < "a"').text, 'false');
  assert.equal(bml.run('#"a" < #"b"').text, 'true');
});

test('valOf, isSome and getOpt are at top level as well as in Option', () => {
  const bml = createInterpreter({ typecheck: 'off' });
  bml.loadPrelude();
  assert.equal(bml.run('valOf (SOME 2)').text, '2');
  assert.equal(bml.run('isSome NONE').text, 'false');
  assert.equal(bml.run('getOpt (NONE, 9)').text, '9');
});

// ---- nine departures closed (v1.299) ----------------------------------------

test('a signature abbreviation inherits the names it abbreviates', () => {
  // D-05, and the cause is worth keeping: `isKeyword` lowercases, so a
  // signature NAMED `SIG` looked like the keyword `sig` and
  // `signature ABBR = SIG` parsed as an empty `sig … end` block.
  const bml = createInterpreter({ typecheck: 'off' });
  bml.run('signature SIG = sig val v : int end');
  bml.run('signature ABBR = SIG');
  bml.run('structure U :> ABBR = struct val v = 3 end');
  assert.equal(bml.run('U.v').text, '3');
});

test('val rec binds the function, not a variable called rec', () => {
  // D-07. `rec` was read as the name, so `fact` never bound at all.
  const bml = createInterpreter({ typecheck: 'off' });
  bml.run('val rec fact = fn n => if n = 0 then 1 else n * fact (n - 1)');
  assert.equal(bml.run('fact 6').text, '720');
});

test('comments nest, which the Definition says in section 2.3', () => {
  const bml = createInterpreter({ typecheck: 'off' });
  assert.equal(bml.run('(* outer (* inner *) still outer *) 2').text, '2');
  assert.equal(bml.run('(* (* (* deep *) *) *) 4').text, '4');
});

test('hex and scientific literals', () => {
  const bml = createInterpreter({ typecheck: 'off' });
  assert.equal(bml.run('0x1F').text, '31');
  assert.equal(bml.run('0xff').text, '255');
  assert.equal(bml.run('1e3').text, '1000.0');
  assert.equal(bml.run('1.5e2').text, '150.0');
  // SML writes a negative exponent with a tilde, like every other negative.
  assert.equal(bml.run('2.0e~3').text, '0.002');
});

test('whitespace is allowed between ~ and what it negates', () => {
  const bml = createInterpreter({ typecheck: 'off' });
  assert.equal(bml.run('~ 3 + 4').text, '1');
  assert.equal(bml.run('~3').text, '~3');
  assert.equal(bml.run('~ (2 + 1)').text, '~3');
});

test('and is simultaneous for values and still recursive for functions', () => {
  // D-53. Every right-hand side sees what was in scope BEFORE the declaration,
  // which is the whole difference between `and` and two declarations in a row.
  const bml = createInterpreter({ typecheck: 'off' });
  bml.run('val u = 1');
  bml.run('val u = 2 and w = u');
  assert.equal(bml.run('w').text, '1', 'w saw the OLD u');
  assert.equal(bml.run('u').text, '2', 'and u is the new one');
  bml.run('val a = 1 and b = 2');
  assert.equal(bml.run('a + b').text, '3');
  // `fun` chains must NOT be held back: mutual recursion needs each name in
  // scope while the others are defined.
  bml.run('fun ev n = if n = 0 then true else od (n-1) and od n = if n = 0 then false else ev (n-1)');
  assert.equal(bml.run('ev 4').text, 'true');
});

test('print is Basis and writes a string', () => {
  const bml = createInterpreter({ typecheck: 'off' });
  bml.loadPrelude();
  assert.equal(bml.run('print "hello"').ok, true);
});

// ---- six more departures closed (v1.300) ------------------------------------

test('open brings a structure\'s names into scope', () => {
  const bml = createInterpreter({ typecheck: 'off' });
  bml.loadPrelude();
  bml.run('open List');
  assert.equal(bml.run('map (fn x => x + 1) [1,2]').text, '[2, 3]');
  assert.equal(bml.run('filter (fn x => x > 1) [1,2,3]').text, '[2, 3]');
  assert.match(bml.run('open NoSuch').text, /no structure NoSuch/);
});

test('while is sugar for a recursive function, and the budget still bounds it', () => {
  const bml = createInterpreter({ typecheck: 'off' });
  assert.equal(bml.run('while false do ()').text, '()');
  bml.run('val r = ref 0');
  bml.run('val s = ref 0');
  bml.run('while !r < 5 do (s := !s + !r; r := !r + 1)');
  assert.equal(bml.run('!s').text, '10');
  assert.equal(bml.run('!r').text, '5');
  // A loop that never ends faults rather than hanging: evalNode counts a step
  // on entry, so the budget bounds the loop with no extra plumbing.
  const runaway = createInterpreter({ typecheck: 'off' });
  assert.equal(runaway.run('while true do ()', { fuel: 500 }).ok, false);
});

test('a local declaration reports what it bound, not a structure', () => {
  // D-06. `local` is implemented as an anonymous structure and echoed as one,
  // so `local val secret = 9 in val vis = secret + 1 end` answered
  // "structure local : 1 name(s)" and told you nothing about vis.
  const bml = createInterpreter({ typecheck: 'off' });
  assert.equal(bml.run('local val secret = 9 in val vis = secret + 1 end').text, 'val vis = 10');
  assert.equal(bml.run('vis').text, '10');
  assert.equal(bml.run('secret').ok, false, 'and what it hides stays hidden');
});

test('an and-chain reports every binding it made', () => {
  // D-08. Both names always bound; only the echo dropped all but the last.
  const bml = createInterpreter({ typecheck: 'off' });
  assert.equal(bml.run('val a = 1 and b = 2').text, 'val a = 1\nval b = 2');
  assert.match(bml.run('fun f x = x and g x = x + 1').text, /val f = <fn>\nval g = <fn>/);
});

test('a projection written out against a value written out has a type', () => {
  // D-42. The general case needs row polymorphism and still answers a fresh
  // variable; this is the case anyone writes at a prompt.
  const bml = createInterpreter({ typecheck: 'report' });
  assert.equal(bml.typeReport('#1 (1, 2)'), 'int');
  assert.equal(bml.typeReport('#2 (1, "a")'), 'string');
  assert.equal(bml.typeReport('#name {name = "x", n = 1}'), 'string');
  assert.equal(bml.typeReport('#n {name = "x", n = 1}'), 'int');
});

test('a declaration that binds a type reports no value type', () => {
  // D-44. `datatype colour = Red | Green : unit` invited the reading that the
  // declaration IS a unit.
  assert.deepEqual(smlEcho('datatype t = A | B', 'unit'), ['datatype t = A | B']);
  assert.deepEqual(smlEcho('exception Fail', 'unit'), ['exception Fail']);
  assert.deepEqual(smlEcho('val x = 1', 'int'), ['val x = 1 : int']);
});
