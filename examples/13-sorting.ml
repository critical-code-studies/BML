(* Two sorts, both written over the shape of a list. *)

(* Insertion sort. Put the head where it belongs in the sorted tail. *)
fun insert (x, nil) = [x]
  | insert (x, y :: ys) = if x <= y then x :: y :: ys else y :: insert (x, ys)

fun isort nil = nil
  | isort (h :: t) = insert (h, isort t)

val sorted = isort [5, 2, 9, 1, 7]

(* Quicksort. Split around the head, sort the halves, put them back.
   Polymorphic: the comparison is the only thing it needs, so it sorts
   anything that can be compared. *)
fun quicksort nil = nil
  | quicksort (pivot :: rest) =
      let
        val smaller = List.filter (fn x => x < pivot) rest
        val larger  = List.filter (fn x => x >= pivot) rest
      in
        quicksort smaller @ [pivot] @ quicksort larger
      end

val numbers = quicksort [9, 1, 5, 3, 7]
val words = quicksort ["pear", "apple", "fig"]

(* Merge two lists that are already in order, which is half of merge sort. *)
fun merge (nil, ys) = ys
  | merge (xs, nil) = xs
  | merge (x :: xs, y :: ys) =
      if x <= y then x :: merge (xs, y :: ys)
      else y :: merge (x :: xs, ys)

val merged = merge ([1, 4, 7], [2, 3, 9])
