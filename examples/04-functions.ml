(* Functions. *)

fun double n = n * 2
val four = double 2

(* Two arguments, curried: `add 1` is itself a function. *)
fun add a b = a + b
val addOne = add 1
val three = addOne 2

(* Or take a tuple, if the two belong together. The annotations say `real`,
   which the arithmetic on its own would have read as `int`. *)
fun distance (x : real, y : real) = Math.sqrt (x * x + y * y)
val five = distance (3.0, 4.0)

(* A function with no name. *)
val triple = fn n => n * 3

(* Functions are values, so they go in and out of other functions. *)
fun twice f x = f (f x)
val twelve = twice double 3

(* Composition, right to left, as the mathematics writes it. *)
val addThenDouble = double o addOne
val eight = addThenDouble 3

(* The type is worked out, not declared. Ask for it with :t at the prompt. *)
fun identity x = x
