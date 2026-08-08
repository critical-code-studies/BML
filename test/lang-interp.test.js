// createInterpreter: the language's one entry point, tested without the game.
//
// Everything here imports src/lang/index.js and nothing else. That is the
// point: if this file ever needs a game import, the seam M3 cut has leaked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createInterpreter, smlEcho, flattenSession, showReal, BML_NAME, BML_VERSION, BML_CREDIT } from '../src/index.js';
import { DECL_KEYWORDS, BLOCK_ENDERS, joinProgram } from '../src/parse.js';

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

test('the checker refuses an unbound name unless a host claims it', () => {
  // It used to answer `'a` for any name nothing had bound, so `:t nosuchthing`
  // reported a type for a name that does not exist. That is what made `:t map`
  // look like a typing bug when `map` is simply not bound at top level — only
  // `List.map` is — and the evaluator had said `unbound variable` since v1.299.
  //
  // The reason for the fallback was a GAME reason, so it moved to a host hook,
  // the twin of the evaluator's `setHostUnbound`. NostOS answers for its bare
  // words; nothing answers in BML, so BML does what Standard ML does.
  const bml = createInterpreter({ typecheck: 'report' });
  assert.match(bml.typeReport('someVerbTheHostSupplies'), /unbound variable/);
  assert.match(bml.typeReport('map'), /unbound variable/, 'map is List.map, not a top-level name');
  assert.equal(bml.typeReport('hd'), "'a list -> 'a", 'a name that IS bound still types');

  // A QUALIFIED name keeps the fallback, and the line is about whose gap it is.
  // The checker cannot always work out what a structure holds — the result of a
  // functor application is the standing case — so refusing there would reject a
  // correct program on the checker's own incompleteness. examples/07-modules.ml
  // is exactly that program.
  assert.equal(bml.typeReport('Whatever.member'), "'a");
});

test('the whole Basis types, which needs recursive members bound first', () => {
  // Every function in the Basis names itself in its own body. The structure
  // member walk did not bind the member's own name before inferring it, so the
  // self-reference was unbound — invisible while an unbound name quietly became
  // a fresh variable, and total the moment the checker started refusing: every
  // recursive member was dropped, and strict mode refused the standard library.
  for (const mode of ['report', 'strict']) {
    const bml = createInterpreter({ typecheck: mode });
    bml.loadPrelude();
    assert.equal(bml.run('List.map (fn x => x + 1) [1, 2]').text, '[2, 3]', `${mode}: List.map runs`);
    assert.equal(bml.typeReport('List.map'), "('a -> 'b) -> 'a list -> 'b list", `${mode}: and types`);
    assert.equal(bml.typeReport('List.partition'), "('a -> bool) -> 'a list -> 'a list * 'a list", mode);
    assert.equal(bml.typeReport('List.length'), "'a list -> int", mode);
  }
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

test('the standard exceptions are catchable by name and still teach', () => {
  // D-34 and D-35. The messages taught, which is the house style and worth
  // keeping, but a message is not catchable, so `hd nil handle Empty => 0` had
  // nothing to match. Both now: `handle` sees an ordinary constructor, and an
  // uncaught one still prints the sentence that says what went wrong.
  const bml = createInterpreter({ typecheck: 'off' });
  bml.loadPrelude();
  assert.equal(bml.run('hd nil handle Empty => 0').text, '0');
  assert.equal(bml.run('tl nil handle Empty => 99').text, '99');
  assert.equal(bml.run('(1 div 0) handle Div => ~1').text, '~1');
  // Uncaught, it names the exception AND says why.
  const loose = bml.run('hd nil');
  assert.match(loose.text, /uncaught exception Empty/);
  assert.match(loose.text, /the list is empty/);
  // A user's own exception still works exactly as before.
  bml.run('exception Mine');
  assert.equal(bml.run('(raise Mine) handle Mine => 7').text, '7');
});

// ---- six more departures closed (v1.302) ------------------------------------

test('a record type may be a constructor argument', () => {
  // D-15. The type skipper knew parentheses and not braces, so `{` ended the
  // type and the declaration failed on it.
  const bml = createInterpreter({ typecheck: 'off' });
  bml.run('datatype u = B of {n : int}');
  assert.equal(bml.run('B {n = 3}').text, 'B {n = 3}');
});

test('withtype attaches abbreviations to a datatype binding', () => {
  // D-19. `withtype` was not in the list of words that end a type expression,
  // so `N of t * t withtype v = int` ate `withtype v` as part of the type.
  const bml = createInterpreter({ typecheck: 'off' });
  bml.run('datatype t = L | N of t * t withtype v = int');
  assert.equal(bml.run('N (L, L)').text, 'N (L, L)');
});

test('any expression may carry a type annotation', () => {
  // D-20. `(1 : int)` worked because the only place a trailing `:` was read was
  // after an open paren.
  const bml = createInterpreter({ typecheck: 'off' });
  assert.equal(bml.run('let val x = 1 in x end : int').text, '1');
  assert.equal(bml.run('(1 : int)').text, '1');
});

test('a symbolic identifier is a name and may be bound', () => {
  // D-21. The fixity table already accepted `infixr 5 ++`, which was the
  // giveaway: it took names the parser could not bind.
  const bml = createInterpreter({ typecheck: 'off' });
  bml.run('fun ++ (a, b) = a + b');
  bml.run('infix 6 ++');
  assert.equal(bml.run('2 ++ 3').text, '5');
  // And every operator the language already spells still lexes as itself.
  assert.equal(bml.run('4 == 4').text, 'true');
  assert.equal(bml.run('4 != 4').text, 'false');
  assert.equal(bml.run('4 >= 4').text, 'true');
  assert.equal(bml.run('1 :: nil').text, '[1]');
});

test('a functor parameter may be an inline signature', () => {
  // D-16. A named one already worked.
  const bml = createInterpreter({ typecheck: 'off' });
  bml.run('functor G (X : sig val n : int end) = struct val d = X.n end');
  bml.run('structure Ten = struct val n = 10 end');
  bml.run('structure GG = G (Ten)');
  assert.equal(bml.run('GG.d').text, '10');
});

test('abstype declares a type and publishes its with-block', () => {
  // D-18. The hiding is not enforced — this build tracks names, not types, the
  // same caveat as a signature — but the form works.
  const bml = createInterpreter({ typecheck: 'off' });
  bml.run('abstype ab = A with val mk = A end');
  assert.equal(bml.run('mk').text, 'A');
  bml.run('abstype t2 = B | C with fun which B = 1 | which C = 2 end');
  assert.equal(bml.run('which C').text, '2');
});

test('mutual recursion works inside let, which is where Harper writes it', () => {
  // D-09. The bindings nested as separate scopes, so the first was closed over
  // an environment the second was not in yet. They share one frame now. It
  // needed doing in TWO places: there are two parsers for a multi-binding
  // `let`, and the top-level one is where a typed line goes.
  const bml = createInterpreter({ typecheck: 'off' });
  assert.equal(
    bml.run('let fun e n = if n = 0 then true else o2 (n-1) and o2 n = if n = 0 then false else e (n-1) in e 4 end').text,
    'true');
  assert.equal(bml.run('let val a = 1 and b = 2 in a + b end').text, '3');
  assert.equal(bml.run('let fun f x = x + 1 and g y = y * 2 in f (g 5) end').text, '11');
});

test('the checker still refuses an ill-typed multi-binding let', () => {
  // LetRec is a new node, and a new node the checker has no case for falls to
  // the fresh-variable default — which meant strict mode quietly stopped
  // refusing anything written this way.
  const bml = createInterpreter({ typecheck: 'strict' });
  assert.equal(bml.run('let val g = fn x => x ^ "!" in g 1 end').ok, false);
});

// ---- proper tail calls (v1.303) ---------------------------------------------

test('a tail call uses no stack, so deep tail recursion runs', () => {
  // D-50, the last entry in the register. Standard ML REQUIRES proper tail
  // calls; this evaluator recursed for every sub-expression, so depth was
  // whatever the host stack had left — about 1950 before this landed.
  const bml = createInterpreter({ typecheck: 'off' });
  bml.run('fun count n = if n = 0 then 0 else count (n - 1)');
  assert.equal(bml.run('count 5000', { fuel: 10000000 }).text, '0', 'D-50\'s own example');
  assert.equal(bml.run('count 200000', { fuel: 10000000 }).text, '0');
  // An accumulator, which is how you write a loop in ML.
  bml.run('fun sum (n, acc) = if n = 0 then acc else sum (n - 1, acc + n)');
  assert.equal(bml.run('sum (100000, 0)', { fuel: 10000000 }).text, '5000050000');
});

test('a tail call through case and let is still a tail call', () => {
  const bml = createInterpreter({ typecheck: 'off' });
  bml.run('fun walk 0 = "done" | walk n = case n of _ => walk (n - 1)');
  assert.equal(bml.run('walk 50000', { fuel: 10000000 }).text, '"done"');
  bml.run('fun viaLet n = if n = 0 then 0 else let val m = n - 1 in viaLet m end');
  assert.equal(bml.run('viaLet 50000', { fuel: 10000000 }).text, '0');
});

test('the budget still bounds a program that never comes back', () => {
  // A tail loop counts steps like anything else, so removing the stack limit
  // must not remove the thing that stops a runaway.
  const bml = createInterpreter({ typecheck: 'off' });
  const r = bml.run('let f x = f x in f 1 end', { fuel: 20000 });
  assert.equal(r.ok, false);
  assert.match(r.text, /step budget/);
});

test('non-tail recursion is still bounded, and says so honestly', () => {
  // `fact` does work AFTER the call returns, so its frames are genuinely
  // needed. It got deeper (the If frames on the way are gone) but it is not
  // unbounded, and the README says so rather than implying the problem is gone.
  const bml = createInterpreter({ typecheck: 'off' });
  bml.run('fun fact n = if n = 0 then 1 else n * fact (n - 1)');
  assert.equal(bml.run('fact 20', { fuel: 10000000 }).ok, true);
  assert.equal(bml.run('fact 2500', { fuel: 100000000 }).ok, true, 'deeper than the old ~2000 ceiling');
});

test('a closure carries its own ctx and builtins through a tail jump', () => {
  // A tail jump reassigns ctx and builtins along with node and env, so a
  // function made at one station and called from another still runs against
  // the verbs and the world it was made with, however many jumps later.
  const seen = [];
  const bml = createInterpreter({
    typecheck: 'off',
    builtins: { note: { arity: 1, fn: ([v], c) => { seen.push(c && c.who); return v; } } },
  });
  bml.run('fun go n = if n = 0 then note 1 else go (n - 1)', { who: 'made-here' });
  bml.run('go 3', { who: 'called-here' });
  assert.deepEqual(seen, ['made-here'], 'three tail jumps later, still the defining ctx');
});

// ---- one stop list, three parsers (v1.303) ---------------------------------

test('a declaration keyword stops a type, an open list and a fixity list', () => {
  // Three parsers consume identifiers until they run out: skipTypeExpr, which
  // skips a type rather than parsing one, and the name lists of `open` and
  // `infix`. A word missing from the stop list is not reported, it is eaten.
  // All three had written their own answer or none, and all three were wrong.
  //
  // Each case declares something in a context where declarations legally sit
  // side by side, then probes that the SECOND one took effect.
  const CASES = [
    // skipTypeExpr — a constructor payload is the only way to reach it
    ['with',       'abstype q = T of int with fun mk n = T n end',                    'mk 1',  'T 1'],
    ['struct val', 'structure S = struct datatype q = T of int val v = 9 end',        'S.v',   '9'],
    ['struct open','structure S = struct datatype q = T of int open List val v = 1 end', 'S.v', '1'],
    ['struct loc', 'structure S = struct datatype q = T of int local val a = 7 in val b = a end end', 'S.b', '7'],
    ['struct exn', 'structure S = struct datatype q = T of int exception Boom val v = 2 end', 'S.v', '2'],
    ['struct abs', 'structure S = struct datatype q = T of int abstype r = R with val m = R end end', 'S.m', 'R'],
    ['struct str', 'structure S = struct datatype q = T of int structure I = struct val k = 3 end end', 'S.I.k', '3'],
    ['struct wt',  'structure S = struct datatype q = T of int withtype al = int val v = 4 end', 'S.v', '4'],
    ['local',      'local datatype q = T of int in val v = 5 end',                    'v',     '5'],
    // the `open` name list
    ['open+val',   'structure S = struct open List val v = 1 end',                    'S.v',   '1'],
    ['open+two',   'structure S = struct open List Int val v = 2 end',                'S.v',   '2'],
    ['open+end',   'structure S = struct val k = 6 open List end',                    'S.k',   '6'],
    // the fixity name list
    ['infix+val',  'structure S = struct infix 6 pl val v = 1 end',                   'S.v',   '1'],
    ['infixr+val', 'structure S = struct infixr 5 ct val v = 2 end',                  'S.v',   '2'],
    ['nonfix+val', 'structure S = struct nonfix junk val v = 3 end',                  'S.v',   '3'],
  ];
  for (const [word, decl, probe, want] of CASES) {
    const bml = createInterpreter({ typecheck: 'off' });
    bml.loadPrelude();
    const d = bml.run(decl);
    assert.equal(d.ok, true, `${word}: the declaration was refused — ${d.text}`);
    const r = bml.run(probe);
    assert.equal(r.ok, true, `${word}: ${probe} was refused — ${r.text}`);
    assert.equal(r.text, want, `${word}: the declaration after it did not take effect`);
  }
});

test('the stop list covers every keyword that starts a declaration', () => {
  // The list is shared, so it can be walked. Adding a declaration keyword to
  // the parser without adding it here is the mistake this catches: the parse
  // would not fail, it would swallow the word.
  for (const kw of DECL_KEYWORDS) {
    const bml = createInterpreter({ typecheck: 'off' });
    bml.loadPrelude();
    // `open X <kw>` — the name list must stop, leaving the keyword for the
    // parser proper, which then reports it rather than binding a name called
    // `val` or `fun`.
    const r = bml.run(`open List ${kw}`);
    assert.equal(r.ok, false, `open stopped at ${kw} but the parser then accepted it`);
    assert.doesNotMatch(String(r.text), /no structure end to open/,
      `${kw} was taken as a structure name by open`);
  }
  for (const kw of BLOCK_ENDERS) {
    assert.ok(typeof kw === 'string' && kw.length, 'a block ender must be a word');
  }
});

// ---- a datatype's type parameters (v1.305) ----------------------------------

test('a datatype carries its type parameters', () => {
  // D-56. The parser read the head parameters and threw them away, over a
  // comment saying they carried no meaning because nothing here was typed —
  // true when written, false once the checker landed. Without them the checker
  // builds a type constructor of NO arguments, so every value of the type
  // prints as the bare name.
  const bml = createInterpreter({ typecheck: 'report' });
  bml.loadPrelude();
  bml.run("datatype 'a box = Box of 'a");
  assert.equal(bml.typeReport('Box 1'), 'int box');
  assert.equal(bml.typeReport('Box "s"'), 'string box');
  // option is declared in the prelude like any other datatype, which is why
  // this showed on every REPL line involving one.
  assert.equal(bml.typeReport('SOME 1'), 'int option');
  assert.equal(bml.typeReport('NONE'), "'a option");
  assert.equal(bml.typeReport('SOME (SOME 1)'), 'int option option');
  assert.equal(bml.typeReport('valOf (SOME 3)'), 'int', 'and it reaches through the Basis');
  assert.equal(bml.typeReport('valOf'), "'a option -> 'a");
  assert.equal(bml.typeReport('Option.map'), "('a -> 'b) -> 'a option -> 'b option");
});

test('a parameter is ONE variable, at both ends', () => {
  // The identity is the whole point. Give the payload its own fresh variable
  // and `Box of 'a` types as `'b -> 'a box`, which reports worse than saying
  // nothing: `un` would be `'a box -> 'b` and tell you the wrong thing.
  const bml = createInterpreter({ typecheck: 'report' });
  bml.run("datatype 'a box = Box of 'a");
  bml.run('fun un (Box x) = x');
  assert.equal(bml.typeReport('un'), "'a box -> 'a", 'one variable, not two');
  assert.equal(bml.typeReport('un (Box 1)'), 'int');
});

test('a recursive parameterised datatype names itself correctly', () => {
  const bml = createInterpreter({ typecheck: 'report' });
  bml.run("datatype 'a tree = Leaf | Node of 'a tree * 'a * 'a tree");
  assert.equal(bml.typeReport('Leaf'), "'a tree");
  assert.equal(bml.typeReport('Node (Leaf, 1, Leaf)'), 'int tree');
});

test('more than one parameter is bracketed, as Standard ML writes it', () => {
  const bml = createInterpreter({ typecheck: 'report' });
  bml.run("datatype ('a,'b) pair = P of 'a * 'b");
  assert.equal(bml.typeReport('P (1, "a")'), '(int, string) pair');
  // And it can now be WRITTEN, which it could not: the annotation parser read
  // one type inside the brackets and made the comma a parse error, so the form
  // `datatype` declared happily was one nothing could annotate.
  assert.equal(bml.run('val q : (int, string) pair = P (1, "a")').ok, true);
});

test('the parameters make real clashes catchable', () => {
  // The point of carrying them: a type constructor with no arguments has
  // nothing to disagree about, so every one of these used to be accepted.
  const bml = createInterpreter({ typecheck: 'strict' });
  bml.loadPrelude();
  bml.run("datatype 'a box = Box of 'a");
  bml.run('datatype colour = Red | Green');
  for (const bad of ['Box 1 = Box "s"', 'SOME 1 = SOME "x"', 'val z : int box = Box "s"', 'val c : colour = 5']) {
    assert.equal(bml.run(bad).ok, false, `${bad} should be refused`);
  }
  for (const good of ['Box 1 = Box 1', 'SOME 1 = SOME 2', 'val z : int box = Box 1', 'val c : colour = Red']) {
    assert.equal(bml.run(good).ok, true, `${good} should run: ${bml.run(good).text}`);
  }
});

test('a type ABBREVIATION stays permissive, deliberately', () => {
  // `type 'a syn = 'a list` is not tracked, so `int syn` cannot be resolved to
  // `int list`. Making it rigid anyway would refuse a correct program for
  // saying `syn` where the checker worked out `list`. A variable under-reports;
  // a wrong rigid type refuses. Only names known to be datatypes go rigid.
  const bml = createInterpreter({ typecheck: 'strict' });
  bml.run("type 'a syn = 'a list");
  bml.run('type count = int');
  assert.equal(bml.run('val c : int syn = [1, 2]').ok, true);
  assert.equal(bml.run('val d : count = 5').ok, true);
});

// ---- functors: applied, typed, and taking an anonymous argument (v1.305) ----

test('an anonymous structure can be a functor argument', () => {
  // `F (struct val z = 5 end)` is Standard ML and was a parse error: the
  // argument had to be a name declared on an earlier line.
  const bml = createInterpreter({ typecheck: 'report' });
  bml.loadPrelude();
  bml.run('signature SG = sig val z : int end');
  bml.run('functor F (X : SG) = struct val m = X.z + 1 fun g y = y * X.z end');
  assert.equal(bml.run('structure U = F (struct val z = 5 end)').ok, true);
  assert.equal(bml.run('U.m').text, '6');
  assert.equal(bml.run('U.g 2').text, '10');
  // and the named form still works
  bml.run('structure A = struct val z = 9 end');
  bml.run('structure T = F (A)');
  assert.equal(bml.run('T.m').text, '10');
});

test('a functor application is typed, by inferring the body again', () => {
  // There was no checker case for `structure T = F (A)` at all, so it took the
  // fresh-variable default and every member of the result reported `'a`. And
  // because a qualified name keeps the unbound fallback, nothing said so.
  const bml = createInterpreter({ typecheck: 'report' });
  bml.loadPrelude();
  bml.run('signature SG = sig val z : int end');
  bml.run('functor F (X : SG) = struct val m = X.z + 1 fun g y = y * X.z end');
  bml.run('structure A = struct val z = 9 end');
  bml.run('structure T = F (A)');
  assert.equal(bml.typeReport('T.m'), 'int');
  assert.equal(bml.typeReport('T.g'), 'int -> int');
});

test('the result type follows the argument, which is what a functor is for', () => {
  // Copying the functor's own member types would answer the same thing every
  // time. Inferring the body against THIS argument is what makes the answer
  // depend on what was passed in.
  const bml = createInterpreter({ typecheck: 'report' });
  bml.loadPrelude();
  bml.run('signature ITEM = sig val one : int end');
  bml.run('functor Wrap (X : ITEM) = struct val w = [X.one] end');
  bml.run('structure Wi = Wrap (struct val one = 3 end)');
  bml.run('structure Ws = Wrap (struct val one = "s" end)');
  assert.equal(bml.typeReport('Wi.w'), 'int list');
  assert.equal(bml.typeReport('Ws.w'), 'string list', 'same functor, a different argument type');
});

test('a record projection reads the type of what it is applied to', () => {
  // It used to check the argument's SYNTAX, so it only worked when the record
  // was spelled out at the call: `#age {name = "a", age = 3}` was int and
  // `val r = {…}` then `#age r` was `'a`. The checker knew r's type and which
  // field was which, and declined to look.
  const bml = createInterpreter({ typecheck: 'report' });
  bml.run('val r = {name = "a", age = 3}');
  bml.run('val p = (1, "x")');
  assert.equal(bml.typeReport('#age r'), 'int');
  assert.equal(bml.typeReport('#name r'), 'string');
  assert.equal(bml.typeReport('#1 p'), 'int');
  assert.equal(bml.typeReport('#2 p'), 'string');
  assert.equal(bml.typeReport('#age {name = "b", age = 9}'), 'int', 'the written-out case still works');
});

test('while … do is unit, not a fresh variable', () => {
  // No case for it in the checker at all, so it took the default and reported
  // `'a` — reading as "this could be anything" for a form that is always one
  // thing.
  const bml = createInterpreter({ typecheck: 'report' });
  bml.run('val i = ref 0');
  assert.equal(bml.typeReport('while false do ()'), 'unit');
  assert.equal(bml.typeReport('while !i < 3 do i := !i + 1'), 'unit');
});

// ---- `as` binds loosest of all pattern forms (v1.306) -----------------------

test('`as` names the whole pattern, not the first thing in it', () => {
  // D-57. `as` was handled at the ATOM level, so `w as h :: t` read as
  // `(w as h) :: t` and `w` named the HEAD. Silent, and the more so because
  // parenthesising it gave the right answer, so the feature looked present.
  const bml = createInterpreter({ typecheck: 'off', printing: 'sml' });
  bml.loadPrelude();
  assert.equal(bml.run('case [1,2] of w as h :: _ => (w, h)').text, '([1, 2], 1)');
  // The one that answered quietly wrong rather than failing:
  assert.equal(bml.run('case [1,2] of w as h :: _ => length w').text, '2');
  assert.equal(bml.run('case [1,2] of w as (h :: _) => (w, h)').text, '([1, 2], 1)', 'parenthesised too');
  bml.run('fun g (w as h :: _) = (w, h)');
  assert.equal(bml.run('g [1,2,3]').text, '([1, 2, 3], 1)', 'and in a fun clause');
  assert.equal(bml.run('case (1,2) of w as (a, b) => (w, a + b)').text, '((1, 2), 3)', 'over a tuple');
  assert.equal(bml.run('case [[1,2]] of outer as (inner as (x :: _)) :: _ => (outer, inner, x)').text,
    '([[1, 2]], [1, 2], 1)', 'nested');
});

// ---- type abbreviations are resolved (v1.306) -------------------------------

test('an abbreviation is expanded, so an annotation using one is checked', () => {
  // `type 'a syn = 'a list` was read and dropped, on the reasoning that
  // inference works structurally and does not need the name. True of inference,
  // false of ANNOTATIONS, which is the one place a type name appears — so
  // `val y : int syn = 5` was accepted, `int syn` having become a variable that
  // unifies with anything.
  const bml = createInterpreter({ typecheck: 'strict' });
  bml.loadPrelude();
  bml.run("type 'a syn = 'a list");
  bml.run('type count = int');
  bml.run("type ('a,'b) both = 'a * 'b");
  bml.run('type link = {url : string, n : int}');
  for (const good of ['val a : int syn = [1,2]', 'val c : count = 5',
                      'val e : (int,string) both = (1,"a")', 'val g : link = {url = "x", n = 1}']) {
    assert.equal(bml.run(good).ok, true, `${good}: ${bml.run(good).text}`);
  }
  for (const bad of ['val b : int syn = 5', 'val d : count = "x"',
                     'val f : (int,string) both = (1,2)', 'val h : link = {url = 1, n = 1}']) {
    assert.equal(bml.run(bad).ok, false, `${bad} should be refused`);
  }
});

test('a record type can be written, in an abbreviation or an annotation', () => {
  // parseTypeExpr had no case for `{a : int}` while skipTypeExpr counted
  // braces, so the two disagreed and nothing noticed until an abbreviation's
  // right-hand side was parsed rather than skipped.
  const bml = createInterpreter({ typecheck: 'strict' });
  assert.equal(bml.run('val c : {p : int} = {p = 5}').ok, true);
  assert.equal(bml.run('val d : {p : int} = {p = "s"}').ok, false);
});

// ---- names are case-sensitive, as Standard ML's are (v1.306) ----------------

test('foo and Foo are two names', () => {
  // Every identifier was lower-cased, so this left ONE name holding 2. The
  // convention that constructors are capitalised and variables are not is a
  // convention only because the two can differ.
  const bml = createInterpreter({ typecheck: 'off', printing: 'sml' });
  bml.run('val foo = 1');
  bml.run('val Foo = 2');
  assert.equal(bml.run('foo').text, '1');
  assert.equal(bml.run('Foo').text, '2');
});

test('a keyword is lower-case and nothing else', () => {
  // `IF` is an ordinary name in Standard ML, not the keyword.
  const bml = createInterpreter({ typecheck: 'off', printing: 'sml' });
  assert.equal(bml.run('val IF = 5').ok, true, 'IF is a name you may bind');
  assert.equal(bml.run('IF').text, '5');
  assert.equal(bml.run('if true then 1 else 2').text, '1', 'and the keyword still works');
});

test('a structure name is case-sensitive too', () => {
  const bml = createInterpreter({ typecheck: 'off' });
  bml.loadPrelude();
  assert.equal(bml.run('List.length [1]').text, '1');
  assert.equal(bml.run('list.length [1]').ok, false, 'list is not List');
});

test('exception Size can exist alongside the size function', () => {
  // It could not while names were folded: one name, and declaring the
  // exception shadowed the function. Five tests went red on that single line.
  const bml = createInterpreter({ typecheck: 'off', printing: 'sml' });
  bml.loadPrelude();
  assert.equal(bml.run('size "abc"').text, '3', 'the function');
  assert.equal(bml.run('Array.array (~1, 0) handle Size => Array.fromList []').text, '[||]', 'the exception');
});

test('a host may ask for folding, and NostOS does', () => {
  // The game's terminals are 1980s machines: a player types HACK OB_1A2B as
  // readily as hack ob_1a2b. So it is a host policy, like the unbound-name
  // hooks, rather than something baked into the language.
  const folded = createInterpreter({ typecheck: 'off', printing: 'sml', names: 'fold' });
  folded.run('val bar = 1');
  folded.run('val Bar = 2');
  assert.equal(folded.run('bar').text, '2', 'folded: one name, the later binding wins');
  assert.equal(folded.run('IF true then 1 else 2').text, '1', 'folded: a keyword in caps is the keyword');
});

test('the new Basis primitives have types, not fresh variables', () => {
  // A primitive missing from the checker's base environment takes the
  // unknown-name path, so `Math.sqrt 4.0` reported `'a` for a value that is a
  // real and nothing else. The list of primitive types is the fifth list in
  // this project to go stale behind an addition.
  const bml = createInterpreter({ typecheck: 'report' });
  bml.loadPrelude();
  assert.equal(bml.typeReport('Math.sqrt'), 'real -> real');
  assert.equal(bml.typeReport('Math.sqrt 4.0'), 'real');
  assert.equal(bml.typeReport('ceil 1.2'), 'int');
  assert.equal(bml.typeReport('Array.fromList [1,2,3]'), 'int array');
  assert.equal(bml.typeReport('Array.sub (Array.fromList [1,2,3], 1)'), 'int');
  assert.equal(bml.typeReport('Vector.fromList [1]'), 'int vector');
  assert.equal(bml.typeReport('Char.ord'), 'char -> int');
});

test('a val alias is not recursive; a fun is', () => {
  // Both arrive as TopLet and the difference is that `fun` parses to a Lam.
  // Pre-binding the name for a plain `val` made an ALIAS self-referential:
  // `val sqrt = sqrt` read the right-hand side as the one being declared.
  const bml = createInterpreter({ typecheck: 'report' });
  bml.loadPrelude();
  bml.run('val mysqrt = sqrt');
  assert.equal(bml.typeReport('mysqrt'), 'real -> real', 'the alias sees the outer name');
  bml.run('fun count n = if n = 0 then 0 else count (n - 1)');
  assert.equal(bml.typeReport('count'), 'int -> int', 'and a fun still sees itself');
});

// ---- `;` between declarations (v1.307) --------------------------------------

test('a semicolon separates declarations at the top level', () => {
  // `;` means two things in Standard ML and this build implemented one: the
  // expression sequence inside parentheses. The `;` loop ran everywhere, so at
  // the top level it ate a `;` that was never its own — `val p = 1; val q = 2`
  // read the `;` as a sequence, took `val q` for an expression, and asked for
  // the `in` a `let` would need.
  const bml = createInterpreter({ typecheck: 'off', printing: 'sml' });
  bml.loadPrelude();
  assert.equal(bml.run('val p = 1; val q = 2').text, 'val p = 1\nval q = 2');
  assert.equal(bml.run('p + q').text, '3');
  // Sequential, so each may use the names before it. A bare `Decls` is an
  // and-chain and those are simultaneous.
  bml.run('val a1 = 1; val a2 = a1 + 1; val a3 = a2 + 1');
  assert.equal(bml.run('a3').text, '3');
});

test('a semicolon may terminate a declaration', () => {
  // Standard ML's own texts end nearly every line this way, and it reached
  // eat('EOF') and was reported there.
  const bml = createInterpreter({ typecheck: 'off', printing: 'sml' });
  bml.loadPrelude();
  assert.equal(bml.run('val zz = 5;').text, 'val zz = 5');
  assert.equal(bml.run('open List;').ok, true);
  assert.equal(bml.run('1 + 1;').text, '2');
});

test('a semicolon separates declarations inside a block too', () => {
  const bml = createInterpreter({ typecheck: 'off', printing: 'sml' });
  bml.loadPrelude();
  assert.equal(bml.run('structure S7 = struct val a = 1; val b = 2 end').ok, true);
  assert.equal(bml.run('S7.b').text, '2');
  assert.equal(bml.run('local val h = 1; val g = 2 in val sh = h + g end').ok, true);
  assert.equal(bml.run('sh').text, '3');
  assert.equal(bml.run('abstype q7 = Q7 of int with fun mk7 n = Q7 n; fun get7 (Q7 n) = n end').ok, true);
  assert.equal(bml.run('get7 (mk7 5)').text, '5');
  assert.equal(bml.run('structure S6 = struct val a = 1; end').ok, true, 'a trailing one too');
});

test('a semicolon inside parentheses still SEQUENCES, as it always did', () => {
  // The shapes that were at risk, checked one by one rather than by watching a
  // suite go green: the game writes `(echo n ; go (n - 1))` in three places.
  const bml = createInterpreter({ typecheck: 'off', printing: 'sml' });
  bml.loadPrelude();
  bml.run('val i = ref 0');
  assert.equal(bml.run('(1; 2; 3)').text, '3');
  assert.equal(bml.run('(if true then 1 else 2; 7)').text, '7');
  assert.equal(bml.run('let val a = 1 in a; a + 1 end').text, '2', 'a let body, without parentheses');
  assert.equal(bml.run('(i := 0; while !i < 3 do (i := !i + 1; ()); !i)').text, '3', 'inside a loop');
});

test('a run of declarations is seen by the CHECKER, not just the evaluator', () => {
  // `Decls` had no case in the checker at all, so `remember` was never told
  // what the names are: the evaluator bound them and the checker did not, and
  // under strict — the command line's default — `val u = 1 and v = 2` declared
  // two names and then refused both the moment you used one.
  //
  // It pre-dates the `;` work by some versions. Routing `;` through the same
  // node is what made it visible.
  const bml = createInterpreter({ typecheck: 'strict' });
  bml.loadPrelude();
  bml.run('val u = 1 and v = 2');
  assert.equal(bml.run('u + v').text, '3', 'an and-chain');
  bml.run('fun ev n = n = 0 and od n = n = 1');
  assert.equal(bml.run('ev 0').text, 'true');
  bml.run('val p2 = 1; val q2 = 2');
  assert.equal(bml.run('p2 + q2').text, '3', 'and a semicolon run');
  assert.equal(bml.typeReport('p2'), 'int');
});

test('a later declaration in a run sees what the earlier ones declared', () => {
  const bml = createInterpreter({ typecheck: 'strict' });
  bml.loadPrelude();
  bml.run('datatype col = R | G; val z = R');
  assert.equal(bml.typeReport('z'), 'col', 'the datatype was registered before the val');
  bml.run('type ct = int; val w : ct = 5');
  assert.equal(bml.typeReport('w'), 'int', 'and so was the abbreviation');
  bml.run('structure Sx = struct val k = 1 end; val kk = Sx.k');
  assert.equal(bml.typeReport('kk'), 'int', 'and the structure');
});

test('a clash anywhere in a run refuses the whole line', () => {
  // StructDecl catches a member that will not type, because a structure is not
  // all-or-nothing. Copying that here was wrong: a top-level run must refuse
  // exactly as the declaration would if it stood alone.
  const bml = createInterpreter({ typecheck: 'strict' });
  bml.loadPrelude();
  assert.equal(bml.run('type ct2 = int; val w2 : ct2 = "s"').ok, false, 'clash in the second');
  assert.equal(bml.run('val bad : int = "s"; val ok2 = 1').ok, false, 'clash in the first');
  assert.equal(bml.run('val g1 = 1; val g2 = 2').ok, true, 'and a good run still runs');
});

test('a run reports one type per declaration', () => {
  // Reporting the run's own type printed `val q = 2 : unit`, which says the
  // wrong thing about q.
  const bml = createInterpreter({ typecheck: 'report', printing: 'sml' });
  bml.loadPrelude();
  const ty = bml.typeReport('val p3 = 1; val q3 = "a"');
  assert.equal(ty, 'int\nstring');
  assert.deepEqual(smlEcho(bml.run('val p3 = 1; val q3 = "a"').text, ty),
    ['val p3 = 1 : int', 'val q3 = "a" : string']);
});

// ---- a structure bound to another structure (v1.308) ------------------------

test('structure A = B names one structure under another', () => {
  // `structure Q = Queue` was read as a functor application with no argument,
  // so it answered *Queue is not a functor*. It is the same form as
  // `structure Key : ORDERED = K` inside a struct, which is how nearly every
  // dictionary in Harper's corpus names its ordering — so one refusal took the
  // whole structure with it, and everything downstream after that.
  const bml = createInterpreter({ typecheck: 'strict' });
  bml.loadPrelude();
  bml.run('structure Queue = struct val empty = nil fun insert (x, q) = x :: q end');
  assert.equal(bml.run('structure Q = Queue').ok, true);
  assert.equal(bml.run('Q.insert (1, Q.empty)').text, '[1]');
  assert.equal(bml.typeReport('Q.insert'), bml.typeReport('Queue.insert'),
    'the checker sees the members too, not just the evaluator');
});

test('an alias may be ascribed, and the ascription narrows it', () => {
  const bml = createInterpreter({ typecheck: 'off' });
  bml.loadPrelude();
  bml.run('signature ORDERED = sig type t val lt : t -> t -> bool end');
  bml.run('structure IntLT = struct type t = int fun lt a b = a < b val hidden = 9 end');
  bml.run('structure Key : ORDERED = IntLT');
  assert.equal(bml.run('Key.lt 1 2').text, 'true');
  assert.equal(bml.run('Key.hidden').ok, false, 'the signature hides what it does not name');
});

test('an alias works inside a struct, and of a functor parameter', () => {
  // Inside a struct the body runs in a scope that prototype-chains to the
  // enclosing one, so own keys alone could not see the structure being named.
  const bml = createInterpreter({ typecheck: 'off' });
  bml.loadPrelude();
  bml.run('signature ORDERED = sig type t val lt : t -> t -> bool end');
  bml.run('structure IntLT = struct type t = int fun lt a b = a < b end');
  bml.run('structure D = struct structure Key : ORDERED = IntLT val e = 1 end');
  assert.equal(bml.run('D.e').text, '1');
  assert.equal(bml.run('D.Key.lt 1 2').text, 'true');
  // and the same form naming a functor's own parameter
  bml.run('functor Dict (structure K : ORDERED) = struct structure Key : ORDERED = K val e = 2 end');
  bml.run('structure D1 = Dict (structure K = IntLT)');
  assert.equal(bml.run('D1.e').text, '2');
});

test('naming a structure that does not exist says so', () => {
  const bml = createInterpreter({ typecheck: 'off' });
  const r = bml.run('structure Z = NoSuchThing');
  assert.equal(r.ok, false);
  assert.match(r.text, /no structure NoSuchThing/);
});

test('a failed match raises Match, and it is catchable', () => {
  // `fun hd (h::_) = h` applied to nil is how Harper introduces the exception.
  // It threw a plain error, so `handle Match` had nothing to catch: the gap
  // v1.301 closed for Empty and Div, missed for this one because the evaluator
  // raises it rather than a primitive.
  const bml = createInterpreter({ typecheck: 'off' });
  bml.loadPrelude();
  bml.run('fun myhd (h::_) = h');
  assert.match(bml.run('myhd nil').text, /uncaught exception Match/);
  assert.equal(bml.run('myhd nil handle Match => 0').text, '0');
  assert.equal(bml.run('(case 5 of 1 => 1) handle Match => ~1').text, '~1');
  assert.match(bml.run('myhd nil').text, /no case matches/, 'and it still teaches');
});

test('a line that cannot have ended takes the next one with it', () => {
  // `functor F (…) :> SIG where type … =` with `struct` at column 0 on the next
  // line was split into two declarations: the header failed on the missing
  // struct and the body arrived as a stray one.
  const joined = joinProgram(
    'functor DictFun (structure K : ORDERED) :> DICT where type Key.t = K.t =\n'
    + 'struct\n  structure Key : ORDERED = K\n  val empty = 1\nend\n');
  assert.equal(joined.length, 1, 'one declaration, not two');
  assert.match(joined[0].text, /^functor DictFun .* = struct .* end$/);
});

test('an alias echoes as a structure, not as a string', () => {
  // It returned a str value, so the prompt printed
  // `val it = "structure Q : 2 name(s)" : unit`, which said the declaration
  // WAS a string. It returns what a `struct` declaration returns.
  const bml = createInterpreter({ typecheck: 'off', printing: 'sml' });
  bml.loadPrelude();
  bml.run('structure Queue = struct val empty = nil end');
  assert.equal(bml.run('structure Q = Queue').text, 'structure Q : 1 name(s)');
});

// ---- three more holes of the same shape (v1.309) ----------------------------
//
// Writing thirty example programs found three declarations the EVALUATOR bound
// and the CHECKER did not. Under strict — the command line's default — each one
// declared its names and then refused every use of them. They are the same
// shape as the `Decls` hole: a declaration form with no case in `remember`.

test('a pattern binding tells the checker what it bound', () => {
  // `val (a, b) = (1, 2)` bound both names in the evaluator and neither in the
  // checker, which makes it the most visible of the three: a tuple binding is
  // ordinary ML, and every use after one was refused.
  const bml = createInterpreter({ typecheck: 'strict' });
  bml.loadPrelude();
  bml.run('val (a, c) = (1, 2)');
  assert.equal(bml.run('a + c').text, '3');
  assert.equal(bml.typeReport('a'), 'int');
  bml.run('val (p, (q, r)) = (1, (2, "x"))');
  assert.equal(bml.run('q').text, '2');
  assert.equal(bml.typeReport('r'), 'string', 'nested, and each with its own type');
  bml.run('val {name = n, born = y} = {name = "ada", born = 1815}');
  assert.equal(bml.run('n').text, '"ada"', 'and through a record');
});

test('local publishes the shown half and hides the rest', () => {
  const bml = createInterpreter({ typecheck: 'strict' });
  bml.loadPrelude();
  bml.run('local fun helper n = n + 1 in fun total x = helper x end');
  assert.equal(bml.run('total 1').text, '2');
  assert.equal(bml.typeReport('total'), 'int -> int');
  assert.equal(bml.run('helper 1').ok, false, 'the hidden half stays hidden');
  bml.run('local val h = 1 in val sh = h + 1 end');
  assert.equal(bml.run('sh').text, '2');
});

test('an and-chain is mutually recursive in the checker too', () => {
  // Which is the reason to write one. The evaluator handled it; the checker
  // read each body in an environment without its sibling, so `odd` was unbound
  // while `even` was being typed.
  const bml = createInterpreter({ typecheck: 'strict' });
  bml.loadPrelude();
  bml.run('fun even 0 = true | even n = odd (n - 1) and odd 0 = false | odd n = even (n - 1)');
  assert.equal(bml.run('even 4').text, 'true');
  assert.equal(bml.run('odd 4').text, 'false');
  assert.equal(bml.typeReport('even'), 'int -> bool');
  // A `;` run is NOT a chain: those are separate declarations, each seeing only
  // what came before it.
  bml.run('val n1 = 1; val n2 = n1 + 1');
  assert.equal(bml.run('n2').text, '2');
});

test('a type annotation is read where the binding form REPEATS', () => {
  // Annotations were read at the first binding of a run and nowhere else, so
  // four forms refused what the line above them accepted: a clause after `|`,
  // the second `val` of a `let`, an `and` continuation, and a field of a record
  // pattern. Each is checked here against its own unannotated twin, which
  // always worked.
  const bml = createInterpreter({ typecheck: 'strict' });
  bml.loadPrelude();

  bml.run('fun g (m:int, 0):int = m | g (0, n:int):int = n');
  assert.equal(bml.run('g (0, 7)').text, '7', 'a clause after `|`');
  assert.equal(bml.typeReport('g'), '(int * int) -> int');

  assert.equal(bml.run('let val m:int = 3 val n:int = m*m in m*n end').text, '27',
    'the second val of a let');

  bml.run('val r1 : real = 2.5 and r2 : real = 1.25');
  assert.equal(bml.run('r1 + r2').text, '3.75', 'an `and` continuation');

  bml.run('fun dst {x = x : real, y = y : real} = x + y');
  assert.equal(bml.run('dst {x = 3.0, y = 4.0}').text, '7.0', 'a record pattern field');
});

test('an annotation in a repeat position is CHECKED, not just stepped over', () => {
  // The failure mode a parser fix invites: eat the tokens, bind nothing, and
  // every one of these lies runs.
  const lies = [
    'fun g2 (m:int, 0):int = m | g2 (0, n:int):string = n',
    'let val m:int = 3 val n:string = m in n end',
    'val a2:int = 1 and b2:string = 2',
    'fun dst2 {x = x : real, y = y : int} = x + y',
  ];
  for (const src of lies) {
    const bml = createInterpreter({ typecheck: 'strict' });
    bml.loadPrelude();
    assert.equal(bml.run(src).ok, false, src);
  }
});

test('a real is written the way the Basis writes one', () => {
  // Real.toString is Real.fmt (StringCvt.GEN NONE), which carries twelve
  // significant digits. JavaScript's String gives the shortest text that reads
  // back as the same double, so `3.14 + 2.17` printed 5.3100000000000005 —
  // the error term, shown on every real answer the language gave.
  const bml = createInterpreter({ typecheck: 'strict' });
  bml.loadPrelude();
  const shows = (src, want) => assert.equal(bml.run(src).text, want, src);

  shows('3.14 + 2.17', '5.31');
  shows('0.1 + 0.2', '0.3');
  shows('1.0 / 3.0', '0.333333333333');   // twelve digits, not seventeen
  shows('2.5 + 1.25', '3.75');            // exact in binary, unchanged

  // A real always shows its point, and a negative takes a tilde.
  shows('1.0', '1.0');
  shows('0.0', '0.0');
  shows('~5.31', '~5.31');
  shows('real 7', '7.0');

  // Real.toString goes through the same path, so it cannot drift from the echo.
  shows('Real.toString (3.14 + 2.17)', '"5.31"');
});

test('showReal spells the edges the way Standard ML does', () => {
  // Each of these was wrong before, and none of them appears in a program often
  // enough for the suite to have noticed.
  assert.equal(showReal(-0), '~0.0', 'JavaScript drops the sign on negative zero');
  assert.equal(showReal(Infinity), 'inf');
  assert.equal(showReal(-Infinity), '~inf');
  assert.equal(showReal(NaN), 'nan');
  assert.equal(showReal(1e20), '1E20', 'E, and no + on the exponent');
  assert.equal(showReal(1e-7), '1E~7', 'a negative exponent takes a tilde');
  assert.equal(showReal(1e21), '1E21', 'used to come out as 1e+21.0');
  assert.equal(showReal(1e11), '100000000000.0', 'fixed while it fits');
});

test('`let … end` can be the operand of an operator', () => {
  // It is an ATOM in Standard ML, and this reads it above the operator grammar
  // and returned it whole, so nothing could follow it: `let … end * 2` stopped
  // at the `end` and reported the `*`. Two corpus declarations write exactly
  // this, both as ordinary arithmetic.
  const bml = createInterpreter({ typecheck: 'strict' });
  bml.loadPrelude();
  assert.equal(bml.run('let val m = 3 in m end * 2').text, '6');
  // The RIGHT operand was a separate gap and was asserted here as refused until
  // v1.322 closed it. Both sides now.
  assert.equal(bml.run('let val m = 3 in m end + let val n = 4 in n end').text, '7',
    'and one on each side');
  bml.run('fun h (x:real):real = let val y = 2.0 in y+y end * x');
  assert.equal(bml.run('h 3.0').text, '12.0', 'and inside a fun body');

  // The `;` work at v1.307 is what this could have broken, so each of its
  // shapes is checked here rather than left to a green suite.
  assert.equal(bml.run('let val x = 1 in x; x + 1 end').text, '2', 'a sequence in a let body');
  assert.equal(bml.run('(1; 2; 3)').text, '3');
  assert.equal(bml.run('(if true then 1 else 2; 7)').text, '7');
  assert.equal(bml.run('let val a = 2 in let val b = 3 in a * b end end').text, '6', 'nested');
  assert.equal(bml.run('let val q = 7 in q end').text, '7', 'and with nothing after it');
});

test('a `fn` can be a clause body when the fun has more than one clause', () => {
  // `fun sa nil = fn l => l | sa (h::t) = …`. The `|` is ambiguous — it could
  // extend the fn's match or start sa's next clause — and the first reading was
  // always taken, so the clause after it was read as a pattern and reported for
  // having `=` where `=>` was wanted. A fn arm ends in `=>`, a fun clause in `=`.
  const bml = createInterpreter({ typecheck: 'strict' });
  bml.loadPrelude();
  bml.run('fun sa nil = fn l => l | sa (h::t) = let val u = sa t in fn l => h :: u l end');
  assert.equal(bml.run('sa [1,2] [3]').text, '[1, 2, 3]');

  // A fn that really does have several arms still gets them.
  bml.run('val f = fn nil => 0 | _ => 1');
  assert.equal(bml.run('f []').text, '0');
  assert.equal(bml.run('f [9]').text, '1');
});

test('an `and` continuation reads a parameter the lookahead cannot spell', () => {
  // Whether an `and` starts a binding is decided by scanning ahead for the `=`,
  // and that scan listed the token types allowed on the way. The list had no
  // closing bracket in it, so it stopped at the first `)`: a parameter holding
  // an `as` made the `and` a boolean conjunction, and the parameter was then
  // read as an expression, where `as` means nothing. It steps over balanced
  // brackets now and accepts whatever is inside them.
  const bml = createInterpreter({ typecheck: 'off' });
  bml.loadPrelude();
  bml.run('datatype pc = Pcl of int ref');
  // The corpus shape, from refs.sml. It is the PARSE that was broken: the
  // declaration was refused outright, taking the binding before the `and` down
  // with it. (`ref` as a pattern is a separate matter and not asserted here.)
  assert.equal(bml.run('fun z 0 = 0 | z n = n and unwrap (Pcl (r as ref c)) = c').ok, true);
  assert.equal(bml.run('z 4').text, '4', 'and the binding before the `and` still stands');
  assert.equal(bml.run('unwrap').ok, true, 'and the name after it is bound');
  // The simpler shape, where `as` is all that was in the way.
  assert.equal(bml.run('fun y1 0 = 0 and y2 (w as nil) = w').ok, true);
  assert.equal(bml.run('y2 []').text, '[]');
});

test('`val` takes a pattern, and the constructor survives it', () => {
  // `val` and `fun` were skipped without recording WHICH word was written, and
  // in Standard ML `val` takes a pattern where `fun` takes a name and its
  // parameters. So `val SOME z = SOME 4` was read as a function called SOME
  // taking z: z was never bound, the constructor was shadowed, and `SOME 9`
  // afterwards recursed until the step budget ran out. No error at any point,
  // which is what made it worth coming back for.
  const bml = createInterpreter({ typecheck: 'off' });
  bml.loadPrelude();
  bml.run('val SOME z = SOME 4');
  assert.equal(bml.run('z').text, '4', 'the pattern binds');
  assert.equal(bml.run('SOME 9').text, 'SOME 9', 'and SOME is still the constructor');

  assert.equal(bml.run('val 0 = 1 - 1').ok, true, 'a literal pattern');
  bml.run('val h :: t = [1,2,3]');
  assert.equal(bml.run('h').text, '1');
  assert.equal(bml.run('t').text, '[2, 3]');

  // The ordinary forms are untouched, including the bare `let name … = e` the
  // game's terminals use, which says neither word.
  bml.run('val x = 1');
  assert.equal(bml.run('x').text, '1');
  bml.run('val y : int = 2');
  assert.equal(bml.run('y').text, '2');
  bml.run('val (a, b) = (5, 6)');
  assert.equal(bml.run('a').text, '5');
  bml.run('fun sq n = n * n');
  assert.equal(bml.run('sq 4').text, '16');
});

test('a `let` can hold several pattern bindings before its `in`', () => {
  // The pattern path handled ONE and then wanted `in`; the chain that takes
  // several is keyed by name, and a pattern has none. Sequential val bindings
  // nest, so the rest of the block is parsed as its own let. datatype.sml
  // writes this four times.
  const bml = createInterpreter({ typecheck: 'off' });
  bml.loadPrelude();
  assert.equal(bml.run('let val SOME a = SOME 3 val SOME b = SOME 4 in a + b end').text, '7');
  assert.equal(bml.run('let val SOME a = SOME 3 val SOME b = SOME (a+1) in b end').text, '4',
    'and the first is in scope inside the second');
  assert.equal(bml.run('let val SOME y = SOME 2 val x = 1 in x + y end').text, '3', 'mixed');
  // A `struct` body is a list of declarations with no `in`, so a pattern
  // binding there ends where it ends rather than swallowing the rest.
  bml.run('structure S = struct datatype d = D of int val D q = D 5 val r = 1 end');
  assert.equal(bml.run('S.q').text, '5');
  assert.equal(bml.run('S.r').text, '1');
});

test('one lookahead decides whether an `and` starts a binding', () => {
  // Three places asked this and two carried their own list of permitted tokens,
  // neither of which had a closing bracket or a comma in it. A tuple parameter
  // stopped the scan short of the `=`, so `and lk' ((k, d), l, r) = …` was read
  // as a boolean conjunction — which is what refs.sml and repinv.sml write.
  const bml = createInterpreter({ typecheck: 'off' });
  bml.loadPrelude();
  assert.equal(bml.run('let fun c1 0 = 1 and c2 ((k, d), l, r) = k in c2 ((7, 0), 0, 0) end').text, '7');
  assert.equal(bml.run('let fun b1 0 = 1 | b1 n = b2 n and b2 (x, y) = x in b2 (5, 6) end').text, '5',
    'a clausal fun continued by `and`');
  assert.equal(
    bml.run('let fun ev 0 = true | ev n = od (n-1) and od 0 = false | od n = ev (n-1) in ev 4 end').text,
    'true', 'mutual recursion inside a let, which is the reason to write one');
});

test('vector literals, and the Vector structure that they exposed', () => {
  // `#[1,2,3]`. The `#` is shared with the selector and the bracket tells them
  // apart, as in Standard ML.
  const bml = createInterpreter({ typecheck: 'strict' });
  bml.loadPrelude();
  assert.equal(bml.run('#[1, 2, 3]').text, '#[1, 2, 3]');
  assert.equal(bml.typeReport('#[1, 2, 3]'), 'int vector');
  assert.equal(bml.run('#[]').text, '#[]');
  assert.equal(bml.run('#1 (4, 5)').text, '4', 'the selector still selects');
  assert.equal(bml.run('#[1,2] = #[1,2]').text, 'true', 'a vector compares structurally');

  // WRITING the literal is what showed this: every member of Vector was typed
  // `'a array -> …`, because the structure reused the array primitives and so
  // reused their types. It RAN — the primitives accept either tag — so only the
  // checker refused, and strict is the default. Vector was unusable.
  assert.equal(bml.run('Vector.length #[1,2,3]').text, '3');
  assert.equal(bml.run('Vector.sub (#[7,8,9], 1)').text, '8');
  assert.equal(bml.run('Vector.toList #[1,2]').text, '[1, 2]');
  assert.equal(bml.run('Vector.map (fn x => x + 1) #[1,2]').text, '#[2, 3]');
  assert.equal(bml.run('Vector.length (Array.fromList [1,2])').ok, false,
    'and an array is not a vector');
});

test('word literals', () => {
  // `0w5` and `0wx1F`. A word here is a non-negative int that prints as
  // uppercase hex, so only the lexer had to learn them.
  const bml = createInterpreter({ typecheck: 'strict' });
  bml.loadPrelude();
  assert.equal(bml.run('0w5').text, '5');
  assert.equal(bml.run('0wx1F').text, '31');
  assert.equal(bml.run('0w5 + 0w3').text, '8');
  assert.equal(bml.run('Word.toString 0wx1F').text, '"1F"');
  // The hex and decimal forms below it in the lexer are untouched.
  assert.equal(bml.run('0x1F').text, '31');
  assert.equal(bml.run('0.5').text, '0.5');
  assert.equal(bml.run('0').text, '0');
});

test('an exception can be replicated', () => {
  // `exception Bang = Boom` is not a new exception but another name for one, so
  // the two must share an identity: raising either is caught by handling
  // either, which is the only reason to write it.
  const bml = createInterpreter({ typecheck: 'off' });
  bml.loadPrelude();
  bml.run('exception Boom of string');
  bml.run('exception Bang = Boom');
  assert.equal(bml.run('(raise Boom "x") handle Bang s => s').text, '"x"');
  assert.equal(bml.run('(raise Bang "y") handle Boom s => s').text, '"y"');

  bml.run('exception Quit');
  bml.run('exception Halt = Quit');
  assert.equal(bml.run('(raise Quit) handle Halt => "caught"').text, '"caught"', 'nullary too');

  // A standard exception can be replicated, being an exception like any other.
  bml.run('exception MyFail = Fail');
  assert.equal(bml.run('(raise Fail "z") handle MyFail s => s').text, '"z"');
  assert.equal(bml.run('exception Nope = Zzz').ok, false, 'and only an exception can be');

  // An ordinary constructor pattern is unaffected by matching on the canonical
  // name, since for anything but a replication the two are the same.
  bml.run('datatype colour = R | G');
  assert.equal(bml.run('case R of R => 1 | G => 2').text, '1');
});

test('Time and Date, against a clock the host supplies', () => {
  // The clock is a HOST POLICY, like the name folding and the unbound-name
  // hooks: the language asks for the time and does not reach for it. So the
  // test hands over a stopped one and every answer below is fixed.
  const bml = createInterpreter({ typecheck: 'strict', clock: () => 0 });
  bml.loadPrelude();
  assert.equal(bml.run('Time.now ()').text, '0');
  assert.equal(bml.run('Time.toSeconds (Time.fromSeconds 90)').text, '90');
  assert.equal(bml.run('Time.toString 1500').text, '"1.500"');

  // 1 January 1970 was a Thursday.
  assert.equal(bml.run('Date.toString (Date.fromTimeUniv 0)').text, '"Thu Jan 01 00:00:00 1970"');
  assert.equal(bml.run('Date.year (Date.fromTimeUniv 0)').text, '1970');
  assert.equal(bml.run('Date.month (Date.fromTimeUniv 0)').text, 'Jan');
  assert.equal(bml.run('Date.weekday (Date.fromTimeUniv 0)').text, 'Thu');
  // 1e12 milliseconds is 9 September 2001, a Sunday.
  assert.equal(bml.run('Date.toString (Date.fromTimeUniv 1000000000000)').text,
    '"Sun Sep 09 01:46:40 2001"');
});

test('a machine given no clock says so', () => {
  // Rather than quietly answering with the reader's own wall clock. Nothing
  // behind this has an operating system, and a clock is the host's to give.
  const bml = createInterpreter({ typecheck: 'strict' });
  bml.loadPrelude();
  const r = bml.run('Time.now ()');
  assert.equal(r.ok, false);
  assert.match(r.text, /no clock/);
  // Everything that is a function of a time it was GIVEN still works, since
  // none of it consults the host.
  assert.equal(bml.run('Time.toSeconds (Time.fromSeconds 5)').text, '5');
  assert.equal(bml.run('Date.toString (Date.fromTimeUniv 0)').text, '"Thu Jan 01 00:00:00 1970"');
});

test('an unbound name offers what the reader probably meant', () => {
  // "ERR: unbound variable: date" is true and useless. Standard ML tells `date`
  // and `Date` apart, so a reader who typed the first meant the second, and the
  // machine can see that.
  const bml = createInterpreter({ typecheck: 'off', clock: () => 0 });
  bml.loadPrelude();
  const say = (src) => bml.run(src).text;

  assert.match(say('date'), /did you mean the structure Date\?/);
  // The capitals lecture, on a name that is a plain value rather than a
  // structure — for a structure the useful thing to say is what to call.
  bml.run('val Threshold = 5');
  assert.match(say('threshold'), /did you mean Threshold\?/);
  assert.match(say('threshold'), /tells capitals apart/);
  // A word carried in from another language.
  assert.match(say('var f = 1'), /Standard ML writes val/);
  assert.match(say('function f x = x'), /Standard ML writes fun/);
  assert.match(say('return 1'), /a function IS its last expression/);
  // A typing slip, including the transposition, which is the commonest one.
  assert.match(say('lenght [1,2]'), /did you mean length\?/);
  assert.match(say('prnt "x"'), /did you mean print\?/);
  // A qualified name misses on its structure more often than on its member.
  assert.match(say('Lst.map'), /did you mean the structure List\? try List\./);
  // And when there is nothing sensible to say, it says nothing.
  assert.equal(say('zqxjw'), 'ERR: unbound variable: zqxjw');
  // A name that IS bound is unaffected.
  assert.equal(bml.run('val x = 1').ok, true);
});

test('a structure is named as one, not reported as an unbound variable', () => {
  // A structure is not a value, so `Date` on its own is an error in Standard ML
  // too — but "unbound variable: Date" is a poor way to say it, and worse when
  // the line above has just suggested Date to somebody who typed `date`.
  const bml = createInterpreter({ typecheck: 'off', clock: () => 0 });
  bml.loadPrelude();
  const say = (s) => bml.run(s).text;

  assert.match(say('Date'), /Date is a structure, not a value/);
  assert.match(say('Date'), /try Date\./);
  assert.match(say('val f = Date'), /is a structure, not a value/);
  // The suggestion carries the advice through rather than sending a reader
  // from one unbound name to another.
  assert.match(say('date'), /did you mean the structure Date\? try Date\./);
  // Callable members come first: ordering by key put the month constructors in
  // front, which are the least useful thing in there.
  assert.match(say('Date'), /Date\.fromTime/);
  // And the structure's own workings stay private.
  assert.equal(bml.run('Date.monthOf 0').ok, false, 'monthOf is local to Date');
  assert.equal(say('Date.toString (Date.fromTimeUniv 0)'), '"Thu Jan 01 00:00:00 1970"');
});

test('an unfinished binding says what is missing, not which token', () => {
  // `val d : Date` answered "expected eq, got 'EOF'", which says what the
  // parser wanted rather than what the reader left out.
  const bml = createInterpreter({ typecheck: 'off', clock: () => 0 });
  bml.loadPrelude();
  assert.match(bml.run('val d : Date').text, /needs a value as well as a type/);
  assert.match(bml.run('val d').text, /needs a value: val d = 0/);
  assert.match(bml.run('fun f x').text, /needs a body: fun f x = x/);
  // The finished forms are untouched — these rules fire only after a parse has
  // already failed, but that is worth asserting rather than assuming.
  assert.equal(bml.run('val d2 : int = 0').ok, true);
  assert.equal(bml.run('fun f2 x = x').ok, true);
});

test('a short name gets no guess, and a member inside a structure gets pointed at', () => {
  const bml = createInterpreter({ typecheck: 'off', clock: () => 0 });
  bml.loadPrelude();
  const say = (s) => bml.run(s).text;

  // ONE EDIT MEANS NOTHING ON A SHORT NAME. Every one-character name is one
  // edit from every other, so `e handle Bad => 0` was answered "did you mean
  // o?" — confident, and no help at all.
  assert.equal(say('e handle Bad => 0'), 'ERR: unbound variable: e');
  assert.equal(say('e'), 'ERR: unbound variable: e');
  assert.equal(say('ab'), 'ERR: unbound variable: ab');
  // Three characters is where an edit is a small enough part of the word to be
  // a slip rather than a coincidence.
  assert.match(say('Tim'), /Time/);
  assert.match(say('prnt'), /did you mean print\?/);

  // A name that is nowhere at the top level may still be inside a structure.
  assert.match(say('February'), /there is Date\.Feb/);
  assert.match(say('tabulate'), /there is List\.tabulate/);
  // And a name that is neither gets nothing rather than a guess.
  assert.equal(say('zqxjw'), 'ERR: unbound variable: zqxjw');
});

test('a `()` parameter is unit, not a fresh variable', () => {
  // `fun f () = 5` reported `'a -> int`, because inferPattern had no case for
  // the unit pattern and fell through to a fresh variable. So `f 7` was let
  // past the checker to fail at RUN time with an unmatched pattern, where
  // Standard ML refuses it where it is written.
  const bml = createInterpreter({ typecheck: 'strict', clock: () => 0 });
  bml.loadPrelude();
  bml.run('fun u1 () = 5');
  assert.equal(bml.typeReport('u1'), 'unit -> int');
  assert.equal(bml.run('u1 ()').text, '5');
  const bad = bml.run('u1 7');
  assert.equal(bad.ok, false);
  assert.match(bad.text, /unit and int are not the same type/);
  // Every function in the library that takes unit gains the same.
  assert.equal(bml.typeReport('Time.now'), 'unit -> int');
});

test('a datatype declared inside a structure publishes its constructors', () => {
  // `Date.Wed` reported `'a`. A structure's member walk collected its VALUES
  // and not the constructors of a datatype declared in it, so they were unknown
  // both outside the structure and inside its own body.
  const bml = createInterpreter({ typecheck: 'strict', clock: () => 0 });
  bml.loadPrelude();
  bml.run('structure Pal = struct datatype hue = Red | Blue of int val n = 1 end');
  assert.equal(bml.typeReport('Pal.Red'), 'hue');
  assert.equal(bml.typeReport('Pal.Blue'), 'int -> hue');
  assert.equal(bml.typeReport('Pal.n'), 'int', 'and a plain value is unaffected');
  // The library's own, which is where this was reported.
  assert.equal(bml.typeReport('Date.Wed'), 'weekday');
  assert.equal(bml.typeReport('Date.Jan'), 'month');
  assert.equal(bml.run('Date.Wed').text, 'Wed');
  // A top-level datatype was always fine; assert it stays so.
  bml.run('datatype colour = R | G of int');
  assert.equal(bml.typeReport('R'), 'colour');
  assert.equal(bml.typeReport('G'), 'int -> colour');
});

test('a qualified name whose structure is right is judged on its MEMBER', () => {
  // `Date.January` when the month is `Date.Jan`. suggestName judges a qualified
  // name on its HEAD, found Date perfectly good, and said nothing — so every
  // near miss on a member got the bare message and no help at all.
  const bml = createInterpreter({ typecheck: 'off', clock: () => 0 });
  bml.loadPrelude();
  const say = (s) => bml.run(s).text;

  assert.match(say('Date.January'), /did you mean Date\.Jan\?/);
  assert.match(say('Date.April'), /did you mean Date\.Apr\?/);
  assert.match(say('Date.Monday'), /did you mean Date\.Mon\?/);
  assert.match(say('Date.Friday'), /did you mean Date\.Fri\?/);
  assert.match(say('Date.Friay'), /did you mean Date\.Fri\?/, 'a slip as well as a long form');
  assert.match(say('List.mapp'), /did you mean List\.map\?/);
  // Nothing like it in there: say that rather than guess.
  assert.match(say('Date.zzz'), /Date has no zzz/);
  // A wrong STRUCTURE is still judged on the structure.
  assert.match(say('Lst.map'), /did you mean the structure List\?/);
  // The ones that exist are untouched.
  assert.equal(say('Date.May'), 'May');
  assert.equal(say('Date.Wed'), 'Wed');
});

test('row polymorphism: #lab constrains an argument it has not seen', () => {
  // `case 'Select': return fresh();  // needs row polymorphism; honestly
  // unknown` — so every projection written INSIDE a function reported `'a -> 'b`
  // and constrained nothing. Which is every accessor in Date.
  const bml = createInterpreter({ typecheck: 'strict', clock: () => 0 });
  bml.loadPrelude();

  assert.equal(bml.typeReport('#a'), "{a : 'a, ...} -> 'a");
  assert.equal(bml.typeReport('fn x => #a x'), "{a : 'a, ...} -> 'a");
  // The field's type is constrained by what is done with it.
  assert.equal(bml.typeReport('fn r => #a r + 1'), '{a : int, ...} -> int');
  // `{a, ...}` is an open record, so a pattern says the same thing.
  assert.equal(bml.typeReport('fn {a, ...} => a'), "{a : 'a, ...} -> 'a");
  assert.equal(bml.typeReport('fn {a, b} => a'), "{a : 'a, b : 'b} -> 'a", 'and a closed one stays closed');

  // A projection that cannot work is refused where it is written.
  const bad = bml.run('(fn x => #a x) {b = 1}');
  assert.equal(bad.ok, false);
  assert.match(bad.text, /has no field a/);
  // Date's accessors, which is what started this.
  assert.match(bml.typeReport('Date.year'), /^\{year : /);
});

test('records unify BY LABEL, not by position', () => {
  // Position was all this had. So the same record written in two field orders
  // was refused for disagreeing about field one, and two records with different
  // labels but the same width were accepted as the same type and failed at RUN
  // time instead.
  const bml = createInterpreter({ typecheck: 'strict', clock: () => 0 });
  bml.loadPrelude();

  bml.run('fun tk (r : {a : int, b : string}) = #a r');
  assert.equal(bml.run('tk {b = "x", a = 1}').text, '1', 'the same record, written in the other order');
  assert.equal(bml.run('tk {a = 1, b = "x"}').text, '1');

  bml.run('fun tk2 (r : {a : int, b : int}) = #a r');
  const wrong = bml.run('tk2 {c = 1, d = 2}');
  assert.equal(wrong.ok, false, 'different labels are a different type');
  assert.match(wrong.text, /not the same type|has no field/);

  // A generalised record type keeps its labels through instantiation — it was
  // rebuilt without them, so any reuse lost the fields.
  bml.run('fun pair x = {a = x, b = x}');
  assert.equal(bml.typeReport('pair 1'), '{a : int, b : int}');
  assert.equal(bml.typeReport('pair "s"'), '{a : string, b : string}');
});

// ---- the eight language gaps, one test each (docs/language-gaps-plan.md) ----

test('G1: control and unicode string escapes', () => {
  // `\^A` is the control character whose code is the letter's minus 64; `\uXXXX`
  // is four hex digits. Both are in the Definition and neither lexed.
  const bml = createInterpreter({ typecheck: 'strict' });
  bml.loadPrelude();
  assert.equal(bml.run('size "\\^A"').text, '1');
  assert.equal(bml.run('ord (String.sub ("\\^A", 0))').text, '1');
  assert.equal(bml.run('ord (String.sub ("\\^[", 0))').text, '27');
  assert.equal(bml.run('"\\u0041"').text, '"A"');
  assert.equal(bml.run('"\\u00e9"').text, '"é"');
  assert.equal(bml.run('"\\^"').ok, false, 'and a malformed one is refused');
  assert.equal(bml.run('"\\u12"').ok, false);
  // The escapes that already worked are untouched.
  assert.equal(bml.run('size "a\\nb"').text, '3');
  assert.equal(bml.run('"\\065"').text, '"A"');
});

test('G2: numeric record labels', () => {
  // In Standard ML a tuple IS a record with numeric labels. The labels were read
  // as identifiers only, so the numeric spelling was a parse error.
  const bml = createInterpreter({ typecheck: 'off' });
  bml.loadPrelude();
  assert.equal(bml.run('#1 {1 = 9, 2 = 8}').text, '9');
  assert.equal(bml.run('#2 {1 = 9, 2 = 8}').text, '8');
  assert.equal(bml.run('case {1 = 4, 2 = 5} of {1 = a, 2 = b} => a + b').text, '9');
  assert.equal(bml.run('{a = 1}').text, '{a = 1}', 'and a named label still reads');
  assert.equal(bml.run('#1 (4, 5)').text, '4');
});

test('G3: datatype replication shares the constructors', () => {
  // `datatype t = datatype u` is another name for one type, not a copy of it,
  // so a value made with u's constructor matches a pattern written against t.
  // That is the half the exception replication got wrong at first.
  const bml = createInterpreter({ typecheck: 'strict' });
  bml.loadPrelude();
  bml.run('datatype hue = Red | Blue of int');
  assert.equal(bml.run('datatype shade = datatype hue').ok, true);
  assert.equal(bml.run('case Red of Red => "red" | Blue _ => "blue"').text, '"red"');
  assert.equal(bml.run('case Blue 2 of Red => 0 | Blue n => n').text, '2');
  assert.equal(bml.run('datatype nope = datatype zzz').ok, false, 'and only a datatype can be');
});

test('G4: open inside a let, and it stops at the end', () => {
  const bml = createInterpreter({ typecheck: 'off' });
  bml.loadPrelude();
  assert.equal(bml.run('let open List in null [] end').text, 'true');
  bml.run('structure Q9 = struct val z9 = 41 end');
  assert.equal(bml.run('let open Q9 in z9 + 1 end').text, '42');
  // SCOPED. `open` binds into the environment rather than the session, so a
  // child scope gives it exactly the reach the Definition says: the body.
  assert.equal(bml.run('z9').ok, false, 'and no further than the end');
  // A plain top-level open is unaffected.
  bml.run('open Q9');
  assert.equal(bml.run('z9').text, '41');
});

test('G5: a let, if, case or fn may be an operator’s right operand', () => {
  const bml = createInterpreter({ typecheck: 'off' });
  bml.loadPrelude();
  assert.equal(bml.run('1 + let val m = 2 in m end').text, '3');
  assert.equal(bml.run('let val a = 1 in a end + let val b = 2 in b end').text, '3');
  assert.equal(bml.run('1 + if true then 2 else 3').text, '3');
  assert.equal(bml.run('1 + case 0 of 0 => 5 | _ => 6').text, '6');

  // The `;` work at v1.307 and the left-operand work at v1.312 are what this
  // could have broken, so each of their shapes is asserted rather than assumed.
  assert.equal(bml.run('let val x = 1 in x; x + 1 end').text, '2');
  assert.equal(bml.run('(1; 2; 3)').text, '3');
  assert.equal(bml.run('(if true then 1 else 2; 7)').text, '7');
  assert.equal(bml.run('let val a = 2 in let val b = 3 in a * b end end').text, '6');
  assert.equal(bml.run('let val m = 3 in m end * 2').text, '6');
  assert.equal(bml.run('2 * 3 + 1').text, '7', 'precedence is unchanged');
  assert.equal(bml.run('1 :: 2 :: nil').text, '[1, 2]', 'and so is associativity');
});

test('G6: a functor may take several structures', () => {
  // `functor F (structure P : S structure Q : S)` is Standard ML's sugar for a
  // functor over one anonymous structure with P and Q inside it, and the
  // application supplies one structure per name.
  const bml = createInterpreter({ typecheck: 'off' });
  bml.loadPrelude();
  bml.run('signature Q1 = sig val v : int end');
  assert.equal(bml.run('functor F2 (structure P : Q1 structure Q : Q1) = struct val w = P.v + Q.v end').ok, true);
  bml.run('structure A1 = struct val v = 10 end');
  bml.run('structure B1 = struct val v = 32 end');
  bml.run('structure R2 = F2 (structure P = A1 structure Q = B1)');
  assert.equal(bml.run('R2.w').text, '42');

  // An anonymous structure per binding, which is what examples/25-functors.ml
  // writes and what the first spelling of this refused.
  bml.run('structure R6 = F2 (structure P = struct val v = 1 end structure Q = struct val v = 2 end)');
  assert.equal(bml.run('R6.w').text, '3');

  // All three single-parameter forms are untouched.
  bml.run('functor F1 (X : Q1) = struct val m = X.v end');
  bml.run('structure R3 = F1 (A1)');
  assert.equal(bml.run('R3.m').text, '10', 'by name');
  bml.run('structure R4 = F1 (structure X = A1)');
  assert.equal(bml.run('R4.m').text, '10', 'by specification');
  bml.run('structure R5 = F1 (struct val v = 7 end)');
  assert.equal(bml.run('R5.m').text, '7', 'anonymous');
});

test('G7/G8: an operator can be named where it will be used', () => {
  // `fun (f ** g) (x, y) = …` defines `**`, not a function called f, and
  // `fun (op ++) (a, b) = …` names the operator plainly. Standard ML reads the
  // left-hand side as a pattern and takes the operator out of it.
  const bml = createInterpreter({ typecheck: 'off' });
  bml.loadPrelude();

  bml.run('fun (f ** g) (x, y) = (f x, g y)');
  bml.run('infix 7 **');
  assert.equal(bml.run('((fn a => a + 1) ** (fn b => b * 2)) (3, 4)').text, '(4, 8)');

  bml.run('fun (op ++) (a, b) = a + b');
  bml.run('infix 6 ++');
  assert.equal(bml.run('3 ++ 4').text, '7');

  // Nothing that was already a binding changes: the shapes below all begin with
  // a `(` too, and are read as they were.
  bml.run('fun idp (x) = x');
  assert.equal(bml.run('idp 9').text, '9');
  bml.run('fun swp (a, b) = (b, a)');
  assert.equal(bml.run('swp (1, 2)').text, '(2, 1)');
  bml.run('val (va, vb) = (1, 2)');
  assert.equal(bml.run('va').text, '1', 'a val still takes a pattern there');
});

test('the language holds nothing of the game', () => {
  // src/lang/ is Standard ML and nothing else. NostOS passes its own values
  // through the evaluator — a tower, a key, a file on a card — and their tags
  // were cased for BY NAME in there, so `case 'key': return v.kind === 'aikey'
  // ? 'the AI key' : …` put the AI key inside an implementation of a 1997
  // language standard. A parse error suggested `let k = hack OB_XXXX in …` too.
  //
  // A host with such values says how they read, the same way it says what an
  // unbound name means. This walks the source because that is the only thing
  // that will notice when one creeps back.
  const dir = new URL('../src/', import.meta.url);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  assert.ok(files.length >= 8, 'found the language');
  const game = /\b(aikey|OB_XXXX|obelisk|hermes|lyre|W4|calypso|poseidon)\b/i;
  for (const f of files) {
    const src = fs.readFileSync(new URL(f, dir), 'utf8');
    src.split('\n').forEach((line, i) => {
      // A comment may EXPLAIN why a host policy exists — that is the design and
      // it is worth writing down. Code may not.
      const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
      const m = game.exec(code);
      assert.equal(m, null, `${f}:${i + 1} names ${m && m[0]} in code: ${line.trim()}`);
    });
  }
});

test('the Basis: the members Phase 1 filled in', () => {
  // docs/basis-plan.md. Every one called once against its answer — the
  // checklist compares answers too, but it is a list of FEATURES and this is a
  // list of members, so it belongs here.
  const bml = createInterpreter({ typecheck: 'strict', clock: () => 0 });
  bml.loadPrelude();
  const is = (src, want) => assert.equal(bml.run(src).text, want, src);

  // List
  is('List.hd [1,2]', '1');
  is('List.tl [1,2]', '[2]');
  is('List.getItem [1,2]', 'SOME (1, [2])');
  is('List.revAppend ([1,2],[3])', '[2, 1, 3]');
  is('List.mapPartial (fn x => if x > 1 then SOME x else NONE) [1,2,3]', '[2, 3]');
  is('List.collate Int.compare ([1,2],[1,3])', 'LESS');
  // ListPair, which had two of a dozen
  is('ListPair.zipEq ([1],[2])', '[(1, 2)]');
  is('ListPair.map (fn (a,b) => a+b) ([1,2],[3,4])', '[4, 6]');
  is('ListPair.all (fn (a,b) => a < b) ([1],[2])', 'true');
  is('ListPair.foldl (fn (a,b,c) => a+b+c) 0 ([1],[2])', '3');
  is('(ListPair.zipEq ([1],[2,3])) handle UnequalLengths => nil', '[]');
  // Option
  is('Option.mapPartial (fn x => SOME (x+1)) (SOME 1)', 'SOME 2');
  is('Option.compose (fn x => x+1, fn y => SOME y) 1', 'SOME 2');
  // Vector
  is('Vector.update (#[1,2,3], 1, 9)', '#[1, 9, 3]');
  is('Vector.mapi (fn (i,x) => i+x) #[10,20]', '#[10, 21]');
  is('Vector.foldli (fn (i,x,a) => i+x+a) 0 #[1,2]', '4');
  // Char
  is('Char.isPunct #","', 'true');
  is('Char.isHexDigit #"f"', 'true');
  is('Char.succ #"a"', '#"b"');
  is('Char.contains "abc" #"b"', 'true');
  // String
  is('String.str #"a"', '"a"');
  is('String.isSuffix "lo" "hello"', 'true');
  is('String.isSubstring "ell" "hello"', 'true');
  // Substring, which had ten of thirty
  is('Substring.getc "ab"', 'SOME (#"a", "b")');
  is('Substring.splitAt ("abcd", 2)', '("ab", "cd")');
  is('Substring.dropl (fn c => c = #" ") "  hi"', '"hi"');
  is('Substring.splitl Char.isAlpha "ab1"', '("ab", "1")');
  // Int and Real
  is('Int.quot (~7, 2)', '~3');
  is('Int.rem (~7, 2)', '~1');
  is('Real.floor ~2.5', '~3');
  is('Real.ceil 2.1', '3');
  is('Real.rem (7.5, 2.0)', '1.5');
  is('Real.round 3.7', '4', 'and round still reads the primitive, not Real.floor');
  is('Time.toReal 1500', '1.5');
});

test('StringCvt, and the constructor payload it exposed', () => {
  const bml = createInterpreter({ typecheck: 'strict', clock: () => 0 });
  bml.loadPrelude();
  assert.equal(bml.run('StringCvt.HEX').text, 'HEX');
  assert.equal(bml.run('StringCvt.padLeft #"0" 4 "7"').text, '"0007"');
  assert.equal(bml.run('StringCvt.padRight #"." 4 "ab"').text, '"ab.."');
  assert.equal(bml.run('StringCvt.skipWS "  hi"').text, '"hi"');

  // `GEN of int option` typed its payload as plain `int`: typeOfWords named
  // `list` and nothing else, so any other type constructor was DROPPED and the
  // head taken. Writing StringCvt is what found it.
  assert.equal(bml.run('StringCvt.GEN NONE').text, 'GEN NONE');
  assert.equal(bml.run('StringCvt.FIX (SOME 2)').text, 'FIX (SOME 2)');
  bml.run('datatype box = B of int option');
  assert.equal(bml.typeReport('B'), 'int option -> box');
  bml.run('datatype lb = LB of string list');
  assert.equal(bml.typeReport('LB'), 'string list -> lb', 'and list is unaffected');
});

test('every member of every structure is actually bound', () => {
  // A STRUCTURE THAT FAILS TO LOAD IS DROPPED IN SILENCE — one member that will
  // not type does not stop the rest, which is right for a console but means an
  // absent structure says nothing at all. The monomorphic arrays were written
  // before Array and Vector in the prelude, and since `val fromList =
  // Vector.fromList` is evaluated where it stands, all eight bound NOTHING and
  // the only sign was a member that could not be found later.
  const bml = createInterpreter({ typecheck: 'off', clock: () => 0 });
  bml.loadPrelude();
  const members = {};
  for (const k of Object.keys(bml.session)) {
    const dot = k.indexOf('.');
    if (dot <= 0 || k.startsWith('__')) continue;
    const m = k.slice(dot + 1);
    if (m.includes('.')) continue;
    (members[k.slice(0, dot)] = members[k.slice(0, dot)] || []).push(m);
  }
  const names = Object.keys(members).sort();
  assert.ok(names.length >= 28, `28 structures or more, found ${names.length}`);
  // The ones that must be there, by name, so a structure quietly vanishing is
  // a failure rather than a smaller number nobody reads.
  for (const s of ['Array', 'Bool', 'Char', 'CharArray', 'CharVector', 'Date', 'General',
    'Int', 'IntArray', 'IntVector', 'List', 'ListPair', 'Math', 'Option', 'Real',
    'RealArray', 'RealVector', 'String', 'StringCvt', 'Substring', 'TextIO', 'Time',
    'Vector', 'Word', 'Word8', 'Word8Array', 'Word8Vector']) {
    assert.ok(members[s], `${s} is missing from the prelude`);
  }
  // Bound is what is asserted, not that it evaluates: naming a primitive-backed
  // function bare answers "needs more arguments", which is not a fault.
  let total = 0;
  for (const s of names) {
    for (const m of members[s]) {
      total++;
      const t = String(bml.run(`${s}.${m}`).text || '');
      assert.ok(!/unbound variable/.test(t), `${s}.${m} is not bound`);
    }
  }
  assert.ok(total >= 400, `400 members or more, found ${total}`);
  // And OS stays out for good: nothing behind this has a file system.
  assert.equal(members.OS, undefined, 'OS is deliberately absent');
});

test('Word8 and the bitwise operators Word never had', () => {
  const bml = createInterpreter({ typecheck: 'strict' });
  bml.loadPrelude();
  const is = (src, want) => assert.equal(bml.run(src).text, want, src);
  // A word is unsigned, so each answer goes back into that range: `notb 0w0`
  // is 4294967295, not ~1.
  is('Word.andb (0w12, 0w10)', '8');
  is('Word.orb (0w12, 0w10)', '14');
  is('Word.xorb (0w12, 0w10)', '6');
  is('Word.notb 0w0', '4294967295');
  is('Word.wordSize', '32');
  // `Word.<<` could not be WRITTEN: the identifier lexer stops at the `<`, so
  // `Word.` was one token and `<<` the next, and every shift was unreachable.
  is('Word.<< (0w1, 0w4)', '16');
  is('Word.>> (0w16, 0w4)', '1');
  is('Word.~>> (0w16, 0w4)', '1');
  // Word8 is the same, masked to eight bits.
  is('Word8.wordSize', '8');
  is('Word8.notb 0w0', '255');
  is('Word8.fromInt 300', '44');
  is('Word8.<< (0w1, 0w9)', '0');
  is('Word8.toString 0w255', '"FF"');
});

test('the monomorphic arrays and vectors', () => {
  const bml = createInterpreter({ typecheck: 'strict' });
  bml.loadPrelude();
  const is = (src, want) => assert.equal(bml.run(src).text, want, src);
  is('CharVector.toString (CharVector.fromString "abc")', '"abc"');
  is('CharVector.length (CharVector.fromString "abc")', '3');
  is('let val a = CharArray.fromString "abc" in (CharArray.update (a,0,#"z"); CharArray.toString a) end', '"zbc"');
  is('Word8Vector.length (Word8Vector.fromList [0w1,0w2])', '2');
  is('let val a = Word8Array.fromList [0w1] in (Word8Array.update (a,0,0w9); Word8Array.sub (a,0)) end', '9');
  is('RealVector.sub (RealVector.fromList [1.5,2.5], 1)', '2.5');
  is('IntArray.length (IntArray.fromList [1,2,3])', '3');
  is('IntVector.toList (IntVector.map (fn x=>x+1) (IntVector.fromList [1,2]))', '[2, 3]');
});

test('IntInf: whole numbers of any size, and a type of their own', () => {
  const bml = createInterpreter({ typecheck: 'strict' });
  bml.loadPrelude();
  const is = (src, want) => assert.equal(bml.run(src).text, want, src);
  is('IntInf.toString (IntInf.fromInt 42)', '"42"');
  is('IntInf.toString (IntInf.pow (IntInf.fromInt 2, 100))', '"1267650600228229401496703205376"');
  is('IntInf.toString (IntInf.* (IntInf.fromString "123456789012345678901234567890", IntInf.fromInt 2))',
    '"246913578024691357802469135780"');
  is('IntInf.toString (IntInf.+ (IntInf.fromInt 1, IntInf.fromInt 2))', '"3"');
  is('IntInf.toString (IntInf.~ (IntInf.fromInt 5))', '"~5"', 'and `op ~` can be declared at all');
  is('IntInf.toString (IntInf.fromString "~7")', '"~7"', 'a tilde is how ML writes a negative');
  is('IntInf.compare (IntInf.fromInt 1, IntInf.fromInt 2)', 'LESS');
  is('IntInf.fromInt 5 = IntInf.fromInt 5', 'true');
  is('IntInf.fromInt 5', '5');
  is('~3', '~3', 'and a plain negative still lexes');

  // A TYPE OF ITS OWN, as the Basis has it: an intinf and an int are not the
  // same thing, and mixing them is an error rather than a coercion.
  assert.equal(bml.typeReport('IntInf.fromInt 1'), 'intinf');
  const mixed = bml.run('IntInf.fromInt 1 + 1');
  assert.equal(mixed.ok, false);
  assert.match(mixed.text, /intinf and int are not the same type/);
});
