// NostOS — a postAI Odyssey.
// Copyright (C) 2026 David M. Berry
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU General Public License as published by the Free Software
// Foundation, either version 3 of the License, or (at your option) any later
// version. This program is distributed WITHOUT ANY WARRANTY; see the GNU
// General Public License for details: <https://www.gnu.org/licenses/>.

// A checklist of Standard ML, run against this build.
//
//   node tools/sml-checklist.mjs
//
// The conformance harness measures against somebody else's PROGRAMS, which is
// the better instrument and the one to trust; this measures against a list of
// FEATURES, which catches what the corpus happens not to use. Harper's files
// contain no `while` and no arrays, so the harness had nothing to say about
// either while both were missing.
//
// Written 2026-08-06 in answer to "where is BML compared to SML", and kept
// because the answer changes. It found twelve gaps in one run, of which two
// were silent wrong answers rather than absences.
//
// It is A CHECKLIST, not the Definition: 100 cases somebody wrote down, so a
// perfect score means every case here passes and nothing more. The corpus
// figure is the one to quote.
//
// Each case is [area, what, setup lines, the expression, the SML answer], and
// passes only on an exact match.
//
// WHAT IT CANNOT SEE: it compares ANSWERS. A defect that gives the right value
// under the wrong type is invisible here — `fun f () = 5` reported `'a -> int`
// for a long time and `f ()` answered 5 throughout. Three cases written for
// that were removed again on finding they passed against the broken checker
// too. Those belong in the unit tests, which can ask for a type.

import { createInterpreter } from '../src/interp.js';

const CASES = [
  // ---- core expressions ---------------------------------------------------
  ['core', 'integer arithmetic', [], '3 + 4 * 2', '11'],
  ['core', 'unary minus (~)', [], '~3 + 1', '~2'],
  ['core', 'div and mod', [], '(17 div 5, 17 mod 5)', '(3, 2)'],
  ['core', 'real arithmetic', [], '1.5 + 2.5', '4.0'],
  // 1.5 + 2.5 is exact in binary and says nothing about how a real is WRITTEN.
  // Real.toString carries twelve significant digits, so an inexact sum has to
  // round to them rather than show the error term.
  ['core', 'real printed to 12 significant digits', [], '3.14 + 2.17', '5.31'],
  ['core', 'real division to 12 digits', [], '1.0 / 3.0', '0.333333333333'],
  ['core', 'string concat', [], '"a" ^ "b"', '"ab"'],
  ['core', 'char literal', [], '#"a"', '#"a"'],
  ['core', 'comparison chain', [], '(1 < 2, "a" < "b", #"a" < #"b")', '(true, true, true)'],
  ['core', 'andalso / orelse precedence', [], 'true orelse true andalso false', 'true'],
  ['core', 'if then else', [], 'if 1 < 2 then "y" else "n"', '"y"'],
  ['core', 'let ... in ... end', [], 'let val x = 2 in x * x end', '4'],
  ['core', 'fn abstraction', [], '(fn x => x + 1) 41', '42'],
  ['core', 'curried application', ['fun add a b = a + b'], 'add 2 3', '5'],
  ['core', 'tuple', [], '(1, "a", true)', '(1, "a", true)'],
  ['core', 'record', [], '{a = 1, b = "x"}', '{a = 1, b = "x"}'],
  ['core', 'record projection #lab', ['val r = {a = 1, b = "x"}'], '#b r', '"x"'],
  ['core', 'tuple projection #n', [], '#2 (1, 2, 3)', '2'],
  ['core', 'list literal + cons', [], '1 :: [2, 3]', '[1, 2, 3]'],
  ['core', 'vector literal', [], '#[1, 2, 3]', '#[1, 2, 3]'],
  ['core', 'append @', [], '[1] @ [2]', '[1, 2]'],
  ['core', 'sequence (e1; e2)', [], '(1; 2)', '2'],
  ['core', 'while ... do', ['val i = ref 0'], '(while !i < 3 do i := !i + 1; !i)', '3'],
  ['core', 'ref / ! / :=', ['val c = ref 1'], '(c := !c + 1; !c)', '2'],
  ['core', 'o (composition)', [], '((fn x => x + 1) o (fn x => x * 2)) 5', '11'],
  ['core', 'op', [], 'op + (1, 2)', '3'],

  // ---- patterns -----------------------------------------------------------
  ['patterns', 'wildcard', [], 'case 5 of _ => "any"', '"any"'],
  ['patterns', 'literal pattern', [], 'case 1 of 1 => "one" | _ => "no"', '"one"'],
  ['patterns', 'tuple pattern', [], 'case (1, 2) of (a, b) => a + b', '3'],
  ['patterns', 'list pattern', [], 'case [1,2,3] of h :: t => h', '1'],
  ['patterns', 'nested pattern', [], 'case SOME (1, 2) of SOME (a, _) => a | NONE => 0', '1'],
  ['patterns', 'val destructuring', ['val (a, b) = (1, 2)'], 'a + b', '3'],
  // `val` takes a PATTERN in Standard ML. A constructor pattern used to be read
  // as a function binding, so the name was never bound and the constructor was
  // shadowed — no error, which is why the checklist needed to say it.
  ['patterns', 'constructor pattern in a val', ['val SOME cz = SOME 4'], 'cz', '4'],
  ['patterns', 'val leaves the constructor alone', ['val SOME cz2 = SOME 4'], 'SOME 9', 'SOME 9'],
  ['patterns', 'cons pattern in a val', ['val vh :: vt = [1,2,3]'], '(vh, vt)', '(1, [2, 3])'],
  ['patterns', 'as (layered) pattern', [], 'case [1,2] of whole as h :: _ => length whole', '2'],
  ['patterns', 'record pattern', [], 'case {a = 1, b = 2} of {a = x, b = y} => x + y', '3'],
  ['patterns', 'record pattern with ...', [], 'case {a = 1, b = 2} of {a = x, ...} => x', '1'],
  ['patterns', 'clausal fun', ['fun len nil = 0 | len (_ :: t) = 1 + len t'], 'len [1,2,3]', '3'],
  ['patterns', 'string pattern', [], 'case "hi" of "hi" => 1 | _ => 0', '1'],

  // ---- types --------------------------------------------------------------
  ['types', 'let-polymorphism', ['fun id x = x'], '(id 1, id "a")', '(1, "a")'],
  ['types', 'type annotation honoured', [], '(5 : int)', '5'],
  // One case for annotations was not enough. `(5 : int)` passed while four
  // ordinary uses were refused, all four in a position where the binding form
  // REPEATS — which is why they are four cases here and not one.
  ['types', 'annotation on a clause after |',
    ['fun g (m:int, 0):int = m | g (0, n:int):int = n'], 'g (0, 7)', '7'],
  ['types', 'annotation on a later val of a let',
    [], 'let val m:int = 3 val n:int = m*m in m*n end', '27'],
  ['types', 'annotation on an `and` continuation',
    ['val u1 : int = 1 and u2 : int = 2'], 'u1 + u2', '3'],
  ['types', 'annotation in a record pattern field',
    ['fun dst {x = x : real, y = y : real} = x + y'], 'dst {x = 3.0, y = 4.0}', '7.0'],
  ['types', 'parameterised datatype', ["datatype 'a box = Box of 'a"], 'Box 1', 'Box 1'],
  ['types', 'recursive datatype', ["datatype t = L | N of t * int * t"], 'N (L, 1, L)', 'N (L, 1, L)'],
  ['types', 'type abbreviation', ['type count = int'], '(5 : count)', '5'],
  ['types', 'withtype', ["datatype t = A of pair withtype pair = int * int"], 'A (1, 2)', 'A (1, 2)'],
  ['types', 'abstype', ['abstype q = Q of int with fun mk n = Q n fun get (Q n) = n end'], 'get (mk 7)', '7'],

  // ---- exceptions ---------------------------------------------------------
  ['exceptions', 'declare and raise', ['exception Boom'], '(raise Boom) handle Boom => "caught"', '"caught"'],
  ['exceptions', 'exception with payload', ['exception E of string'], '(raise E "m") handle E s => s', '"m"'],
  ['exceptions', 'Fail carries a string', [], '(raise Fail "b") handle Fail m => m', '"b"'],
  ['exceptions', 'standard Empty', [], '(hd nil) handle Empty => 0', '0'],
  ['exceptions', 'Div', [], '(1 div 0) handle Div => ~1', '~1'],
  ['exceptions', 'replication shares identity',
    ['exception Boom of string', 'exception Bang = Boom'],
    '(raise Boom "x") handle Bang s => s', '"x"'],

  // ---- modules ------------------------------------------------------------
  ['modules', 'structure + dot access', ['structure S = struct val k = 3 end'], 'S.k', '3'],
  ['modules', 'signature ascription (:)', ['signature SG = sig val k : int end', 'structure S2 : SG = struct val k = 4 val hidden = 9 end'], 'S2.k', '4'],
  ['modules', 'opaque ascription (:>) hides', ['signature SG2 = sig val k : int end', 'structure S3 :> SG2 = struct val k = 5 val secret = 9 end'], 'S3.secret', 'REFUSED'],
  ['modules', 'open', ['structure O = struct val zz = 8 end', 'open O'], 'zz', '8'],
  ['modules', 'functor, named argument', ['signature I = sig val z : int end', 'functor F (X : I) = struct val m = X.z + 1 end', 'structure A = struct val z = 9 end', 'structure T = F (A)'], 'T.m', '10'],
  ['modules', 'functor, anonymous argument', ['structure U = F (struct val z = 5 end)'], 'U.m', '6'],
  ['modules', 'local ... in ... end', ['local val h = 7 in val shown = h end'], 'shown', '7'],
  ['modules', 'sharing constraint', ['signature SH = sig type t type u sharing type t = u end'], '1', '1'],
  ['modules', 'where type', ['signature WT = sig type t val z : t end', 'signature WT2 = WT where type t = int'], '1', '1'],

  // ---- fixity -------------------------------------------------------------
  ['fixity', 'infix declaration', ['infix 6 plus', 'fun plus (a, b) = a + b'], '1 plus 2', '3'],
  ['fixity', 'infixr', ['infixr 5 cc', 'fun cc (a, b) = a ^ b'], '"a" cc "b"', '"ab"'],
  ['fixity', 'nonfix', ['infix 6 pp', 'fun pp (a, b) = a + b', 'nonfix pp'], 'pp (1, 2)', '3'],

  // ---- lexical ------------------------------------------------------------
  ['lexical', 'nested comments', [], '(* a (* b *) c *) 1', '1'],
  ['lexical', 'hex literal', [], '0x1F', '31'],
  ['lexical', 'word literal', [], '0w5', '5'],
  ['lexical', 'word literal, hex', [], '0wx1F', '31'],
  ['lexical', 'scientific notation', [], '1e3', '1000.0'],
  ['lexical', 'string escapes', [], 'size "a\\nb"', '3'],
  ['lexical', 'symbolic identifier', ['fun ** (a, b) = a * b', 'infix 7 **'], '3 ** 4', '12'],

  // ---- the Basis ----------------------------------------------------------
  ['basis', 'Time conversions', [], 'Time.toSeconds (Time.fromSeconds 90)', '90'],
  ['basis', 'Date.toString', [], 'Date.toString (Date.fromTimeUniv 0)', '"Thu Jan 01 00:00:00 1970"'],
  ['basis', 'Date.weekday', [], 'Date.weekday (Date.fromTimeUniv 0)', 'Thu'],
  ['basis', 'Vector.length', [], 'Vector.length #[1,2,3]', '3'],
  ['basis', 'Vector.sub', [], 'Vector.sub (#[7,8,9], 1)', '8'],
  ['basis', 'List.map', [], 'List.map (fn x => x + 1) [1, 2]', '[2, 3]'],
  ['basis', 'List.foldl', [], 'List.foldl (fn (a, b) => a + b) 0 [1,2,3]', '6'],
  ['basis', 'List.filter', [], 'List.filter (fn x => x > 1) [1,2,3]', '[2, 3]'],
  ['basis', 'List.nth', [], 'List.nth ([1,2,3], 1)', '2'],
  ['basis', 'String.size / sub', [], '(String.size "abc", String.sub ("abc", 1))', '(3, #"b")'],
  ['basis', 'String.substring', [], 'String.substring ("abcdef", 1, 3)', '"bcd"'],
  ['basis', 'Int.toString', [], 'Int.toString 42', '"42"'],
  ['basis', 'Int.fromString', [], 'Int.fromString "42"', 'SOME 42'],
  ['basis', 'Char.ord / chr', [], '(Char.ord #"A", Char.chr 66)', '(65, #"B")'],
  ['basis', 'Real.fromInt', [], 'Real.fromInt 3', '3.0'],
  ['basis', 'Option.valOf', [], 'Option.valOf (SOME 3)', '3'],
  ['basis', 'ListPair.zip', [], 'ListPair.zip ([1,2], ["a","b"])', '[(1, "a"), (2, "b")]'],
  ['basis', 'Math.sqrt', [], 'Math.sqrt 4.0', '2.0'],
  ['basis', 'Array', ['val arr = Array.array (3, 0)'], 'Array.sub (arr, 0)', '0'],
  ['basis', 'Vector', [], 'Vector.length (Vector.fromList [1,2,3])', '3'],
  ['basis', 'Word', [], 'Word.toInt (Word.fromInt 5)', '5'],
  ['basis', 'TextIO.print', [], 'TextIO.print "x"', 'x'],
  ['basis', 'Substring', [], 'Substring.string (Substring.full "ab")', '"ab"'],
  ['basis', 'General.o', [], 'General.o ((fn x => x + 1), (fn x => x)) 1', '2'],
];

const bml = createInterpreter({ typecheck: 'off', printing: 'sml' });
bml.loadPrelude();
const results = [];
for (const [area, what, setup, expr, want] of CASES) {
  for (const l of setup) bml.run(l);
  let got;
  try { const r = bml.run(expr); got = r.ok ? r.text : 'REFUSED'; }
  catch (e) { got = 'THREW'; }
  results.push({ area, what, want, got, ok: got === want });
}
const byArea = {};
for (const r of results) {
  (byArea[r.area] ||= []).push(r);
}
let tot = 0, pass = 0;
for (const [area, rs] of Object.entries(byArea)) {
  const p = rs.filter((r) => r.ok).length;
  tot += rs.length; pass += p;
  console.log(`\n${area.toUpperCase()}  ${p}/${rs.length}`);
  for (const r of rs.filter((x) => !x.ok)) {
    console.log(`   MISSING  ${r.what.padEnd(32)} want ${JSON.stringify(r.want)}  got ${JSON.stringify(r.got)}`);
  }
}
console.log(`\nTOTAL ${pass}/${tot} (${Math.round(pass / tot * 100)}%)`);
