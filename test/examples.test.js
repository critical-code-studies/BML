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
import os from 'node:os';

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

test('bml --examples copies them somewhere editable', () => {
  // Installed, the examples sit inside node_modules where nobody will find them
  // and nobody should edit them in place.
  const dir = fs.mkdtempSync(`${os.tmpdir()}/bml-ex-`);
  const out = execFileSync('node', [BML, '--examples', `${dir}/copied`], { encoding: 'utf8' });
  assert.match(out, /Copied \d+ files/);
  const copied = fs.readdirSync(`${dir}/copied`).filter((f) => f.endsWith('.ml'));
  assert.equal(copied.length, files.length, 'every example travels');
  // And a copied one still runs.
  const ran = execFileSync('node', [BML, `${dir}/copied/${copied[0]}`], { encoding: 'utf8' });
  assert.doesNotMatch(ran, /^ERR:/m);
});

test('bml --examples refuses to write over what is already there', () => {
  const dir = fs.mkdtempSync(`${os.tmpdir()}/bml-ex-`);
  execFileSync('node', [BML, '--examples', `${dir}/twice`], { encoding: 'utf8' });
  let status = 0, out = '';
  try { execFileSync('node', [BML, '--examples', `${dir}/twice`], { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }); }
  catch (e) { status = e.status; out = String(e.stdout || ''); }
  assert.notEqual(status, 0);
  assert.match(out, /already exists/);
});

test('the README head carries the credit and the version, and they agree', () => {
  // A version in prose goes stale the moment nobody checks it.
  const readme = fs.readFileSync(new URL('../README.md', import.meta.url).pathname, 'utf8');
  const head = readme.split('\n').slice(0, 12).join('\n');
  assert.match(head, /David M\. Berry, University of Sussex, 2026/);
  assert.match(head, /Milner, Mads Tofte, and Robert Harper/);
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url).pathname, 'utf8'));
  assert.match(head, new RegExp(`Version ${pkg.version.replace(/[.]/g, '\\.')}`),
    `the README head says a different version from package.json (${pkg.version})`);
});
