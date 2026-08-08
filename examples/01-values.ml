(* Values. The smallest thing you can type at a prompt. *)

val greeting = "hello, world"
val answer = 6 * 7

(* int and real are different types and do not mix. There are ways across. *)
val whole = 7
val fraction = 7.0 / 2.0
val crossed = real whole + 0.5

(* A negative number is written with a tilde. The minus sign is binary only. *)
val below = ~3
val gap = 3 - 10

(* Truncating division and its remainder, as Standard ML has them. *)
val q = 17 div 5
val r = 17 mod 5

(* A tuple holds a fixed number of things, of any types you like. *)
val point = (3, 4)
val mixed = (1, "one", #"1", true)

(* A record is a tuple whose parts have names. *)
val book = {title = "Poplog", year = 1981}
val when = #year book
