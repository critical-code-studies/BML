(* Lists. Built one item at a time, from the front. *)

val empty = nil
val one = 1 :: nil
val few = 1 :: 2 :: 3 :: nil
val same = [1, 2, 3]

(* Every item must be the same type, so this is a list of lists. *)
val nested = [[1, 2], [3], nil]

val joined = [1, 2] @ [3, 4]
val howMany = length joined

(* Taking one apart. The head is the first item; the tail is all the rest. *)
val first = hd few
val rest = tl few

(* Written as a function, over the two shapes a list can have. *)
fun mySum nil = 0
  | mySum (h :: t) = h + mySum t

val six = mySum [1, 2, 3]

fun myLength nil = 0
  | myLength (_ :: t) = 1 + myLength t

(* Building one, rather than walking it. *)
val squares = List.tabulate (5, fn i => i * i)
val counted = rev [1, 2, 3]
