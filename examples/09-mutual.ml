(* Two functions that need each other. `and` joins them so each is in scope
   inside the other. *)

fun even 0 = true
  | even n = odd (n - 1)
and odd 0 = false
  | odd n = even (n - 1)

val fourIsEven = even 4
val fourIsOdd = odd 4

(* The same shape over a list: one function for each alternating position. *)
fun evens nil = nil
  | evens (h :: t) = h :: odds t
and odds nil = nil
  | odds (_ :: t) = evens t

val everyOther = evens [1, 2, 3, 4, 5, 6]

(* `and` also joins plain bindings, and those happen at the same moment: both
   right-hand sides are worked out before either name exists. *)
val a = 1 and b = 2
val swapped = (b, a)
