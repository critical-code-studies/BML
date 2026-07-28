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

import { typeOf, remember } from './types.js';

const numericTag = (x) => !!x && (x.tag === 'int' || x.tag === 'real');

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

// A raised exception in flight. Not a RonmlError: an uncaught one is reported
// as one, but on the way up it is a value being carried, not a failure.
export class RonmlRaise extends Error {
  constructor(value) { super('uncaught exception'); this.value = value; }
}
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
    if (c === ':' && src[i + 1] === ':') { toks.push({ t: 'CONS' }); i += 2; continue; }
    if (c === ':' && src[i + 1] === '>') { toks.push({ t: 'ASCRIBE' }); i += 2; continue; }   // opaque ascription
    if (c === ':' && src[i + 1] === '=') { toks.push({ t: 'ASSIGN' }); i += 2; continue; }    // assignment, before the bare colon
    if (c === ':') { toks.push({ t: 'COLON' }); i++; continue; }  // cons, as in ML
    if (c === '|' && src[i + 1] === '>') { toks.push({ t: 'PIPE' }); i += 2; continue; }
    if (c === '|') { toks.push({ t: 'BAR' }); i++; continue; }
    if (c === '@') { toks.push({ t: 'AT' }); i++; continue; }    // list append
    if (c === '!' && src[i + 1] === '=') { toks.push({ t: 'NE' }); i += 2; continue; }   // older spelling of <>
    if (c === '!') { toks.push({ t: 'BANG' }); i++; continue; }
    if (c === '{') { toks.push({ t: 'LC' }); i++; continue; }    // record
    if (c === '}') { toks.push({ t: 'RC' }); i++; continue; }
    // #"a" is a character; #label and #1 are selectors. The quote tells them
    // apart, and it has to be checked first or every char lexes as a selector.
    if (c === '#' && src[i + 1] === '"') {
      const ch = src[i + 2];
      if (src[i + 3] !== '"') throw new RonmlError('a character is one letter: #"a"');
      toks.push({ t: 'CHAR', v: ch });
      i += 4;
      continue;
    }
    if (c === '#') { toks.push({ t: 'HASH' }); i++; continue; }  // #label and #1
    if (c === '.' && src[i + 1] === '.' && src[i + 2] === '.') { toks.push({ t: 'ELLIPSIS' }); i += 3; continue; }   // separates datatype constructors and case arms
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
      // Standard ML string escapes. The old code copied the character after a
      // backslash verbatim, so `\n` was the letter n, not a newline — data
      // silently corrupted, the worst kind of wrong. This is Harper §2.2.4:
      // \n \t \\ \" and the numeric \ddd, plus the \…\ form that lets a string
      // span source lines by swallowing whitespace between two backslashes.
      let j = i + 1, s = '';
      while (j < n && src[j] !== '"') {
        if (src[j] !== '\\') { s += src[j]; j++; continue; }
        const e = src[j + 1];
        if (e === undefined) throw new RonmlError('a string ends with a lone backslash');
        // \…\ : whitespace (including newlines) between two backslashes is
        // elided, so a long string literal can be broken across lines.
        if (/\s/.test(e)) {
          let k = j + 1;
          while (k < n && /\s/.test(src[k])) k++;
          if (src[k] !== '\\') throw new RonmlError('a \\ … \\ gap in a string must close with a second \\');
          j = k + 1; continue;
        }
        const simple = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', a: '\x07', b: '\b', f: '\f', v: '\v' };
        if (e in simple) { s += simple[e]; j += 2; continue; }
        // \ddd : exactly three decimal digits, the character's code point.
        if (/[0-9]/.test(e)) {
          const m = src.slice(j + 1, j + 4);
          if (!/^[0-9]{3}$/.test(m)) throw new RonmlError('a \\ddd escape needs exactly three digits');
          s += String.fromCharCode(Number(m)); j += 4; continue;
        }
        throw new RonmlError(`unknown string escape \\${e}`);
      }
      if (j >= n) throw new RonmlError('unterminated string — a " has no closing "');
      toks.push({ t: 'STR', v: s });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[0-9]/.test(src[j])) j++;
      // A decimal point makes it a real, and only if a digit follows: `1.5` is
      // a real, `l.hd` is a qualified name, and `[1,2]` is two ints.
      let real = false;
      if (src[j] === '.' && /[0-9]/.test(src[j + 1] || '')) {
        real = true;
        j++;
        while (j < n && /[0-9]/.test(src[j])) j++;
      }
      toks.push({ t: 'NUM', v: parseFloat(src.slice(i, j)), real });
      i = j;
      continue;
    }
    // `~` is SML's unary minus. It was missing because it was never lexed.
    if (c === '~' && /[0-9(]/.test(src[i + 1] || '')) { toks.push({ t: 'NEG' }); i++; continue; }
    if (/[A-Za-z_]/.test(c) || (c === "'" && /[A-Za-z]/.test(src[i + 1] || ''))) {
      let j = i + 1;
      // `.` is allowed inside an identifier so filenames lex as one token
      // (factory_id.ml, readme.md) — evalNode tags anything ending .ml/.md a file.
      // `-` is NOT: it is the subtraction operator now (codes/filenames underscore).
      while (j < n && /[A-Za-z0-9_.']/.test(src[j])) j++;
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
  // `val` is Standard ML's word for a value binding. Accepted as a synonym for
  // `let` so that a line copied out of a manual binds rather than complains.
  if (word === 'let' && tok && tok.t === 'IDENT' && ['val', 'fun'].includes(tok.v.toLowerCase())) return true;
  return tok.t === 'IDENT' && tok.v.toLowerCase() === word;
}

// ---- Fixity ----------------------------------------------------------------
//
// In Standard ML an operator's precedence is a PARSE-TIME fact: `infix 8 OR`
// changes how the lines after it are read, so the parser has to carry the table
// and update it as it goes. Harper's regexp.sml declares OR and THEN in the
// middle of a structure and uses them three lines later, in the same parse.
//
// Levels are SML's own. `^` sits at 6 with `+` and `-`, not at 7 with `*`,
// which is where this parser used to put it.
export function defaultFixity() {
  return {
    '*': [7, 'l'], '/': [7, 'l'], div: [7, 'l'], mod: [7, 'l'],
    '+': [6, 'l'], '-': [6, 'l'], '^': [6, 'l'],
    '::': [5, 'r'], '@': [5, 'r'],
    '=': [4, 'l'], '<>': [4, 'l'], '<': [4, 'l'], '>': [4, 'l'], '<=': [4, 'l'], '>=': [4, 'l'],
    // `o` (composition) and `before` are infix in Standard ML's Basis, and are
    // deliberately NOT seeded here: neither function exists in this build, and
    // `o` is an ordinary variable name in plenty of programs. Seeding them made
    // every `x o y` parse as a composition and broke Harper's N-queens. Declare
    // them with `infix` if you define them.
  };
}

// Token type to the symbol the fixity table is keyed by.
const OP_SYM = {
  PLUS: '+', MINUS: '-', STAR: '*', SLASH: '/', CARET: '^',
  LT: '<', GT: '>', LE: '<=', GE: '>=', EQEQ: '=', NE: '<>', EQ: '=',
  CONS: '::', AT: '@',
};
// …and back to the node this parser already builds for it.
const SYM_BIN = {
  '+': 'PLUS', '-': 'MINUS', '*': 'STAR', '/': 'SLASH', '^': 'CARET',
  '<': 'LT', '>': 'GT', '<=': 'LE', '>=': 'GE', '=': 'EQEQ', '<>': 'NE',
  div: 'DIV', mod: 'MOD',
};

function parse(toks, fixityIn) {
  let p = 0;
  // The parser's own copy: `infix` inside a block must not leak out to the
  // caller's session until the declaration is actually evaluated.
  const fixity = { ...(fixityIn || defaultFixity()) };
  let inBlock = 0;      // >0 while inside local/struct: `in` and `end` are the block's
  const peek = () => toks[p];
  const eat = (t) => {
    if (toks[p].t !== t) throw new RonmlError(`expected ${t.toLowerCase()}, got '${toks[p].v ?? toks[p].t}'`);
    return toks[p++];
  };

  // `fn x => body` — an anonymous function (a lambda). Curry more than one
  // parameter as `fn x => fn y => …` (the `let f x y = …` sugar does this for you).
  function parseLambda() {
    p++; // 'fn'
    // `fn x => e` is the common case, but ML's fn takes a MATCH: several
    // alternatives separated by |, which is what makes `fn nil => … | _ => …`
    // work and what the corpus uses for one-off matchers.
    const first = parsePattern();
    if (peek().t !== 'ARROW') throw new RonmlError("expected '=>' after fn's parameter — try: fn x => x");
    p++;
    const arms = [{ pat: first, body: parseExpr1() }];
    while (peek().t === 'BAR') {
      p++;
      const pat = parsePattern();
      if (peek().t !== 'ARROW') throw new RonmlError("expected '=>' after a pattern — try: fn nil => 0 | _ => 1");
      p++;
      arms.push({ pat, body: parseExpr1() });
    }
    if (arms.length === 1 && first.p === 'name' && !first.args.length) {
      return { type: 'Lam', param: first.name, body: arms[0].body };
    }
    return { type: 'Lam', param: '__fnarg', body: { type: 'Case', subject: { type: 'Var', name: '__fnarg' }, arms } };
  }

  // Collect zero+ parameter names sitting between a let-name and its `=`, so
  // `let f x y = e` sugars to `let f = fn x => fn y => e`.
  // `let f p1 = e | f p2 = e` — a function defined by cases, which is how ML
  // is actually written and how every recursive function in Harper's examples
  // is spelled. Folded into one lambda per argument with a single case over a
  // tuple of them, so the arms may test any combination of the arguments.
  function clausalRest(name, firstParams, firstBody) {
    const clauses = [{ params: firstParams, body: firstBody }];
    while (peek().t === 'BAR') {
      const save = p;
      p++;
      if (peek().t !== 'IDENT' || peek().v.toLowerCase() !== name.toLowerCase()) { p = save; break; }
      p++;
      const ps = letParams();
      if (peek().t !== 'EQ') { p = save; break; }
      p++;
      clauses.push({ params: ps, body: parseExpr() });
    }
    if (clauses.length === 1) return null;
    const n = clauses[0].params.length;
    if (clauses.some((c) => c.params.length !== n)) {
      throw new RonmlError(`every clause of ${name} must take the same number of arguments`);
    }
    const tmps = Array.from({ length: n }, (_, i) => `__c${i}`);
    // A bare name in parameter position is usually a variable, but nil, true,
    // false and _ are patterns in their own right. Left as variables, `length
    // nil = 0` binds a variable called nil, matches every list, and the second
    // clause is never reached — which is exactly what it did.
    const asPat = (par) => {
      if (par && par.name && par.ann) return { p: 'name', name: par.name, args: [] };
      if (typeof par !== 'string') return par.pat;
      const lower = par.toLowerCase();
      if (par === '_') return { p: 'wild' };
      if (lower === 'nil') return { p: 'nil' };
      if (lower === 'true') return { p: 'bool', v: true };
      if (lower === 'false') return { p: 'bool', v: false };
      return { p: 'name', name: par, args: [] };
    };
    const subject = n === 1
      ? { type: 'Var', name: tmps[0] }
      : { type: 'Tuple', items: tmps.map((t) => ({ type: 'Var', name: t })) };
    const arms = clauses.map((c) => ({
      pat: n === 1 ? asPat(c.params[0]) : { p: 'tuple', items: c.params.map(asPat) },
      body: c.body,
    }));
    let v = { type: 'Case', subject, arms };
    for (let k = n - 1; k >= 0; k--) v = { type: 'Lam', param: tmps[k], body: v };
    return v;
  }

  function wrapParams(params, value) {
    let v = value;
    for (let k = params.length - 1; k >= 0; k--) {
      const par = params[k];
      if (typeof par === 'string') { v = { type: 'Lam', param: par, body: v }; continue; }
      if (par.name) { v = { type: 'Lam', param: par.name, ann: par.ann, body: v }; continue; }
      // A pattern parameter becomes a lambda over a fresh name that immediately
      // takes its argument apart. Same machinery as case, no new runtime.
      const tmp = `__arg${k}`;
      v = { type: 'Lam', param: tmp, body: { type: 'Case', subject: { type: 'Var', name: tmp }, arms: [{ pat: par.pat, body: v }] } };
    }
    return v;
  }
  // A parameter may be a pattern, not only a name: `let dist (x, y) = x + y`.
  // Harper (1993, s.2.4) treats a plain name as the simplest case of a pattern
  // rather than a separate thing, and so does this: a name comes back as a
  // string, anything else as a parsed pattern, and wrapParams tells them apart.
  function letParams() {
    const params = [];
    for (;;) {
      if (peek().t === 'IDENT' && !isKeyword(peek(), 'in')) {
        const nm = eat('IDENT').v;
        // A parameter's annotation is kept, not stepped over: `fun sq (n:int)`
        // has to constrain n, or the return annotation is the only claim in
        // the line and it drags the parameter along with it.
        if (peek().t === 'COLON') { p++; params.push({ name: nm, ann: parseTypeExpr() }); continue; }
        params.push(nm);
        continue;
      }
      if (['LP', 'LB', 'LC', 'NUM', 'STR', 'CHAR', 'NEG'].includes(peek().t)) {
        params.push({ pat: parsePatternAtom() }); continue;
      }
      break;
    }
    return params;
  }

  // Sequencing sits at the very top (loosest): `e1 ; e2` runs e1 for its effect,
  // throws away its value, then evaluates e2 and returns that. It threads through
  // everything below via parseExpr1. A trailing `;` (before `)` or end) is tolerated.
  function parseExpr() {
    let left = parseHandle();
    while (peek().t === 'SEMI') {
      p++;
      if (peek().t === 'RP' || peek().t === 'EOF' || peek().t === 'RB') break; // trailing ; is fine
      left = { type: 'Seq', left, right: parseHandle() };
    }
    return left;
  }

  // `e handle Pat => e | Pat => e` — the same arm shape as case, because that
  // is what a handler is: a match, tried against whatever was raised.
  function parseHandle() {
    let body = parseAssign();
    while (isKeyword(peek(), 'handle')) {
      p++;
      const arms = [];
      for (;;) {
        const pat = parsePattern();
        if (peek().t !== 'ARROW') throw new RonmlError("expected '=>' after a handler pattern");
        p++;
        arms.push({ pat, body: parseExpr1() });
        if (peek().t !== 'BAR') break;
        p++;
      }
      body = { type: 'Handle', body, arms };
    }
    return body;
  }

  // `r := e` — the only thing in the language that changes something that
  // already exists.
  function parseAssign() {
    const left = parseExpr1();
    if (peek().t !== 'ASSIGN') return left;
    p++;
    return { type: 'Assign', target: left, value: parseExpr1() };
  }

  function parseExpr1() {
    if (isKeyword(peek(), 'raise')) { p++; return { type: 'Raise', arg: parseExpr1() }; }
    if (isKeyword(peek(), 'case')) return parseCase();
    if (isKeyword(peek(), 'fn')) return parseLambda();
    if (isKeyword(peek(), 'if')) return parseIf();
    if (isKeyword(peek(), 'let')) {
      p++;
      if (peek().t === 'IDENT' && ['val', 'fun'].includes(peek().v.toLowerCase())) p++;
      // `let (a, b) = e` and `let [x, y] = e` bind several names at once.
      // Harper introduces this as "the following generalization of a value
      // binding" (1993, p.16), before case, because it is the simpler idea:
      // write down the shape and the parts get names.
      if (peek().t === 'LP' || peek().t === 'LB' || peek().t === 'LC') {
        const pat = parsePatternAtom();
        eat('EQ');
        const value = parseExpr();
        if (isKeyword(peek(), 'in')) {
          p++;
          return { type: 'LetPat', pat, value, body: parseExpr() };
        }
        return { type: 'TopLetPat', pat, value };
      }
      const nameTok = eat('IDENT');
      const params = letParams();
      let ann0 = null;
      if (peek().t === 'COLON') { p++; ann0 = parseTypeExpr(); }
      eat('EQ');
      const first0 = parseExpr();
      const v0 = clausalRest(nameTok.v, params, first0) || wrapParams(params, first0);
      const value = ann0 ? { type: 'Annot', expr: v0, ann: ann0, params: params.length } : v0;
      // `let a = 1 and b = 2 in …` and `let val a = 1 val b = 2 in … end`.
      // Several bindings before the `in`, which is how ML writes a local block
      // and how most of the worked examples in the corpus are shaped.
      const extra = [];
      for (;;) {
        // Only treat `and` as a binding separator when what follows really is
        // a binding; otherwise `let x = a and b in …` would lose its boolean.
        const isBind = () => {
          let q = p + 1;
          if (!toks[q] || toks[q].t !== 'IDENT') return false;
          while (toks[q] && (toks[q].t === 'IDENT' || toks[q].t === 'LP' || toks[q].t === 'LB')) q++;
          return !!toks[q] && toks[q].t === 'EQ';
        };
        if ((isKeyword(peek(), 'and') && isBind()) || isKeyword(peek(), 'let')) {
          p++;
          const n2 = eat('IDENT');
          const p2 = letParams();
          eat('EQ');
          const b2 = parseExpr();
          extra.push({ name: n2.v, value: clausalRest(n2.v, p2, b2) || wrapParams(p2, b2) });
          continue;
        }
        break;
      }
      if (extra.length) {
        if (!isKeyword(peek(), 'in')) throw new RonmlError("expected 'in' after the bindings");
        p++;
        let body = parseExpr();
        if (isKeyword(peek(), 'end')) p++;
        for (let k = extra.length - 1; k >= 0; k--) body = { type: 'Let', name: extra[k].name, value: extra[k].value, body };
        return { type: 'Let', name: nameTok.v, value, body };
      }
      if (!isKeyword(peek(), 'in')) throw new RonmlError("expected 'in' after let — try: let k = hack OB_XXXX in crash OB_XXXX k");
      p++;
      const body = parseExpr();
      if (isKeyword(peek(), 'end')) p++;      // SML closes a local block with `end`
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
  // A pattern with an optional `: type` after it. Annotations are checked by
  // the type checker, not here; this only has to let them through.
  function parsePatternAnn() {
    const pt = parsePattern();
    if (peek().t !== 'COLON') return pt;
    p++;
    return { p: 'ann', pat: pt, ann: parseTypeExpr() };
  }

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
    if (tok.t === 'NUM') { p++; return { p: 'num', v: tok.v, real: !!tok.real }; }
    if (tok.t === 'CHAR') { p++; return { p: 'char', v: tok.v }; }
    if (tok.t === 'NEG') { p++; const n2 = eat('NUM'); return { p: 'num', v: -n2.v, real: !!n2.real }; }
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
    if (tok.t === 'LC') {
      p++;
      const fields = [];
      let open = false;
      if (peek().t !== 'RC') {
        for (;;) {
          if (peek().t === 'ELLIPSIS') { p++; open = true; break; }
          const label = eat('IDENT').v;
          if (peek().t === 'EQ') { p++; fields.push({ label, pat: parsePattern() }); }
          else fields.push({ label, pat: { p: 'name', name: label, args: [] } });
          if (peek().t !== 'COMMA') break;
          p++;
        }
      }
      eat('RC');
      return { p: 'record', fields, open };
    }
    if (tok.t === 'LP') {
      p++;
      if (peek().t === 'RP') { p++; return { p: 'unit' }; }
      const first = parsePatternAnn();
      if (peek().t === 'COMMA') {
        const items = [first];
        while (peek().t === 'COMMA') { p++; items.push(parsePatternAnn()); }
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
      // `whole as pattern` names the value AND takes it apart, which the
      // corpus uses whenever a clause needs both.
      if (peek().t === 'IDENT' && peek().v.toLowerCase() === 'as') {
        p++;
        return { p: 'as', name: v, pat: parsePatternAtom() };
      }
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
  // Is the `and` at position p separating two BINDINGS rather than joining two
  // conditions? It is if what follows looks like `name … =`.
  function andIsBinding() {
    let q = p + 1;
    if (!toks[q] || toks[q].t !== 'IDENT') return false;
    // A binding's left-hand side is a name and then, for a `fun` clause, its
    // parameter patterns — which may be literals (`and od 0 = false`), not only
    // identifiers. Scanning identifiers alone made a mutually recursive
    // definition read as a boolean conjunction.
    while (toks[q] && ['IDENT', 'LP', 'LB', 'LC', 'NUM', 'STR', 'CHAR', 'NEG', 'USCORE'].includes(toks[q].t)) q++;
    return !!toks[q] && toks[q].t === 'EQ';
  }

  function parseBool() {
    let left = parseCompare();
    // `and` is both boolean conjunction and the separator between simultaneous
    // bindings. Take it as boolean only when what follows is not a binding, or
    // `let a = 1 and b = 2 in …` swallows the second name and then trips on =.
    const BOOLW = { and: 'and', andalso: 'and', or: 'or', orelse: 'or' };
    while (peek().t === 'IDENT' && BOOLW[peek().v.toLowerCase()]
      && !(peek().v.toLowerCase() === 'and' && andIsBinding())) {
      const op = BOOLW[toks[p++].v.toLowerCase()];
      left = { type: 'Bool', op, left, right: parseCompare() };
    }
    return left;
  }

  // Precedence, loosest to tightest: pipe < and/or < the INFIX TABLE <
  // application (juxtaposition). Everything between and/or and application is
  // one precedence-climbing loop driven by `fixity`, so that a user's
  // `infix 8 OR` sits in the same ladder as `+` and `::` rather than beside it.
  //
  // This replaced four hand-written levels (compare/cons/add/mul). The levels
  // are unchanged from what those did, with one deliberate correction: `^` was
  // at 7 with `*` and is now at 6 with `+`, which is where Standard ML puts it.

  // The operator at the cursor, as a fixity-table key, or null if there is none.
  function opSym() {
    const t = peek();
    if (OP_SYM[t.t]) return OP_SYM[t.t];
    if (t.t === 'IDENT') {
      const w = t.v.toLowerCase();
      if (w === 'div' || w === 'mod') return w;
      // A user-declared operator. Matched case-sensitively, because OR and THEN
      // are ordinary identifiers that happen to have been given a fixity.
      if (Object.prototype.hasOwnProperty.call(fixity, t.v)) return t.v;
    }
    return null;
  }

  function mkInfix(sym, left, right) {
    if (sym === '::') return { type: 'Cons', head: left, tail: right };
    if (sym === '@') return { type: 'Append', left, right };
    if (SYM_BIN[sym]) return { type: 'Bin', op: SYM_BIN[sym], left, right };
    // A user-declared operator is an ordinary function applied to the PAIR, as
    // it is in ML: `a OR b` is `OR (a, b)`.
    return { type: 'App', fn: { type: 'Var', name: sym }, arg: { type: 'Tuple', items: [left, right] } };
  }

  function parseInfix(minPrec) {
    let left = parseApp();
    for (;;) {
      const sym = opSym();
      if (sym === null) break;
      const f = fixity[sym];
      if (!f || f[0] < minPrec) break;
      p++;                                        // consume the operator
      // Left-associative operators demand a tighter right operand; right-
      // associative ones accept their own level, which is what makes
      // `1 :: 2 :: nil` group to the right.
      const right = parseInfix(f[1] === 'l' ? f[0] + 1 : f[0]);
      left = mkInfix(sym, left, right);
    }
    return left;
  }

  function parseCompare() { return parseInfix(0); }

  function atomStarts(tok) {
    // Keywords delimit rather than begin an atom, so a bare `if`/`then`/`else`/`fn`
    // in application position ends the current argument list instead of being eaten
    // as a variable named "then".
    if (tok.t === 'IDENT' && ['in', 'let', 'if', 'then', 'else', 'fn', 'and', 'or', 'andalso', 'orelse', 'mod', 'div', 'case', 'of', 'datatype', 'val', 'fun', 'as', 'end',
      'structure', 'signature', 'sig', 'struct', 'exception', 'raise', 'handle', 'type'].includes(tok.v.toLowerCase())) return false;
    return ['NUM', 'STR', 'CHAR', 'NEG', 'IDENT', 'LP', 'LB', 'LC', 'HASH'].includes(tok.t);
  }

  function parseApp() {
    let node = parseAtom();
    // An identifier with a fixity is an OPERATOR, not an argument. Without this
    // check `1 PLUS3 2` is read as applying 1 to PLUS3 and then to 2, because
    // juxtaposition binds tighter than any infix and gets there first. Symbolic
    // operators never reach here (they are not atom starts); word-shaped ones
    // like Harper's OR and THEN do.
    while (atomStarts(peek()) && !(peek().t === 'IDENT'
        && Object.prototype.hasOwnProperty.call(fixity, peek().v))) {
      const arg = parseAtom();
      node = { type: 'App', fn: node, arg };
    }
    return node;
  }

  function parseAtom() {
    const tok = peek();
    // `op +` — an infix operator used as an ordinary value, so it can be passed
    // to something else: `reduce (0, op +, l)`. Desugars to the function that
    // takes the pair, which is what the operator IS in ML.
    if (tok.t === 'IDENT' && tok.v.toLowerCase() === 'op') {
      p++;
      const t2 = toks[p++];
      const sym = OP_SYM[t2.t] || (t2.t === 'STAR' ? '*' : null) || (t2.t === 'IDENT' ? t2.v : null);
      if (!sym) throw new RonmlError('op needs an operator after it, as in: op +');
      const L = { type: 'Var', name: '__opl' }, R = { type: 'Var', name: '__opr' };
      return {
        type: 'Lam',
        param: '__oparg',
        body: {
          type: 'Case',
          subject: { type: 'Var', name: '__oparg' },
          arms: [{
            pat: { p: 'tuple', items: [{ p: 'name', name: '__opl', args: [] }, { p: 'name', name: '__opr', args: [] }] },
            body: mkInfix(sym, L, R),
          }],
        },
      };
    }
    // Unary minus: `-3` is `0 - 3`. (Binary `5 - 3` is caught in parseAdd before
    // we ever reach here, so this only fires when `-` opens a subexpression.)
    if (tok.t === 'MINUS') { p++; return { type: 'Bin', op: 'MINUS', left: { type: 'Lit', value: 0 }, right: parseAtom() }; }
    if (tok.t === 'NUM') { p++; return { type: 'Lit', value: tok.v, real: !!tok.real }; }
    if (tok.t === 'CHAR') { p++; return { type: 'CharLit', value: tok.v }; }
    if (tok.t === 'NEG') { p++; const a = parseAtom(); return { type: 'Neg', arg: a }; }
    if (tok.t === 'BANG') { p++; return { type: 'Deref', arg: parseAtom() }; }
    if (tok.t === 'STR') { p++; return { type: 'StrLit', value: tok.v }; }
    if (tok.t === 'IDENT') { p++; return { type: 'Var', name: tok.v }; }
    if (tok.t === 'LP') {
      p++;
      if (peek().t === 'RP') { p++; return { type: 'Unit' }; }
      const e = parseExpr();
      if (peek().t === 'COLON') { p++; const ann = parseTypeExpr(); eat('RP'); return { type: 'Annot', expr: e, ann, params: 0 }; }
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
    // { a = 1, b = 2 } — a record: named fields rather than positions. The
    // shorthand { a, b } means { a = a, b = b }, as it does in ML.
    if (tok.t === 'LC') {
      p++;
      const fields = [];
      if (peek().t !== 'RC') {
        for (;;) {
          const label = eat('IDENT').v;
          if (peek().t === 'EQ') { p++; fields.push({ label, value: parseExpr() }); }
          else fields.push({ label, value: { type: 'Var', name: label } });
          if (peek().t !== 'COMMA') break;
          p++;
        }
      }
      eat('RC');
      return { type: 'Record', fields };
    }
    // #label r selects a field; #1 p selects from a tuple, counting from one.
    if (tok.t === 'HASH') {
      p++;
      const sel = peek().t === 'NUM' ? String(eat('NUM').v) : eat('IDENT').v;
      return { type: 'Select', label: sel };
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
  // A type expression: read for its shape and thrown away, since inference
  // works structurally. Returns the number of *-separated components, which is
  // the one fact a constructor declaration needs from it.
  // A type expression, KEPT. `int`, `'a`, `int list`, `a * b`, `a -> b`. The
  // checker unifies it with what it infers, so an annotation is a claim the
  // machine will hold you to rather than a decoration it steps around.
  function parseTypeExpr() {
    const parseAtomT = () => {
      if (peek().t === 'LP') {
        p++;
        const inner = parseTypeExpr();
        eat('RP');
        return inner;
      }
      const id = eat('IDENT');
      return { t: 'name', name: id.v };
    };
    let left = parseAtomT();
    // postfix: `int list`, `'a tree`
    while (peek().t === 'IDENT' && !['of', 'val', 'fun', 'type', 'datatype', 'end', 'exception', 'structure', 'signature', 'in', 'and'].includes(peek().v.toLowerCase())) {
      left = { t: 'app', name: eat('IDENT').v, arg: left };
    }
    if (peek().t === 'STAR') {
      const parts = [left];
      while (peek().t === 'STAR') { p++; parts.push(parseTypeExpr1()); }
      left = { t: 'tuple', parts };
    }
    if (peek().t === 'MINUS' && toks[p + 1] && toks[p + 1].t === 'GT') {
      p += 2;
      return { t: 'fn', from: left, to: parseTypeExpr() };
    }
    if (peek().t === 'ARROWT') { p++; return { t: 'fn', from: left, to: parseTypeExpr() }; }
    return left;
  }
  function parseTypeExpr1() {
    const save = p;
    try { 
      const t = parseTypeExpr();
      return t;
    } catch { p = save; return { t: 'name', name: '_' }; }
  }

  function skipTypeExpr() {
    let parts = 1;
    let depth = 0;
    for (;;) {
      const t = peek();
      if (t.t === 'EOF') break;
      if (t.t === 'LP') { depth++; p++; continue; }
      if (t.t === 'RP') { if (!depth) break; depth--; p++; continue; }
      if (t.t === 'STAR' && !depth) { parts++; p++; continue; }
      if (t.t === 'STAR' || t.t === 'ARROW' || t.t === 'COMMA' || t.t === 'CONS') { p++; continue; }
      if (t.t === 'IDENT' && !['val', 'fun', 'type', 'datatype', 'end', 'exception', 'structure', 'signature', 'in', 'and'].includes(t.v.toLowerCase())) { p++; continue; }
      if (t.t === 'MINUS' && toks[p + 1] && toks[p + 1].t === 'GT') { p += 2; continue; }
      break;
    }
    return parts;
  }

  // SIMULTANEOUS DECLARATIONS. `type count = int and average = real`,
  // `datatype tree = … and forest = …`, `fun ev … and od …`. The `and` joins
  // declarations of the SAME kind, so the keyword is not repeated after it.
  //
  // Handled by continuing with the keyword the chain started with: the `and`
  // token is rewritten to it and the same declaration parser runs again. A
  // boolean `and` never reaches here — parseBool has already eaten it (see
  // andIsBinding), so an `and` still standing at this point is a chain.
  //
  // Mutual recursion works without further ceremony at the top level: closures
  // capture the session object itself, so a name bound by a later declaration
  // in the chain is visible to an earlier one by the time either is called.
  const CHAINS = ['type', 'datatype', 'val', 'fun'];
  function parseTop() {
    const first = peek();
    const kw = first.t === 'IDENT' ? first.v.toLowerCase() : null;
    const d = parseTopOne();
    if (!CHAINS.includes(kw)) return d;
    if (!(peek().t === 'IDENT' && peek().v.toLowerCase() === 'and')) return d;
    const items = [d];
    while (peek().t === 'IDENT' && peek().v.toLowerCase() === 'and') {
      toks[p] = { ...toks[p], v: kw };     // read the `and` as the keyword again
      items.push(parseTopOne());
    }
    return { type: 'Decls', items };
  }

  function parseTopOne() {
    // `datatype colour = Red | Blue | Circle of num`
    //
    // The `of ...` part is a TYPE, and this build does not check types, so it
    // is read for one thing only: how many arguments the constructor takes,
    // counted by the * between components. Harper (1993, s.2.7) declares the
    // type and its value constructors in one binding; so does this, minus the
    // checking. The Restrictions page says as much rather than implying more.
    // `type board = int * int * ...` — an abbreviation. It names a type and
    // introduces no values, so it is read and recorded and nothing else
    // happens. Inference works structurally and does not need the name.
    if (isKeyword(peek(), 'type')) {
      p++;
      while (peek().t === 'IDENT' && /^'/.test(peek().v)) p++;
      const nameTok = eat('IDENT');
      eat('EQ');
      skipTypeExpr();
      return { type: 'TypeAbbrev', name: nameTok.v };
    }
    // `exception Fail` / `exception Bad of str`. An exception is a constructor
    // like any other; what makes it an exception is `raise`.
    if (isKeyword(peek(), 'exception')) {
      p++;
      const nameTok = eat('IDENT');
      let arity = 0;
      if (isKeyword(peek(), 'of')) { p++; arity = skipTypeExpr(); }
      return { type: 'ExnDecl', name: nameTok.v, arity };
    }
    // `infix [n] id …`, `infixr [n] id …`, `nonfix id …`. These are parse-time:
    // the table is updated here so that the very next line in the same unit
    // reads its operators correctly, and the node carries the change so eval can
    // persist it into the session for the lines after that.
    if (isKeyword(peek(), 'infix') || isKeyword(peek(), 'infixr') || isKeyword(peek(), 'nonfix')) {
      const word = toks[p++].v.toLowerCase();
      const assoc = word === 'infixr' ? 'r' : 'l';
      let prec = 0;
      if (peek().t === 'NUM' && !peek().real) prec = Number(toks[p++].v);
      const names = [];
      // The operators being declared. They are ordinary identifiers, and any
      // symbolic ones (`**`) arrive as whatever the lexer made of them.
      while (peek().t === 'IDENT' || OP_SYM[peek().t] || peek().t === 'STAR') {
        const t = toks[p++];
        names.push(t.t === 'IDENT' ? t.v : (OP_SYM[t.t] || t.v));
      }
      for (const n of names) {
        if (word === 'nonfix') delete fixity[n];
        else fixity[n] = [prec, assoc];
      }
      return { type: 'FixityDecl', word, prec, assoc, names };
    }
    // `signature NAME = sig ... end` — the names a structure agrees to show.
    // Without a checker this cannot verify the TYPES, and does not pretend to;
    // what it does is real all the same: it records which names are public, and
    // `:>` hides the rest, which is what a signature is for.
    if (isKeyword(peek(), 'signature')) {
      p++;
      const nameTok = eat('IDENT');
      eat('EQ');
      // A signature abbreviation: `signature INT_DICT = DICT where type key =
      // int`. The body is another signature's NAME, optionally refined by
      // `where type … = …`. Since this build tracks names and not types, the
      // refinement is a no-op and the new signature simply inherits the named
      // one's public names. `views.sml` is built entirely this way.
      if (!isKeyword(peek(), 'sig')) {
        const refTok = eat('IDENT');
        // Swallow any `where type t = …` clauses; they refine types we do not
        // track, so there is nothing to record, only to skip.
        while (isKeyword(peek(), 'where')) {
          p++;
          if (isKeyword(peek(), 'type')) p++;
          while (peek().t === 'IDENT' && /^'/.test(peek().v)) p++;
          if (peek().t === 'IDENT') p++;              // the type name
          if (peek().t === 'EQ') { p++; skipTypeExpr(); }
        }
        return { type: 'SigAbbrev', name: nameTok.v, from: refTok.v };
      }
      p++;
      const names = [];
      while (!isKeyword(peek(), 'end') && peek().t !== 'EOF') {
        if (isKeyword(peek(), 'val') || isKeyword(peek(), 'fun')) {
          p++;
          names.push(eat('IDENT').v);
          if (peek().t === 'COLON') { p++; skipTypeExpr(); }
        } else if (isKeyword(peek(), 'type') || isKeyword(peek(), 'datatype')) {
          p++;
          while (peek().t === 'IDENT' && /^'/.test(peek().v)) p++;
          eat('IDENT');
          if (peek().t === 'EQ') { p++; skipTypeExpr(); }
        } else p++;
      }
      if (isKeyword(peek(), 'end')) p++;
      return { type: 'SigDecl', name: nameTok.v, names };
    }
    // `structure Name [:> SIG] = struct ... end`
    // `local d1 in d2 end` — d1 is in scope for d2 and nowhere after. The
    // declarations version of let.
    if (isKeyword(peek(), 'local')) {
      p++;
      const hidden = [];
      inBlock++;
      while (!isKeyword(peek(), 'in') && peek().t !== 'EOF') hidden.push(parseTop());
      if (isKeyword(peek(), 'in')) p++;
      const shown = [];
      while (!isKeyword(peek(), 'end') && peek().t !== 'EOF') shown.push(parseTop());
      inBlock--;
      if (isKeyword(peek(), 'end')) p++;
      return { type: 'Local', hidden, shown };
    }
    // `functor F (X : SIG) = struct ... end` — a structure with a structure for
    // an argument. The body is kept unevaluated and run per application, which
    // is the whole difference from a plain structure.
    if (isKeyword(peek(), 'functor')) {
      p++;
      const nameTok = eat('IDENT');
      eat('LP');
      const param = eat('IDENT').v;
      if (peek().t === 'COLON' || peek().t === 'ASCRIBE') { p++; eat('IDENT'); }
      eat('RP');
      if (peek().t === 'COLON' || peek().t === 'ASCRIBE') { p++; eat('IDENT'); }
      eat('EQ');
      if (!isKeyword(peek(), 'struct')) throw new RonmlError("expected 'struct' after a functor's =");
      p++;
      const decls = [];
      inBlock++;
      while (!isKeyword(peek(), 'end') && peek().t !== 'EOF') decls.push(parseTop());
      inBlock--;
      if (isKeyword(peek(), 'end')) p++;
      return { type: 'FunctorDecl', name: nameTok.v, param, decls };
    }
    if (isKeyword(peek(), 'structure')) {
      p++;
      const nameTok = eat('IDENT');
      let ascribe = null;
      if (peek().t === 'COLON' || peek().t === 'ASCRIBE') { p++; ascribe = eat('IDENT').v; }
      eat('EQ');
      // `structure M = F (A)` applies a functor rather than opening a struct.
      if (peek().t === 'IDENT' && !isKeyword(peek(), 'struct')) {
        const fn = eat('IDENT').v;
        let arg = null;
        if (peek().t === 'LP') { p++; arg = eat('IDENT').v; eat('RP'); }
        else if (peek().t === 'IDENT') arg = eat('IDENT').v;
        return { type: 'StructApply', name: nameTok.v, functor: fn, arg, ascribe };
      }
      if (!isKeyword(peek(), 'struct')) throw new RonmlError("expected 'struct' after a structure name");
      p++;
      const decls = [];
      inBlock++;
      while (!isKeyword(peek(), 'end') && peek().t !== 'EOF') decls.push(parseTop());
      inBlock--;
      if (isKeyword(peek(), 'end')) p++;
      return { type: 'StructDecl', name: nameTok.v, ascribe, decls };
    }
    if (isKeyword(peek(), 'datatype')) {
      p++;
      // `datatype 'a option = …` — type parameters are read and thrown away.
      // Nothing here is typed, so they carry no meaning, but a declaration
      // copied out of a manual should still declare its constructors.
      while (peek().t === 'IDENT' && /^'/.test(peek().v)) p++;
      if (peek().t === 'LP') { while (peek().t !== 'RP') p++; p++; }
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
          while (peek().t === 'IDENT' && !isKeyword(peek(), 'of')) p++;   // `'a tree` is two words, one type
          while (peek().t === 'STAR') {
            p++; arity++;
            eat('IDENT');
            while (peek().t === 'IDENT' && !isKeyword(peek(), 'of')) p++;
          }
        }
        cons.push({ name: c.v, arity });
        if (peek().t !== 'BAR') break;
        p++;
      }
      return { type: 'Datatype', name: nameTok.v, cons };
    }
    if (isKeyword(peek(), 'let')) {
      p++;
      if (peek().t === 'IDENT' && ['val', 'fun'].includes(peek().v.toLowerCase())) p++;
      // `let (a, b) = e` and `let [x, y] = e` bind several names at once.
      // Harper introduces this as "the following generalization of a value
      // binding" (1993, p.16), before case, because it is the simpler idea:
      // write down the shape and the parts get names.
      if (peek().t === 'LP' || peek().t === 'LB' || peek().t === 'LC') {
        const pat = parsePatternAtom();
        eat('EQ');
        const value = parseExpr();
        if (isKeyword(peek(), 'in')) {
          p++;
          return { type: 'LetPat', pat, value, body: parseExpr() };
        }
        return { type: 'TopLetPat', pat, value };
      }
      const nameTok = eat('IDENT');
      const params = letParams();
      let ann = null;
      if (peek().t === 'COLON') { p++; ann = parseTypeExpr(); }
      eat('EQ');
      const first = parseExpr();
      const value0 = clausalRest(nameTok.v, params, first) || wrapParams(params, first);
      const value = ann ? { type: 'Annot', expr: value0, ann, params: params.length } : value0;
      // Several bindings before the `in`: `let val m = 3 val n = 4 in m+n end`
      // and `let a = 1 and b = 2 in a+b`. `end` closes the block if it is there.
      const extra = [];
      // Is there an `in` ahead of the next declaration? Without this the loop
      // swallows the following `fun` inside a struct, where declarations simply
      // follow one another and no `in` is coming.
      const inAhead = () => {
        for (let q = p; q < toks.length; q++) {
          const t = toks[q];
          if (t.t === 'EOF') return false;
          if (t.t !== 'IDENT') continue;
          const w = t.v.toLowerCase();
          if (w === 'in') return true;
          if (w === 'structure' || w === 'signature' || w === 'end') return false;
        }
        return false;
      };
      const isBind = () => {
        let q = p + 1;
        if (!toks[q] || toks[q].t !== 'IDENT') return false;
        while (toks[q] && ['IDENT', 'LP', 'LB', 'LC'].includes(toks[q].t)) q++;
        return !!toks[q] && toks[q].t === 'EQ';
      };
      while (!inBlock && inAhead() && ((isKeyword(peek(), 'and') && isBind()) || isKeyword(peek(), 'let'))) {
        p++;
        const n2 = eat('IDENT');
        const p2 = letParams();
        eat('EQ');
        const b2 = parseExpr();
        extra.push({ name: n2.v, value: clausalRest(n2.v, p2, b2) || wrapParams(p2, b2) });
      }
      if (!inBlock && isKeyword(peek(), 'in')) {
        p++;
        let body = parseExpr();
        if (isKeyword(peek(), 'end')) p++;
        for (let k = extra.length - 1; k >= 0; k--) body = { type: 'Let', name: extra[k].name, value: extra[k].value, body };
        return { type: 'Let', name: nameTok.v, value, body };
      }
      if (extra.length) throw new RonmlError("expected 'in' after the bindings");
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
      return kind === 'bool' ? { tag: 'bool', v: !!v } : { tag: 'int', v: Number(v) || 0 };
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
    // ---- the little that stands in for a standard library ------------
    // A machine with no floating-point unit and no printer does not get one,
    // but these five come up in every worked example and cost nothing.
    abs: { arity: 1, fn: ([n]) => { if (!numericTag(n)) throw new RonmlError(`${describeValue(n)} is not a number`); return { tag: n.tag, v: Math.abs(n.v) }; } },
    sqrt: { arity: 1, fn: ([n]) => { if (!numericTag(n)) throw new RonmlError(`${describeValue(n)} is not a number`); if (n.v < 0) throw new RonmlError('sqrt of a negative'); return { tag: 'real', v: Math.sqrt(n.v) }; } },
    // int and real do not mix, so there have to be ways across.
    real: { arity: 1, fn: ([n]) => { if (!numericTag(n)) throw new RonmlError(`${describeValue(n)} is not a number`); return { tag: 'real', v: n.v }; } },
    floor: { arity: 1, fn: ([n]) => { if (!numericTag(n)) throw new RonmlError(`${describeValue(n)} is not a number`); return { tag: 'int', v: Math.floor(n.v) }; } },
    // characters
    ord: { arity: 1, fn: ([c]) => { if (!c || c.tag !== 'char') throw new RonmlError(`${describeValue(c)} is not a character`); return { tag: 'int', v: c.v.charCodeAt(0) }; } },
    chr: { arity: 1, fn: ([n]) => { if (!numericTag(n)) throw new RonmlError(`${describeValue(n)} is not a number`); return { tag: 'char', v: String.fromCharCode(n.v) }; } },
    // WHAT THE CARD CAN HEAR. Not the control wire — this is the NostBook's own
    // wireless card reading traffic off the air, the same table `arp -a` prints.
    // A machine broadcasts to its tower whether or not anyone is listening, so
    // listening costs nothing and gives itself away to nobody.
    units: {
      arity: 0,
      fn: (_args, ctx) => ({
        tag: 'list',
        items: ((ctx && ctx.units && ctx.units()) || []).map((u) => ({
          tag: 'record',
          fields: {
            name: { tag: 'str', v: String(u.name) },
            range: { tag: 'int', v: Number(u.range) || 0 },
            bearing: { tag: 'str', v: String(u.bearing) },
            kind: { tag: 'str', v: String(u.kind || '?') },
          },
        })),
      }),
    },
    str: { arity: 1, fn: ([c]) => { if (!c || c.tag !== 'char') throw new RonmlError(`${describeValue(c)} is not a character`); return { tag: 'str', v: c.v }; } },
    explode: { arity: 1, fn: ([x]) => { if (!x || x.tag !== 'str') throw new RonmlError(`${describeValue(x)} is not a string`); return { tag: 'list', items: [...x.v].map((ch) => ({ tag: 'char', v: ch })) }; } },
    implode: { arity: 1, fn: ([l]) => { if (!l || l.tag !== 'list') throw new RonmlError(`${describeValue(l)} is not a list`); return { tag: 'str', v: l.items.map((c) => (c && c.tag === 'char' ? c.v : formatValue(c))).join('') }; } },
    min: { arity: 2, fn: ([a, b]) => { if (!a || !numericTag(a) || !b || !numericTag(b)) throw new RonmlError('min needs two numbers'); return { tag: a.tag, v: Math.min(a.v, b.v) }; } },
    max: { arity: 2, fn: ([a, b]) => { if (!a || !numericTag(a) || !b || !numericTag(b)) throw new RonmlError('max needs two numbers'); return { tag: a.tag, v: Math.max(a.v, b.v) }; } },
    size: { arity: 1, fn: ([x]) => { if (x && x.tag === 'str') return { tag: 'int', v: x.v.length }; if (x && x.tag === 'list') return { tag: 'int', v: x.items.length }; throw new RonmlError(`${describeValue(x)} has no size`); } },
    // A cell whose contents can be replaced. The only mutable thing here.
    ref: { arity: 1, fn: ([v]) => ({ tag: 'ref', cell: { v } }) },
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
        if (l && l.tag === 'str') return { tag: 'int', v: String(l.v).length };
        if (!l || l.tag !== 'list') throw new RonmlError(`${describeValue(l)} has no length`);
        return { tag: 'int', v: l.items.length };
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
    // ---- fire control (P8) ----------------------------------------------
    // The level below `hunt`. A machine that carries a weapon has to know
    // whether it can see the target, whether it is loaded, whether the target
    // is behind something, whether it is being touched, and how long it has
    // been looking without finding anything.
    sight: SENSE('sight', 'bool'),
    armed: SENSE('armed', 'bool'),
    shielded: SENSE('shielded', 'bool'),
    contact: SENSE('contact', 'bool'),
    lost_for: SENSE('lost_for', 'num'),
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
const LAPTOP_VERBS = ['echo', 'not', 'hd', 'tl', 'length', 'abs', 'sqrt', 'min', 'max', 'size',
  'real', 'floor', 'ord', 'chr', 'str', 'explode', 'implode', 'ref', 'units'];
// A MACHINE'S OWN STATION. Its program runs here: senses in, an intent out, and
// nothing else within reach — no network, no files, no console verbs. That is
// not a restriction bolted on, it is what a unit actually has.
// What a machine's own program may say. `not` and `echo` are the language's,
// not the machine's, so they are listed here but stay neutral elsewhere.
const MACHINE_ONLY = ['charge', 'integrity', 'range', 'home_range',
  'threat', 'hurt', 'linked', 'blight', 'daylight', 'beep', 'eye', 'flash',
  // Fire control (docs/robot-programs-plan.md P8). A machine that shoots needs
  // to know whether it can see, whether it is loaded, whether the target is
  // covered, whether it is being touched, and how long it has been looking.
  'sight', 'armed', 'shielded', 'contact', 'lost_for'];
const ROBOT_VERBS = [...MACHINE_ONLY, 'not', 'echo', 'hd', 'tl', 'length', 'abs', 'sqrt', 'min', 'max', 'size',
  'real', 'floor', 'ord', 'chr', 'str', 'explode', 'implode'];
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
  if (fnVal && fnVal.tag === 'select') {
    const l = fnVal.label;
    if (argVal && argVal.tag === 'record') {
      if (!Object.prototype.hasOwnProperty.call(argVal.fields, l)) throw new RonmlError(`no field ${l} in this record`);
      return argVal.fields[l];
    }
    if (argVal && argVal.tag === 'tuple') {
      const i = Number(l);
      if (!Number.isInteger(i) || i < 1 || i > argVal.items.length) throw new RonmlError(`a tuple of ${argVal.items.length} has no #${l}`);
      return argVal.items[i - 1];
    }
    throw new RonmlError(`${describeValue(argVal)} has no fields`);
  }
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
    case 'int': case 'real': case 'str': case 'bool': case 'char': return a.v === b.v;
    case 'tuple': return a.items.length === b.items.length && a.items.every((x, i) => valuesEqual(x, b.items[i]));
    case 'list': return a.items.length === b.items.length && a.items.every((x, i) => valuesEqual(x, b.items[i]));
    case 'con': return a.name === b.name && (a.args || []).length === (b.args || []).length
      && (a.args || []).every((x, i) => valuesEqual(x, b.args[i]));
    case 'node': return a.id === b.id;
    case 'key': return a.kind === b.kind && a.id === b.id;
    case 'file': return a.name === b.name;
    case 'unit': return true;
    // A record is equal when it has the same labels and equal values under
    // each. Field order is not part of a record, so compare by label.
    case 'record': {
      const ka = Object.keys(a.fields || {}), kb = Object.keys(b.fields || {});
      if (ka.length !== kb.length) return false;
      return ka.every((k) => k in (b.fields || {}) && valuesEqual(a.fields[k], b.fields[k]));
    }
    // A ref is equal to itself and to nothing else. Two cells holding the same
    // value are two cells: that is the whole point of having a cell, and it is
    // what Standard ML compares. `cell` is the identity.
    case 'ref': return a.cell === b.cell;
    default: return false;
  }
}

// Standard ML restricts `=` to EQUALITY TYPES, and a function is not one: `f = g`
// there is a type error, not a false. This build cannot say so in the type
// system, because the checker reports and does not refuse, so it says so at the
// point of comparison instead. Answering `false` when a function is compared
// with itself is the worse outcome, because nothing tells you it happened.
function equalityChecked(v, other) {
  for (const x of [v, other]) {
    if (x && (x.tag === 'fn' || x.tag === 'closure' || x.tag === 'builtin')) {
      throw new RonmlError('functions cannot be compared — there is no equality on functions');
    }
  }
}

// Evaluate an infix operator. Arithmetic and comparison want two numbers; `^`
// concatenates any two values as text; `==`/`!=` work on any pair.
function applyBinOp(op, l, r) {
  if (op === 'CARET') return { tag: 'str', v: formatValue(l) + formatValue(r) };
  if (op === 'EQEQ') { equalityChecked(l, r); return { tag: 'bool', v: valuesEqual(l, r) }; }
  if (op === 'NE') { equalityChecked(l, r); return { tag: 'bool', v: !valuesEqual(l, r) }; }

  // int and real are separate types now, as they are in ML, and the operators
  // divide along the same line: div and mod are whole-number, / is not. There
  // is no coercion between them; `real` and `floor` convert on request.
  const isInt = (x) => x && x.tag === 'int';
  const isReal = (x) => x && x.tag === 'real';
  const numeric = (x) => isInt(x) || isReal(x);
  const need = (x) => {
    if (!numeric(x)) throw new RonmlError(`${describeValue(x)} is not a number — arithmetic and comparison need numbers`);
    return x.v;
  };
  const a = need(l);
  const b = need(r);
  if (isInt(l) !== isInt(r)) {
    throw new RonmlError(`${describeValue(l)} and ${describeValue(r)} are not the same kind of number — use real n or floor x`);
  }
  const tag = isReal(l) ? 'real' : 'int';

  switch (op) {
    case 'PLUS': return { tag, v: a + b };
    case 'MINUS': return { tag, v: a - b };
    case 'STAR': return { tag, v: a * b };
    case 'SLASH':
      if (tag !== 'real') throw new RonmlError('/ divides reals. For whole numbers use div');
      if (b === 0) throw new RonmlError('division by zero');
      return { tag: 'real', v: a / b };
    case 'MOD':
      if (tag !== 'int') throw new RonmlError('mod is for whole numbers');
      if (b === 0) throw new RonmlError('mod by zero');
      return { tag: 'int', v: ((a % b) + b) % b };
    case 'DIV':
      if (tag !== 'int') throw new RonmlError('div is for whole numbers. For reals use /');
      if (b === 0) throw new RonmlError('div by zero');
      return { tag: 'int', v: Math.floor(a / b) };
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
    case 'Lit': return { tag: node.real ? 'real' : 'int', v: node.value };
    case 'CharLit': return { tag: 'char', v: node.value };
    case 'Neg': {
      const x = evalNode(node.arg, env, ctx, builtins);
      if (!x || (x.tag !== 'int' && x.tag !== 'real')) throw new RonmlError(`${describeValue(x)} is not a number`);
      return { tag: x.tag, v: -x.v };
    }
    case 'StrLit': return { tag: 'str', v: node.value };
    case 'Lam': return { tag: 'closure', param: node.param, body: node.body, env, ctx, builtins };
    case 'Bin': return applyBinOp(node.op, evalNode(node.left, env, ctx, builtins), evalNode(node.right, env, ctx, builtins));
    // Cons builds a list by putting one value on the front of another list,
    // which is the definition rather than a convenience: Harper (1993, p.9)
    // gives the empty list and cons as the two cases a list can be.
    case 'Append': {
      const a = evalNode(node.left, env, ctx, builtins);
      const b = evalNode(node.right, env, ctx, builtins);
      if (!a || a.tag !== 'list') throw new RonmlError(`${describeValue(a)} is not a list — @ joins two lists`);
      if (!b || b.tag !== 'list') throw new RonmlError(`${describeValue(b)} is not a list — @ joins two lists`);
      return { tag: 'list', items: [...a.items, ...b.items] };
    }
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
    case 'Unit': return { tag: 'unit' };
    case 'Deref': {
      const r = evalNode(node.arg, env, ctx, builtins);
      if (!r || r.tag !== 'ref') throw new RonmlError(`${describeValue(r)} is not a ref`);
      return r.cell.v;
    }
    case 'Assign': {
      const r = evalNode(node.target, env, ctx, builtins);
      if (!r || r.tag !== 'ref') throw new RonmlError(`${describeValue(r)} is not a ref`);
      r.cell.v = evalNode(node.value, env, ctx, builtins);
      return { tag: 'unit' };
    }
    case 'Annot': return evalNode(node.expr, env, ctx, builtins);
    case 'Tuple': return { tag: 'tuple', items: node.items.map((it) => evalNode(it, env, ctx, builtins)) };
    case 'Record': {
      const fields = {};
      for (const f of node.fields) fields[f.label] = evalNode(f.value, env, ctx, builtins);
      return { tag: 'record', fields };
    }
    // #label and #1 are functions, not syntax, so they may be passed around:
    // `map #name people` works because #name is a value like any other.
    case 'Select': return { tag: 'select', label: node.label };

    // Declaring a datatype puts its constructors where names are looked up.
    // A nullary one IS a value; one that takes arguments is a function that
    // collects them and then is a value. Nothing is checked, because there is
    // nothing here to check with.
    case 'TypeAbbrev': return { tag: 'typename', name: node.name };

    // An exception is a constructor that can be raised. Declaring one puts it
    // where names are looked up, exactly like a datatype's constructors.
    case 'ExnDecl': {
      const store = (ctx && ctx.session) || {};
      const reg = (store.__cons = store.__cons || {});
      reg[node.name] = { name: node.name, arity: node.arity, of: 'exn' };
      (store.__exn = store.__exn || {})[node.name] = true;
      store[node.name.toLowerCase()] = node.arity === 0
        ? { tag: 'con', name: node.name, args: [] }
        : { tag: 'confn', name: node.name, arity: node.arity, args: [] };
      return { tag: 'exndecl', name: node.name };
    }

    case 'Raise': {
      const v = evalNode(node.arg, env, ctx, builtins);
      throw new RonmlRaise(v);
    }

    case 'Handle': {
      try {
        return evalNode(node.body, env, ctx, builtins);
      } catch (e) {
        if (!(e instanceof RonmlRaise)) throw e;
        for (const arm of node.arms) {
          const binds = matchPattern(arm.pat, e.value, ctx);
          if (!binds) continue;
          const scope = Object.create(env);
          for (const k of Object.keys(binds)) scope[k.toLowerCase()] = binds[k];
          return evalNode(arm.body, scope, ctx, builtins);
        }
        throw e;                 // not ours: let it keep going up
      }
    }

    // A structure's declarations run in a scope of their own and are then
    // published. Pulled out because local, functor and structure all do it.
    case 'Local': {
      const store = (ctx && ctx.session) || {};
      const inner = Object.create(env);
      for (const d of node.hidden) evalNode(d, inner, { ...ctx, session: inner }, builtins);
      const names = [];
      for (const d of node.shown) {
        evalNode(d, inner, { ...ctx, session: inner }, builtins);
        if (d.name) { store[d.name.toLowerCase()] = inner[d.name.toLowerCase()]; names.push(d.name); }
      }
      return { tag: 'struct', name: 'local', names };
    }

    case 'FunctorDecl': {
      const store = (ctx && ctx.session) || {};
      (store.__functors = store.__functors || {})[node.name] = { param: node.param, decls: node.decls };
      return { tag: 'functor', name: node.name, param: node.param };
    }

    case 'StructApply': {
      const store = (ctx && ctx.session) || {};
      const f = (store.__functors || {})[node.functor];
      if (!f) throw new RonmlError(`${node.functor} is not a functor`);
      const inner = Object.create(env);
      // The argument's names are visible inside the body both bare and under
      // the parameter's name, so `X.size` and `size` both find it.
      const prefix = `${String(node.arg || '').toLowerCase()}.`;
      for (const k of Object.keys(store)) {
        if (!k.startsWith(prefix)) continue;
        const bare = k.slice(prefix.length);
        inner[bare] = store[k];
        inner[`${f.param.toLowerCase()}.${bare}`] = store[k];
      }
      for (const d of f.decls) evalNode(d, inner, { ...ctx, session: inner }, builtins);
      const allowed = node.ascribe ? ((store.__sigs || {})[node.ascribe] || null) : null;
      const published = [];
      for (const k of Object.keys(inner)) {
        if (k.startsWith('__') || k.includes('.')) continue;
        if (allowed && !allowed.some((n) => n.toLowerCase() === k)) continue;
        store[`${node.name.toLowerCase()}.${k}`] = inner[k];
        published.push(k);
      }
      return { tag: 'struct', name: node.name, names: published };
    }

    // Fixity is applied at parse time; this persists it so the NEXT line parsed
    // in this session sees it too.
    // A chain of simultaneous declarations. Evaluated in order into the same
    // environment, which is what makes `fun ev … and od …` mutually recursive:
    // both land in the session before either is called.
    case 'Decls': {
      let last = { tag: 'unit' };
      for (const d of node.items) last = evalNode(d, env, ctx, builtins);
      return last;
    }

    case 'FixityDecl': {
      const store = (ctx && ctx.session) || {};
      const tbl = (store.__fixity = store.__fixity || defaultFixity());
      for (const n of node.names) {
        if (node.word === 'nonfix') delete tbl[n];
        else tbl[n] = [node.prec, node.assoc];
      }
      return { tag: 'unit' };
    }

    case 'SigDecl': {
      const store = (ctx && ctx.session) || {};
      (store.__sigs = store.__sigs || {})[node.name] = node.names;
      return { tag: 'sig', name: node.name, names: node.names };
    }

    // `signature B = A where type … = …`: B inherits A's public names. The
    // where-type refinement is a no-op here, since signatures track names and
    // not types.
    case 'SigAbbrev': {
      const store = (ctx && ctx.session) || {};
      const names = (store.__sigs || {})[node.from];
      if (!names) throw new RonmlError(`no signature ${node.from} to name`);
      (store.__sigs = store.__sigs || {})[node.name] = names;
      return { tag: 'sig', name: node.name, names };
    }

    // A structure runs its declarations in a scope of their own and then
    // publishes them under a prefix, so `Board.size` finds what `size` became.
    // `:>` publishes only the names the signature lists, which is the real work
    // a signature does even without a checker behind it: everything else stays
    // inside, and a caller reaching for it does not find it.
    case 'StructDecl': {
      const store = (ctx && ctx.session) || {};
      const inner = Object.create(env);
      for (const d of node.decls) evalNode(d, inner, { ...ctx, session: inner }, builtins);
      const allowed = node.ascribe ? ((store.__sigs || {})[node.ascribe] || null) : null;
      const published = [];
      for (const k of Object.keys(inner)) {
        if (k.startsWith('__')) continue;
        const bare = k;
        if (allowed && !allowed.some((n) => n.toLowerCase() === bare)) continue;
        store[`${node.name.toLowerCase()}.${bare}`] = inner[k];
        published.push(bare);
      }
      // Constructors declared inside are visible through the prefix too.
      const icons = inner.__cons || {};
      const reg = (store.__cons = store.__cons || {});
      for (const c of Object.keys(icons)) reg[c] = icons[c];
      return { tag: 'struct', name: node.name, names: published };
    }

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
    case 'LetPat': {
      const v = evalNode(node.value, env, ctx, builtins);
      const binds = matchPattern(node.pat, v, ctx);
      if (!binds) throw new RonmlError(`this binding does not fit ${describeValue(v)}`);
      const env2 = Object.create(env);
      for (const k of Object.keys(binds)) env2[k.toLowerCase()] = binds[k];
      return evalNode(node.body, env2, ctx, builtins);
    }
    case 'TopLetPat': {
      const v = evalNode(node.value, env, ctx, builtins);
      const binds = matchPattern(node.pat, v, ctx);
      if (!binds) throw new RonmlError(`this binding does not fit ${describeValue(v)}`);
      const names = Object.keys(binds);
      for (const k of names) env[k.toLowerCase()] = binds[k];
      // Echo every name it bound, the way the top level echoes one.
      return { tag: 'bindings', names, values: names.map((k) => binds[k]) };
    }
    case 'App': {
      const fn = evalNode(node.fn, env, ctx, builtins);
      const arg = evalNode(node.arg, env, ctx, builtins);
      // The closure case is inlined rather than going through applyValue,
      // because it is the hot path of every recursive program and the host
      // frame it saves is the difference between a deep continuation-passing
      // program running and exhausting the host stack. Harper's N-queens in
      // continuation-passing style sits close enough to that line to notice.
      if (fn && fn.tag === 'closure') {
        const env2 = Object.create(fn.env);
        env2[fn.param.toLowerCase()] = arg;
        return evalNode(fn.body, env2, fn.ctx, fn.builtins);
      }
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
    case 'unit': return v && v.tag === 'unit' ? {} : null;
    case 'num': return v && (v.tag === 'int' || v.tag === 'real') && v.v === pat.v ? {} : null;
    case 'char': return v && v.tag === 'char' && v.v === pat.v ? {} : null;
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
    case 'as': {
      const m = matchPattern(pat.pat, v, ctx);
      return m ? { ...m, [pat.name]: v } : null;
    }
    // An annotation is the checker's business, not the matcher's.
    case 'ann': return matchPattern(pat.pat, v, ctx);
    case 'record': {
      if (!v || v.tag !== 'record') return null;
      const out = {};
      for (const f of pat.fields) {
        if (!Object.prototype.hasOwnProperty.call(v.fields, f.label)) return null;
        const m = matchPattern(f.pat, v.fields[f.label], ctx);
        if (!m) return null;
        Object.assign(out, m);
      }
      // Without `...` the pattern must account for every field, as in ML.
      if (!pat.open && Object.keys(v.fields).length !== pat.fields.length) return null;
      return out;
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

// TYPE ANNOTATIONS, AND WHAT THIS MACHINE DOES WITH THEM.
//
// Standard ML checks an annotation before anything runs. This build cannot:
// inference is a whole-program analysis and a console has one line at a time,
// with the next not yet written. The tempting shortcut is to parse annotations
// and throw them away, so a file copied out of a manual runs. That is worse
// than refusing them, because `val x : int = "hello"` would then be accepted
// and hand you a string: the annotation would say something the machine had no
// intention of honouring.
//
// So they are honoured, LATE. The annotation is checked when the value arrives
// rather than before the program runs, which is the actual difference between a
// compiler and a console, and is worth a player knowing. A type this build has
// no opinion about (a function type, a type variable, a datatype you declared)
// is carried and not checked, which is stated rather than hidden.
const TYPE_TAGS = {
  int: 'num', real: 'num', word: 'num',
  string: 'str', char: 'str',
  bool: 'bool', unit: 'unit', list: 'list',
};

function checkType(ann, v, what) {
  if (!ann) return v;
  const want = TYPE_TAGS[ann.toLowerCase()];
  if (!want) return v;                       // nothing this build can judge
  if (!v || v.tag !== want) {
    throw new RonmlError(`${what} is annotated ${ann} but the value is ${describeValue(v)}`);
  }
  return v;
}

function describeValue(v) {
  if (!v) return 'nothing';
  switch (v.tag) {
    case 'unit': return '()';
    case 'int': return `the whole number ${v.v}`;
    case 'real': return `the real ${v.v}`;
    case 'char': return `the character ${v.v}`;
    case 'bool': return v.v ? 'true' : 'false';
    case 'node': return `node ${v.id}`;
    case 'key': return v.kind === 'aikey' ? 'the AI key' : 'a key';
    case 'file': return `the file ${v.name}`;
    case 'list': return 'a list';
    case 'tuple': return `a tuple of ${v.items.length}`;
    case 'record': return `a record of {${Object.keys(v.fields).join(', ')}}`;
    case 'select': return `#${v.label}`;
    case 'con': return `${v.name}`;
    case 'confn': return `${v.name} (needs ${v.arity - v.args.length} more)`;
    case 'datatype': return `the type ${v.name}`;
    case 'functor': return `the functor ${v.name}`;
    case 'binding': return `the binding ${v.name}`;
    case 'bindings': return `${v.names.length} bindings`;
    case 'fn': return `${v.name} (needs ${v.builtin.arity - v.args.length} more arg${v.builtin.arity - v.args.length === 1 ? '' : 's'})`;
    default: return 'that';
  }
}

function formatValue(v) {
  if (!v) return '()';
  switch (v.tag) {
    case 'unit': return '()';
    case 'int': return String(v.v);
    case 'real': return Number.isInteger(v.v) ? `${v.v}.0` : String(v.v);
    case 'char': return v.v;
    case 'bool': return v.v ? 'true' : 'false';
    case 'str': return v.v;
    case 'node': return v.id;
    case 'key': return v.kind === 'aikey' ? (v.enc === false ? 'AIKEY:open' : 'AIKEY:sealed') : `KEY:${v.id}`;
    case 'file': return v.name;
    case 'list': return '[' + v.items.map(formatValue).join(', ') + ']';
    case 'tuple': return '(' + v.items.map(formatValue).join(', ') + ')';
    case 'record': return '{' + Object.keys(v.fields).map((k) => `${k} = ${formatValue(v.fields[k])}`).join(', ') + '}';
    case 'select': return `#${v.label}`;
    // A constructor's arguments are parenthesised when they are themselves
    // constructors carrying something, or `Plus (Chr "a") (Chr "b")` prints as
    // `Plus Chr a Chr b`, which reads as four arguments and is not what it is.
    case 'ref': return `ref ${formatValue(v.cell.v)}`;
    case 'con': {
      if (!v.args || !v.args.length) return v.name;
      const arg = (a) => (a && a.tag === 'con' && a.args && a.args.length ? `(${formatValue(a)})` : formatValue(a));
      return `${v.name} ${v.args.map(arg).join(' ')}`;
    }
    case 'confn': return `<${v.name}>`;
    case 'datatype': return `datatype ${v.name} = ${v.cons.join(' | ')}`;
    case 'typename': return `type ${v.name}`;
    case 'exndecl': return `exception ${v.name}`;
    case 'sig': return `signature ${v.name} = sig ${v.names.join(' ')} end`;
    case 'struct': return `structure ${v.name} : ${v.names.length} name(s)`;
    case 'functor': return `functor ${v.name} (${v.param})`;
    case 'binding': return `val ${v.name} = ${formatValue(v.value)}`;
    case 'bindings': return v.names.map((n, i) => `val ${n} = ${formatValue(v.values[i])}`).join('\n');
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
  if (t.t === 'NUM') return { tag: 'int', v: t.v };
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

// What a program may say about its weapon, alongside what it says about its
// feet. A unit moves and shoots in the same quarter-second, so one intent per
// tick cannot describe it, which is why a program may return a pair.
export const FIRE = ['fire', 'hold', 'reload'];

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

  // A program returns either ONE intent, or a PAIR of what to do with its feet
  // and what to do with its weapon: `[hunt, fire]`. The pair exists because a
  // W-4 moves and shoots in the same tick and a single word cannot say that.
  const raw = String(r.text).trim();
  const pair = raw.match(/^\[\s*([a-z_]+)\s*,\s*([a-z_]+)\s*\]$/i);
  const intent = (pair ? pair[1] : raw).toLowerCase();
  const fire = pair ? pair[2].toLowerCase() : null;
  if (!INTENTS.includes(intent)) {
    return { ok: false, fault: `'${pair ? pair[1] : raw}' is not something this unit can do`, effects };
  }
  if (fire && !FIRE.includes(fire)) {
    return { ok: false, fault: `'${pair[2]}' is not something this unit can do with a weapon`, effects };
  }
  return { ok: true, intent, fire, effects };
}


// WHAT THIS BUILD DOES NOT HAVE, said in words.
//
// A file of Standard ML pasted in here will fail, and it should; the useful
// question is whether it fails in a way that tells you why. "unexpected
// character ':'" is a lexer complaining about the third token of a signature
// block, and it names neither the construct nor the reason. The console's
// stated job is to teach rather than gatekeep, and that has to hold when the
// answer is no.
//
// Pure, ordered most specific first, and returns null when nothing is
// recognised so the parser's own message stands.
const NOT_FITTED = [
  // A test walks this list and asserts every pattern here still FAILS to parse.
  // That is the only thing that has stopped it going stale: it went on refusing
  // modules, exceptions, chars, local and refs after each of them shipped, six
  // times, and every time it fired before the parser and hid the real error.
  // `infix`/`infixr`/`nonfix`/`op` were here until v1.277 added them, and
  // String/List/Int/Option were here until v1.257 added them. Both pruned by
  // the test below, which is the only thing that has ever kept this honest.
  [/\b(Char|Real|Word|Array|Vector|IO|TextIO|OS|Math|Substring|General)\./, 'that library is not on this machine. ml -full lists what is.'],
  [/^\s*(abstype|open)\b/, 'no abstype and no open on this build.'],
];

// The samples the test uses, one per rule above, in the same order.
export const NOT_FITTED_SAMPLES = ['Char.ord c', 'open List'];

export function diagnose(src) {
  for (const [re, why] of NOT_FITTED) if (re.test(src)) return why;
  return null;
}

// Split a program file into the logical lines the parser expects, KEEPING the
// physical line each one started on, so an error can say where. See
// joinProgramLines for the joining rules; this is the same function with the
// numbers left in.
// Parse one line to an AST without evaluating it. Exists so the type checker
// can look at what you wrote before the machine does anything about it.
export function parseLine(source, fixity) {
  return parse(tokenize(String(source)), fixity);
}

// What the type checker makes of a line, as a string to print beside the
// answer. Never throws and never refuses: inference here REPORTS. A machine in
// a name it has never seen is "anything" rather than an error.
// THE LIBRARY, written in the language it is for.
//
// It is loaded as source rather than built as JavaScript builtins, so `List.map`
// is the same map a player would write and can be read with the same eyes. The
// structures are the ones the manuals name, minus everything this build has no
// way to do.
export const PRELUDE = [
  "datatype 'a option = NONE | SOME of 'a",
  '',
  'structure List = struct',
  '  fun null nil = true | null _ = false',
  '  fun map f nil = nil | map f (h :: t) = f h :: map f t',
  '  fun filter p nil = nil',
  '    | filter p (h :: t) = if p h then h :: filter p t else filter p t',
  '  fun foldl f b nil = b | foldl f b (h :: t) = foldl f (f h b) t',
  '  fun foldr f b nil = b | foldr f b (h :: t) = f h (foldr f b t)',
  '  fun rev l = foldl (fn h => fn a => h :: a) nil l',
  '  fun exists p nil = false | exists p (h :: t) = p h orelse exists p t',
  '  fun all p nil = true | all p (h :: t) = p h andalso all p t',
  '  fun nth (h :: t, n) = if n == 0 then h else nth (t, n - 1)',
  '  fun take (l, n) = if n == 0 then nil else hd l :: take (tl l, n - 1)',
  '  fun drop (l, n) = if n == 0 then l else drop (tl l, n - 1)',
  '  fun concat nil = nil | concat (h :: t) = h @ concat t',
  '  fun tabulate (n, f) = if n == 0 then nil else tabulate (n - 1, f) @ [f (n - 1)]',
  'end',
  '',
  'structure Char = struct',
  '  fun isDigit c = ord c >= 48 andalso ord c <= 57',
  '  fun isUpper c = ord c >= 65 andalso ord c <= 90',
  '  fun isLower c = ord c >= 97 andalso ord c <= 122',
  '  fun isAlpha c = isUpper c orelse isLower c',
  '  fun isSpace c = ord c == 32 orelse ord c == 9 orelse ord c == 10',
  '  fun toUpper c = if isLower c then chr (ord c - 32) else c',
  '  fun toLower c = if isUpper c then chr (ord c + 32) else c',
  'end',
  '',
  'structure String = struct',
  '  fun size s = length (explode s)',
  '  fun sub (s, n) = List.nth (explode s, n)',
  '  fun map f s = implode (List.map f (explode s))',
  '  fun rev s = implode (List.rev (explode s))',
  '  fun concat nil = "" | concat (h :: t) = h ^ concat t',
  '  fun isPrefix (p, s) = List.take (explode s, size p) == explode p',
  'end',
  '',
  'structure Int = struct',
  '  fun abs n = if n < 0 then 0 - n else n',
  '  fun min (a, b) = if a < b then a else b',
  '  fun max (a, b) = if a > b then a else b',
  '  fun toString n = "" ^ n',
  'end',
  '',
  'structure Option = struct',
  '  fun isSome NONE = false | isSome (SOME _) = true',
  '  fun valOf (SOME x) = x',
  '  fun getOpt (NONE, d) = d | getOpt (SOME x, _) = x',
  '  fun map f NONE = NONE | map f (SOME x) = SOME (f x)',
  'end',
].join('\n');

// Load it into a session. Cheap enough to do on the first line typed, and
// skipped afterwards.
export function loadPrelude(ctx) {
  const sess = (ctx && ctx.session) || {};
  if (sess.__prelude) return;
  sess.__prelude = true;
  for (const line of joinProgramLines(PRELUDE)) {
    try { runRonml(line, ctx); } catch { /* a prelude line that fails is a bug, not a player error */ }
  }
}

export function typeReport(source, ctx) {
  if (!ctx || !ctx.types) return null;
  try {
    const ast = parseLine(source);
    const r = typeOf(ast, ctx.session || {});
    if (!r.ok) return r.error ? `TYPE: ${r.error}` : null;
    remember(ast, ctx.session || {}, r.t);
    // A warning rides alongside the type rather than replacing it: the line is
    // well typed and also has a hole in it, and you want to be told both.
    if (r.warnings && r.warnings.length) return `${r.type}    WARNING: ${r.warnings.join('; ')}`;
    return r.type;
  } catch {
    return null;         // unparseable is the parser's business, not this one's
  }
}

// ---- what this build of the language is ------------------------------------
//
// The language has its own version now, separate from the game's. It grew by
// accretion for two hundred versions and then by measurement against somebody
// else's corpus, and a reader who pastes a program in deserves to know which
// build refused it. `ml -ver` prints the line; `ml -full` prints the survey.
export const AIML_VERSION = '1.9';
export const AIML_NAME = 'AI-ML';

// THE CREDIT. One list, printed by -ver and again at the foot of -full, so the
// two can never drift apart. Also shown in the game's About box.
export const AIML_CREDIT = [
  'AI-ML created by David M. Berry, 2026.',
  'Based on Standard ML developed by Robin Milner, Mads Tofte, and',
  'Robert Harper. Many thanks to Robert Harper for the inspiration in',
  'his book "Introduction to Standard ML" (1986), and to \u00c5ke Wikstr\u00f6m for',
  '"Functional Programming Using Standard ML" (1987).',
];

export function aimlVersion() {
  return [
    `${AIML_NAME} ${AIML_VERSION}  (RON build)`,
    'A descendant of Standard ML. Type inference, modules, exceptions.',
    'ml -full  for full details about this implementation.',
    '',
    ...AIML_CREDIT,
  ].join('\n');
}

// The survey: what is here, what is not, and what is here but spelled
// differently. Enough to tell whether a given program will run.
export function aimlFull() {
  const L = [];
  const sec = (t) => { L.push('', t, '='.repeat(t.length)); };
  const row = (a, b) => L.push(`  ${a.padEnd(26)}${b}`);

  L.push(`${AIML_NAME} ${AIML_VERSION}  (RON build)`);
  L.push('The language on the obelisk consoles, the HERMES relays, this laptop,');
  L.push('and inside every machine that runs a program you can read.');

  sec('VALUES');
  row('int', '4, ~3. div and mod are whole-number.');
  row('real', '3.5, 2.0. / divides these and not ints.');
  row('', 'real n and floor x go between them.');
  row('char', '#"a". ord chr str explode implode.');
  row('str', '"a string". ^ joins two.');
  row('bool', 'true false. and or not, andalso orelse.');
  row('unit', '()');
  row('tuple', '(1, "a"). Fixed width, mixed kinds.');
  row('record', '{ a = 1, b = 2 }. #a selects. #1 works on a tuple.');
  row('list', 'nil, ::, [1,2,3], @ joins. hd tl length.');
  row('ref', 'ref 0, !r reads, r := v writes. The only mutable thing.');

  sec('BINDING AND FUNCTIONS');
  row('let / val / fun', 'three words, one thing.');
  row('let ... in ... end', 'several bindings, and joins them.');
  row('fn x => e', 'lambda. fn takes alternatives too.');
  row('let f x y = e', 'curried. Partial application gives a function.');
  row('clausal definitions', 'fun f nil = 0 | f (h::t) = 1 + f t');
  row('pattern bindings', 'let (m, n) = e, and in parameters.');
  row('recursion', 'a name is in scope inside its own value.');

  sec('TAKING THINGS APART');
  row('case e of p => e', 'first arm that fits wins.');
  row('patterns', 'constructor, variable, _, constant, nil, ::,');
  L.push('                            tuple, record, { ... }, as.');
  row('datatype', "datatype 'a option = NONE | SOME of 'a");

  sec('THE LARGER STRUCTURES');
  row('structure / struct', 'publishes its names under a prefix: Board.size');
  row('signature / sig', 'names what a structure shows.');
  row(':>  opaque ascription', 'hides everything the signature omits.');
  row('exception / raise', 'exception Fail; raise Fail');
  row('handle', 'e handle Fail => e, with full pattern arms.');
  row('type', 'type board = int * int. An abbreviation.');
  row('local ... in ... end', 'declarations in scope for the block only.');
  row('functor F (X) = ...', 'a structure taking a structure. F (A) applies it.');

  sec('TYPES');
  row('inference', 'Hindley-Milner. Runs on this laptop only.');
  row('', 'map : (\'a -> \'b) -> \'a list -> \'b list');
  row('annotations', 'val x : int = 5. Checked, not decoration.');
  row('on a clash', 'names it, then runs the line anyway.');

  sec('THE LIBRARY');
  row('List', 'map filter foldl foldr rev exists all nth take');
  L.push('                            drop concat tabulate null');
  row('String', 'size sub map rev concat isPrefix');
  row('Char', 'isDigit isAlpha isUpper isLower isSpace toUpper');
  L.push('                            toLower');
  row('Int', 'abs min max toString');
  row('Option', "datatype 'a option, isSome valOf getOpt map");
  row('bare verbs', 'hd tl length abs sqrt min max size real floor');
  L.push('                            ord chr str explode implode ref echo');
  L.push('');
  L.push('  It is written in AI-ML, not underneath it. `ml -src List` prints it.');

  sec('NOT ON THIS BUILD');
  row('infix declarations', 'no infix, no op.');
  row('the rest of the library', 'no Array, Vector, IO, Real beyond sqrt.');

  sec('WRITTEN DIFFERENTLY');
  row('==  and  =', 'both are equality. A binding eats its = first.');
  row('(* comments *)', 'as in ML.');
  row('echo', 'prints. ; sequences.');
  row('|>', 'pipes a value into a function.');

  sec('WHERE IT RUNS');
  row('obelisk console', 'the tower verbs, and the language.');
  row('HERMES relay', "RON's own, plus the forge.");
  row('this laptop', 'the language alone, and the type checker.');
  row('inside a machine', 'its own program, 2,000 steps, four times a second.');
  L.push('');
  L.push('  A machine answers with an intent, or a pair: [hunt, fire].');
  L.push('  feet: patrol hunt flee home tend wait   weapon: fire hold reload');
  L.push('  senses: charge integrity range home_range threat hurt linked');
  L.push('          blight daylight sight armed shielded contact lost_for');
  L.push('');
  sec('WHAT THE CHECKER DOES');
  L.push('  Hindley-Milner inference: unification, occurs check, let-polymorphism,');
  L.push('  and the value restriction (an application does not generalise).');
  L.push('  It reports and does not refuse: a clash names itself and the line');
  L.push('  still runs. A `case` that misses a constructor is a WARNING beside');
  L.push('  the type, which is the one worth having before you post a program.');
  L.push('  Equality is structural on records and lists, by identity on refs,');
  L.push('  and refused on functions.');
  L.push('');
  L.push('  On THIS machine only: `units` is what the wireless card can hear —');
  L.push('  a list of records with name, range, bearing and kind. See sniffer.ml.');
  sec('CREDITS');
  for (const l of AIML_CREDIT) L.push(`  ${l}`);

  return L.join('\n');
}

export function joinProgram(text) {
  const out = [];
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    let line = raw.replace(/\(\*.*?\*\)/g, '').replace(/\s+$/, '');
    if (!line.trim()) continue;
    if (/^>/.test(line)) continue;
    line = line.replace(/^(\s*)-\s+(?=[A-Za-z(\[])/, '$1');
    const continues = /^\s/.test(raw) || /^\s*(\||=>|::|@|\)|and\b|in\b|end\b|else\b|then\b)/.test(line);
    if (continues && out.length) out[out.length - 1].text += ` ${line.trim()}`;
    else out.push({ text: line.trim(), line: i + 1 });
  }
  return out;
}

// Join the physical lines of a program file into the logical ones the parser
// expects. A line continues the previous one when it is indented or opens with
// an operator that cannot start a declaration — which is how ML is written, and
// how every worked example in every manual is laid out. Without this, a file
// could only hold one-liners, and every multi-line function in the demos and in
// Harper's corpus failed on its second line.
export function joinProgramLines(text) {
  return joinProgram(text).map((l) => l.text);
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
    // The session's fixity table, so `infix 8 OR` on an earlier line changes how
    // this one reads.
    const ast = parse(toks, (ctx && ctx.session && ctx.session.__fixity) || undefined);
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
    // If the line is a piece of Standard ML this build does not have, say
    // which piece. The parser's own message names the character it choked
    // on, which for a signature block is a colon, and that helps nobody.
    if (e instanceof RonmlRaise) {
      return { ok: false, text: `ERR: uncaught exception ${formatValue(e.value)}` };
    }
    // A JavaScript stack overflow means one thing here: a program that recursed
    // without ever coming back. The step budget is supposed to catch that first,
    // but the two are in a race — a deeply nested (non-tail) recursion uses
    // several host frames per AI-ML step, so on a small stack the host loses.
    // Report it as what it is rather than leaking the engine's own words, and
    // the fault a machine shows is the same either way.
    if (e instanceof RangeError && /call stack/i.test(e.message || '')) {
      return { ok: false, text: 'ERR: step budget exceeded — this recursion never comes back' };
    }
    const why = diagnose(source);
    if (why) return { ok: false, text: `ERR: ${why}` };
    if (e instanceof RonmlError) return { ok: false, text: `ERR: ${e.message}` };
    return { ok: false, text: `ERR: ${e.message || 'malformed command'}` };
  }
}
