(* Four sorts, each in a few lines, and none of them mutating anything. *)

fun insert (x, nil) = [x]
  | insert (x, h :: t) = if x <= h then x :: h :: t else h :: insert (x, t)

fun insertionSort nil = nil
  | insertionSort (h :: t) = insert (h, insertionSort t)

(* Quicksort, which is really "partition and recur". *)
fun quicksort nil = nil
  | quicksort (pivot :: rest) =
      let val (smaller, larger) = List.partition (fn x => x < pivot) rest
      in quicksort smaller @ [pivot] @ quicksort larger end

(* Mergesort. Split, sort the halves, then walk them together. *)
fun merge (nil, ys) = ys
  | merge (xs, nil) = xs
  | merge (x :: xs, y :: ys) =
      if x <= y then x :: merge (xs, y :: ys)
      else y :: merge (x :: xs, ys)

fun split nil = (nil, nil)
  | split [x] = ([x], nil)
  | split (x :: y :: rest) =
      let val (a, b) = split rest in (x :: a, y :: b) end

fun mergesort nil = nil
  | mergesort [x] = [x]
  | mergesort l =
      let val (a, b) = split l in merge (mergesort a, mergesort b) end

val numbers = [5, 2, 9, 1, 7, 3, 8, 2, 6]

val byInsertion = insertionSort numbers
val byQuick = quicksort numbers
val byMerge = mergesort numbers
val allAgree = byInsertion = byQuick andalso byQuick = byMerge

(* The comparisons work on strings too, so the same code sorts words. *)
val words = ["pear", "apple", "fig", "cherry", "date"]
val sortedWords = quicksort words

(* And on characters. *)
val letters = implode (quicksort (explode "sorting"))
