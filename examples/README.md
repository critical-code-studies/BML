# Examples

Thirty programs, in teaching order. Each runs on its own and prints what it
bound:

```
bml examples/01-values.ml
```

Or read one in at the prompt and poke at what it leaves behind:

```
$ bml
- use "examples/13-sorting.ml";
- quicksort [9, 1, 5]
val it = [1, 5, 9] : int list
```

They all run under the default strict checker, so everything here typechecks
as well as evaluating. If you want to watch a type go wrong, edit one and run
it again.

## First steps

- `01-values.ml` — values
- `02-bindings.ml` — bindings and scope
- `03-strings.ml` — strings and characters
- `04-functions.ml` — functions
- `05-choice.ml` — truth and choice

## Recursion

- `06-recursion.ml` — recursion
- `07-patterns.ml` — patterns
- `08-accumulators.ml` — accumulators
- `09-mutual.ml` — two functions that need each other
- `10-collatz.ml` — the Collatz sequence

## Lists

- `11-lists.ml` — lists
- `12-higher-order.ml` — map, filter and fold
- `13-sorting.ml` — sorting
- `14-pairs.ml` — two lists at once
- `15-run-length.ml` — run-length encoding
- `16-primes.ml` — primes

## Types of your own

- `17-datatypes.ml` — datatypes
- `18-options.ml` — option, and no null
- `19-trees.ml` — binary search trees
- `20-expressions.ml` — an expression evaluator
- `21-stack-machine.ml` — a stack machine
- `22-records.ml` — records

## Modules

- `23-structures.ml` — structures
- `24-signatures.ml` — signatures, and hiding
- `25-functors.ml` — functors
- `26-dictionary.ml` — a dictionary over any key

## Programs

- `27-fizzbuzz.ml` — FizzBuzz, three ways
- `28-eight-queens.ml` — eight queens
- `29-life.ml` — Conway's Life
- `30-turing.ml` — a Turing machine

---

`examples/index.json` is the same list in a form the web page reads.
`test/examples.test.js` walks this README, that manifest and the directory
against each other in both directions, so a file added without being listed
goes red, and so does a listing with no file behind it.
