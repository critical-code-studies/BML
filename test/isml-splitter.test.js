// NostOS — a postAI Odyssey.
// Copyright (C) 2026 David M. Berry
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU General Public License as published by the Free Software
// Foundation, either version 3 of the License, or (at your option) any later
// version. This program is distributed WITHOUT ANY WARRANTY; see the GNU
// General Public License for details: <https://www.gnu.org/licenses/>.

// The conformance harness's declaration splitter.
//
// This exists because the INSTRUMENT has been wrong three times, and each time
// it looked like a language regression: it ate the second colon of every
// `h::t`, it turned each second clause's defining `=` into `==`, and it split
// on the words `in` and `end`, cutting every `local … in … end` and every
// `structure S = struct … end` into fragments that could not parse alone. That
// last one accounted for roughly a quarter of all reported failures.
//
// A number produced by an untested instrument is not a measurement, so the
// splitter is tested like anything else now.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decls } from '../tools/isml-conformance.mjs';

test('a run of simple declarations splits one per declaration', () => {
  const src = [
    'fun length nil = 0',
    '  | length (_::t) = 1 + length t',
    '',
    'fun append (nil, l) = l',
    '  | append (h::t, l) = h :: append (t, l)',
  ].join('\n');
  const d = decls(src);
  assert.equal(d.length, 2);
  assert.match(d[0], /^fun length/);
  assert.match(d[1], /^fun append/);
  assert.match(d[0], /length t$/, 'the second clause stays with its first');
});

test('local … in … end is ONE declaration', () => {
  // The bug this file was written for. `in` and `end` were splitters, so this
  // came out as three fragments and all three failed to parse.
  const src = [
    'local',
    '    fun helper (nil, a) = a',
    '      | helper (h::t, a) = helper (t, h::a)',
    'in',
    '    fun rev l = helper (l, nil)',
    'end',
  ].join('\n');
  const d = decls(src);
  assert.equal(d.length, 1, `expected one declaration, got ${d.length}`);
  assert.match(d[0], /^local/);
  assert.match(d[0], /end$/);
});

test('a structure with an ascription is ONE declaration', () => {
  const src = [
    'structure IntDict :> DICT = struct',
    '  type key = int',
    '',                                   // a blank line INSIDE the block
    '  fun lt (x, y) = x < y',
    'end',
    '',
    'val d = IntDict.empty',
  ].join('\n');
  const d = decls(src);
  assert.equal(d.length, 2, `expected two declarations, got ${d.length}`);
  assert.match(d[0], /^structure IntDict/);
  assert.match(d[0], /end$/, 'the blank line inside the block did not end it');
  assert.match(d[1], /^val d/);
});

test('nesting is counted, not merely matched', () => {
  const src = [
    'structure S = struct',
    '  fun f x =',
    '    let val y = x + 1 in y end',      // a `let … end` inside the struct
    '  val z = 2',
    'end',
    '',
    'val q = 1',
  ].join('\n');
  const d = decls(src);
  assert.equal(d.length, 2, `expected two declarations, got ${d.length}`);
  assert.match(d[0], /^structure S/);
  assert.match(d[1], /^val q/);
});

test('a keyword inside a comment or a string does not split', () => {
  const src = [
    'val a = "end val fun"',
    'val b = 2',
    '(* val c = 3',
    '   fun d () = ()  *)',
    'val e = 4',
  ].join('\n');
  const d = decls(src);
  assert.equal(d.length, 3, `expected three declarations, got ${d.length}`);
  assert.match(d[0], /^val a/);
  assert.match(d[0], /"end val fun"/, 'the string survives intact');
  assert.match(d[2], /^val e/);
  assert.ok(!d.some((x) => /val c/.test(x)), 'the commented-out code is gone');
});

test('SML comments nest, and the stripper knows it', () => {
  // A non-greedy regex stops at the FIRST `*)`, which would leave `val b = 2`
  // outside the comment and count a declaration that is not there.
  const src = [
    '(* outer (* inner *) still outer',
    '   val b = 2 *)',
    'val c = 3',
  ].join('\n');
  const d = decls(src);
  assert.equal(d.length, 1, `expected one declaration, got ${d.length}`);
  assert.match(d[0], /^val c/);
});

test('every declaration handed over is non-empty and starts with a keyword', () => {
  const src = [
    '(* a header comment *)',
    '',
    'signature Q = sig',
    '  val e : int',
    'end',
    '',
    '',
    'structure R = struct val e = 0 end',
  ].join('\n');
  const d = decls(src);
  assert.equal(d.length, 2);
  for (const x of d) {
    assert.ok(x.trim().length, 'no empty fragments');
    assert.match(x, /^(fun|val|datatype|type|exception|local|structure|signature|functor|infix|open|abstype)\b/);
  }
});
