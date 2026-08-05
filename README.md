# BML

A little Standard ML, in plain JavaScript. No build step, no dependencies, no
`package.json`.

BML is a small implementation of Standard ML, the lexer, the parser, the type
inference, the standard library, all of it short enough that one person can hold
it in mind and follow what happens to a program between the typing and the
answer.

The compiler is opaque, the type error arrives from nowhere, and the student
learns to propitiate the machine rather than to understand it. Iteracy, by which
I mean the capacity to read and write computational processes rather than merely
operate them, depends on there being something available to read, and an
instrument whose parameters are visible is a different sort of object from one
whose parameters are hidden. A teaching interpreter can be the first sort, and
this one tries to be. The standard library is written in BML itself and loaded as
source, so the `map` you call is the `map` you could have written, and you can
open the file and confirm that it is.

Types are inferred rather than declared, a program that does not typecheck does
not run, and the tradition running from Milner's LCF is one of machine-checked
proof, of formality as a working condition rather than as decoration. Whether a
language of that kind teaches anything a survivor of a ruined world would need is
a question the game this grew inside asks rather than answers.

```
$ node bin/bml.js
BML 2.7   :quit to leave, :t for a type
- fun fact 0 = 1
=   | fact n = n * fact (n - 1)
val fact = <fn> : int -> int
- fact 10
val it = 3628800 : int
- List.partition (fn x => x > 2) [1,2,3,4]
val it = ([3, 4], [1, 2]) : int list * int list
- val x : int = "hello"
ERR: string and int are not the same type
```

## What is here

The core language: `val`, `fun` (clausal, curried, tuple-argument), `fn`, `let`,
`case`, `datatype` with type variables, records, tuples, exceptions, mutable
references, `local`, and `infix`/`infixr`/`nonfix`/`op`. Modules: `structure`,
`signature`, and generative functors.

Types are inferred by Hindley-Milner with the occurs check, let-polymorphism and
the value restriction, with exhaustiveness warnings on `case`. The Basis subset
is written in BML itself and loaded as source, so you can open `src/basis.js` and
read the same `map` you would have written.

It is measured rather than described. Against the 32 example files from Robert
Harper's *Introduction to Standard ML* course, this build runs **320 of 395
top-level declarations (81%)** as written, with no translation:

```
node tools/isml-conformance.mjs
```

That corpus is Harper's teaching material. The harness fetches it on first run
into a gitignored cache; it is **not** in this repository and is not
redistributed here.

## Using it

```
bml                 strict repl (a line that does not typecheck is refused)
bml --sloppy        advisory repl (the clash is named; the line runs)
bml file.ml …       run files and exit
bml -i file.ml      run files, then stay at the prompt
```

At the prompt: `use "file.ml";` reads a file in, `:t <expr>` gives a type without
evaluating, `:quit` leaves.

As a library:

```js
import { createInterpreter } from './src/index.js';

const bml = createInterpreter({ typecheck: 'strict' });
bml.loadPrelude();
bml.run('3 + 4').text;        // '7'
bml.typeReport('fn x => x');  // "'a -> 'a"
```

A host supplies its own verbs through `builtins`, and answers the language's
questions through `hooks`, so that the language calls host policy and never
reads host tables. `typecheck` is `'off' | 'report' | 'strict'` and `printing` is
`'sml' | 'bare'`.

## Where it came from

BML grew inside [NostOS](https://github.com/dmberry/nostos), a game in which you
type this language into the terminals of derelict machines. It still runs there,
under the in-fiction name AI-ML, through the same `createInterpreter`, differing
only in what it is passed: the game is **advisory** everywhere, because a machine
in a ruin should say what it worked out and let the operator decide.

The history in this repository is that history. `git log` reaches back to the
day the language got its name, and the file the whole thing grew inside travels
with it for the record even though the file itself is gone.

## What it is not

Not SML '97. The full Basis of 47 structures, `abstype`, sharing constraints and
functor signatures are years of work no teaching implementation attempts.

Known gaps, kept honest by a test that walks them: no `abstype`, no `open`, and
nothing outside `List`, `String`, `Char`, `Int`, `Real`, `Bool`, `Option`,
`ListPair`. Identifiers are lower-cased, which Standard ML does not do, so `foo`
and `Foo` name the same value. Recursion depth is the host's rather than the
interpreter's, so a deep non-tail recursion can exhaust the JavaScript stack
before the step budget notices.

## Licence

MIT. See [LICENSE](LICENSE). Harper's example corpus is his own teaching material
and is not included here under any licence; the conformance harness fetches it.

## Credit

BML created by David M. Berry, 2026.

Based on Standard ML developed by Robin Milner, Mads Tofte, and Robert Harper.
Many thanks to Robert Harper for the inspiration in his book *Introduction to
Standard ML* (1986), and to Åke Wikström for *Functional Programming Using
Standard ML* (1987).
