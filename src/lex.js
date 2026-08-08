// THE LEXER. Source text to a flat list of tokens.
//
// Part of src/lang/, the language proper: nothing here knows about NostOS, its
// terminals, or its robots. See docs/aiml-standalone-plan.md.
//
// Moved out of src/game/ai_ml.js unchanged at v1.286 (M1). The only edits were
// the import below and the export keyword on tokenize.

import { RonmlError } from './errors.js';

// The characters Standard ML allows in a symbolic identifier, and the runs of
// them this language already spells something with. Anything else that is two
// or more of these is a NAME.
const SYMBOLIC = /[!%&$#+\-/:<=>?@\\~^|*]/;
// Read OUT of the lexer below rather than recalled: every two-character
// operator it spells something with. The first version of this list was
// Standard ML's and left out this dialect's own `==` and `!=`, so `4 == 4`
// lexed as a symbolic NAME and twenty tests went red at once.
const KNOWN_SYMBOLIC = new Set([
  '::', ':=', ':>', '<=', '<>', '==', '=>', '>=', '|>', '!=', '->', '..',
  // `**` WAS here and should not have been. Every other entry is a spelling
  // this lexer or parser gives its own token to — `::` is CONS, `->` is MINUS
  // GT read as a type arrow, and so on — but nothing has ever handled `**`. So
  // it was excluded from the symbolic path without being a token either, and
  // `fun ** (a, b) = a * b` failed on an unexpected STAR: a name nobody could
  // bind and nothing could use. Standard ML has no `**` operator either; it is
  // an ordinary symbolic identifier there, and it is one here now.
]);

// ---- Tokenizer --------------------------------------------------------

// Read a run of characters up to `close`, decoding Standard ML's escapes on the
// way: \n \t \r \\ \" \a \b \f \v, the numeric \ddd, and the \ … \ gap that lets a
// literal span source lines. Shared by strings and character literals, which
// take the same escapes — the character lexer used to take none, so `#"\\"`
// could not be lexed and Harper's regexp tokenizer was unreadable.
// Returns the decoded text and the index of the closing delimiter.
function readEscaped(src, from, n, close) {
  let j = from, out = '';
  while (j < n && src[j] !== close) {
    if (src[j] !== '\\') { out += src[j]; j++; continue; }
    const e = src[j + 1];
    if (e === undefined) throw new RonmlError('a literal ends with a lone backslash');
    // \ … \ : whitespace between two backslashes is elided.
    if (/\s/.test(e)) {
      let k = j + 1;
      while (k < n && /\s/.test(src[k])) k++;
      if (src[k] !== '\\') throw new RonmlError('a \\ … \\ gap must close with a second \\');
      j = k + 1; continue;
    }
    const simple = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', a: '\x07', b: '\b', f: '\f', v: '\v' };
    if (e in simple) { out += simple[e]; j += 2; continue; }
    if (/[0-9]/.test(e)) {
      const m = src.slice(j + 1, j + 4);
      if (!/^[0-9]{3}$/.test(m)) throw new RonmlError('a \\ddd escape needs exactly three digits');
      out += String.fromCharCode(Number(m)); j += 4; continue;
    }
    // `\^A` is the control character whose code is the letter's minus 64, so
    // `\^A` is 1 and `\^[` is 27. The Definition's own spelling for the ones
    // that have no letter of their own.
    if (e === '^') {
      const c = src[j + 2];
      if (!c || c.charCodeAt(0) < 64 || c.charCodeAt(0) > 95) {
        throw new RonmlError('a \\^ escape takes one character from @ to _');
      }
      out += String.fromCharCode(c.charCodeAt(0) - 64); j += 3; continue;
    }
    // `\uXXXX`, four hex digits.
    if (e === 'u') {
      const h = src.slice(j + 2, j + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(h)) throw new RonmlError('a \\u escape needs exactly four hex digits');
      out += String.fromCharCode(parseInt(h, 16)); j += 6; continue;
    }
    throw new RonmlError(`unknown escape \\${e}`);
  }
  return { text: out, at: j };
}

export function tokenize(src) {
  const toks = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    // COMMENTS NEST, which the Definition says in §2.3 and this did not do: it
    // took the first `*)` it found, so `(* outer (* inner *) still outer *)`
    // ended at the inner one and left `still outer *)` to be lexed as code. The
    // conformance harness has counted depth correctly since v1.274; the
    // tokenizer the harness measures never did.
    if (c === '(' && src[i + 1] === '*') {
      let depth = 1;
      let k = i + 2;
      while (k < n && depth > 0) {
        if (src[k] === '(' && src[k + 1] === '*') { depth++; k += 2; continue; }
        if (src[k] === '*' && src[k + 1] === ')') { depth--; k += 2; continue; }
        k++;
      }
      i = k;
      continue;
    }
    // A SYMBOLIC IDENTIFIER. Standard ML lets a name be made of symbol
    // characters — `++`, `<+>`, `\\` — and such a name may be bound like any
    // other. The fixity table already accepted them (`infixr 5 ++` parsed),
    // which was the giveaway: the table took names the parser could not bind.
    //
    // Only runs of TWO OR MORE are considered, and only when the run is not one
    // of the language's own spellings. Every single-character operator keeps
    // its existing path untouched, so nothing about `+` or `~` changes.
    if (SYMBOLIC.test(c)) {
      let k = i;
      while (k < n && SYMBOLIC.test(src[k])) k++;
      const run = src.slice(i, k);
      if (run.length >= 2 && !KNOWN_SYMBOLIC.has(run)) {
        toks.push({ t: 'IDENT', v: run });
        i = k;
        continue;
      }
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
      // A character literal takes the SAME escapes a string does — `#"\\"` is a
      // backslash and `#"\n"` is a newline. They were not decoded here, so
      // Harper's regexp tokenizer, which matches `#"\\"` to spot an escaped
      // character in a pattern, could not be lexed at all.
      const r = readEscaped(src, i + 2, n, '"');
      if (r.text.length !== 1) throw new RonmlError('a character is one letter: #"a"');
      if (src[r.at] !== '"') throw new RonmlError('a character is one letter: #"a"');
      toks.push({ t: 'CHAR', v: r.text });
      i = r.at + 1;
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
      const r = readEscaped(src, i + 1, n, '"');
      if (r.at >= n) throw new RonmlError('unterminated string — a " has no closing "');
      toks.push({ t: 'STR', v: r.text });
      i = r.at + 1;
      continue;
    }
    if (/[0-9]/.test(c)) {
      // A WORD, which Standard ML writes 0w5 and 0wx1F. `Word` here holds a
      // non-negative int and prints as uppercase hex, so the literal only has
      // to reach the lexer: nothing downstream needs a tag of its own.
      // Checked before the hex branch, since `0wx…` begins with `0w`.
      if (src[i] === '0' && (src[i + 1] === 'w' || src[i + 1] === 'W')) {
        const hex = src[i + 2] === 'x' || src[i + 2] === 'X';
        const from = i + (hex ? 3 : 2);
        const digits = hex ? /[0-9a-fA-F]/ : /[0-9]/;
        if (digits.test(src[from] || '')) {
          let w = from;
          while (w < n && digits.test(src[w])) w++;
          toks.push({ t: 'NUM', v: parseInt(src.slice(from, w), hex ? 16 : 10), real: false });
          i = w;
          continue;
        }
      }
      // Hexadecimal, which Standard ML writes 0x1F.
      if (src[i] === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X') && /[0-9a-fA-F]/.test(src[i + 2] || '')) {
        let h = i + 2;
        while (h < n && /[0-9a-fA-F]/.test(src[h])) h++;
        toks.push({ t: 'NUM', v: parseInt(src.slice(i + 2, h), 16), real: false });
        i = h;
        continue;
      }
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
      // Scientific notation: 1e3, 1.5e~2. SML writes a negative exponent with a
      // tilde like every other negative number, so both spellings are taken.
      if ((src[j] === 'e' || src[j] === 'E')
          && /[0-9~-]/.test(src[j + 1] || '')
          && /[0-9]/.test(src[j + 1] === '~' || src[j + 1] === '-' ? (src[j + 2] || '') : src[j + 1])) {
        real = true;
        let k = j + 1;
        if (src[k] === '~' || src[k] === '-') k++;
        while (k < n && /[0-9]/.test(src[k])) k++;
        const mantissa = src.slice(i, j);
        const exp = src.slice(j + 1, k).replace('~', '-');
        toks.push({ t: 'NUM', v: parseFloat(mantissa) * Math.pow(10, parseInt(exp, 10)), real: true });
        i = k;
        continue;
      }
      toks.push({ t: 'NUM', v: parseFloat(src.slice(i, j)), real });
      i = j;
      continue;
    }
    // `~` is SML's unary minus. It was missing because it was never lexed.
    // `~` is SML's unary minus, and whitespace is allowed between it and what it
    // negates: `~ 3` is minus three. Only the tight form was lexed.
    if (c === '~') {
      let k = i + 1;
      while (k < n && /\s/.test(src[k])) k++;
      if (/[0-9(a-zA-Z]/.test(src[k] || '')) { toks.push({ t: 'NEG' }); i = k; continue; }
    }
    if (/[A-Za-z_]/.test(c) || (c === "'" && /[A-Za-z]/.test(src[i + 1] || ''))) {
      let j = i + 1;
      // `.` is allowed inside an identifier so filenames lex as one token
      // (factory_id.ml, readme.md) — evalNode tags anything ending .ml/.md a file.
      // `-` is NOT: it is the subtraction operator now (codes/filenames underscore).
      while (j < n && /[A-Za-z0-9_.']/.test(src[j])) j++;
      // A structure's member may be SYMBOLIC: `Word.<<`, `Word8.~>>`. The run
      // above stops at the `<`, which left `Word.` as one token and `<<` as the
      // next, so the member could not be reached at all — Word's shift
      // operators were unbindable and unusable.
      if (src[j - 1] === '.' && SYMBOLIC.test(src[j] || '')) {
        while (j < n && SYMBOLIC.test(src[j])) j++;
      }
      toks.push({ t: 'IDENT', v: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new RonmlError(`unexpected character '${c}'`);
  }
  toks.push({ t: 'EOF' });
  return toks;
}
