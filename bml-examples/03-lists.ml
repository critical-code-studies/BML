(* Lists. A list is nil, or a value cons'd onto a list. That is the whole
   definition, and every function below is written from it. *)

val empty = nil
val three = 1 :: 2 :: 3 :: nil
val same = [1, 2, 3]
val joined = [1, 2] @ [3, 4]

(* Write the library yourself: this is exactly how the prelude does it. *)
fun myLength nil = 0
  | myLength (_ :: t) = 1 + myLength t

fun myMap f nil = nil
  | myMap f (h :: t) = f h :: myMap f t

fun myFilter p nil = nil
  | myFilter p (h :: t) = if p h then h :: myFilter p t else myFilter p t

fun sum nil = 0
  | sum (h :: t) = h + sum t

val counted = myLength [4, 5, 6, 7]
val doubled = myMap (fn x => x * 2) [1, 2, 3]
val evens = myFilter (fn x => x mod 2 = 0) [1, 2, 3, 4, 5, 6]
val total = sum [1, 2, 3, 4, 5]

(* Reverse, by folding the list onto an accumulator. *)
fun rev l =
  let fun go (nil, acc) = acc
        | go (h :: t, acc) = go (t, h :: acc)
  in go (l, nil) end

val backwards = rev [1, 2, 3, 4]

(* The library has these too, and they are written in BML: read src/basis.js. *)
val fromLib = List.filter (fn x => x > 2) [1, 2, 3, 4]
val parts = List.partition (fn x => x mod 2 = 0) [1, 2, 3, 4, 5, 6]
val found = List.find (fn x => x > 3) [1, 2, 3, 4, 5]
