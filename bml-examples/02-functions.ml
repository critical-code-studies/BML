(* Functions, and the several ways to write one. *)

fun square x = x * x
val nine = square 3

(* A function with no name. *)
val double = fn x => x * 2
val eight = double 4

(* CLAUSES, tried in order. This is how Standard ML writes a base case. *)
fun factorial 0 = 1
  | factorial n = n * factorial (n - 1)

val big = factorial 12

(* Two arguments, curried, so the function may be applied to one of them. *)
fun add a b = a + b
val addTen = add 10
val fifteen = addTen 5

(* Or take a pair, which is one argument that happens to be a tuple. *)
fun addPair (a, b) = a + b
val also = addPair (10, 5)

(* Functions are values: they go into lists and come back out. *)
val ops = [square, double, addTen]
fun applyAll (nil, x) = nil
  | applyAll (f :: fs, x) = f x :: applyAll (fs, x)

val results = applyAll (ops, 6)

(* Composition, which is infix here as it is in Standard ML. *)
val squareThenDouble = double o square
val fifty = squareThenDouble 5
