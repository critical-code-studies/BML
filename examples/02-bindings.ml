(* Bindings. A name, and how long it lasts. *)

val x = 10

(* A later binding of the same name hides the earlier one. It does not change
   it: anything that already captured the old one still sees the old one. *)
fun addTen n = n + x
val x = 99
val stillTen = addTen 1

(* `let` opens a scope that closes at `end`, so `scratch` is gone afterwards. *)
val area =
  let
    val width = 4
    val height = 5
  in
    width * height
  end

(* A binding can take a value apart as it names it. *)
val (a, b) = (1, 2)
val {title = t, year = y} = {title = "Poplog", year = 1981}
(* A list is taken apart with `case`, which names both ends at once. *)
val (first, rest) = case [1, 2, 3] of h :: t => (h, t) | nil => (0, nil)
