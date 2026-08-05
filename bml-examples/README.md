# Examples

Each file runs on its own and prints what it bound:

```
bml examples/01-first-steps.ml
```

Or read one in at the prompt and poke at what it leaves behind:

```
$ bml
- use "examples/08-sorting.ml";
- quicksort [9, 1, 5]
val it = [1, 5, 9] : int list
```

They run under the default strict checker, so everything here typechecks as
well as evaluating. If you want to watch a type go wrong, edit one and rerun.

| | |
|---|---|
| `01-first-steps.ml` | values, arithmetic, why `int` and `real` do not mix |
| `02-functions.ml` | clauses, currying, functions as values, composition |
| `03-lists.ml` | writing `map`, `filter` and `foldl` yourself from `nil` and `::` |
| `04-your-own-types.ml` | `datatype`, pattern matching, an expression evaluator |
| `05-fizzbuzz.ml` | the traditional one, with no loop in it |
| `06-fun-and-games.ml` | Fibonacci, Collatz, roman numerals, palindromes, Caesar |
| `07-modules.ml` | a queue, a signature that hides a name, a functor |
| `08-sorting.ml` | insertion, quick and merge sort, over numbers *and* words |
| `09-eight-queens.ml` | the whole search in one recursive function, and a drawn board |

Roughly in order. The first three assume nothing; the last three assume the
first six.

## Things worth trying

Break something on purpose. The checker runs before anything else does:

```
- val n : int = "seven"
ERR: string and int are not the same type
```

Ask what a function is, without running it:

```
- :t List.partition
('a -> bool) -> 'a list -> 'a list * 'a list
```

Write a sort once and use it on three types, which is what let-polymorphism is
for:

```
- quicksort [3, 1, 2]
- quicksort ["pear", "apple"]
- quicksort (explode "sorting")
```

Leave a case out and see what you are told:

```
- datatype colour = Red | Green | Blue
- fun name Red = "red" | name Green = "green"
  WARNING: this case does not cover Blue
```

## Two things that will trip you

**Multi-line clausal definitions only work in a file.** The prompt reads one
line at a time, so a `|` continuation on its own line is a syntax error there.
Put the clauses on one line at the prompt, or write a file. Standard ML reads
until the declaration is complete; this does not, yet.

**`~` is negation and `-` is subtraction.** `~3` is minus three; `3 - 10` is
subtraction. They are different characters and Standard ML means it.
