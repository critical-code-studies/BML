// AI-ML: the small functional language typed into an obelisk terminal, a
// HERMES relay, the NostBook, and carried by a machine as its own program.
// Design: docs/ob-terminal-language.md.
//
// LINEAGE. This is a descendant of Standard ML, and the resemblance is meant
// to survive inspection: `let` and `let ... in`, `fn x => e` lambdas, named
// functions applied by juxtaposition, recursion, and lists built from `nil`
// and `::`. Harper's Introduction to Standard ML (1986-1993) is the reference
// the design keeps returning to; where this language departs from it, the
// departure is deliberate and noted at the point it happens.
//
// WHAT IT DROPS, and why. No type system: the machine this runs on has no
// compiler, only an interpreter, and a survivor typing at a dead console gets
// their error when the thing runs, not before. No pattern matcher: matching in
// ML is the eliminator for constructors declared with `datatype`, and there is
// no `datatype` here, so a matcher would have nothing to take apart but lists
// and would buy syntax rather than power. `hd`, `tl` and `length` do that job.
// No `map` or `filter`: with recursion you can write them, and writing them is
// what this machine is for.
//
// Runtime values are tagged objects, never raw JS primitives, so error
// messages can name what went wrong:
//   {tag:'node', id}   {tag:'key', id}   {tag:'num', v}
//   {tag:'list', items}  {tag:'unit'}   {tag:'fn', name, builtin, args}

export class RonmlError extends Error {}

// The current run's print buffer. `echo` pushes into it as it evaluates and the
// two entry points (runRonml / runStar) install a fresh one per line, so output
// arrives in order even from deep inside a recursion. Module-level on purpose:
// closures capture the ctx of the line that defined them, so a per-ctx buffer
// silently swallowed output from any function called on a LATER line.
let OUT = null;

// FUEL (docs/robot-programs-plan.md §3). A program carried by a machine must not
// be able to hang the game: `let f x = f x` has to stop somewhere. Evaluation
// counts reductions and aborts past a budget. At a console the budget is huge
// (a human is waiting, and a wrong line should still finish); for a machine's
// own program it is small and strict, because a unit whose program overruns is
// not an error message — it is a FAULT in that machine, and it should read that
// way in play.
export class RonmlFuelError extends RonmlError {}
const CONSOLE_FUEL = 200000;
let STEPS = 0;
let FUEL = CONSOLE_FUEL;

// ---- Tokenizer --------------------------------------------------------

function tokenize(src) {
  const toks = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c === '(' && src[i + 1] === '*') {
      const end = src.indexOf('*)', i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (c === ':' && src[i + 1] === ':') { toks.push({ t: 'CONS' }); i += 2; continue; }  // cons, as in ML
    if (c === '|' && src[i + 1] === '>') { toks.push({ t: 'PIPE' }); i += 2; continue; }
    if (c === '|') { toks.push({ t: 'BAR' }); i++; continue; }   // separates datatype constructors and case arms
    // Comparison operators (two-char forms first). Equality is `==` (bare `=` is
    // reserved for `let`), inequality `!=` or ML's `<>`.
    if (c === '<' && src[i + 1] === '=') { toks.push({ t: 'LE' }); i += 2; continue; }
    if (c === '>' && src[i + 1] === '=') { toks.push({ t: 'GE' }); i += 2; continue; }
    if (c === '<' && src[i + 1] === '>') { toks.push({ t: 'NE' }); i += 2; continue; }
    if (c === '!' && src[i + 1] === '=') { toks.push({ t: 'NE' }); i += 2; continue; }
    if (c === '<') { toks.push({ t: 'LT' }); i++; continue; }
    if (c === '>') { toks.push({ t: 'GT' }); i++; continue; }
    // Arithmetic. `-` is free now that node codes / filenames are underscored, so
    // it lexes as an operator and no longer as part of an identifier.
    if (c === '+') { toks.push({ t: 'PLUS' }); i++; continue; }
    if (c === '-') { toks.push({ t: 'MINUS' }); i++; continue; }
    if (c === '*') { toks.push({ t: 'STAR' }); i++; continue; }
    if (c === '/') { toks.push({ t: 'SLASH' }); i++; continue; }
    if (c === '^') { toks.push({ t: 'CARET' }); i++; continue; }   // string concat, ML-style
    if (c === '(') { toks.push({ t: 'LP' }); i++; continue; }
    if (c === ')') { toks.push({ t: 'RP' }); i++; continue; }
    if (c === '[') { toks.push({ t: 'LB' }); i++; continue; }
    if (c === ']') { toks.push({ t: 'RB' }); i++; continue; }
    if (c === ',') { toks.push({ t: 'COMMA' }); i++; continue; }
    if (c === ';') { toks.push({ t: 'SEMI' }); i++; continue; }   // sequence: e1 ; e2
    if (c === '=' && src[i + 1] === '>') { toks.push({ t: 'ARROW' }); i += 2; continue; } // fn x => e
    if (c === '=' && src[i + 1] === '=') { toks.push({ t: 'EQEQ' }); i += 2; continue; } // equality
    if (c === '=') { toks.push({ t: 'EQ' }); i++; continue; }                              // let-binding only
    if (c === '"') {
      let j = i + 1, s = '';
      while (j < n && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < n) { s += src[j + 1]; j += 2; continue; } // \" and \\ escapes
        s += src[j]; j++;
      }
      if (j >= n) throw new RonmlError('unterminated string — a " has no closing "');
      toks.push({ t: 'STR', v: s });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[0-9.]/.test(src[j])) j++;
      toks.push({ t: 'NUM', v: parseFloat(src.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      // `.` is allowed inside an identifier so filenames lex as one token
      // (factory_id.ml, readme.md) — evalNode tags anything ending .ml/.md a file.
      // `-` is NOT: it is the subtraction operator now (codes/filenames underscore).
      while (j < n && /[A-Za-z0-9_.]/.test(src[j])) j++;
      toks.push({ t: 'IDENT', v: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new RonmlError(`unexpected character '${c}'`);
  }
  toks.push({ t: 'EOF' });
  return toks;
}

// ---- Parser: expr -> tiny AST (Let, App, Var, Lit, ListLit) -----------

function isKeyword(tok, word) {
  return tok.t === 'IDENT' && tok.v.toLowerCase() === word;
}

function parse(toks) {
  let p = 0;
  const peek = () => toks[p];
  const eat = (t) => {
    if (toks[p].t !== t) throw new RonmlError(`expected ${t.toLowerCase()}, got '${toks[p].v ?? toks[p].t}'`);
    return toks[p++];
  };

  // `fn x => body` — an anonymous function (a lambda). Curry more than one
  // parameter as `fn x => fn y => …` (the `let f x y = …` sugar does this for you).
  function parseLambda() {
    p++; // 'fn'
    const param = eat('IDENT');
    if (peek().t !== 'ARROW') throw new RonmlError("expected '=>' after fn's parameter — try: fn x => x");
    p++;
    return { type: 'Lam', param: param.v, body: parseExpr() };
  }

  // Collect zero+ parameter names sitting between a let-name and its `=`, so
  // `let f x y = e` sugars to `let f = fn x => fn y => e`.
  function wrapParams(params, value) {
    let v = value;
    for (let k = params.length - 1; k >= 0; k--) v = { type: 'Lam', param: params[k], body: v };
    return v;
  }
  function letParams() {
    const params = [];
    while (peek().t === 'IDENT' && !isKeyword(peek(), 'in')) params.push(eat('IDENT').v);
    return params;
  }

  // Sequencing sits at the very top (loosest): `e1 ; e2` runs e1 for its effect,
  // throws away its value, then evaluates e2 and returns that. It threads through
  // everything below via parseExpr1. A trailing `;` (before `)` or end) is tolerated.
  function parseExpr() {
    let left = parseExpr1();
    while (peek().t === 'SEMI') {
      p++;
      if (peek().t === 'RP' || peek().t === 'EOF' || peek().t === 'RB') break; // trailing ; is fine
      left = { type: 'Seq', left, right: parseExpr1() };
    }
    return left;
  }

  function parseExpr1() {
    if (isKeyword(peek(), 'case')) return parseCase();
    if (isKeyword(peek(), 'fn')) return parseLambda();
    if (isKeyword(peek(), 'if')) return parseIf();
    if (isKeyword(peek(), 'let')) {
      p++;
      const nameTok = eat('IDENT');
      const params = letParams();
      eat('EQ');
      const value = wrapParams(params, parseExpr());
      if (!isKeyword(peek(), 'in')) throw new RonmlError("expected 'in' after let — try: let k = hack OB_XXXX in crash OB_XXXX k");
      p++;
      const body = parseExpr();
      return { type: 'Let', name: nameTok.v, value, body };
    }
    return parsePipe();
  }

  // `case e of p => e | p => e` — the eliminator. Every compound value in this
  // language is built by a constructor of some kind (cons for lists, a tuple's
  // comma, a datatype's own names), and Harper's point (1993, s.2.4) is that
  // the way to take such a value apart is to write down the shape it was built
  // with and let the machine fill in the parts. That is all a pattern is: an
  // expression whose variables are about to be bound rather than looked up.
  function parseCase() {
    p++; // 'case'
    const subject = parseExpr1();
    if (!isKeyword(peek(), 'of')) throw new RonmlError("expected 'of' after case — try: case l of nil => 0 | x :: r => 1");
    p++;
    const arms = [];
    for (;;) {
      const pat = parsePattern();
      if (peek().t !== 'ARROW') throw new RonmlError("expected '=>' after a pattern — try: nil => 0");
      p++;
      arms.push({ pat, body: parseExpr1() });
      if (peek().t !== 'BAR') break;
      p++;
    }
    return { type: 'Case', subject, arms };
  }

  // Patterns. Cons binds loosest so `x :: y :: rest` reads to the right, the
  // same way the expression does.
  function parsePattern() {
    const head = parsePatternAtom();
    if (peek().t !== 'CONS') return head;
    p++;
    return { p: 'cons', head, tail: parsePattern() };
  }

  // One pattern in argument position: an atom, but a bare name stays a bare
  // name rather than swallowing what follows it.
  function parsePatternArg() {
    const tok = peek();
    if (tok.t === 'IDENT') {
      const lower = tok.v.toLowerCase();
      if (!['of', 'case', 'let', 'in', 'if', 'then', 'else', 'fn', 'and', 'or', 'mod'].includes(lower)) {
        p++;
        if (tok.v === '_') return { p: 'wild' };
        if (lower === 'nil') return { p: 'nil' };
        if (lower === 'true') return { p: 'bool', v: true };
        if (lower === 'false') return { p: 'bool', v: false };
        return { p: 'name', name: tok.v, args: [] };
      }
    }
    return parsePatternAtom();
  }

  function parsePatternAtom() {
    const tok = peek();
    if (tok.t === 'NUM') { p++; return { p: 'num', v: tok.v }; }
    if (tok.t === 'STR') { p++; return { p: 'str', v: tok.v }; }
    if (tok.t === 'MINUS') { p++; const n = eat('NUM'); return { p: 'num', v: -n.v }; }
    if (tok.t === 'LB') {
      p++;
      const items = [];
      if (peek().t !== 'RB') {
        items.push(parsePattern());
        while (peek().t === 'COMMA') { p++; items.push(parsePattern()); }
      }
      eat('RB');
      return items.reduceRight((tail, head) => ({ p: 'cons', head, tail }), { p: 'nil' });
    }
    if (tok.t === 'LP') {
      p++;
      const first = parsePattern();
      if (peek().t === 'COMMA') {
        const items = [first];
        while (peek().t === 'COMMA') { p++; items.push(parsePattern()); }
        eat('RP');
        return { p: 'tuple', items };
      }
      eat('RP');
      return first;
    }
    if (tok.t === 'IDENT') {
      p++;
      const v = tok.v;
      const lower = v.toLowerCase();
      if (v === '_') return { p: 'wild' };
      if (lower === 'nil') return { p: 'nil' };
      if (lower === 'true') return { p: 'bool', v: true };
      if (lower === 'false') return { p: 'bool', v: false };
      // A constructor pattern may take arguments: `Circle r`, `Rect w h`. A
      // bare name with none is ambiguous between a nullary constructor and a
      // variable, and is resolved at match time against the declared set,
      // because with no types there is nothing else to resolve it against.
      // Arguments are parsed WITHOUT letting each one collect arguments of its
      // own, or `Rect w h` would read as `Rect (w h)` and the constructor would
      // see one argument where it declared two. Nest with parentheses when a
      // sub-pattern really is applied: `Node (Leaf x) r`.
      const args = [];
      while (peek().t === 'IDENT' || peek().t === 'NUM' || peek().t === 'LP' || peek().t === 'LB') {
        if (peek().t === 'IDENT' && ['of', 'case', 'let', 'in', 'if', 'then', 'else', 'fn', 'and', 'or', 'mod'].includes(peek().v.toLowerCase())) break;
        args.push(parsePatternArg());
      }
      return { p: 'name', name: v, args };
    }
    throw new RonmlError(`'${tok.v ?? tok.t}' cannot start a pattern`);
  }

  // `if c then a else b` — the conditional. The condition is a full expression
  // (a comparison, usually); `then`/`else` are keywords, so the sub-parsers stop
  // at them cleanly.
  function parseIf() {
    p++; // 'if'
    const cond = parseExpr();
    if (!isKeyword(peek(), 'then')) throw new RonmlError("expected 'then' — try: if n == 0 then 1 else 0");
    p++;
    const thenE = parseExpr();
    if (!isKeyword(peek(), 'else')) throw new RonmlError("if needs an 'else' — try: if n == 0 then 1 else 0");
    p++;
    const elseE = parseExpr();
    return { type: 'If', cond, then: thenE, else: elseE };
  }

  function parsePipe() {
    let left = parseBool();
    while (peek().t === 'PIPE') {
      p++;
      const right = parseBool();
      left = { type: 'App', fn: right, arg: left };
    }
    return left;
  }

  // `and` / `or`: loosest of the operators, so a condition reads the way it is
  // spoken — `threat and hurt`. Both SHORT-CIRCUIT, which matters once sensors
  // are functions: `linked and calls_home` must not call home when unlinked.
  function parseBool() {
    let left = parseCompare();
    while (peek().t === 'IDENT' && (peek().v.toLowerCase() === 'and' || peek().v.toLowerCase() === 'or')) {
      const op = toks[p++].v.toLowerCase();
      left = { type: 'Bool', op, left, right: parseCompare() };
    }
    return left;
  }

  // Precedence, loosest to tightest: pipe < comparison < add/sub < mul/div/concat
  // < application (juxtaposition). So `fact (n - 1) * n` is `(fact (n-1)) * n`, and
  // `scan |> nearest` still parses as a pipe of two applications.
  function parseCompare() {
    let left = parseCons();
    while (['LT', 'GT', 'LE', 'GE', 'EQEQ', 'NE'].includes(peek().t)) {
      const op = toks[p++].t;
      left = { type: 'Bin', op, left, right: parseAdd() };
    }
    return left;
  }
  function parseAdd() {
    let left = parseMul();
    while (peek().t === 'PLUS' || peek().t === 'MINUS') {
      const op = toks[p++].t;
      left = { type: 'Bin', op, left, right: parseMul() };
    }
    return left;
  }
  // `::` is right-associative: 1 :: 2 :: nil parses as 1 :: (2 :: nil). Harper
  // (1993, p.9) puts it this way — a list "is either empty, or it consists of a
  // value of type t followed by a t list" — and the associativity is what makes
  // that recursive reading hold. Written by recursive descent on the right,
  // which is the shortest correct way to say right-associative.
  function parseCons() {
    const left = parseAdd();
    if (peek().t !== 'CONS') return left;
    p++;
    return { type: 'Cons', head: left, tail: parseCons() };
  }

  function parseMul() {
    let left = parseApp();
    // `mod` is a word rather than a symbol, as it is in ML, so it arrives as an
    // IDENT and is matched here by value. Same precedence as * and /.
    const isMod = (t) => t.t === 'IDENT' && t.v.toLowerCase() === 'mod';
    while (peek().t === 'STAR' || peek().t === 'SLASH' || peek().t === 'CARET' || isMod(peek())) {
      const op = isMod(peek()) ? (p++, 'MOD') : toks[p++].t;
      left = { type: 'Bin', op, left, right: parseApp() };
    }
    return left;
  }

  function atomStarts(tok) {
    // Keywords delimit rather than begin an atom, so a bare `if`/`then`/`else`/`fn`
    // in application position ends the current argument list instead of being eaten
    // as a variable named "then".
    if (tok.t === 'IDENT' && ['in', 'let', 'if', 'then', 'else', 'fn', 'and', 'or', 'mod', 'case', 'of', 'datatype'].includes(tok.v.toLowerCase())) return false;
    return tok.t === 'NUM' || tok.t === 'STR' || tok.t === 'IDENT' || tok.t === 'LP' || tok.t === 'LB';
  }

  function parseApp() {
    let node = parseAtom();
    while (atomStarts(peek())) {
      const arg = parseAtom();
      node = { type: 'App', fn: node, arg };
    }
    return node;
  }

  function parseAtom() {
    const tok = peek();
    // Unary minus: `-3` is `0 - 3`. (Binary `5 - 3` is caught in parseAdd before
    // we ever reach here, so this only fires when `-` opens a subexpression.)
    if (tok.t === 'MINUS') { p++; return { type: 'Bin', op: 'MINUS', left: { type: 'Lit', value: 0 }, right: parseAtom() }; }
    if (tok.t === 'NUM') { p++; return { type: 'Lit', value: tok.v }; }
    if (tok.t === 'STR') { p++; return { type: 'StrLit', value: tok.v }; }
    if (tok.t === 'IDENT') { p++; return { type: 'Var', name: tok.v }; }
    if (tok.t === 'LP') {
      p++;
      const e = parseExpr();
      // (e) is just e; (e1, e2, ...) is a tuple. Harper introduces tuples
      // before lists (1993, s.2.2.6) because they are the simpler compound:
      // fixed width, and the parts may differ in kind.
      if (peek().t === 'COMMA') {
        const items = [e];
        while (peek().t === 'COMMA') { p++; items.push(parseExpr()); }
        eat('RP');
        return { type: 'Tuple', items };
      }
      eat('RP');
      return e;
    }
    if (tok.t === 'LB') {
      p++;
      const items = [];
      if (peek().t !== 'RB') {
        items.push(parseExpr());
        while (peek().t === 'COMMA') { p++; items.push(parseExpr()); }
      }
      eat('RB');
      return { type: 'ListLit', items };
    }
    throw new RonmlError(tok.t === 'EOF' ? 'unexpected end of command' : `unexpected '${tok.v ?? tok.t}'`);
  }

  // The top level accepts a bare `let x = e` (no `in`) as a persistent
  // binding — the ML top-level. Nested lets inside an expression still require
  // `in` (parseExpr enforces that). So the fortress program can be typed as
  // separate lines that follow one another (copy aikey / let k = hack OB / ...).
  function parseTop() {
    // `datatype colour = Red | Blue | Circle of num`
    //
    // The `of ...` part is a TYPE, and this build does not check types, so it
    // is read for one thing only: how many arguments the constructor takes,
    // counted by the * between components. Harper (1993, s.2.7) declares the
    // type and its value constructors in one binding; so does this, minus the
    // checking. The Restrictions page says as much rather than implying more.
    if (isKeyword(peek(), 'datatype')) {
      p++;
      const nameTok = eat('IDENT');
      eat('EQ');
      const cons = [];
      for (;;) {
        const c = eat('IDENT');
        let arity = 0;
        if (isKeyword(peek(), 'of')) {
          p++;
          arity = 1;
          // Skip the type expression, counting * separators. A type here is a
          // run of identifiers; nothing else may appear.
          eat('IDENT');
          while (peek().t === 'STAR') { p++; eat('IDENT'); arity++; }
        }
        cons.push({ name: c.v, arity });
        if (peek().t !== 'BAR') break;
        p++;
      }
      return { type: 'Datatype', name: nameTok.v, cons };
    }
    if (isKeyword(peek(), 'let')) {
      p++;
      const nameTok = eat('IDENT');
      const params = letParams();
      eat('EQ');
      const value = wrapParams(params, parseExpr());
      if (isKeyword(peek(), 'in')) {
        p++;
        const body = parseExpr();
        return { type: 'Let', name: nameTok.v, value, body };
      }
      return { type: 'TopLet', name: nameTok.v, value };
    }
    return parseExpr();
  }

  const expr = parseTop();
  eat('EOF');
  return expr;
}

// What a unit's lamp can be set to. A machine of this vintage has one LED and
// a handful of drive levels, not a colour picker, so the set is short and named.
export const LAMP_COLOURS = ['red', 'amber', 'green', 'blue', 'white', 'off'];

// Effects a program can have on its own machine as it evaluates. Collected in
// EFFECTS (module-level, like OUT, because closures capture the defining ctx —
// see the echo bug) and drained by decide(). The engine decides whether to
// honour any of them; the language only records the request.
let EFFECTS = null;
function EFFECT(kind, arity, build) {
  return {
    arity,
    fn: (args) => {
      const extra = build(args) || {};
      if (EFFECTS) EFFECTS.push({ k: kind, ...extra });
      return { tag: 'unit' };
    },
  };
}

// A sensor: reads one field out of the snapshot the engine handed in. Missing
// readings are not an error — a machine with a broken sensor reports zero or
// false, and a program written against it still runs.
function SENSE(field, kind) {
  return {
    arity: 0,
    fn: (_args, ctx) => {
      const v = ctx && ctx.sense ? ctx.sense[field] : undefined;
      return kind === 'bool' ? { tag: 'bool', v: !!v } : { tag: 'num', v: Number(v) || 0 };
    },
  };
}

// ---- Builtins ----------------------------------------------------------
// Each `ctx` method is supplied by the caller (main.js) and does the actual
// world-mutation; this module only handles language mechanics and gating.

// `copy <file> <device>` — the arity-2 second half of the polymorphic `copy`.
// `copy` (below) returns a partial bound to this when its first arg is a file,
// so `copy factory_id.ml ob` moves the file, while `copy aikey` stays the
// arity-1 key-bind. ctx.copyFile does the world-side move and returns {ok,msg}.
const COPY_FILE = {
  arity: 2,
  fn: ([file, dest], ctx) => {
    if (!file || file.tag !== 'file') throw new RonmlError('copy needs a file first — try: copy factory_id.ml ob');
    const destName = (dest && dest.id) ? String(dest.id).toLowerCase() : '';
    if (!destName) throw new RonmlError('copy a file WHERE? — try: copy factory_id.ml ob');
    if (!ctx.copyFile) throw new RonmlError("you can't move files at this terminal.");
    const r = ctx.copyFile(file.name, destName);
    if (!r || !r.ok) throw new RonmlError((r && r.msg) || `couldn't copy ${file.name}.`);
    return { tag: 'file', name: file.name };
  },
};

function makeBuiltins(station) {
  const B = {
    scan: {
      arity: 0,
      fn: (_args, ctx) => ({ tag: 'list', items: ctx.listObelisks().map((id) => ({ tag: 'node', id })) }),
    },
    keys: {
      arity: 0,
      fn: (_args, ctx) => ({ tag: 'list', items: [...ctx.heldKeys()].map((id) => ({ tag: 'key', id })) }),
    },
    repel: {
      arity: 0,
      fn: (_args, ctx) => { ctx.repelNearby(); return { tag: 'unit' }; },
    },
    sing: {
      arity: 0,
      fn: (_args, ctx) => { ctx.sing(); return { tag: 'unit' }; },
    },
    map: {
      arity: 0,
      fn: (_args, ctx) => { ctx.showMap(); return { tag: 'unit' }; },
    },
    // `print <topic>` at an obelisk: `print map` runs off a carryable map;
    // `print aikey` stamps a fresh physical AI key at your feet (you must be
    // holding one — a spare against losing it). The HERMES relay overrides
    // `print` to take a document topic (see makeBuiltins).
    print: {
      arity: 1,
      fn: ([topic], ctx) => {
        const raw = topic && (topic.kind === 'aikey' ? 'aikey' : (topic.id || '')) || '';
        const name = String(raw).toLowerCase();
        if (name === 'aikey' || name === 'key') ctx.printKey();
        else if (name === 'map' || name === 'territory') ctx.printMap();
        else throw new RonmlError('print needs a topic — try: print map   or   print aikey');
        return { tag: 'unit' };
      },
    },
    // `copy aikey`: read the AI key you physically hold and bind it into the
    // session under the name you gave (usually `aikey`), so the rest of the
    // language can use it — the bridge from your pack to the console. Returns a
    // SEALED AI-key value; `decrypt` opens it. Fails if you hold no AI key.
    copy: {
      arity: 1,
      fn: ([what], ctx) => {
        // Polymorphic on the first argument.
        //  - a FILE (foo.ml)      -> `copy <file> <device>`: a partial bound to
        //    COPY_FILE that the next atom (the device) completes.
        //  - `aikey`/`card`/`key` -> the classic key-bind: bind the held AI key
        //    into the session as a sealed token for decrypt/unlock.
        //  - any OTHER bare word  -> a filename someone typed without its
        //    extension (players type `copy zeus_lightning card`, not
        //    `zeus_lightning.ml`): treat it as a file too, and let COPY_FILE + the
        //    fs resolve the extension. Forgiving beats a misleading error.
        if (what && what.tag === 'file') {
          return { tag: 'fn', name: 'copy', builtin: COPY_FILE, args: [what], ctx };
        }
        // The name may already be BOUND in the session — a previous `copy aikey`
        // or `copy card` binds `aikey`, so the SECOND `copy aikey` resolves the
        // bound key TOKEN, not the literal word, and used to fall through to a
        // baffling "copy what?" (while `copy card`, unbound, still worked). Accept
        // an already-sealed AI-key token and just re-affirm it.
        if (what && what.tag === 'key' && what.kind === 'aikey') {
          if (!ctx.hasAiKey || !ctx.hasAiKey()) {
            throw new RonmlError('nothing to copy — you are not holding an AI key. (a wrecked W-factory drops one.)');
          }
          const token = { tag: 'key', kind: 'aikey', enc: true };
          if (ctx.bindSession) ctx.bindSession('aikey', token);
          return token;
        }
        const id = (what && what.id ? String(what.id) : '').toLowerCase();
        if (id === 'aikey' || id === 'card' || id === 'key') {
          if (!ctx.hasAiKey || !ctx.hasAiKey()) {
            throw new RonmlError('nothing to copy — you are not holding an AI key. (a wrecked W-factory drops one.)');
          }
          const token = { tag: 'key', kind: 'aikey', enc: true };
          if (ctx.bindSession) ctx.bindSession(id === 'key' ? 'aikey' : id, token);
          return token;
        }
        if (id) {
          return { tag: 'fn', name: 'copy', builtin: COPY_FILE, args: [{ tag: 'file', name: id }], ctx };
        }
        throw new RonmlError('copy what? — try: copy <file> <drive>   or   copy aikey');
      },
    },
    // `cd <device>` / `ls`: the RON-DOS drive navigation. Devices are the AI key
    // you hold (cd aikey / cd card), the obelisk's scratch bench (cd ob), and a
    // HERMES relay's folder (cd hermes). `ls` lists the current device's files.
    // ctx supplies cd/ls (main.js) — where the file state actually lives.
    cd: {
      arity: 1,
      fn: ([dev], ctx) => {
        const name = (dev && (dev.id || dev.name)) ? String(dev.id || dev.name).toLowerCase() : '';
        if (!name) throw new RonmlError('cd needs a drive — try: cd card  ·  cd ob  (drives lists them)');
        if (!ctx.cd) throw new RonmlError('no drives at this terminal.');
        const r = ctx.cd(name);
        if (!r || !r.ok) throw new RonmlError((r && r.msg) || `no drive '${name}' here — try: drives`);
        return r.label ? { tag: 'node', id: `» ${r.label}` } : { tag: 'unit' }; // echo which drive + card state
      },
    },
    // `drives`: list the drives attached here (ob / card / hermes) and, crucially,
    // the card's CURRENT name — so you can always tell what state it's in.
    drives: {
      arity: 0,
      fn: (_args, ctx) => {
        if (!ctx.drives) throw new RonmlError('no drives at this terminal.');
        ctx.drives();
        return { tag: 'unit' };
      },
    },
    ls: {
      arity: 0,
      fn: (_args, ctx) => {
        if (!ctx.ls) throw new RonmlError('no drives at this terminal.');
        return { tag: 'list', items: (ctx.ls() || []).map((n) => ({ tag: 'file', name: n })) };
      },
    },
    // `decrypt aikey`: turn a sealed AI key (from `copy`) into the open token
    // `unlock` needs. The AI encrypts its own masters out of habit; this undoes it.
    decrypt: {
      arity: 1,
      fn: ([k], ctx) => {
        if (!k || k.tag !== 'key' || k.kind !== 'aikey') {
          throw new RonmlError('decrypt needs the AI key. copy it in first: copy aikey');
        }
        return { tag: 'key', kind: 'aikey', enc: false };
      },
    },
    // `echo`: PRINT a value — ML's `print`. It emits to the run's output buffer as a
    // side effect (mid-evaluation, so a recursive `echo n ; go (n-1)` prints every
    // step as it counts) and returns unit, not the string. runRonml/runStar join the
    // buffer with the final value for display.
    //
    // The buffer is module-level (OUT), deliberately NOT hung off `ctx`: a closure
    // captures the ctx of the line that DEFINED it, and the hub builds a fresh ctx
    // per command, so `let f = fn x => echo x` on one line and `f "hi"` on the next
    // pushed into the previous line's dead buffer and printed nothing.
    echo: {
      arity: 1,
      fn: ([x]) => {
        if (OUT) OUT.push(formatValue(x));
        return { tag: 'unit' };
      },
    },
    // ---- taking a list apart ------------------------------------------
    // The language could make lists from the day it had `scan`, and could do
    // nothing with one: a program could be handed a list and had no way in.
    // These three close that, and they are the language's own rather than any
    // station's, so a robot's program can use them with no network at all.
    // Deliberately not `map`/`filter`: with recursion these are enough to
    // write those yourself, which is the sort of thing this machine is for.
    hd: {
      arity: 1,
      fn: ([l]) => {
        if (!l || l.tag !== 'list') throw new RonmlError(`${describeValue(l)} is not a list`);
        if (!l.items.length) throw new RonmlError('hd: the list is empty. Check with length first.');
        return l.items[0];
      },
    },
    tl: {
      arity: 1,
      fn: ([l]) => {
        if (!l || l.tag !== 'list') throw new RonmlError(`${describeValue(l)} is not a list`);
        if (!l.items.length) throw new RonmlError('tl: the list is empty. Check with length first.');
        return { tag: 'list', items: l.items.slice(1) };
      },
    },
    length: {
      arity: 1,
      fn: ([l]) => {
        if (l && l.tag === 'str') return { tag: 'num', v: String(l.v).length };
        if (!l || l.tag !== 'list') throw new RonmlError(`${describeValue(l)} has no length`);
        return { tag: 'num', v: l.items.length };
      },
    },
    not: {
      arity: 1,
      fn: ([b]) => {
        if (!b || b.tag !== 'bool') throw new RonmlError(`${describeValue(b)} is not true or false`);
        return { tag: 'bool', v: !b.v };
      },
    },
    // ---- a machine's own senses (docs/robot-programs-plan.md §2) ----------
    // Nullary builtins reading the unit's state off ctx.sense. Functions, not
    // fields, so the language needs no records and no `.` accessor — and being
    // station-scoped means a unit's program cannot reach the network by mistake.
    charge: SENSE('charge', 'num'),
    integrity: SENSE('integrity', 'num'),
    range: SENSE('range', 'num'),
    home_range: SENSE('home_range', 'num'),
    threat: SENSE('threat', 'bool'),
    hurt: SENSE('hurt', 'bool'),
    linked: SENSE('linked', 'bool'),
    blight: SENSE('blight', 'bool'),
    daylight: SENSE('daylight', 'bool'),
    // ---- a machine's own EFFECTS ----------------------------------------
    // Sensors read; these do. They are not intents: a program still evaluates
    // to exactly one intent, and these happen along the way, exactly like
    // `echo` at a console. `beep ; if threat then hunt else patrol` sounds the
    // buzzer and then decides, and because they sit inside branches, a unit can
    // be made to announce only the thing you care about:
    //     if threat then (beep ; eye "white" ; hunt) else patrol
    // The engine collects them (decide returns them) and is free to refuse:
    // beeping is rate-limited and inaudible from across the island.
    beep: EFFECT('beep', 0, () => ({})),
    eye: EFFECT('eye', 1, ([c]) => {
      const name = String(c && c.v != null ? c.v : c && c.id != null ? c.id : '').toLowerCase();
      if (!LAMP_COLOURS.includes(name)) {
        throw new RonmlError(`no such lamp colour: ${name || '?'} — try ${LAMP_COLOURS.join(' · ')}`);
      }
      return { colour: name };
    }),
    flash: EFFECT('flash', 1, ([n]) => {
      const hz = Number(n && n.v);
      if (!Number.isFinite(hz) || hz < 0 || hz > 10) throw new RonmlError('flash takes a rate from 0 to 10 (0 is steady)');
      return { hz };
    }),
    // `timer`: how long until POSEIDON comes online — a free read off the network
    // clock, so you can pace the run from the console.
    timer: {
      arity: 0,
      fn: (_args, ctx) => {
        if (!ctx.poseidonTimer) throw new RonmlError('no clock on this wire.');
        return { tag: 'node', id: ctx.poseidonTimer() };
      },
    },
    // `name`: the code of the obelisk you are jacked into — a free read, so you
    // can see which node you're on without scrolling the boot banner.
    name: {
      arity: 0,
      fn: (_args, ctx) => {
        const id = ctx.currentNode && ctx.currentNode();
        if (!id) throw new RonmlError('no node here.');
        return { tag: 'node', id };
      },
    },
    // Opens the browsable notepad overlay (ctx.showNotepad, main.js) rather
    // than printing to the console — a real page you flip through, not a
    // wall of scrollback.
    // (The `notes` verb was removed from the console — press N for the notepad.)
    // ELIZA has two faces. Bare `eliza` / `run eliza` opens the 1966 DOCTOR as
    // an interactive chat — that is intercepted in the REPL (main.js), not here,
    // since it is a mode, not a value. `eliza <file>` is the TRANSFORM: feed a
    // file through the DOCTOR's reflection and get a new file back. On the
    // factory's id line (`I am W-FACTORY, my keys are mine`) the my->your
    // reflection turns the boast into a grant — root_access.ml. (Calypso escape
    // chain, docs/calypso-escape-chain.md.)
    eliza: {
      arity: 1,
      fn: ([file], ctx) => {
        if (!file || file.tag !== 'file') {
          throw new RonmlError('eliza needs a file to transform — try: eliza factory_id.ml  (or `eliza` alone to talk to the DOCTOR)');
        }
        if (!ctx.elizaTransform) throw new RonmlError('no ELIZA image on this node.');
        const r = ctx.elizaTransform(file.name);
        if (!r || !r.ok) throw new RonmlError((r && r.msg) || `ELIZA can do nothing with ${file.name}.`);
        return { tag: 'file', name: r.out };
      },
    },
    // `retire` (R3): with the hermes card, stand the fortress guards down — they
    // become gardeners instead of hunters. The refunction-by-command payoff.
    retire: {
      arity: 0,
      fn: (_args, ctx) => {
        if (!ctx.retire) throw new RonmlError('nothing to retire from this terminal.');
        ctx.retire();
        return { tag: 'unit' };
      },
    },
    // ---- HERMES station verbs (RON hilltop relays only) ------------------
    // RON tech is off-grid on purpose: no network verb (touching the wire would
    // give the relay away). It is the human record — read it, print a copy — AND
    // a maker's bench that forges only from what you carry in (see `forge`), so
    // the no-wire rule holds while the relay still arms Zeus's command. (A HERMES
    // `print` is added in makeBuiltins below, so it can take a topic; the
    // obelisk's own arity-0 `print` maps the network.)
    read: {
      arity: 1,
      fn: ([topic], ctx) => {
        // Accept a doc topic (read history) or a file (read readme.md) — file
        // values carry .name, topics come through as .id/node.
        const name = topic && (topic.name || topic.id || '') || '';
        ctx.read(String(name).toLowerCase());
        return { tag: 'unit' };
      },
    },
    // `forge zeus_virus.ml` (HERMES relay): arm the sealed payload with the two
    // credentials on your Trojan card -> zeus_lightning.ml on the relay bench.
    // The relay stays off the wire; it forges only from what you carry in.
    forge: {
      arity: 1,
      fn: ([file], ctx) => {
        if (!file || file.tag !== 'file') throw new RonmlError('forge needs the payload file — try: forge zeus_virus.ml');
        if (!ctx.forge) throw new RonmlError('nothing to forge at this terminal.');
        const r = ctx.forge(file.name);
        if (!r || !r.ok) throw new RonmlError((r && r.msg) || `can't forge ${file.name}.`);
        return { tag: 'file', name: r.out };
      },
    },
    // Lists the human knowledge this relay still holds — RON kept it alive when
    // the machines were deleting it.
    archive: {
      arity: 0,
      fn: (_args, ctx) => { ctx.archive(); return { tag: 'unit' }; },
    },
    // Pull the next of RON's own field records off the relay mesh into your
    // Scrapbook — the half of the record RON kept on its relays, not in caches.
    records: {
      arity: 0,
      fn: (_args, ctx) => { ctx.records(); return { tag: 'unit' }; },
    },
    // Override a nearby machine and see through its eyes — RON turning the
    // enemy's own units. You drive it until it leaves the relay's short range
    // or you trip its self-destruct.
    drive: {
      arity: 0,
      fn: (_args, ctx) => { ctx.drive(); return { tag: 'unit' }; },
    },
    // `backup aikey` / `restore aikey`: RON's relays keep a copy of your AI key
    // off the AI's hardware, so losing it (death, a fumble) needn't cost you the
    // endgame. The `aikey` word is the thing being backed up; its value is not
    // needed (the check is whether you physically hold / have backed up a key).
    backup: {
      arity: 1,
      fn: (_args, ctx) => { ctx.backup(); return { tag: 'unit' }; },
    },
    restore: {
      arity: 1,
      fn: (_args, ctx) => { ctx.restore(); return { tag: 'unit' }; },
    },
    nearest: {
      arity: 1,
      fn: ([list], ctx) => {
        if (!list || list.tag !== 'list') throw new RonmlError('nearest needs a list — try: scan |> nearest');
        if (!list.items.length) throw new RonmlError('nothing in range to pick from');
        let best = null, bestD = Infinity;
        for (const item of list.items) {
          if (item.tag !== 'node') throw new RonmlError('nearest only works on a list of nodes');
          const d = ctx.distanceToNode(item.id);
          if (d < bestD) { bestD = d; best = item; }
        }
        return best;
      },
    },
    hack: {
      arity: 1,
      fn: ([node], ctx) => {
        if (!node || node.tag !== 'node') throw new RonmlError('hack needs a node — try: hack OB_XXXX');
        // No AI key needed to hack a node's own key — the access chip that got
        // you into this console is enough. crash therefore needs no AI key
        // either (it only wants the key hack hands back). The AI key still
        // gates the sharper verbs (sleep/rewind/repel) and the fortress unlock.
        if (!ctx.nodeExists(node.id)) throw new RonmlError(`no node ${node.id} on the wire`);
        ctx.recordHack(node.id);
        return { tag: 'key', id: node.id };
      },
    },
    crash: {
      arity: 2,
      fn: ([node, key], ctx) => {
        if (!node || node.tag !== 'node') throw new RonmlError('crash needs a node first — try: crash OB_XXXX k');
        const label = node.id || 'OB_XXXX';
        if (!key || key.tag !== 'key' || key.id !== node.id) {
          throw new RonmlError(`crash needs ${label}'s own key. try: let k = hack ${label} in crash ${label} k`);
        }
        if (!ctx.nodeExists(node.id)) throw new RonmlError(`${label} is already dark`);
        ctx.crashNode(node.id);
        return { tag: 'unit' };
      },
    },
    // The easy way in: one word, one node, no key. Pins an infinite loop
    // into the node instead of physically felling it — it and its garrison
    // freeze where they stand, burning CPU, until a repair drone eventually
    // resets it. Weaker than crash (nothing is destroyed, and it self-heals
    // on its own schedule) but far cheaper to pull off.
    loop: {
      arity: 1,
      fn: ([node], ctx) => {
        if (!node || node.tag !== 'node') throw new RonmlError('loop needs a node — try: loop OB_XXXX');
        const label = node.id || 'OB_XXXX';
        if (!ctx.nodeExists(node.id)) throw new RonmlError(`no node ${label} on the wire`);
        if (ctx.nodeFrozen(node.id)) throw new RonmlError(`${label} is already looping — it needs a repair drone, not a second one`);
        ctx.loopNode(node.id);
        return { tag: 'unit' };
      },
    },
    sleep: {
      arity: 1,
      fn: ([num], ctx) => {
        if (!num || num.tag !== 'num') throw new RonmlError('sleep needs a number of minutes — try: sleep 30');
        ctx.sleepNearby(num.v);
        return { tag: 'unit' };
      },
    },
    // Claws hours back off the POSEIDON deadline — the resistance's own clock
    // sabotage, buying more time before the towers link up for the purge.
    // Only meaningful before the purge starts; once POSEIDON is actually live
    // the deadline clock isn't running anymore, so ctx reports back if so.
    rewind: {
      arity: 1,
      fn: ([num], ctx) => {
        if (!num || num.tag !== 'num') throw new RonmlError('rewind needs a number of hours — try: rewind 3');
        if (ctx.skylinkActive()) throw new RonmlError('POSEIDON is already live — the deadline clock isn\'t running anymore. Knock towers dark instead.');
        ctx.rewindClock(num.v);
        return { tag: 'unit' };
      },
    },
    // Extract a fortress key from the network using a node key you hacked — the
    // program that actually earns its keep: `let k = hack OB_XXXX in unlock k`.
    // The argument must be a key from hack; it drops a single fortress key.
    // `unlock k d`: the endgame program. `k` is a key hacked off a live node
    // (`hack`), `d` is the DECRYPTED AI key (`copy aikey` then `decrypt aikey`).
    // Both together drop a fortress key; either alone is refused with a hint.
    unlock: {
      arity: 2,
      fn: ([key, dec], ctx) => {
        if (!key || key.tag !== 'key' || key.kind === 'aikey') {
          throw new RonmlError('unlock needs a hacked node key first. try: let k = hack OB_XXXX in unlock k d');
        }
        if (!dec || dec.tag !== 'key' || dec.kind !== 'aikey') {
          throw new RonmlError('unlock needs the AI key too. copy it in and decrypt it: copy aikey  then  let d = decrypt aikey');
        }
        if (dec.enc !== false) {
          throw new RonmlError('that AI key is still sealed. decrypt it first: let d = decrypt aikey');
        }
        ctx.unlock(key.id);
        return { tag: 'unit' };
      },
    },
  };
  // The obelisk (TIRESIAS) and the HERMES relay are two different systems, each
  // with its own commands — not one language that refuses half its verbs. So we
  // hand back only the verbs that belong to the station you're at. A verb from
  // the other system simply isn't a command here (see evalNode's unknown path).
  // Neutral verbs (notes; help/let are handled outside this table) belong to
  // both. A station-less caller (tools/tests) gets everything.
  for (const k of OB_VERBS) if (B[k]) B[k].station = 'ob';
  for (const k of HERMES_VERBS) if (B[k]) B[k].station = 'hermes';
  // A unit's senses and service verbs belong to the unit. Untagged, they fell
  // through to every console below — you could ask an obelisk for its `charge`
  // and be told 0, or type `beep` at a relay and have it quietly succeed. They
  // are tagged here so those consoles say plainly that this is not their verb.
  // (`not` and `echo` are in ROBOT_VERBS too and stay neutral: they belong to
  // the language, not to any one machine.)
  for (const k of MACHINE_ONLY) if (B[k]) B[k].station = 'robot';
  if (!station) return B;
  // The laptop is the language WITHOUT the world: hand back only its own short
  // list, so no verb that needs a wire (or a drive, or a card) is even present.
  if (station === 'robot') {
    const bot = {};
    for (const k of ROBOT_VERBS) if (B[k]) bot[k] = { ...B[k], station: 'robot' };
    return bot;
  }
  if (station === 'laptop') {
    const lap = {};
    for (const k of LAPTOP_VERBS) if (B[k]) lap[k] = { ...B[k], station: 'laptop' };
    return lap;
  }
  const out = {};
  for (const k of Object.keys(B)) {
    if (!B[k].station || B[k].station === station) out[k] = B[k];
  }
  // A HERMES relay prints DOCUMENTS, not maps — override `print` here so it
  // takes a topic (`print fortress`). The obelisk keeps its own arity-0 `print`.
  if (station === 'hermes') {
    out.print = {
      arity: 1, station: 'hermes',
      fn: ([topic], ctx) => { ctx.printDoc(String((topic && topic.id) || '').toLowerCase()); return { tag: 'unit' }; },
    };
  }
  return out;
}

// Which verbs belong to which system. Used to filter each terminal's builtins,
// and to tell "not a command here" (a real verb, wrong system) apart from a
// plain bad word.
// `copy`, `cd`, `ls` are deliberately NOT listed here — they are neutral (work at
// both an obelisk and a HERMES relay), like `notes`. A verb tagged for one station
// is refused at the other; the file verbs must move files at either terminal.
const OB_VERBS = ['scan', 'nearest', 'keys', 'name', 'timer', 'echo', 'not', 'hack', 'crash', 'loop', 'sleep', 'rewind', 'repel', 'sing', 'map', 'print', 'decrypt', 'unlock', 'eliza', 'retire'];
// Note: HERMES's `print` is added as an override in makeBuiltins (it takes a
// topic), not tagged here — tagging it would steal the obelisk's own arity-0
// `print`. `print` is already in OB_VERBS, so ALL_VERBS still covers it.
const HERMES_VERBS = ['read', 'archive', 'records', 'drive', 'backup', 'restore', 'forge'];
// The LAPTOP is off the network by design (docs/laptop-plan.md), so it carries no
// station verbs at all — only `echo` and the language core (let / fn / if /
// arithmetic / `;` / recursion), which is exactly what makes it a place to LEARN
// the language rather than perform it under fire. A tower verb typed here is not a
// typo, it is a machine that isn't listening: evalNode says so and points at a tower.
const LAPTOP_VERBS = ['echo', 'not', 'hd', 'tl', 'length'];
// A MACHINE'S OWN STATION. Its program runs here: senses in, an intent out, and
// nothing else within reach — no network, no files, no console verbs. That is
// not a restriction bolted on, it is what a unit actually has.
// What a machine's own program may say. `not` and `echo` are the language's,
// not the machine's, so they are listed here but stay neutral elsewhere.
const MACHINE_ONLY = ['charge', 'integrity', 'range', 'home_range',
  'threat', 'hurt', 'linked', 'blight', 'daylight', 'beep', 'eye', 'flash'];
const ROBOT_VERBS = [...MACHINE_ONLY, 'not', 'echo', 'hd', 'tl', 'length'];
// Retired verbs kept only so typing one gives a clean "not a command" instead
// of a cryptic node error (make/ping were removed when TORs became info-only).
const RETIRED_VERBS = ['make', 'ping'];
// ROBOT_VERBS are in here too: a unit's own senses and service verbs are real
// words, so typing `beep` or `charge` at a console should say it is not a
// command HERE rather than quietly evaluating to a node id.
const ALL_VERBS = new Set([...OB_VERBS, ...HERMES_VERBS, ...RETIRED_VERBS, ...ROBOT_VERBS]);

// A real verb typed at the wrong machine. On the laptop that is not a mistake so
// much as the machine's whole nature — it is off the network — so say what the
// laptop IS for instead of just refusing.
function notHereMessage(name, station) {
  if (station === 'laptop') {
    return `no network on this machine. '${name}' needs a tower — practise the language here, run it there.`;
  }
  return `'${name}' isn't a command on this terminal.`;
}

// ---- Evaluator -----------------------------------------------------------

function applyValue(fnVal, argVal) {
  // A user lambda (closure): bind the parameter and evaluate the body in the
  // closure's captured environment (extended, so nothing leaks back out).
  if (fnVal && fnVal.tag === 'closure') {
    const env2 = Object.create(fnVal.env);
    env2[fnVal.param.toLowerCase()] = argVal;
    return evalNode(fnVal.body, env2, fnVal.ctx, fnVal.builtins);
  }
  // A datatype constructor that takes arguments behaves like a function until
  // it has them all, at which point it stops being one and becomes a value.
  // This is Harper's point about constructors: they build, and building is the
  // only thing they do.
  if (fnVal && fnVal.tag === 'confn') {
    const args = [...fnVal.args, argVal];
    return args.length >= fnVal.arity
      ? { tag: 'con', name: fnVal.name, args }
      : { tag: 'confn', name: fnVal.name, arity: fnVal.arity, args };
  }
  if (!fnVal || fnVal.tag !== 'fn') {
    throw new RonmlError(`${describeValue(fnVal)} isn't something you can apply an argument to`);
  }
  const args = [...fnVal.args, argVal];
  if (args.length >= fnVal.builtin.arity) return fnVal.builtin.fn(args, fnVal.ctx);
  return { tag: 'fn', name: fnVal.name, builtin: fnVal.builtin, args, ctx: fnVal.ctx };
}

// Structural equality for `==` / `!=`: same tag and same payload. Numbers, strings,
// booleans compare by value; nodes/keys/files by their identifier; unit is unit.
function valuesEqual(a, b) {
  if (!a || !b || a.tag !== b.tag) return false;
  switch (a.tag) {
    case 'num': case 'str': case 'bool': return a.v === b.v;
    case 'node': return a.id === b.id;
    case 'key': return a.kind === b.kind && a.id === b.id;
    case 'file': return a.name === b.name;
    case 'unit': return true;
    default: return false;
  }
}

// Evaluate an infix operator. Arithmetic and comparison want two numbers; `^`
// concatenates any two values as text; `==`/`!=` work on any pair.
function applyBinOp(op, l, r) {
  if (op === 'CARET') return { tag: 'str', v: formatValue(l) + formatValue(r) };
  if (op === 'EQEQ') return { tag: 'bool', v: valuesEqual(l, r) };
  if (op === 'NE') return { tag: 'bool', v: !valuesEqual(l, r) };
  const num = (x) => {
    if (!x || x.tag !== 'num') throw new RonmlError(`${describeValue(x)} is not a number — arithmetic and comparison need numbers`);
    return x.v;
  };
  const a = num(l), b = num(r);
  switch (op) {
    case 'PLUS': return { tag: 'num', v: a + b };
    case 'MINUS': return { tag: 'num', v: a - b };
    case 'STAR': return { tag: 'num', v: a * b };
    case 'SLASH':
      if (b === 0) throw new RonmlError('division by zero');
      return { tag: 'num', v: a / b };
    // What is left over. The reason it is here: a machine that should act every
    // N ticks needs `tick mod n == 0`, and there was no way to write that.
    case 'MOD':
      if (b === 0) throw new RonmlError('mod by zero');
      return { tag: 'num', v: ((a % b) + b) % b };
    case 'LT': return { tag: 'bool', v: a < b };
    case 'GT': return { tag: 'bool', v: a > b };
    case 'LE': return { tag: 'bool', v: a <= b };
    case 'GE': return { tag: 'bool', v: a >= b };
    default: throw new RonmlError('malformed command');
  }
}

function evalNode(node, env, ctx, builtins) {
  if (++STEPS > FUEL) throw new RonmlFuelError('step budget exceeded');
  switch (node.type) {
    case 'Lit': return { tag: 'num', v: node.value };
    case 'StrLit': return { tag: 'str', v: node.value };
    case 'Lam': return { tag: 'closure', param: node.param, body: node.body, env, ctx, builtins };
    case 'Bin': return applyBinOp(node.op, evalNode(node.left, env, ctx, builtins), evalNode(node.right, env, ctx, builtins));
    // Cons builds a list by putting one value on the front of another list,
    // which is the definition rather than a convenience: Harper (1993, p.9)
    // gives the empty list and cons as the two cases a list can be.
    case 'Cons': {
      const head = evalNode(node.head, env, ctx, builtins);
      const tail = evalNode(node.tail, env, ctx, builtins);
      if (!tail || tail.tag !== 'list') throw new RonmlError(`${describeValue(tail)} is not a list — :: puts a value on the front of a list`);
      return { tag: 'list', items: [head, ...tail.items] };
    }
    case 'Seq': {
      evalNode(node.left, env, ctx, builtins);   // run the left for its effect, discard its value
      return evalNode(node.right, env, ctx, builtins);
    }
    case 'Bool': {
      const l = evalNode(node.left, env, ctx, builtins);
      if (!l || l.tag !== 'bool') throw new RonmlError(`${describeValue(l)} is not true or false`);
      if (node.op === 'and' && !l.v) return { tag: 'bool', v: false };   // short-circuit
      if (node.op === 'or' && l.v) return { tag: 'bool', v: true };
      const r = evalNode(node.right, env, ctx, builtins);
      if (!r || r.tag !== 'bool') throw new RonmlError(`${describeValue(r)} is not true or false`);
      return { tag: 'bool', v: r.v };
    }
    case 'If': {
      const c = evalNode(node.cond, env, ctx, builtins);
      if (!c || c.tag !== 'bool') throw new RonmlError('if needs a true/false test — try: if n == 0 then 1 else 0');
      return evalNode(c.v ? node.then : node.else, env, ctx, builtins);
    }
    case 'ListLit': return { tag: 'list', items: node.items.map((it) => evalNode(it, env, ctx, builtins)) };
    case 'Tuple': return { tag: 'tuple', items: node.items.map((it) => evalNode(it, env, ctx, builtins)) };

    // Declaring a datatype puts its constructors where names are looked up.
    // A nullary one IS a value; one that takes arguments is a function that
    // collects them and then is a value. Nothing is checked, because there is
    // nothing here to check with.
    case 'Datatype': {
      const store = (ctx && ctx.session) || {};
      const reg = (store.__cons = store.__cons || {});
      for (const c of node.cons) {
        reg[c.name] = { name: c.name, arity: c.arity, of: node.name };
        store[c.name.toLowerCase()] = c.arity === 0
          ? { tag: 'con', name: c.name, args: [] }
          : { tag: 'confn', name: c.name, arity: c.arity, args: [] };
      }
      return { tag: 'datatype', name: node.name, cons: node.cons.map((c) => c.name) };
    }

    // The eliminator. Arms are tried in order and the first that matches wins,
    // which is what lets you put the base case first and read the thing like
    // the definition it is.
    case 'Case': {
      const v = evalNode(node.subject, env, ctx, builtins);
      for (const arm of node.arms) {
        const binds = matchPattern(arm.pat, v, ctx);
        if (binds) {
          const scope = Object.create(env);
          for (const k of Object.keys(binds)) scope[k.toLowerCase()] = binds[k];
          return evalNode(arm.body, scope, ctx, builtins);
        }
      }
      throw new RonmlError(`no case matches ${describeValue(v)} — add an arm, or _ => … to catch the rest`);
    }
    case 'Var': {
      const lower = node.name.toLowerCase();
      // Walk the scope chain (envs nest via Object.create for let/lambda scopes),
      // stopping before Object.prototype so `toString` etc. never resolve as vars.
      // hasOwnProperty alone missed grandparent bindings (nested closures).
      for (let e = env; e && e !== Object.prototype; e = Object.getPrototypeOf(e)) {
        if (Object.prototype.hasOwnProperty.call(e, lower)) return e[lower];
      }
      // nil is the empty list, and the name matters: it is the base case every
      // recursion over a list stops at. [] is the same value, written the other
      // way, exactly as ML has both.
      if (lower === 'nil') return { tag: 'list', items: [] };
      if (lower === 'true') return { tag: 'bool', v: true };
      if (lower === 'false') return { tag: 'bool', v: false };
      const b = builtins[lower];
      if (b) {
        if (b.arity === 0) return b.fn([], ctx);
        return { tag: 'fn', name: lower, builtin: b, args: [], ctx };
      }
      // A real verb from the OTHER system, typed at this terminal: it just isn't
      // a command here (the two systems don't know each other). Distinct from a
      // plain node id like OB_XXXX or an atom like berries, which stay nodes.
      if (ctx && ctx.station && ALL_VERBS.has(lower)) {
        throw new RonmlError(notHereMessage(node.name, ctx.station));
      }
      // A dotted name ending .ml/.md is a FILE, not a node — so cd/ls/copy/eliza
      // can carry it around the drives. Everything else is a node id (OB_XXXX).
      if (/\.(ml|md)$/i.test(node.name)) return { tag: 'file', name: node.name };
      return { tag: 'node', id: node.name };
    }
    case 'Let': {
      // RECURSIVE, like SML's `fun`: the scope is created first and the name is
      // bound into it before the value is evaluated, so `let f x = … f … in …`
      // can call itself. (The top-level `let` was already recursive; this makes
      // the two agree, and it is what a machine's program needs — a program is
      // one expression, with no top level to recurse at.)
      const env2 = Object.create(env);
      env2[node.name.toLowerCase()] = evalNode(node.value, env2, ctx, builtins);
      return evalNode(node.body, env2, ctx, builtins);
    }
    case 'TopLet': {
      // Bare top-level `let x = e`: evaluate `e`, then persist the binding into
      // the session env the REPL handed us as the base `env` (main.js passes
      // `ctx.session`), so the next line entered can read `x`. Echoes `val x = …`.
      const v = evalNode(node.value, env, ctx, builtins);
      env[node.name.toLowerCase()] = v;
      return { tag: 'binding', name: node.name, value: v };
    }
    case 'App': {
      const fn = evalNode(node.fn, env, ctx, builtins);
      const arg = evalNode(node.arg, env, ctx, builtins);
      return applyValue(fn, arg);
    }
    default:
      throw new RonmlError('malformed command');
  }
}


// Match a value against a pattern. Returns a map of bindings, or null if the
// pattern does not fit. Harper (1993, p.16): "the variables in a pattern are
// not references to previously-bound variables, but rather variables that are
// about to be bound by pattern-matching." That sentence is the whole function.
function matchPattern(pat, v, ctx) {
  const cons = (ctx && ctx.session && ctx.session.__cons) || {};
  switch (pat.p) {
    case 'wild': return {};
    case 'num': return v && v.tag === 'num' && v.v === pat.v ? {} : null;
    case 'str': return v && v.tag === 'str' && v.v === pat.v ? {} : null;
    case 'bool': return v && v.tag === 'bool' && v.v === pat.v ? {} : null;
    case 'nil': return v && v.tag === 'list' && v.items.length === 0 ? {} : null;
    case 'cons': {
      if (!v || v.tag !== 'list' || !v.items.length) return null;
      const h = matchPattern(pat.head, v.items[0], ctx);
      if (!h) return null;
      const t = matchPattern(pat.tail, { tag: 'list', items: v.items.slice(1) }, ctx);
      return t ? { ...h, ...t } : null;
    }
    case 'tuple': {
      if (!v || v.tag !== 'tuple' || v.items.length !== pat.items.length) return null;
      const out = {};
      for (let i = 0; i < pat.items.length; i++) {
        const m = matchPattern(pat.items[i], v.items[i], ctx);
        if (!m) return null;
        Object.assign(out, m);
      }
      return out;
    }
    case 'name': {
      // A declared constructor matches by name and arity; anything else is a
      // variable, and a variable matches anything.
      if (cons[pat.name]) {
        if (!v || (v.tag !== 'con' && v.tag !== 'confn') || v.name !== pat.name) return null;
        const got = v.args || [];
        if (pat.args.length !== got.length) return null;
        const out = {};
        for (let i = 0; i < pat.args.length; i++) {
          const m = matchPattern(pat.args[i], got[i], ctx);
          if (!m) return null;
          Object.assign(out, m);
        }
        return out;
      }
      if (pat.args.length) return null;   // `Foo x` where Foo is not a constructor
      return { [pat.name]: v };
    }
    default: return null;
  }
}

function describeValue(v) {
  if (!v) return 'nothing';
  switch (v.tag) {
    case 'unit': return '()';
    case 'num': return `the number ${v.v}`;
    case 'bool': return v.v ? 'true' : 'false';
    case 'node': return `node ${v.id}`;
    case 'key': return v.kind === 'aikey' ? 'the AI key' : 'a key';
    case 'file': return `the file ${v.name}`;
    case 'list': return 'a list';
    case 'tuple': return `a tuple of ${v.items.length}`;
    case 'con': return `${v.name}`;
    case 'confn': return `${v.name} (needs ${v.arity - v.args.length} more)`;
    case 'datatype': return `the type ${v.name}`;
    case 'binding': return `the binding ${v.name}`;
    case 'fn': return `${v.name} (needs ${v.builtin.arity - v.args.length} more arg${v.builtin.arity - v.args.length === 1 ? '' : 's'})`;
    default: return 'that';
  }
}

function formatValue(v) {
  if (!v) return '()';
  switch (v.tag) {
    case 'unit': return '()';
    case 'num': return String(v.v);
    case 'bool': return v.v ? 'true' : 'false';
    case 'str': return v.v;
    case 'node': return v.id;
    case 'key': return v.kind === 'aikey' ? (v.enc === false ? 'AIKEY:open' : 'AIKEY:sealed') : `KEY:${v.id}`;
    case 'file': return v.name;
    case 'list': return '[' + v.items.map(formatValue).join(', ') + ']';
    case 'tuple': return '(' + v.items.map(formatValue).join(', ') + ')';
    case 'con': return v.args && v.args.length ? `${v.name} ${v.args.map(formatValue).join(' ')}` : v.name;
    case 'confn': return `<${v.name}>`;
    case 'datatype': return `datatype ${v.name} = ${v.cons.join(' | ')}`;
    case 'binding': return `val ${v.name} = ${formatValue(v.value)}`;
    case 'closure': return '<fn>';
    case 'fn': return `<${describeValue(v)}>`;
    default: return String(v);
  }
}

// Join anything `echo` printed during evaluation with the expression's final value.
// If the program printed and its final value is unit (the usual case for an
// echo/`;` sequence), show only the printed lines — no trailing "()". Otherwise the
// printed lines come first, then the value.
function combineOutput(out, result) {
  const tail = formatValue(result);
  if (!out || !out.length) return tail;
  if (result && result.tag === 'unit') return out.join('\n');
  return out.join('\n') + '\n' + tail;
}

// Usage hints for a builtin left short of its full argument count — shown
// as the teaching error instead of a cryptic partial-function value, per the
// design doc's "crash OB_BB05 alone -> ERR: crash needs a key..." example.
const USAGE_HINTS = {
  hack: 'hack needs a node. try: hack OB_XXXX',
  crash: "crash needs a node and its key. try: let k = hack OB_XXXX in crash OB_XXXX k",
  loop: 'loop needs a node. try: loop OB_XXXX',
  nearest: 'nearest needs a list. try: scan |> nearest',
  sleep: 'sleep needs a number of minutes. try: sleep 30',
  rewind: 'rewind needs a number of hours. try: rewind 3',
  copy: 'copy a key (copy aikey) or a file to a device (copy factory_id.ml ob)',
  cd: 'cd needs a device. try: cd aikey  ·  cd ob',
  eliza: 'eliza <file> transforms a file (eliza factory_id.ml); bare `eliza` opens the DOCTOR',
  decrypt: 'decrypt needs the AI key. try: copy aikey  then  decrypt aikey',
  unlock: 'unlock needs a hacked node key and the decrypted AI key. try: copy aikey / let k = hack OB_XXXX / let d = decrypt aikey / unlock k d',
  print: 'print needs a topic — at an obelisk: print map  or  print aikey; at a relay: print <document>',
  backup: 'backup needs a key — try: backup aikey',
  restore: 'restore needs a key — try: restore aikey',
  read: 'read needs a topic — try: read history (archive lists them)',
  forge: 'forge needs the payload — try: forge zeus_virus.ml (at a relay, Trojan card in hand)',
};

// `help` reference, shown when the operator types it at the terminal. Per-verb
// detail lines keyed by name; `sing` is deliberately omitted (it's a secret).
// Each row: [sig, type, desc, gate, station]. `station` scopes the verb to a
// terminal — 'ob' (AI obelisk / TIRESIAS), 'hermes' (RON relay), or '' for the
// verbs that work anywhere. `help` filters to the terminal you're at.
const HELP_VERBS = [
  ['scan', 'unit -> list', 'obelisks/machines in range of this terminal', '', 'ob'],
  ['nearest', 'list -> node', 'the closest element of a list', '', 'ob'],
  ['keys', 'unit -> list', 'the access keys you currently hold', '', 'ob'],
  ['name', 'unit -> node', 'the code of the obelisk you are jacked into', '', 'ob'],
  ['timer', 'unit -> node', 'time left until POSEIDON comes online', '', 'ob'],
  ['hack n', 'node -> key', "take node n's access key", 'no key needed', 'ob'],
  ['crash n k', 'node key -> unit', 'knock node n dark until a drone mends it', 'needs k from hack', 'ob'],
  ['loop n', 'node -> unit', 'pin an infinite loop into node n — freezes it and its garrison until a drone resets it', 'no key needed', 'ob'],
  ['sleep t', 'num -> unit', 'idle local machines for t game-minutes', 'no key needed', 'ob'],
  ['rewind t', 'num -> unit', 'claw t hours back off the POSEIDON deadline', 'before the purge only', 'ob'],
  ['repel', 'unit -> unit', 'nearby machines turn tail and flee you', 'no key needed', 'ob'],
  ['map', 'unit -> unit', 'show the territory map (obelisks, machines, mainframe)', '', 'ob'],
  ['print t', 'atom -> unit', 'print map (a carryable map) or print aikey (a spare AI key)', '', 'ob'],
  ['copy k', 'key -> key', 'copy the AI key you hold into the session as `aikey`', 'hold an AI key', ''],
  ['copy f d', 'file device -> file', 'copy a file onto a device — copy factory_id.ml ob', '', ''],
  ['cd d', 'device -> node', 'change drive — the console echoes which drive, and the card state (run `drives` to see what is attached here)', '', ''],
  ['drives', 'unit -> unit', "list the drives attached here and the card's current name", '', ''],
  ['ls', 'unit -> list', 'list the files on the current drive', '', ''],
  ['decrypt k', 'key -> key', 'open the sealed AI key so unlock can use it', 'hold an AI key', 'ob'],
  ['unlock k d', 'key key -> unit', 'legacy — the fortress gate opens to a Trojan card now (refunction your AI key)', 'superseded', 'ob'],
  ['eliza', 'file -> file', 'eliza <file> runs the DOCTOR transform on a file; bare `eliza` (or run eliza) opens the DOCTOR to talk to — quit to leave', '', 'ob'],
  ['retire', 'unit -> unit', "stand the fortress guards down — they become gardeners (needs the hermes card)", 'hermes card', 'ob'],
  ['read t', 'atom -> unit', 'read a document — read ronml / fortress / obelisks / robots / history / destroy', 'HERMES relay only', 'hermes'],
  ['print t', 'atom -> unit', 'print a copy of a document into your notepad (N)', 'HERMES relay only', 'hermes'],
  ['archive', 'unit -> unit', 'list the documents this relay holds', 'HERMES relay only', 'hermes'],
  ['records', 'unit -> unit', "pull the next of RON's own field records into your Scrapbook (J); repeat until dry", 'HERMES relay only', 'hermes'],
  ['drive', 'unit -> unit', 'override a nearby machine and see through its eyes — drive it till it leaves range', 'HERMES relay only', 'hermes'],
  ['backup aikey', 'key -> unit', "copy your AI key to RON's relay mesh — survives death", 'HERMES relay only', 'hermes'],
  ['restore aikey', 'key -> unit', 'mint a backed-up AI key back into your pack', 'HERMES relay only', 'hermes'],
  ['forge f', 'file -> file', 'forge zeus_virus.ml into zeus_lightning.ml from your Trojan card', 'HERMES relay, Trojan card', 'hermes'],
  ['help', 'unit -> unit', 'this reference, or `help <verb>` for one verb', '', ''],
];
// `help ml` — a one-screen tour of the language itself (as opposed to `help`,
// which lists the verbs). Overview + worked examples, hello-world first.
const ML_OVERVIEW = [
  'AI-ML — a tiny functional language (Standard ML flavour).',
  '',
  '  VALUES     30    "text"    true/false    OB_1A2B (a node)    [a, b] (a list)',
  '  A COMMAND  a verb and its args:   scan    hack OB_1A2B    sleep 30',
  '  BIND       let x = e in body    (top level: bare  let x = e,  no `in`)',
  '  PIPE       scan |> nearest |> crash    (feeds left into right)',
  '  FUNCTION   fn x => e  is a lambda;   let f x = e  names one',
  '  MATH       + - * /   and   ^ (join text)',
  '  COMPARE    == != < > <= >=   give true/false',
  '  CHOOSE     if c then a else b',
  '  PRINT      echo x   emits a line as it runs;   a ; b   runs a then b',
  '  * COMMAND  *scan   *timer   *print map    (literal args, BBC-Micro style)',
  '',
  '  hello world:    echo "hello world"',
  '  a greeting:     let greet = fn name => echo ("hi " ^ name)     then   greet "world"',
  '  count down:     let go n = if n == 0 then echo "liftoff" else (echo n ; go (n - 1))',
  '                  then   go 3     prints  3 / 2 / 1 / liftoff',
  '  factorial:      let fact n = if n == 0 then 1 else n * fact (n - 1)     then   fact 5',
  '  the hack chain: let k = hack OB_1A2B in crash OB_1A2B k',
  '',
  '  type `help` for the verb list, or `help <verb>` for one verb.',
].join('\n');

// The laptop's own `help`: it has no station verbs, so listing the terminal
// reference would only advertise commands the machine hasn't got. Show the
// LANGUAGE instead — which is what this machine is for.
const LAPTOP_HELP = [
  'AI-ML — this machine is off the network, so this is the language only.',
  '',
  '  echo x            print a line',
  '  a ; b             do a, then b',
  '  let x = e         bind a value (top level: no `in` needed)',
  '  fn x => e         a function      let f x = e   names one',
  '  if c then a else b',
  '  + - * /  math     ^  join text    == != < > <= >=  compare',
  '',
  '  the tower verbs (scan, hack, crash, …) need a wire. Practise here.',
  '  type `help ml` for the full tour with worked examples.',
  '  type `quit` to leave ML and go back to the shell.',
].join('\n');

function helpText(topic, station, hasManual) {
  if (topic === 'ml' || topic === 'lang' || topic === 'language') return ML_OVERVIEW;
  if (!topic && station === 'laptop') return LAPTOP_HELP;
  if (topic) {
    const row = HELP_VERBS.find((v) => v[0].split(' ')[0] === topic);
    if (!row) return `no help for '${topic}'. try: help  ·  help ml`;
    const [sig, type, desc, gate] = row;
    return `${sig}\n  : ${type}\n  ${desc}${gate ? `\n  (${gate})` : ''}`;
  }
  // Show only the verbs that work at the terminal you're actually at — an
  // obelisk (TIRESIAS) lists the AI-network verbs, a HERMES relay lists RON's.
  const here = HELP_VERBS.filter((v) => !v[4] || !station || v[4] === station);
  const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);
  // Imperative verbs — the do-it-now commands that don't compose — are shown with
  // a leading `*` (their BBC-Micro command form). The composable ML verbs (hack,
  // crash, copy, decrypt, unlock, nearest, eliza, echo, cd/ls) stay bare, since
  // they nest in `let`/pipes/functions. Both forms still run; this just teaches the
  // split by how the reference presents them.
  const IMPERATIVE = new Set([
    'scan', 'keys', 'name', 'timer', 'map', 'print', 'sleep', 'rewind', 'repel', 'sing', 'loop', 'retire',
    'read', 'make', 'archive', 'records', 'drive', 'backup', 'restore', 'forge',
  ]);
  const lines = here.map(([sig, , desc, gate]) => {
    const shown = IMPERATIVE.has(sig.split(' ')[0]) ? '*' + sig : sig;
    return `  ${pad(shown, 12)} ${desc}${gate ? `  [${gate}]` : ''}`;
  });
  const title = station === 'hermes' ? 'HERMES reference (RON relay)' : 'AI-ML reference';
  const example = station === 'hermes'
    ? '  e.g.  read moly      make berries      archive'
    : '  e.g.  scan |> nearest      let k = hack OB_1A2B in crash OB_1A2B k';
  const out = [
    title,
    ...lines,
    '',
    '  let x = e in body   bind a value      |>   pipe left into right',
    '  fn x => e  a function    let f x = e  names one    "text"  a string',
    '  + - * /  math    ^  join text    == != < >  compare    if c then a else b',
    '  echo x  print a line    a ; b  do a then b    *cmd arg  plain command (BBC style)',
    example,
    '  type `help ml` for a tour of the language + examples.',
  ];
  // If the player hasn't read the full manual yet, say so — this reference is
  // the short form, and the bound RON-DOS Operator's Manual is a real find
  // (teaches the language properly and unlocks console autocomplete).
  if (!hasManual) {
    out.push('', '  TIP: Read the OB Operator\'s Manual for full information.');
  }
  return out.join('\n');
}

// Runs one line of AI-ML against a world context. Returns
// {ok, text} — text is either the printed result or a "ERR: ..." message,
// always a teaching error per the design doc (never a raw stack trace).
// A `*`-command turns a tokenizer token into a LITERAL value — BBC-Micro filing
// semantics: `*print map` passes `map` as the literal topic, never evaluating it
// as the `map` verb, and `*crash OB k` would pass a literal `k`, not a binding.
function litTokenToValue(t) {
  if (t.t === 'STR') return { tag: 'str', v: t.v };
  if (t.t === 'NUM') return { tag: 'num', v: t.v };
  if (t.t === 'IDENT') return /\.(ml|md)$/i.test(t.v) ? { tag: 'file', name: t.v } : { tag: 'node', id: t.v };
  return { tag: 'node', id: String(t.v ?? t.t) };
}

// `*verb arg arg` — the BBC-style command form (see AI-ML design). The verb is a
// builtin; its arguments are LITERAL tokens, not ML expressions (no `let`, no
// pipes, no variable lookup), which is what separates a command from the ML.
function runStar(rest, ctx) {
  let toks;
  try { toks = tokenize(rest).filter((t) => t.t !== 'EOF'); }
  catch (e) { return { ok: false, text: `ERR: ${e.message}` }; }
  if (!toks.length || toks[0].t !== 'IDENT') {
    return { ok: false, text: 'ERR: a * command is a verb — try: *scan · *timer · *hack OB_XXXX · *echo "hi"' };
  }
  const verb = toks[0].v.toLowerCase();
  const builtins = makeBuiltins(ctx && ctx.station);
  const b = builtins[verb];
  if (!b) {
    if (ctx && ctx.station && ALL_VERBS.has(verb)) return { ok: false, text: `ERR: ${notHereMessage(toks[0].v, ctx.station)}` };
    return { ok: false, text: `ERR: no such command: ${toks[0].v}. type help for the list.` };
  }
  const out = [];
  OUT = out;   // so *echo prints through the same buffer as bare echo
  STEPS = 0;
  FUEL = (ctx && ctx.fuel) || CONSOLE_FUEL;
  const argVals = toks.slice(1).map(litTokenToValue);
  try {
    let v;
    if (argVals.length === 0) {
      v = b.arity === 0 ? b.fn([], ctx) : { tag: 'fn', name: verb, builtin: b, args: [], ctx };
    } else {
      let fn = { tag: 'fn', name: verb, builtin: b, args: [], ctx };
      for (const a of argVals) fn = applyValue(fn, a);
      v = fn;
    }
    if (v && v.tag === 'fn') return { ok: false, text: `ERR: ${USAGE_HINTS[verb] || `${verb} needs more arguments`}` };
    return { ok: true, text: combineOutput(out, v) };
  } catch (e) {
    if (e instanceof RonmlError) return { ok: false, text: `ERR: ${e.message}` };
    return { ok: false, text: `ERR: ${e.message || 'malformed command'}` };
  }
}

// The intents a program may choose between. The ENGINE knows how to do each of
// these already (robots.js); the program only picks. Anything else a program
// returns is a fault — a machine that asks for something it cannot do is broken,
// not creative.
export const INTENTS = ['patrol', 'hunt', 'flee', 'home', 'tend', 'wait'];

// Run a machine's own program against a snapshot of its senses and get back the
// intent it chose. Pure: no world, no mutation, no clock. Returns
// {ok:true, intent} or {ok:false, fault} — and a fault is a fact about the
// machine, which the engine shows as a faulted unit rather than an error.
export function decide(program, sense, opts = {}) {
  const ctx = { station: 'robot', session: {}, sense, fuel: opts.fuel || 2000 };
  // A program is ONE expression, however many lines it is written across — an
  // if/else laid out over four lines is still a single expression, so the lines
  // are joined before evaluation. Locals come from `let … in …`, which is the
  // ML way and needs nothing added. (Comments are dropped first so a leading
  // (* … *) line cannot swallow the program.)
  const src = String(program || '')
    .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('(*'))
    .join(' ');
  if (!src) return { ok: false, fault: 'the program is empty' };
  // Effects (beep, eye, flash) are collected while the expression evaluates,
  // so only the branch actually taken has them — which is what makes them
  // useful for telling one machine from another at a distance.
  EFFECTS = [];
  const r = runRonml(src, ctx);
  const effects = EFFECTS;
  EFFECTS = null;
  if (!r.ok) return { ok: false, fault: r.text.replace(/^ERR: /, ''), effects };
  const intent = String(r.text).trim().toLowerCase();
  if (!INTENTS.includes(intent)) {
    return { ok: false, fault: `'${r.text}' is not something this unit can do`, effects };
  }
  return { ok: true, intent, effects };
}

export function runRonml(source, ctx) {
  // `help` is a console meta-command, not a language expression — intercept it
  // before evaluation so a bare `help` prints the reference instead of failing
  // as an unknown name. `help <verb>` gives detail on one verb. (`notes` is a
  // real builtin now — see makeBuiltins — since it opens a UI overlay rather
  // than printing text.)
  const trimmed = source.trim();
  if (trimmed === 'help' || trimmed.startsWith('help ')) {
    return { ok: true, text: helpText(trimmed.slice(4).trim(), ctx && ctx.station, ctx && ctx.hasManual) };
  }
  // `*command` — the BBC-Micro command form, run with literal arguments. Anything
  // without a leading `*` is an AI-ML expression (let / pipes / values / lambdas).
  if (trimmed.startsWith('*')) return runStar(trimmed.slice(1), ctx);
  try {
    const toks = tokenize(source);
    const ast = parse(toks);
    const builtins = makeBuiltins(ctx && ctx.station);
    // A bare word typed as a WHOLE command that is neither a verb nor a known
    // binding is a typo, not a value — say so (and let the error chime play),
    // instead of echoing it back with the success chime as if it ran. This fires
    // ONLY at the top level: arguments (aikey, map, OB_XXXX, filenames) still
    // evaluate to atoms exactly as before.
    // A plain word (no hyphen, no dot) is command-shaped; a hyphenated node code
    // (OB_XXXX) or a dotted filename (foo.ml) is a legitimate bare VALUE and is
    // left alone.
    // ...but NOT in a machine's own program, where a bare word is the intent it
    // chose (`patrol`), not a mistyped command.
    if (ast && ast.type === 'Var' && /^[a-z][a-z0-9]*$/i.test(ast.name)
        && !(ctx && ctx.station === 'robot')) {
      const lower = ast.name.toLowerCase();
      const bound = Object.prototype.hasOwnProperty.call((ctx && ctx.session) || {}, lower);
      const declared = (ctx && ctx.session && ctx.session.__cons) || {};
      const isCon = Object.prototype.hasOwnProperty.call(declared, ast.name);
      if (!bound && !isCon && !builtins[lower] && lower !== 'true' && lower !== 'false' && lower !== 'nil') {
        if (ctx && ctx.station && ALL_VERBS.has(lower)) {
          return { ok: false, text: `ERR: ${notHereMessage(ast.name, ctx.station)}` };
        }
        return { ok: false, text: `ERR: no such command: ${ast.name}. type help for the list.` };
      }
    }
    // Fresh output buffer for this line: `echo` pushes into it mid-evaluation, so a
    // `;`-sequence or a recursive echo prints every step, not just the final value.
    const out = [];
    OUT = out;
    STEPS = 0;
    FUEL = (ctx && ctx.fuel) || CONSOLE_FUEL;
    // Base env is the persistent session (main.js passes ctx.session) so bare
    // top-level `let`/`copy` bindings survive to the next line entered.
    const result = evalNode(ast, (ctx && ctx.session) || {}, ctx, builtins);
    if (result && result.tag === 'fn') {
      return { ok: false, text: `ERR: ${USAGE_HINTS[result.name] || `${result.name} needs more arguments`}` };
    }
    return { ok: true, text: combineOutput(out, result) };
  } catch (e) {
    if (e instanceof RonmlError) return { ok: false, text: `ERR: ${e.message}` };
    return { ok: false, text: `ERR: ${e.message || 'malformed command'}` };
  }
}
