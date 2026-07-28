// THE LEXER. Source text to a flat list of tokens.
//
// Part of src/lang/, the language proper: nothing here knows about NostOS, its
// terminals, or its robots. See docs/aiml-standalone-plan.md.
//
// Moved out of src/game/ai_ml.js unchanged at v1.286 (M1). The only edits were
// the import below and the export keyword on tokenize.

import { RonmlError } from './errors.js';

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
