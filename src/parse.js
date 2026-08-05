// THE PARSER. Tokens to an abstract syntax tree.
//
// Part of src/lang/, the language proper: nothing here knows about NostOS, its
// terminals, or its robots. See docs/aiml-standalone-plan.md.
//
// Moved out of src/game/ai_ml.js unchanged at v1.286 (M1), together with the
// fixity table it carries, parseLine, and the program joiner. The only edits
// were the imports below and the export keywords.

import { RonmlError } from './errors.js';
import { tokenize } from './lex.js';

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

export function parse(toks, fixityIn) {
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
    // `fn x : real => …` — an annotated parameter, written without brackets.
    // parsePatternAnn keeps the annotation so the checker still sees the claim;
    // `fn (x : real) => …` is the same thing and already worked.
    const first = parsePatternAnn();
    if (peek().t !== 'ARROW') throw new RonmlError("expected '=>' after fn's parameter — try: fn x => x");
    p++;
    const arms = [{ pat: first, body: parseExpr1() }];
    while (peek().t === 'BAR') {
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
          const body = parseExpr();
          // …and its `end`, which the name-binding path already ate. Without
          // this, `let val (d, a, b) = … in … end` parsed to the body and then
          // reported the `end` as unexpected — which reads as a broken `let`
          // rather than a missing two lines here.
          if (isKeyword(peek(), 'end')) p++;
          return { type: 'LetPat', pat, value, body };
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

  // TWO LEVELS, because Standard ML has two: `andalso` binds tighter than
  // `orelse`, so `true orelse true andalso false` is `true orelse (true andalso
  // false)` and answers true. This was one flat loop and therefore purely
  // left-to-right, which read it as `(true orelse true) andalso false` and
  // answered FALSE. A wrong answer with no error, in an operator anyone writing
  // a guard reaches for.
  function parseBool() {
    let left = parseAndalso();
    while (peek().t === 'IDENT' && ['or', 'orelse'].includes(peek().v.toLowerCase())) {
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
    while (peek().t === 'IDENT' && ['and', 'andalso'].includes(peek().v.toLowerCase())
      && !(peek().v.toLowerCase() === 'and' && andIsBinding())) {
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

  function skipTypeExpr() {
    let parts = 1;
    let depth = 0;
    for (;;) {
      const t = peek();
      if (t.t === 'EOF') break;
      if (t.t === 'LP') { depth++; p++; continue; }
      if (t.t === 'RP') { if (!depth) break; depth--; p++; continue; }
      if (t.t === 'STAR' && !depth) { parts++; p++; continue; }
      // `->` is ARROWT and belongs to the type; `=>` is ARROW and does NOT —
      // it ends the annotation and starts the body of a `fn`. Consuming ARROW
      // here swallowed the arrow of every `fn x : ty => e`.
      if (t.t === 'STAR' || t.t === 'ARROWT' || t.t === 'COMMA' || t.t === 'CONS') { p++; continue; }
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
      // Standard ML lets a functor's parameter be written as a SPECIFICATION
      // rather than a name: `functor F (structure K : ORDERED)` means the
      // parameter is an anonymous structure and `K` is visible directly in the
      // body. That is already how a functor is applied here — the argument's
      // names are bound both bare and under the parameter's name — so the
      // sugar only has to reach the same place: take K as the parameter.
      if (isKeyword(peek(), 'structure')) p++;
      const param = eat('IDENT').v;
      if (peek().t === 'COLON' || peek().t === 'ASCRIBE') { p++; eat('IDENT'); }
      eat('RP');
      if (peek().t === 'COLON' || peek().t === 'ASCRIBE') { p++; eat('IDENT'); skipWhereClauses(); }
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
      if (peek().t === 'COLON' || peek().t === 'ASCRIBE') { p++; ascribe = eat('IDENT').v; skipWhereClauses(); }
      eat('EQ');
      // `structure M = F (A)` applies a functor rather than opening a struct.
      if (peek().t === 'IDENT' && !isKeyword(peek(), 'struct')) {
        const fn = eat('IDENT').v;
        let arg = null;
        if (peek().t === 'LP') {
          p++;
          // …and the matching sugar at the application: `F (structure K = X)`
          // names the argument by declaration rather than passing a structure.
          // The name on the right is the structure being handed over.
          if (isKeyword(peek(), 'structure')) { p++; eat('IDENT'); eat('EQ'); }
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
        // The constructor's argument type, read only for how many components it
        // has. This used to be a hand-rolled loop that ate any run of
        // identifiers and stopped only at `of`, so in `datatype t = N of int
        // val z = 1` it swallowed `val z` and then reported the `=`. Use the
        // one type skipper, which already knows that a declaration keyword ends
        // a type — and counts the same `*` separators.
        if (isKeyword(peek(), 'of')) { p++; arity = skipTypeExpr(); }
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
          const body = parseExpr();
          // …and its `end`, which the name-binding path already ate. Without
          // this, `let val (d, a, b) = … in … end` parsed to the body and then
          // reported the `end` as unexpected — which reads as a broken `let`
          // rather than a missing two lines here.
          if (isKeyword(peek(), 'end')) p++;
          return { type: 'LetPat', pat, value, body };
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
