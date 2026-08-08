(* Run-length encoding. "aaabbc" becomes [(3,#"a"), (2,#"b"), (1,#"c")].

   A small thing that is genuinely useful, and it shows a fold carrying
   something more interesting than a number. *)

fun encode nil = nil
  | encode (h :: t) =
      let
        fun go (nil, run, item, out) = rev ((run, item) :: out)
          | go (x :: xs, run, item, out) =
              if x = item then go (xs, run + 1, item, out)
              else go (xs, 1, x, (run, item) :: out)
      in
        go (t, 1, h, nil)
      end

val runs = encode (explode "aaabbbbcd")

(* Undoing it. `List.tabulate` makes the copies. *)
fun decode pairs =
  List.concat (map (fn (n, x) => List.tabulate (n, fn _ => x)) pairs)

val backAgain = implode (decode runs)

(* Which should be what we started with. *)
val roundTrip = backAgain = "aaabbbbcd"

(* The same encoding over numbers, since nothing above mentioned characters. *)
val numberRuns = encode [1, 1, 1, 2, 2, 3]
