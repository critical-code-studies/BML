// THE PARSER. Tokens to an abstract syntax tree.
//
// Part of src/lang/, the language proper: nothing here knows about NostOS, its
// terminals, or its robots. See docs/aiml-standalone-plan.md.
//
// Moved out of src/game/ai_ml.js unchanged at v1.286 (M1), together with the
// fixity table it carries, parseLine, and the program joiner. The only edits
// were the imports below and the export keywords.

import { RonmlError } from './errors.js';
import { nameKey } from './names.js';
import { tokenize } from './lex.js';

// ---- Parser: expr -> tiny AST (Let, App, Var, Lit, ListLit) -----------

// Every word that can BEGIN a declaration, and the words that close a block.
// Three parsers need them, and each had written its own answer or none at all.
//
// The shared problem is a loop that consumes identifiers until it runs out.
// `skipTypeExpr` skips a type rather than parsing one; `open A B C` and
// `infix 6 f g` both take a list of names. A word missing from the stop list
// is not reported, it is EATEN — so at v1.302:
//
//   abstype q = T of int with fun mk n = T n end   the `with` went into the
//                                                  type, the with-block was
//                                                  never parsed
//   struct open List val v = 1 end                 `open` took `List val v`
//                                                  as three structure names
//   struct infix 6 pl val v = 1 end                `infix` took `pl val v` as
//                                                  three operators, so `v` was
//                                                  never declared
//
// The abstype case had a test and passed it, because the test wrote
// `abstype ab = A with …` — no payload, so no type to skip. The payload is the
// reason to write `abstype` at all.
//
// One list, three uses, and a test that walks every word in it.
export const DECL_KEYWORDS = [
  'val', 'fun', 'type', 'datatype', 'abstype', 'exception', 'structure',
  'signature', 'functor', 'local', 'open', 'infix', 'infixr', 'nonfix',
  'withtype',
];
// A type or a name list can also be the last thing before one of these.
export const BLOCK_ENDERS = ['with', 'end', 'in', 'and'];
const STOPS = [...DECL_KEYWORDS, ...BLOCK_ENDERS];
const isStop = (t) => t && t.t === 'IDENT' && STOPS.includes(nameKey(t.v));

function isKeyword(tok, word) {
  // `val` is Standard ML's word for a value binding. Accepted as a synonym for
  // `let` so that a line copied out of a manual binds rather than complains.
  if (word === 'let' && tok && tok.t === 'IDENT' && ['val', 'fun'].includes(nameKey(tok.v))) return true;
  return tok.t === 'IDENT' && nameKey(tok.v) === word;
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

export function parse(toks, fixityIn) {
  let p = 0;
  // The parser's own copy: `infix` inside a block must not leak out to the
  // caller's session until the declaration is actually evaluated.
  const fixity = { ...(fixityIn || defaultFixity()) };
  let inBlock = 0;      // >0 while inside local/struct: `in` and `end` are the block's
  // >0 while inside `( … )` or a `let … in HERE end` body — the two places a
  // `;` SEQUENCES EXPRESSIONS. At the top level it means something else: it
  // separates and terminates DECLARATIONS, and the one `;` loop this parser has
  // was running everywhere, so `val p = 1; val q = 2` read the `;` as a
  // sequence, took `val q` for an expression and asked for the `in` that a
  // `let` would need.
  let seqDepth = 0;
  const inSeq = (f) => { seqDepth++; try { return f(); } finally { seqDepth--; } };
  // A `;` BETWEEN DECLARATIONS in a block body — `struct val a = 1; val b = 2
  // end`, and the same inside `local` and an abstype with-block. Standard ML
  // allows it and the corpus writes it; these loops read one declaration after
  // another and had nowhere for the token to go, so it reported as unexpected.
  // The top level takes the same view (see the end of parse); this is that rule
  // one level down.
  const eatDeclSemis = () => { while (peek().t === 'SEMI') p++; };
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
    // `fn x : real => …` — an annotated parameter, written without brackets.
    // parsePatternAnn keeps the annotation so the checker still sees the claim;
    // `fn (x : real) => …` is the same thing and already worked.
    const first = parsePatternAnn();
    if (peek().t !== 'ARROW') throw new RonmlError("expected '=>' after fn's parameter — try: fn x => x");
    p++;
    // A `|` after the body is AMBIGUOUS. In
    // `fun sa nil = fn l => l | sa (h::t) = …` it could extend this fn's match
    // or start the next CLAUSE of sa, and this always took the first reading,
    // so the clause after it was read as a pattern and then reported for
    // having `=` where `=>` was wanted.
    //
    // What closes the pattern tells them apart: a fn arm ends in `=>`, a fun
    // clause in `=`. So look ahead for whichever comes first outside brackets.
    // Undecidable cases keep the old reading, which is the common one.
    const barStartsAnArm = () => {
      let d = 0;
      for (let q = p + 1; toks[q]; q++) {
        const t = toks[q].t;
        if (t === 'LP' || t === 'LB' || t === 'LC') { d++; continue; }
        if (t === 'RP' || t === 'RB' || t === 'RC') { if (d === 0) return true; d--; continue; }
        if (d > 0) continue;
        if (t === 'ARROW') return true;
        if (t === 'EQ') return false;
        if (t === 'SEMI' || t === 'EOF' || t === 'BAR') return true;
      }
      return true;
    };
    const arms = [{ pat: first, body: parseExpr1() }];
    while (peek().t === 'BAR' && barStartsAnArm()) {
      p++;
      const pat = parsePatternAnn();
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
      if (peek().t !== 'IDENT' || nameKey(peek().v) !== nameKey(name)) { p = save; break; }
      p++;
      const ps = letParams();
      const ann = bindAnn();
      if (peek().t !== 'EQ') { p = save; break; }
      p++;
      // The annotation on a clause after `|` constrains that clause's ANSWER,
      // so it wraps the body. The first clause's goes on the whole function,
      // which the caller has already done before handing the body over.
      clauses.push({ params: ps, body: annotBind(parseExpr(), ann, 0) });
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
      const lower = nameKey(par);
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
  // A binding may claim its own type before the `=`: `val n : int = 3`. This is
  // read at the FIRST binding of a run and was read nowhere else, so the second
  // val of a `let`, an `and` continuation and a clause after `|` each refused
  // an annotation the line above accepted.
  function bindAnn() {
    if (peek().t !== 'COLON') return null;
    p++;
    return parseTypeExpr();
  }

  /** Wrap a bound value in its annotation, if it has one. */
  function annotBind(v, ann, nparams) {
    return ann ? { type: 'Annot', expr: v, ann, params: nparams } : v;
  }

  // Step a LOOKAHEAD over an annotation. The two `isBind` probes decide whether
  // an `and` starts a binding by scanning to the `=`; an annotation puts a type
  // in the way, and brackets in the type mean this has to be depth-tracked
  // rather than a scan for the first `=`.
  function skipAnnAhead(q) {
    let d = 0;
    for (; toks[q]; q++) {
      const t = toks[q].t;
      if (t === 'LP' || t === 'LB' || t === 'LC') d++;
      else if (t === 'RP' || t === 'RB' || t === 'RC') { if (d === 0) return q; d--; }
      else if (d === 0 && (t === 'EQ' || t === 'SEMI' || t === 'EOF')) return q;
    }
    return q;
  }

  // Does a binding start at q-1 and reach its `=`? Balanced brackets are stepped
  // over whole and anything inside them is accepted: what is in a pattern is
  // the pattern parser's business, not a lookahead's. Three places ask this and
  // two of them used to carry their own list of permitted tokens, neither of
  // which had a closing bracket in it.
  function inBeforeEnd() {
    for (let q = p; q < toks.length; q++) {
      const t = toks[q];
      if (t.t === 'EOF') return false;
      if (t.t !== 'IDENT') continue;
      const w = nameKey(t.v);
      if (w === 'in') return true;
      if (w === 'structure' || w === 'signature' || w === 'end') return false;
    }
    return false;
  }

  function bindingReachesEq(q) {
    if (!toks[q] || toks[q].t !== 'IDENT') return false;
    let d = 0;
    for (; toks[q]; q++) {
      const t = toks[q].t;
      if (t === 'LP' || t === 'LB' || t === 'LC') { d++; continue; }
      if (t === 'RP' || t === 'RB' || t === 'RC') { if (--d < 0) return false; continue; }
      if (d > 0) continue;
      if (t === 'COLON') { q = skipAnnAhead(q); break; }
      if (t === 'EQ') break;
      if (!['IDENT', 'NUM', 'STR', 'CHAR', 'NEG', 'USCORE'].includes(t)) return false;
    }
    return !!toks[q] && toks[q].t === 'EQ';
  }

  // A binding whose name is written in the position it will be USED in:
  //
  //   fun (f ** g) (x, y) = (f x, g y)     defines **, taking the pair (f, g)
  //   fun (op +) (a, b) = a                defines +, `op` naming it plainly
  //
  // Standard ML reads the left-hand side as a pattern and takes the operator
  // out of it. Returns the name and the parameters that were around it, or null
  // if this is not one of those shapes — in which case nothing is consumed.
  function infixLhs() {
    if (peek().t !== 'LP') return null;
    const save = p;
    p++;
    // `(op +)`, and `op` on any operator this lexer gives a token of its own.
    if (peek().t === 'IDENT' && nameKey(peek().v) === 'op') {
      p++;
      const t = toks[p++];
      const sym = OP_SYM[t.t] || (t.t === 'STAR' ? '*' : null) || (t.t === 'IDENT' ? t.v : null);
      if (sym && peek().t === 'RP') { p++; return { name: sym, params: [] }; }
      p = save; return null;
    }
    // `(f ** g)` — a name either side of an operator.
    if (peek().t === 'IDENT') {
      const left = toks[p++].v;
      const t = toks[p++];
      const sym = OP_SYM[t.t] || (t.t === 'STAR' ? '*' : null)
        || (t.t === 'IDENT' && !/^[A-Za-z_]/.test(t.v) ? t.v : null);
      if (sym && peek().t === 'IDENT') {
        const right = toks[p++].v;
        if (peek().t === 'RP') {
          p++;
          return { name: sym, params: [{ pat: { p: 'tuple', items: [
            { p: 'name', name: left, args: [] }, { p: 'name', name: right, args: [] },
          ] } }] };
        }
      }
    }
    p = save; return null;
  }

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
    // D-20: ANY expression may carry a type annotation, not only one already
    // inside parentheses. `(1 : int)` and `fn (x : int) => x` both worked and
    // `let val x = 1 in x end : int` did not, because the only place a trailing
    // `:` was read was after an open paren. Standard ML puts the annotation at
    // the loosest level, which is here.
    if (peek().t === 'COLON') {
      p++;
      const ann = parseTypeExpr();
      left = { type: 'Annot', expr: left, ann, params: 0 };
    }
    while (seqDepth > 0 && peek().t === 'SEMI') {
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

  // Let an expression that was parsed WHOLE stand as the left operand of an
  // operator. `let … end` is an atom in Standard ML and is read here, above the
  // operator grammar, so `let val m = 3 in m end * 2` stopped at the `end` and
  // reported the `*`.
  function asOperand(node) {
    return opSym() === null ? node : parseInfix(0, node);
  }

  function parseExpr1() {
    if (isKeyword(peek(), 'raise')) { p++; return { type: 'Raise', arg: parseExpr1() }; }
    if (isKeyword(peek(), 'case')) return parseCase();
    if (isKeyword(peek(), 'fn')) return parseLambda();
    if (isKeyword(peek(), 'if')) return parseIf();
    if (isKeyword(peek(), 'while')) return parseWhile();
    if (isKeyword(peek(), 'let')) {
      // `let open List in null [] end`. A `let` may hold a DECLARATION, not only
      // a binding, and `open` is the one anybody writes there. It binds into the
      // ENVIRONMENT rather than the session, so a child scope gives it exactly
      // the reach Standard ML says it has: the body, and no further.
      if (toks[p + 1] && isKeyword(toks[p + 1], 'open')) {
        p++;
        const decl = parseTopOne();
        if (!isKeyword(peek(), 'in')) throw new RonmlError("expected 'in' after the open");
        p++;
        const body = inSeq(parseExpr);
        if (isKeyword(peek(), 'end')) p++;
        return asOperand({ type: 'LetOpen', decl, body });
      }
      // WHICH WORD it was matters and this used to throw it away. In Standard
      // ML `val` takes a PATTERN and `fun` takes a name and its parameters;
      // `val f x = e` is not a thing. Losing the distinction meant
      // `val SOME z = SOME 4` was read as a function called SOME taking z, so
      // z was never bound, the constructor was shadowed, and `SOME 9`
      // afterwards recursed until the step budget ran out. No error anywhere.
      let saidVal = nameKey(peek().v) === 'val';
      p++;
      if (peek().t === 'IDENT' && ['val', 'fun'].includes(nameKey(peek().v))) {
        saidVal = nameKey(peek().v) === 'val';   // `let val …`
        p++;
      }
      // `val rec f = fn …` is how Standard ML writes a recursive VALUE binding,
      // and Harper uses it. `rec` was read as the name being bound, so a
      // variable called rec was created and `f` never bound at all: `f 5`
      // afterwards was an unknown name, and nothing said so. Every binding here
      // is already recursive (see the Let case in eval.js, which puts the name
      // in scope before evaluating the value), so the word is consumed and the
      // behaviour is what it asks for.
      if (peek().t === 'IDENT' && nameKey(peek().v) === 'rec') p++;
      // `let (a, b) = e` and `let [x, y] = e` bind several names at once.
      // Harper introduces this as "the following generalization of a value
      // binding" (1993, p.16), before case, because it is the simpler idea:
      // write down the shape and the parts get names.
      // After `val`, anything that is not `name =` or `name : ty =` is a
      // pattern: `val 0 = 1-1`, `val SOME z = e`, `val h :: t = e`. The bare
      // `let name … = e` the game's terminals use said neither word and is
      // untouched.
      const valTakesPattern = () => {
        if (!saidVal) return false;
        if (peek().t !== 'IDENT') return true;
        const nxt = toks[p + 1];
        return !!nxt && nxt.t !== 'EQ' && nxt.t !== 'COLON';
      };
      // `fun (f ** g) (x, y) = …` and `fun (op +) (a, b) = …`. Tried before the
      // pattern branch below, which sees the `(` and reads the whole left-hand
      // side as something to bind. Never for `val`, which really does take a
      // pattern there.
      const infLhs = saidVal ? null : infixLhs();
      if (!infLhs && (peek().t === 'LP' || peek().t === 'LB' || peek().t === 'LC' || valTakesPattern())) {
        const pat = valTakesPattern() ? parsePattern() : parsePatternAtom();
        eat('EQ');
        const value = parseExpr();
        if (peek().t === 'IDENT' && ['val', 'fun'].includes(nameKey(peek().v)) && inBeforeEnd()) {
          return { type: 'LetPat', pat, value, body: parseExpr1() };
        }
        if (isKeyword(peek(), 'in')) {
          p++;
          const body = inSeq(parseExpr);   // a let body sequences with `;`, as parens do
          // …and its `end`, which the name-binding path already ate. Without
          // this, `let val (d, a, b) = … in … end` parsed to the body and then
          // reported the `end` as unexpected — which reads as a broken `let`
          // rather than a missing two lines here.
          if (isKeyword(peek(), 'end')) p++;
          return asOperand({ type: 'LetPat', pat, value, body });
        }
        return { type: 'TopLetPat', pat, value };
      }
      // `fun (f ** g) (x, y) = …` and `fun (op +) (a, b) = …` name the function
      // where it will be used. Nothing is consumed when it is neither.
      const nameTok = infLhs ? { t: 'IDENT', v: infLhs.name } : eat('IDENT');
      const params = infLhs ? [...infLhs.params, ...letParams()] : letParams();
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
        const isBind = () => bindingReachesEq(p + 1);
        if ((isKeyword(peek(), 'and') && isBind()) || isKeyword(peek(), 'let')) {
          p++;
          const n2 = eat('IDENT');
          const p2 = letParams();
          const a2 = bindAnn();
          eat('EQ');
          const b2 = parseExpr();
          const v2 = clausalRest(n2.v, p2, b2) || wrapParams(p2, b2);
          extra.push({ name: n2.v, value: annotBind(v2, a2, p2.length) });
          continue;
        }
        break;
      }
      if (extra.length) {
        if (!isKeyword(peek(), 'in')) throw new RonmlError("expected 'in' after the bindings");
        p++;
        const body = inSeq(parseExpr);   // a let body sequences with `;`, as parens do
        if (isKeyword(peek(), 'end')) p++;
        // ONE scope for all of them, not a nest of scopes. Nesting made
        // `let fun e … and o2 … in e 4 end` build Let(e, Let(o2, body)), so e's
        // body was closed over an environment o2 was not in yet and mutual
        // recursion inside `let` could not work — which is where Harper writes
        // most of it. Every name goes into the same frame, so each sees the
        // others once they are all there.
        return asOperand({ type: 'LetRec', binds: [{ name: nameTok.v, value }, ...extra], body });
      }
      if (!isKeyword(peek(), 'in')) throw new RonmlError("expected 'in' after let — try: let val x = 1 in x + 1 end");
      p++;
      const body = inSeq(parseExpr);   // a let body sequences with `;`, as parens do
      if (isKeyword(peek(), 'end')) p++;      // SML closes a local block with `end`
      return asOperand({ type: 'Let', name: nameTok.v, value, body });
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
    // `whole as pat` — names the value AND takes it apart. LOOSEST of all the
    // pattern forms in Standard ML, so `w as h :: t` is `w as (h :: t)`: the
    // name is for the whole thing, which is what the word says.
    if (head && head.p === 'name' && !(head.args || []).length
        && peek().t === 'IDENT' && nameKey(peek().v) === 'as') {
      p++;
      return { p: 'as', name: head.name, pat: parsePattern() };
    }
    if (peek().t !== 'CONS') return head;
    p++;
    return { p: 'cons', head, tail: parsePattern() };
  }

  // One pattern in argument position: an atom, but a bare name stays a bare
  // name rather than swallowing what follows it.
  function parsePatternArg() {
    const tok = peek();
    if (tok.t === 'IDENT') {
      const lower = nameKey(tok.v);
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
          const label = peek().t === 'NUM' ? String(eat('NUM').v) : eat('IDENT').v;
          // `{x = x : real}`. A field takes a pattern WITH its annotation, the
          // same as any other pattern position; `parsePattern` alone stops at
          // the colon and the caller then wants the `}`.
          if (peek().t === 'EQ') { p++; fields.push({ label, pat: parsePatternAnn() }); }
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
      const lower = nameKey(v);
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
      // `whole as pattern` is handled by parsePattern, at the TOP of the
      // grammar, because in Standard ML `as` binds LOOSEST of all the pattern
      // forms. It used to be here, at the atom, so `whole as h :: t` read as
      // `(whole as h) :: t` and `whole` named the head instead of the list
      // (D-57). Silent: `case [1,2] of w as h :: _ => w + 1` answered 2.
      const args = [];
      while (peek().t === 'IDENT' || peek().t === 'NUM' || peek().t === 'LP' || peek().t === 'LB') {
        // `as` ends the argument list. Without it here, moving `as` up meant a
        // bare name swallowed the word as though it were another argument.
        if (peek().t === 'IDENT' && ['of', 'case', 'let', 'in', 'if', 'then', 'else', 'fn', 'and', 'or', 'mod', 'as'].includes(nameKey(peek().v))) break;
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
    // The BRANCHES stop below the sequence level. They used to call parseExpr,
    // which reads `;`, so `(if true then 1 else 2; 7)` parsed as
    // `if true then 1 else (2; 7)` and answered 1 where Standard ML answers 7.
    // Silent, and the sort of thing only written inside parentheses, which is
    // where a sequence lives.
    const thenE = parseHandle();
    if (!isKeyword(peek(), 'else')) throw new RonmlError("if needs an 'else' — try: if n == 0 then 1 else 0");
    p++;
    const elseE = parseHandle();
    return { type: 'If', cond, then: thenE, else: elseE };
  }

  // `while c do e`, as an EXPRESSION. It was parsed only at the declaration
  // level, so `(while !i < 3 do i := !i + 1; !i)` — a loop and then its result,
  // which is how anyone writes one — failed on the `do`. The Definition gives
  // `while` as sugar for a recursive function and that is how it is built; this
  // makes it reachable from inside an expression, which is where loops go.
  function parseWhile() {
    p++; // 'while'
    const cond = parseExpr();
    if (!isKeyword(peek(), 'do')) throw new RonmlError("expected 'do' after while's condition");
    p++;
    const body = parseHandle();   // stops below `;`, as if's branches do
    return { type: 'While', cond, body };
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
  function andIsBinding() { return bindingReachesEq(p + 1); }

  // TWO LEVELS, because Standard ML has two: `andalso` binds tighter than
  // `orelse`, so `true orelse true andalso false` is `true orelse (true andalso
  // false)` and answers true. This was one flat loop and therefore purely
  // left-to-right, which read it as `(true orelse true) andalso false` and
  // answered FALSE. A wrong answer with no error, in an operator anyone writing
  // a guard reaches for.
  function parseBool() {
    let left = parseAndalso();
    while (peek().t === 'IDENT' && ['or', 'orelse'].includes(nameKey(peek().v))) {
      p++;
      left = { type: 'Bool', op: 'or', left, right: parseAndalso() };
    }
    return left;
  }

  function parseAndalso() {
    let left = parseCompare();
    // `and` is both boolean conjunction and the separator between simultaneous
    // bindings. Take it as boolean only when what follows is not a binding, or
    // `let a = 1 and b = 2 in …` swallows the second name and then trips on =.
    while (peek().t === 'IDENT' && ['and', 'andalso'].includes(nameKey(peek().v))
      && !(nameKey(peek().v) === 'and' && andIsBinding())) {
      p++;
      left = { type: 'Bool', op: 'and', left, right: parseCompare() };
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
      const w = nameKey(t.v);
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

  // `seed` is an already-parsed left operand. `let … end` is an ATOM in
  // Standard ML, so an operator may follow it — `let val m = 3 in m end * 2`,
  // which two corpus declarations write as ordinary arithmetic — but the `let`
  // is read by parseExpr1, ABOVE this level, and returned whole. Handing it
  // back in as the left operand puts it where the grammar says it belongs
  // without moving a hundred lines of binding code down here.
  function parseInfix(minPrec, seed) {
    let left = seed === undefined ? parseApp() : seed;
    for (;;) {
      const sym = opSym();
      if (sym === null) break;
      const f = fixity[sym];
      if (!f || f[0] < minPrec) break;
      p++;                                        // consume the operator
      // Left-associative operators demand a tighter right operand; right-
      // associative ones accept their own level, which is what makes
      // `1 :: 2 :: nil` group to the right.
      // A `let`, `if`, `case` or `fn` on the RIGHT of an operator is read by
      // parseExpr1, above this level, so `1 + let val m = 2 in m end` stopped
      // at the `let`. The left operand has worked since v1.312; this is the
      // other half. Standard ML reads such an operand as far as it goes, which
      // is what parseExpr1 does, so there is nothing to bound it with here.
      const right = startsBigExpr(peek())
        ? parseExpr1()
        : parseInfix(f[1] === 'l' ? f[0] + 1 : f[0]);
      left = mkInfix(sym, left, right);
    }
    return left;
  }

  // The forms parseExpr1 reads whole, which the operator grammar has no room
  // for. As an operand they are read by that parser and run to their own end.
  function startsBigExpr(tok) {
    return isKeyword(tok, 'let') || isKeyword(tok, 'if')
      || isKeyword(tok, 'case') || isKeyword(tok, 'fn') || isKeyword(tok, 'raise');
  }

  function parseCompare() { return parseInfix(0); }

  function atomStarts(tok) {
    // Keywords delimit rather than begin an atom, so a bare `if`/`then`/`else`/`fn`
    // in application position ends the current argument list instead of being eaten
    // as a variable named "then".
    if (tok.t === 'IDENT' && ['in', 'let', 'if', 'then', 'else', 'fn', 'and', 'or', 'andalso', 'orelse', 'mod', 'div', 'case', 'of', 'datatype', 'val', 'fun', 'as', 'end', 'do', 'while', 'open',
      'structure', 'signature', 'sig', 'struct', 'exception', 'raise', 'handle', 'type'].includes(nameKey(tok.v))) return false;
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
    if (tok.t === 'IDENT' && nameKey(tok.v) === 'op') {
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
      const e = inSeq(parseExpr);
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
          const label = peek().t === 'NUM' ? String(eat('NUM').v) : eat('IDENT').v;
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
      // `#[1, 2, 3]` is a vector, not a selector. The two share the `#` and are
      // told apart by the bracket, which is how Standard ML reads them.
      if (peek().t === 'LB') {
        p++;
        const items = [];
        if (peek().t !== 'RB') {
          items.push(parseExpr());
          while (peek().t === 'COMMA') { p++; items.push(parseExpr()); }
        }
        eat('RB');
        return { type: 'VectorLit', items };
      }
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
        // `(int, string) pair` — a type constructor of MORE THAN ONE argument.
        // Only one was read here, so the comma was a parse error and the form
        // could not be written at all, though `datatype ('a,'b) pair` declared
        // it happily. Declared and unwritable.
        const parts = [parseTypeExpr()];
        while (peek().t === 'COMMA') { p++; parts.push(parseTypeExpr()); }
        eat('RP');
        return parts.length === 1 ? parts[0] : { t: 'args', parts };
      }
      // A RECORD TYPE, `{a : int, b : string}`. parseTypeExpr had no case for
      // it while skipTypeExpr counted braces, so the two disagreed — and the
      // moment an abbreviation's right-hand side was PARSED rather than
      // skipped, `type hyperlink = {protocol : string, ...}` stopped working.
      // One conformance declaration, and it named the cause exactly.
      if (peek().t === 'LC') {
        p++;
        const labels = [], parts = [];
        while (peek().t !== 'RC' && peek().t !== 'EOF') {
          const lab = eat('IDENT').v;
          if (peek().t === 'COLON') p++;
          labels.push(lab);
          parts.push(parseTypeExpr());
          if (peek().t === 'COMMA') p++;
        }
        if (peek().t === 'RC') p++;
        return { t: 'record', labels, parts };
      }
      const id = eat('IDENT');
      return { t: 'name', name: id.v };
    };
    let left = parseAtomT();
    // postfix: `int list`, `'a tree`, `(int, string) pair`
    // The stop list is the shared one — `of` besides, which ends a
    // constructor's payload. Written out by hand here until v1.305, missing
    // six words, exactly as the other three sites were.
    while (peek().t === 'IDENT' && !isStop(peek()) && nameKey(peek().v) !== 'of') {
      const nm = eat('IDENT').v;
      left = left && left.t === 'args' ? { t: 'app', name: nm, args: left.parts } : { t: 'app', name: nm, arg: left };
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

  // `where type t = …` refines a type in a signature. Nothing here tracks types
  // at that level, so there is nothing to record — only to get past. Used after
  // every ascription: signature abbreviations, structures, and functors.
  function skipWhereClauses() {
    while (isKeyword(peek(), 'where')) {
      p++;
      if (isKeyword(peek(), 'type')) p++;
      while (peek().t === 'IDENT' && /^'/.test(peek().v)) p++;
      if (peek().t === 'IDENT') p++;                 // the type name
      // A qualified name (`K.t`) arrives as its own tokens; take the dots too.
      while (peek().t === 'DOT' || (peek().t === 'IDENT' && toks[p - 1] && toks[p - 1].t === 'DOT')) p++;
      if (peek().t === 'EQ') { p++; skipTypeExpr(); }
    }
  }

  // Walks a type expression and returns how many `*`-separated parts it had,
  // which is a constructor's arity here. It also KEEPS the words of each part
  // now: throwing them away meant `datatype shape = Circle of real` told the
  // checker only that Circle takes one argument, so the argument came out as a
  // fresh variable and `fun area (Rect (w, h)) = w * h` inferred int. The type
  // was written down and then ignored.
  function skipTypeExpr(out) {
    let parts = 1;
    let depth = 0;
    const words = [[]];
    const keep = (t) => { if (t.t === 'IDENT' && !depth) words[words.length - 1].push(t.v); };
    for (;;) {
      const t = peek();
      if (t.t === 'EOF') break;
      if (t.t === 'LP') { depth++; p++; continue; }
      // D-15: a RECORD type, `B of {n : int}`. The skipper knew parentheses and
      // not braces, so the `{` ended the type and the declaration failed on it.
      if (t.t === 'LC') { depth++; p++; continue; }
      if (t.t === 'RC') { if (!depth) break; depth--; p++; continue; }
      if (t.t === 'RP') { if (!depth) break; depth--; p++; continue; }
      if (t.t === 'STAR' && !depth) { parts++; words.push([]); p++; continue; }
      // `->` is ARROWT and belongs to the type; `=>` is ARROW and does NOT —
      // it ends the annotation and starts the body of a `fn`. Consuming ARROW
      // here swallowed the arrow of every `fn x : ty => e`.
      if (t.t === 'STAR' || t.t === 'ARROWT' || t.t === 'COMMA' || t.t === 'CONS') { p++; continue; }
      if (t.t === 'COLON' && depth) { p++; continue; }   // `{n : int}` inside a record type
      if (t.t === 'IDENT' && !isStop(t)) { keep(t); p++; continue; }
      if (t.t === 'MINUS' && toks[p + 1] && toks[p + 1].t === 'GT') { p += 2; continue; }
      break;
    }
    if (out) out.words = words;
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
    const kw = first.t === 'IDENT' ? nameKey(first.v) : null;
    const d = parseTopOne();
    if (!CHAINS.includes(kw)) return d;
    if (!(peek().t === 'IDENT' && nameKey(peek().v) === 'and')) return d;
    const items = [d];
    while (peek().t === 'IDENT' && nameKey(peek().v) === 'and') {
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
      // The PARAMETERS and the right-hand side are kept now. They were read and
      // dropped, on the reasoning that inference works structurally and does
      // not need the name — true of inference and false of ANNOTATIONS, which
      // is where a name appears. `type 'a syn = 'a list` then
      // `val y : int syn = 5` was accepted, because `int syn` could not be
      // resolved to `int list` and became a variable that unifies with
      // anything.
      //
      // Both spellings, as `datatype` takes: `'a syn` and `('a,'b) both`.
      const params = [];
      while (peek().t === 'IDENT' && /^'/.test(peek().v)) params.push(toks[p++].v);
      if (peek().t === 'LP') {
        p++;
        while (peek().t !== 'RP' && peek().t !== 'EOF') {
          if (peek().t === 'IDENT' && /^'/.test(peek().v)) params.push(peek().v);
          p++;
        }
        if (peek().t === 'RP') p++;
      }
      const nameTok = eat('IDENT');
      eat('EQ');
      // parseTypeExpr rather than skipTypeExpr: the right-hand side has to be
      // KEPT to expand the abbreviation, not merely stepped over.
      const rhs = parseTypeExpr();
      return { type: 'TypeAbbrev', name: nameTok.v, params, rhs };
    }
    // `exception Fail` / `exception Bad of str`. An exception is a constructor
    // like any other; what makes it an exception is `raise`.
    if (isKeyword(peek(), 'exception')) {
      p++;
      const nameTok = eat('IDENT');
      // `exception E = Fail` — a REPLICATION. Not a new exception but another
      // name for one that exists, so it has to share the identity: `handle E`
      // catching a Fail is the whole reason to write it.
      if (peek().t === 'EQ') {
        p++;
        return { type: 'ExnDecl', name: nameTok.v, alias: eat('IDENT').v };
      }
      let arity = 0;
      const shape = {};
      if (isKeyword(peek(), 'of')) { p++; arity = skipTypeExpr(shape); }
      return { type: 'ExnDecl', name: nameTok.v, arity };
    }
    // `infix [n] id …`, `infixr [n] id …`, `nonfix id …`. These are parse-time:
    // the table is updated here so that the very next line in the same unit
    // reads its operators correctly, and the node carries the change so eval can
    // persist it into the session for the lines after that.
    if (isKeyword(peek(), 'infix') || isKeyword(peek(), 'infixr') || isKeyword(peek(), 'nonfix')) {
      const word = nameKey(toks[p++].v);
      const assoc = word === 'infixr' ? 'r' : 'l';
      let prec = 0;
      if (peek().t === 'NUM' && !peek().real) prec = Number(toks[p++].v);
      const names = [];
      // The operators being declared. They are ordinary identifiers, and any
      // symbolic ones (`**`) arrive as whatever the lexer made of them.
      while ((peek().t === 'IDENT' && !isStop(peek())) || OP_SYM[peek().t] || peek().t === 'STAR') {
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
      // CASE MATTERS for the keyword here, and only here it has ever mattered
      // enough to break something. `isKeyword` lowercases, so a signature NAMED
      // `SIG` — which is what half of Harper's files call theirs — looked like
      // the keyword `sig`, and `signature ABBR = SIG` parsed as an empty
      // `sig … end` block. The abbreviation inherited no names, so ascribing to
      // it hid everything, which is what D-05 was.
      //
      // Standard ML is case-sensitive throughout and this build is not; that is
      // a departure of its own, recorded in the README. Fixing it everywhere is
      // a bigger change than this one and wants its own day. Here the keyword is
      // matched exactly, which is enough.
      if (!(peek().t === 'IDENT' && peek().v === 'sig')) {
        const refTok = eat('IDENT');
        skipWhereClauses();
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
      while (eatDeclSemis(), !isKeyword(peek(), 'in') && peek().t !== 'EOF') { hidden.push(parseTop()); }
      if (isKeyword(peek(), 'in')) p++;
      const shown = [];
      while (eatDeclSemis(), !isKeyword(peek(), 'end') && peek().t !== 'EOF') { shown.push(parseTop()); }
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
      // Standard ML lets a functor's parameter be written as a SPECIFICATION
      // rather than a name: `functor F (structure K : ORDERED)` means the
      // parameter is an anonymous structure and `K` is visible directly in the
      // body. That is already how a functor is applied here — the argument's
      // names are bound both bare and under the parameter's name — so the
      // sugar only has to reach the same place: take K as the parameter.
      // SEVERAL structure parameters: `functor F (structure P : S structure Q : S)`.
      // Standard ML's sugar for a functor over one anonymous structure with P
      // and Q inside it, so each name is a parameter and the application
      // supplies one structure per name.
      const params = [];
      if (isKeyword(peek(), 'structure')) p++;
      const param = eat('IDENT').v;
      params.push(param);
      // D-16: the parameter's signature may be written OUT rather than named:
      // `functor G (X : sig val n : int end)`. A named one already worked, so
      // this only had to accept the other spelling and skip to the matching
      // `end`. Signatures restrict names here and the parameter's names are
      // bound bare anyway, so nothing downstream needs the body.
      if (peek().t === 'COLON' || peek().t === 'ASCRIBE') {
        p++;
        if (peek().t === 'IDENT' && peek().v === 'sig') {
          let depth = 0;
          for (;;) {
            const t = peek();
            if (t.t === 'EOF') break;
            if (t.t === 'IDENT' && ['sig', 'struct', 'let', 'local'].includes(nameKey(t.v))) depth++;
            else if (isKeyword(t, 'end')) { depth--; p++; if (!depth) break; continue; }
            p++;
          }
        } else {
          eat('IDENT');
        }
      }
      // …and any more of them, each with its own optional signature.
      while (isKeyword(peek(), 'structure')) {
        p++;
        params.push(eat('IDENT').v);
        if (peek().t === 'COLON' || peek().t === 'ASCRIBE') { p++; eat('IDENT'); skipWhereClauses(); }
      }
      eat('RP');
      if (peek().t === 'COLON' || peek().t === 'ASCRIBE') { p++; eat('IDENT'); skipWhereClauses(); }
      eat('EQ');
      if (!isKeyword(peek(), 'struct')) throw new RonmlError("expected 'struct' after a functor's =");
      p++;
      const decls = [];
      inBlock++;
      while (eatDeclSemis(), !isKeyword(peek(), 'end') && peek().t !== 'EOF') { decls.push(parseTop()); }
      inBlock--;
      if (isKeyword(peek(), 'end')) p++;
      return { type: 'FunctorDecl', name: nameTok.v, param, params, decls };
    }
    // `open S` brings a structure's names into scope unqualified. It takes
    // several at once and later ones win, which is what SML says.
    // `while c do e`. The Definition gives it as sugar for a recursive
    // function, and that is exactly how it is built here: no loop construct
    // reaches the evaluator, so nothing else had to learn about it.
    if (isKeyword(peek(), 'while')) return parseWhile();

    // `abstype t = A | B with <declarations> end`. Standard ML hides the
    // representation; this build tracks names and not types, so the same
    // caveat applies as to a signature: the FORM works and the hiding is not
    // enforced. Written as a datatype plus the declarations that follow it.
    if (isKeyword(peek(), 'abstype')) {
      p++;
      toks[p - 1] = { ...toks[p - 1], v: 'datatype' };
      p--;
      const dt = parseTopOne();
      const items = [dt];
      if (isKeyword(peek(), 'with')) {
        p++;
        while (eatDeclSemis(), !isKeyword(peek(), 'end') && peek().t !== 'EOF') { items.push(parseTopOne()); }
        if (isKeyword(peek(), 'end')) p++;
      }
      // SEQUENTIAL, not simultaneous. `Decls` is also what an `and`-chain
      // produces, and since v1.299 that evaluates every right-hand side before
      // binding any name — which is right for `and` and wrong here, where the
      // with-block must see the datatype the line just declared. Marked, rather
      // than given its own node type, because everything else about it is the
      // same list of declarations.
      return items.length === 1 ? dt : { type: 'Decls', items, sequential: true };
    }

    if (isKeyword(peek(), 'open')) {
      p++;
      const names = [];
      while (peek().t === 'IDENT' && !isStop(peek())) names.push(toks[p++].v);
      if (!names.length) throw new RonmlError('open what? — try: open List');
      return { type: 'OpenDecl', names };
    }

    if (isKeyword(peek(), 'structure')) {
      p++;
      const nameTok = eat('IDENT');
      let ascribe = null;
      if (peek().t === 'COLON' || peek().t === 'ASCRIBE') { p++; ascribe = eat('IDENT').v; skipWhereClauses(); }
      eat('EQ');
      // `structure M = F (A)` applies a functor rather than opening a struct.
      if (peek().t === 'IDENT' && !isKeyword(peek(), 'struct')) {
        const fn = eat('IDENT').v;
        // `structure Q = Queue` — an ALIAS, not an application. With no `(`
        // after the name there is no functor call here, and reading one anyway
        // gave *Queue is not a functor*. It is the same form as
        // `structure Key : ORDERED = K` inside a struct, which is how nearly
        // every dictionary in the corpus names its ordering, so one refusal
        // took the whole structure with it and everything downstream after
        // that.
        if (peek().t !== 'LP') {
          return { type: 'StructAlias', name: nameTok.v, from: fn, ascribe };
        }
        let arg = null;
        if (peek().t === 'LP') {
          p++;
          // …and the matching sugar at the application: `F (structure K = X)`
          // names the argument by declaration rather than passing a structure.
          // The name on the right is the structure being handed over. SEVERAL of
          // them is the matching half of a multi-parameter functor:
          // `F (structure P = A structure Q = B)`, one structure per name.
          if (isKeyword(peek(), 'structure')) {
            const binds = [];
            while (isKeyword(peek(), 'structure')) {
              p++;
              const pname = eat('IDENT').v;
              eat('EQ');
              // The right-hand side is a NAME or an anonymous `struct … end`.
              // The example in examples/25-functors.ml writes the second, which
              // the first spelling of this refused.
              if (isKeyword(peek(), 'struct')) {
                p++;
                const ds = [];
                inBlock++;
                while (eatDeclSemis(), !isKeyword(peek(), 'end') && peek().t !== 'EOF') { ds.push(parseTop()); }
                inBlock--;
                if (isKeyword(peek(), 'end')) p++;
                binds.push({ param: pname, decls: ds });
              } else {
                binds.push({ param: pname, from: eat('IDENT').v });
              }
            }
            eat('RP');
            // ONE of them, given by name, is the form that already worked: hand
            // the structure over and let the single-parameter path take it.
            if (binds.length === 1 && binds[0].from) {
              return { type: 'StructApply', name: nameTok.v, functor: fn, arg: binds[0].from, ascribe };
            }
            if (binds.length === 1 && binds[0].decls) {
              return { type: 'StructApply', name: nameTok.v, functor: fn, arg: null, argDecls: binds[0].decls, ascribe };
            }
            return { type: 'StructApply', name: nameTok.v, functor: fn, arg: null, argBinds: binds, ascribe };
          }
          // `F (struct val z = 5 end)` — an ANONYMOUS structure as the
          // argument, which Standard ML allows and which was a parse error
          // here: the argument had to be a name declared on an earlier line.
          // Read as the declarations it holds, and handed over as those.
          if (isKeyword(peek(), 'struct')) {
            p++;
            const inlineDecls = [];
            inBlock++;
            while (eatDeclSemis(), !isKeyword(peek(), 'end') && peek().t !== 'EOF') { inlineDecls.push(parseTop()); }
            inBlock--;
            if (isKeyword(peek(), 'end')) p++;
            eat('RP');
            return { type: 'StructApply', name: nameTok.v, functor: fn, arg: null, argDecls: inlineDecls, ascribe };
          }
          arg = eat('IDENT').v;
          eat('RP');
        }
        else if (peek().t === 'IDENT') arg = eat('IDENT').v;
        return { type: 'StructApply', name: nameTok.v, functor: fn, arg, ascribe };
      }
      if (!isKeyword(peek(), 'struct')) throw new RonmlError("expected 'struct' after a structure name");
      p++;
      const decls = [];
      inBlock++;
      while (eatDeclSemis(), !isKeyword(peek(), 'end') && peek().t !== 'EOF') { decls.push(parseTop()); }
      inBlock--;
      if (isKeyword(peek(), 'end')) p++;
      return { type: 'StructDecl', name: nameTok.v, ascribe, decls };
    }
    if (isKeyword(peek(), 'datatype')) {
      p++;
      // `datatype 'a option = …`. The parameters used to be read and thrown
      // away, over a comment saying they carried no meaning because nothing
      // here was typed. That was true when it was written and stopped being
      // true when the checker landed: without them the checker builds a type
      // constructor of NO arguments, so `SOME 1` reports `option` where
      // Standard ML says `int option` (D-56).
      //
      // Both spellings: `'a box` and `('a, 'b) pair`.
      const params = [];
      while (peek().t === 'IDENT' && /^'/.test(peek().v)) params.push(toks[p++].v);
      if (peek().t === 'LP') {
        p++;
        while (peek().t !== 'RP' && peek().t !== 'EOF') {
          if (peek().t === 'IDENT' && /^'/.test(peek().v)) params.push(peek().v);
          p++;
        }
        if (peek().t === 'RP') p++;
      }
      const nameTok = eat('IDENT');
      eat('EQ');
      // `datatype t = datatype u` — a REPLICATION. Not a new type but another
      // name for one, sharing its constructors, so `t` and `u` are one type
      // under two names. The same shape as `exception E = Fail`.
      if (isKeyword(peek(), 'datatype')) {
        p++;
        return { type: 'Datatype', name: nameTok.v, params: [], cons: [], alias: eat('IDENT').v };
      }
      const cons = [];
      for (;;) {
        const c = eat('IDENT');
        let arity = 0;
        // The constructor's argument type, read only for how many components it
        // has. This used to be a hand-rolled loop that ate any run of
        // identifiers and stopped only at `of`, so in `datatype t = N of int
        // val z = 1` it swallowed `val z` and then reported the `=`. Use the
        // one type skipper, which already knows that a declaration keyword ends
        // a type — and counts the same `*` separators.
        const shape = {};
        if (isKeyword(peek(), 'of')) { p++; arity = skipTypeExpr(shape); }
        // argWords carries the words of each `*`-separated part, so the checker
        // can give `Circle of real` a real rather than a fresh variable.
        cons.push({ name: c.v, arity, argWords: shape.words || [] });
        if (peek().t !== 'BAR') break;
        p++;
      }
      // D-19: `datatype t = … withtype u = …` attaches type abbreviations to a
      // datatype binding. Abbreviations are names only here (see TypeAbbrev),
      // so the clause is read and skipped, which is what the abbreviation
      // amounts to on a build that does not track type structure.
      while (isKeyword(peek(), 'withtype')) {
        p++;
        eat('IDENT');
        if (peek().t === 'EQ') { p++; skipTypeExpr(); }
      }
      return { type: 'Datatype', name: nameTok.v, params, cons };
    }
    if (isKeyword(peek(), 'let')) {
      // `let open List in null [] end`. A `let` may hold a DECLARATION, not only
      // a binding, and `open` is the one anybody writes there. It binds into the
      // ENVIRONMENT rather than the session, so a child scope gives it exactly
      // the reach Standard ML says it has: the body, and no further.
      if (toks[p + 1] && isKeyword(toks[p + 1], 'open')) {
        p++;
        const decl = parseTopOne();
        if (!isKeyword(peek(), 'in')) throw new RonmlError("expected 'in' after the open");
        p++;
        const body = inSeq(parseExpr);
        if (isKeyword(peek(), 'end')) p++;
        return asOperand({ type: 'LetOpen', decl, body });
      }
      // WHICH WORD it was matters and this used to throw it away. In Standard
      // ML `val` takes a PATTERN and `fun` takes a name and its parameters;
      // `val f x = e` is not a thing. Losing the distinction meant
      // `val SOME z = SOME 4` was read as a function called SOME taking z, so
      // z was never bound, the constructor was shadowed, and `SOME 9`
      // afterwards recursed until the step budget ran out. No error anywhere.
      let saidVal = nameKey(peek().v) === 'val';
      p++;
      if (peek().t === 'IDENT' && ['val', 'fun'].includes(nameKey(peek().v))) {
        saidVal = nameKey(peek().v) === 'val';   // `let val …`
        p++;
      }
      // `val rec f = fn …`, Standard ML's recursive value binding. See the
      // same skip in the `let` case above: this is the TOP-LEVEL one, and
      // fixing only that one left `val rec` still binding a variable called
      // rec at the prompt, which is where anyone would type it.
      if (peek().t === 'IDENT' && nameKey(peek().v) === 'rec') p++;
      // `let (a, b) = e` and `let [x, y] = e` bind several names at once.
      // Harper introduces this as "the following generalization of a value
      // binding" (1993, p.16), before case, because it is the simpler idea:
      // write down the shape and the parts get names.
      // After `val`, anything that is not `name =` or `name : ty =` is a
      // pattern: `val 0 = 1-1`, `val SOME z = e`, `val h :: t = e`. The bare
      // `let name … = e` the game's terminals use said neither word and is
      // untouched.
      const valTakesPattern = () => {
        if (!saidVal) return false;
        if (peek().t !== 'IDENT') return true;
        const nxt = toks[p + 1];
        return !!nxt && nxt.t !== 'EQ' && nxt.t !== 'COLON';
      };
      // `fun (f ** g) (x, y) = …` and `fun (op +) (a, b) = …`. Tried before the
      // pattern branch below, which sees the `(` and reads the whole left-hand
      // side as something to bind. Never for `val`, which really does take a
      // pattern there.
      const infLhs = saidVal ? null : infixLhs();
      if (!infLhs && (peek().t === 'LP' || peek().t === 'LB' || peek().t === 'LC' || valTakesPattern())) {
        const pat = valTakesPattern() ? parsePattern() : parsePatternAtom();
        eat('EQ');
        const value = parseExpr();
        if (peek().t === 'IDENT' && ['val', 'fun'].includes(nameKey(peek().v)) && inBeforeEnd()) {
          return { type: 'LetPat', pat, value, body: parseExpr1() };
        }
        if (isKeyword(peek(), 'in')) {
          p++;
          const body = inSeq(parseExpr);   // a let body sequences with `;`, as parens do
          // …and its `end`, which the name-binding path already ate. Without
          // this, `let val (d, a, b) = … in … end` parsed to the body and then
          // reported the `end` as unexpected — which reads as a broken `let`
          // rather than a missing two lines here.
          if (isKeyword(peek(), 'end')) p++;
          return asOperand({ type: 'LetPat', pat, value, body });
        }
        return { type: 'TopLetPat', pat, value };
      }
      // `fun (f ** g) (x, y) = …` and `fun (op +) (a, b) = …` name the function
      // where it will be used. Nothing is consumed when it is neither.
      const nameTok = infLhs ? { t: 'IDENT', v: infLhs.name } : eat('IDENT');
      const params = infLhs ? [...infLhs.params, ...letParams()] : letParams();
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
          const w = nameKey(t.v);
          if (w === 'in') return true;
          if (w === 'structure' || w === 'signature' || w === 'end') return false;
        }
        return false;
      };
      const isBind = () => bindingReachesEq(p + 1);
      while (!inBlock && inAhead() && ((isKeyword(peek(), 'and') && isBind()) || isKeyword(peek(), 'let'))) {
        p++;
        const n2 = eat('IDENT');
        const p2 = letParams();
        const a2 = bindAnn();
        eat('EQ');
        const b2 = parseExpr();
        const v2 = clausalRest(n2.v, p2, b2) || wrapParams(p2, b2);
        extra.push({ name: n2.v, value: annotBind(v2, a2, p2.length) });
      }
      if (!inBlock && isKeyword(peek(), 'in')) {
        p++;
        const body = inSeq(parseExpr);   // a let body sequences with `;`, as parens do
        if (isKeyword(peek(), 'end')) p++;
        // ONE scope, as in the inner let parser above. There are TWO paths that
        // parse a multi-binding `let` — this is the top-level one, which is
        // where a line typed at a prompt goes — and fixing only the other left
        // mutual recursion broken exactly where anyone would meet it. Same
        // shape as the `val rec` fix earlier: one branch done, its sibling not.
        return asOperand({ type: 'LetRec', binds: [{ name: nameTok.v, value }, ...extra], body });
      }
      if (extra.length) throw new RonmlError("expected 'in' after the bindings");
      return { type: 'TopLet', name: nameTok.v, value };
    }
    return parseExpr();
  }

  let expr = parseTop();
  // A trailing annotation on the whole line. `let val x = 1 in x end : int` is
  // read at the top by the DECLARATION parser, which returns before parseExpr
  // ever sees the `:`, so fixing it in parseExpr alone left the form that
  // anyone would actually type still failing.
  if (peek().t === 'COLON') {
    p++;
    const ann = parseTypeExpr();
    expr = { type: 'Annot', expr, ann, params: 0 };
  }
  // `;` BETWEEN AND AFTER DECLARATIONS. At the top level it is a separator and
  // a terminator, not an expression sequence — `val p = 1; val q = 2` declares
  // two things, and `open List;` is one declaration with a full stop after it.
  // Standard ML's own texts end nearly every line this way, and the parser had
  // no case for it: the `;` was eaten by whatever expression happened to be
  // being read, or reached `eat('EOF')` and was reported there.
  if (peek().t === 'SEMI') {
    const items = [expr];
    while (peek().t === 'SEMI') {
      p++;
      if (peek().t === 'EOF') break;    // a terminating `;`, with nothing after it
      items.push(parseTop());
    }
    // SEQUENTIAL, and marked, because a bare `Decls` means an `and`-chain and
    // those are simultaneous (v1.299). These run in order and each may use the
    // names declared before it, which is the whole point of writing them on one
    // line.
    if (items.length > 1) expr = { type: 'Decls', items, sequential: true };
  }
  eat('EOF');
  return expr;
}

// Parse one line to an AST without evaluating it. Exists so the type checker
// can look at what you wrote before the machine does anything about it.
export function parseLine(source, fixity) {
  return parse(tokenize(String(source)), fixity);
}

// Split a program file into the logical lines the parser expects, KEEPING the
// physical line each one started on, so an error can say where.
export function joinProgram(text) {
  const out = [];
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    let line = raw.replace(/\(\*.*?\*\)/g, '').replace(/\s+$/, '');
    if (!line.trim()) continue;
    if (/^>/.test(line)) continue;
    line = line.replace(/^(\s*)-\s+(?=[A-Za-z(\[])/, '$1');
    // A line CONTINUES the previous one when it is indented, or opens with
    // something that cannot start a declaration.
    const opensAsContinuation = /^\s/.test(raw) || /^\s*(\||=>|::|@|\)|and\b|in\b|end\b|else\b|then\b)/.test(line);
    // …or when the PREVIOUS line cannot have ended there. A declaration whose
    // last token is `=` is waiting for its right-hand side, and the corpus
    // writes exactly that:
    //
    //     functor DictFun (structure K : ORDERED) :> DICT where type … =
    //     struct
    //
    // `struct` sits at column 0 and opens nothing on the list above, so the
    // header was cut from its body: the header failed on the missing `struct`
    // and the body arrived as a stray one. Same for a trailing `|` in a
    // datatype written down the page.
    const prev = out.length ? out[out.length - 1].text : '';
    const prevWantsMore = /(=|\||=>|->|:|,|\bof)$/.test(prev.trim());
    const continues = opensAsContinuation || (prevWantsMore && out.length);
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
