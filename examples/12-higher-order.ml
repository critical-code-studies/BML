(* map, filter and fold. Three ways of walking a list, each taking a function
   as an argument. *)

val doubled = map (fn n => n * 2) [1, 2, 3]
val shouted = map Char.toUpper (explode "abc")

val odds = List.filter (fn n => n mod 2 = 1) [1, 2, 3, 4, 5]

(* `foldl` carries an accumulator from the left. Its function takes a pair:
   the item, and the answer so far. *)
val added = foldl (fn (x, acc) => x + acc) 0 [1, 2, 3, 4]
val biggest = foldl Int.max 0 [3, 9, 2]

(* `foldr` goes from the right, which is what you want when the operator
   leans that way. Cons does, so this rebuilds the list as it was. *)
val rebuilt = foldr (fn (x, acc) => x :: acc) nil [1, 2, 3]

(* All three can be written with fold, which is the point of fold. *)
fun myMap f xs = foldr (fn (x, acc) => f x :: acc) nil xs
fun myFilter p xs = foldr (fn (x, acc) => if p x then x :: acc else acc) nil xs

val viaFold = myMap (fn n => n + 1) [1, 2, 3]

(* A function that answers a function. *)
fun times n = fn m => n * m
val sixTimes = times 6
val fortyTwo = sixTimes 7
