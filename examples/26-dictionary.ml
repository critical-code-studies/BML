(* A dictionary, built over any ordered key. The tree from an earlier example,
   with the comparison supplied from outside. *)

signature ORDERED = sig
  type t
  val compare : t * t -> order
end

signature DICT = sig
  type key
  type 'a dict
  val empty : 'a dict
  val insert : 'a dict * key * 'a -> 'a dict
  val lookup : 'a dict * key -> 'a option
  val keys : 'a dict -> key list
end

functor Dict (structure Key : ORDERED) :> DICT where type key = Key.t = struct
  type key = Key.t
  datatype 'a dict = Empty | Node of 'a dict * key * 'a * 'a dict

  val empty = Empty

  fun insert (Empty, k, v) = Node (Empty, k, v, Empty)
    | insert (Node (l, k', v', r), k, v) =
        case Key.compare (k, k') of
            LESS => Node (insert (l, k, v), k', v', r)
          | GREATER => Node (l, k', v', insert (r, k, v))
          | EQUAL => Node (l, k, v, r)

  fun lookup (Empty, _) = NONE
    | lookup (Node (l, k', v, r), k) =
        case Key.compare (k, k') of
            LESS => lookup (l, k)
          | GREATER => lookup (r, k)
          | EQUAL => SOME v

  fun keys Empty = nil
    | keys (Node (l, k, _, r)) = keys l @ [k] @ keys r
end

structure StringKey : ORDERED = struct
  type t = string
  fun compare (a, b) = String.compare (a, b)
end

structure Phone = Dict (structure Key = StringKey)

val book =
  Phone.insert (Phone.insert (Phone.insert (Phone.empty, "ada", 1815),
                              "alan", 1912), "grace", 1906)

val alan = Phone.lookup (book, "alan")
val bob = Phone.lookup (book, "bob")
val everyone = Phone.keys book
