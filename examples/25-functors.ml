(* A functor. A structure that takes a structure and answers a structure.

   It is how you write something once and get it for every type that supplies
   what it needs. *)

signature ORDERED = sig
  type t
  val compare : t * t -> order
end

structure IntOrder : ORDERED = struct
  type t = int
  fun compare (a, b) = Int.compare (a, b)
end

structure StringOrder : ORDERED = struct
  type t = string
  fun compare (a, b) = String.compare (a, b)
end

(* The sort is written once. It knows nothing about what it is sorting except
   that the argument structure can compare two of them. *)
functor Sorter (structure Elt : ORDERED) = struct
  structure Key = Elt
  fun insert (x, nil) = [x]
    | insert (x, y :: ys) =
        case Key.compare (x, y) of
            GREATER => y :: insert (x, ys)
          | _ => x :: y :: ys
  fun sort nil = nil
    | sort (h :: t) = insert (h, sort t)
end

structure IntSort = Sorter (structure Elt = IntOrder)
structure StringSort = Sorter (structure Elt = StringOrder)

val numbers = IntSort.sort [5, 2, 9, 1]
val words = StringSort.sort ["pear", "apple", "fig"]

(* Applying it again costs nothing, which is the argument for writing it this
   way rather than copying the sort twice. *)
structure Backwards = Sorter (structure Elt = struct
  type t = int
  fun compare (a, b) = Int.compare (b, a)
end)

val descending = Backwards.sort [5, 2, 9, 1]
