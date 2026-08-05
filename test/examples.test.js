// Every file in examples/ must run, under the DEFAULT checker.
//
// They are documentation, and documentation that does not run is worse than
// none — but they are also the broadest test in the repository, because each
// one uses the language the way somebody learning it would rather than the way
// a unit test does. Writing them found four defects in an afternoon: the
// checker ignoring a constructor's declared payload types, `Int.toString`
// inferring `string -> string`, comparison being numbers-only so one sort
// could not do words, and `List.length` simply missing.

import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const BML = new URL('../bin/bml.js', import.meta.url).pathname;
const DIR = new URL('../examples/', import.meta.url).pathname;

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.ml')).sort();

test('there are examples to run', () => {
  assert.ok(files.length >= 9, `expected the examples to be there, found ${files.length}`);
});

for (const f of files) {
  test(`examples/${f} runs under the default strict checker`, () => {
    let out = '', status = 0;
    try {
      out = execFileSync('node', [BML, DIR + f], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      out = `${e.stdout || ''}${e.stderr || ''}`;
      status = e.status;
    }
    assert.equal(status, 0, `${f} exited ${status}:\n${out}`);
    assert.doesNotMatch(out, /^ERR:/m, `${f} reported an error:\n${out}`);
  });
}

test('the examples README lists every file that is there', () => {
  const readme = fs.readFileSync(`${DIR}README.md`, 'utf8');
  for (const f of files) {
    assert.match(readme, new RegExp(f.replace(/[.]/g, '\\.')), `README does not mention ${f}`);
  }
});
