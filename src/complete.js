// BML — a 2026 Standard ML. Part of NostOS; synced to the BML repository.
// Copyright (C) 2026 David M. Berry
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU General Public License as published by the Free Software
// Foundation, either version 3 of the License, or (at your option) any later
// version. This program is distributed WITHOUT ANY WARRANTY; see the GNU
// General Public License for details: <https://www.gnu.org/licenses/>.

// Tab completion, as a pure function.
//
// It lives here rather than in either prompt because there are two of them —
// the CLI's readline and the page's input — and a rule written twice is a rule
// that drifts. This module knows nothing about a terminal: hand it the text,
// where the caret is, and two lookups, and it answers what could go there.
//
// The two lookups are the ones the "did you mean `Date`?" diagnostics already
// built and never exposed: every name in scope, and the members of a structure.

// What a learner most wants to be reminded of, and what is in no session:
// keywords are the parser's, not the environment's. Kept beside DECL_KEYWORDS
// in spirit — that list is the declarations, this adds the expression forms and
// the two words that open a block.
export const COMPLETION_KEYWORDS = [
  'val', 'fun', 'type', 'datatype', 'abstype', 'exception', 'structure',
  'signature', 'functor', 'local', 'open', 'infix', 'infixr', 'nonfix',
  'withtype', 'let', 'in', 'end', 'if', 'then', 'else', 'case', 'of', 'fn',
  'handle', 'raise', 'while', 'do', 'andalso', 'orelse', 'sig', 'struct',
  'true', 'false', 'nil', 'ref', 'op', 'as', 'rec',
];

// A word here is what an ML name can be made of, plus the dot that qualifies
// it. Symbolic operators are deliberately not completed: `+` has nothing useful
// to offer and a prefix of one symbol would match half the Basis.
const WORD_CHAR = /[A-Za-z0-9_'.]/;

/** Where the word under the caret starts. */
function wordStart(text, caret) {
  let i = caret;
  while (i > 0 && WORD_CHAR.test(text[i - 1])) i--;
  return i;
}

/**
 * What could be typed at the caret.
 *
 * @param text   the line being edited
 * @param caret  index into it
 * @param api    { knownNames, membersOf } — as returned by createInterpreter
 * @param opts   { keywords = true }
 * @returns { from, to, word, candidates } — `from`..`to` is the span to
 *          replace, `candidates` are whole words in their real spelling.
 */
export function complete(text, caret, api = {}, opts = {}) {
  const src = String(text == null ? '' : text);
  const at = Math.max(0, Math.min(src.length, caret == null ? src.length : caret));
  const from = wordStart(src, at);
  const word = src.slice(from, at);
  const empty = { from, to: at, word, candidates: [] };

  const dot = word.lastIndexOf('.');
  // CASE-INSENSITIVE MATCHING, case-preserving completion. The language is
  // case-sensitive (v1.306) but NostOS folds, so a host that folds must still
  // get `List.map` back from `list.m`. The candidate keeps its real spelling.
  const startsWith = (name, pre) => name.toLowerCase().startsWith(pre.toLowerCase());
  const uniqSort = (xs) => [...new Set(xs)].sort((a, b) => a.localeCompare(b));

  if (dot >= 0) {
    // `List.f` — the head names a structure, the tail is the prefix. An unknown
    // head answers nothing rather than falling back to the global list, which
    // would offer `List.datatype` and other nonsense.
    const typed = word.slice(0, dot);
    const pre = word.slice(dot + 1);
    if (!typed || !api.membersOf) return empty;
    // Resolve the HEAD case-insensitively as well, or a folding host gets
    // nothing from `list.m`: membersOf looks up `list.` and the session holds
    // `List.`. The completion carries the structure's real spelling back, which
    // is what a case-sensitive host needs and a folding one does not mind.
    const head = (api.knownNames ? api.knownNames() : [])
      .find((n) => n.toLowerCase() === typed.toLowerCase()) || typed;
    const members = api.membersOf(head, Infinity) || [];
    return {
      from,
      to: at,
      word,
      candidates: uniqSort(members.filter((mName) => startsWith(mName, pre))).map((mName) => `${head}.${mName}`),
    };
  }

  const names = (api.knownNames ? api.knownNames() : []) || [];
  const pool = opts.keywords === false ? names : [...names, ...COMPLETION_KEYWORDS];
  // An empty prefix offers everything. That is what a reader pressing Tab on a
  // blank line is asking for, and readline pages a long list rather than
  // dumping it.
  return { from, to: at, word, candidates: uniqSort(pool.filter((n) => startsWith(n, word))) };
}

/**
 * The shape node's readline wants: [matches, wordBeingCompleted].
 *
 * readline replaces the trailing substring of the line that equals the second
 * element, so the word handed back must be exactly what was typed — including
 * the `List.` part of a qualified name, or it replaces only the tail and leaves
 * the head behind.
 */
export function readlineCompleter(line, api, opts) {
  const r = complete(line, line.length, api, opts);
  return [r.candidates, r.word];
}

/**
 * The longest prefix every candidate shares, for a prompt that fills in as far
 * as it can before offering a list. Answers the word itself when they diverge
 * immediately, so a caller can tell "nothing to add" from "one answer".
 */
export function commonPrefix(candidates) {
  if (!candidates || !candidates.length) return '';
  let pre = candidates[0];
  for (const c of candidates.slice(1)) {
    let i = 0;
    while (i < pre.length && i < c.length && pre[i].toLowerCase() === c[i].toLowerCase()) i++;
    pre = pre.slice(0, i);
    if (!pre) break;
  }
  return pre;
}
