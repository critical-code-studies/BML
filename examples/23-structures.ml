(* A structure. A group of declarations under one name. *)

structure Counter = struct
  val start = 0
  fun bump n = n + 1
  fun bumpBy (n, k) = n + k
end

val one = Counter.bump Counter.start
val five = Counter.bumpBy (Counter.start, 5)

(* `open` brings the names into scope without the prefix. Handy at a prompt,
   less so in a program, where the prefix is what tells the reader where a
   name came from. *)
structure Temperature = struct
  fun toFahrenheit c = c * 9.0 / 5.0 + 32.0
  fun toCelsius f = (f - 32.0) * 5.0 / 9.0
end

val boiling = Temperature.toFahrenheit 100.0

(* One structure may be named under another. Nothing is copied: the names are
   the same names. *)
structure T = Temperature
val same = T.toFahrenheit 100.0

(* A structure may hold a type as well as values, which is what makes it a
   module rather than a namespace. *)
structure Money = struct
  type amount = int
  val zero : amount = 0
  fun add (a : amount, b : amount) = a + b
  fun show (a : amount) = Int.toString (a div 100) ^ "." ^ Int.toString (a mod 100)
end

val total = Money.add (Money.zero, 350)
val printed = Money.show total
