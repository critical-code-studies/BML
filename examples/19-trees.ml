(* A binary search tree. The type is recursive, so the functions are too. *)

datatype 'a tree = Leaf | Node of 'a tree * 'a * 'a tree

fun insert (Leaf, x) = Node (Leaf, x, Leaf)
  | insert (Node (l, v, r), x) =
      if x < v then Node (insert (l, x), v, r)
      else if x > v then Node (l, v, insert (r, x))
      else Node (l, v, r)

fun member (Leaf, _) = false
  | member (Node (l, v, r), x) =
      if x = v then true
      else if x < v then member (l, x) else member (r, x)

fun fromList xs = foldl (fn (x, t) => insert (t, x)) Leaf xs

val t = fromList [5, 3, 8, 1, 9, 7]

val hasEight = member (t, 8)
val hasFour = member (t, 4)

(* Walking it in order gives the items sorted, which is the whole trick. *)
fun toList Leaf = nil
  | toList (Node (l, v, r)) = toList l @ [v] @ toList r

val sorted = toList t

fun depth Leaf = 0
  | depth (Node (l, _, r)) = 1 + Int.max (depth l, depth r)

val howDeep = depth t

fun count Leaf = 0
  | count (Node (l, _, r)) = 1 + count l + count r

(* Nothing above says what is in the tree, so it holds anything ordered. *)
val words = toList (fromList ["pear", "fig", "apple"])
