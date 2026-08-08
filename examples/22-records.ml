(* Records. A tuple whose parts have names, which matters once there are more
   than two or three. *)

type point = {x : real, y : real}

val origin = {x = 0.0, y = 0.0}
val somewhere = {x = 3.0, y = 4.0}

val across = #x somewhere

fun distance ({x = x1, y = y1} : point, {x = x2, y = y2} : point) =
  Math.sqrt ((x1 - x2) * (x1 - x2) + (y1 - y2) * (y1 - y2))

val five = distance (origin, somewhere)

(* A record type of your own, used as a datatype's payload. *)
type person = {name : string, born : int}

val ada = {name = "Ada Lovelace", born = 1815}
val alan = {name = "Alan Turing", born = 1912}

fun older (a : person, b : person) = if #born a < #born b then a else b
val earlier = #name (older (ada, alan))

(* Naming the type says which record you mean, so `#name` knows where to look.
   Standard ML also writes `{name = n, ...}` to mean "and other fields I do not
   care about"; that needs row polymorphism, which this build does not have,
   so the annotation does the same job here. *)
fun greet (p : person) = "hello, " ^ #name p
val hello = greet ada

val people = [ada, alan]
val names = map #name people
val years = map #born people
