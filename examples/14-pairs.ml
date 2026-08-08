(* Working with two lists at once. *)

val zipped = ListPair.zip ([1, 2, 3], ["one", "two", "three"])
val (numbers, names) = ListPair.unzip zipped

(* Written out, so you can see what zip does. It stops at the shorter one. *)
fun myZip (nil, _) = nil
  | myZip (_, nil) = nil
  | myZip (x :: xs, y :: ys) = (x, y) :: myZip (xs, ys)

val short = myZip ([1, 2, 3], ["a", "b"])

(* Adding two lists item by item. *)
fun addLists (xs, ys) = map (fn (a, b) => a + b) (ListPair.zip (xs, ys))
val summed = addLists ([1, 2, 3], [10, 20, 30])

(* A dot product falls straight out of it. *)
fun dot (xs, ys) = foldl (fn (n, acc) => n + acc) 0 (addLists (xs, ys))

(* Pairing each item with its position. *)
fun withIndex xs = ListPair.zip (List.tabulate (length xs, fn i => i), xs)
val positioned = withIndex ["a", "b", "c"]
