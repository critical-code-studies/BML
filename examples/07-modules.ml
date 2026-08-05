(* Modules. A structure groups declarations; a signature says which of them the
   outside world may see; a functor is a structure that takes a structure. *)

structure Queue = struct
  (* Two lists: the front, and the back held in reverse. Pushing is cheap and
     popping is cheap amortised, because the back is flipped only when the
     front runs out. *)
  val empty = (nil, nil)

  fun push (x, (f, b)) = (f, x :: b)

  fun pop (nil, nil) = NONE
    | pop (nil, b) = pop (List.rev b, nil)
    | pop (h :: f, b) = SOME (h, (f, b))

  fun toList q =
    case pop q of
        NONE => nil
      | SOME (x, rest) => x :: toList rest
end

val q = Queue.push (3, Queue.push (2, Queue.push (1, Queue.empty)))
val drained = Queue.toList q

(* A signature restricts what is visible. *)
signature COUNTER = sig
  val start : int
  val bump : int
end

structure Counter : COUNTER = struct
  val start = 0
  val bump = 1
  val secret = 99
end

val from = Counter.start

(* A functor takes a structure and gives back a structure. *)
signature ORDERED = sig
  val below : int
end

structure Ten = struct val below = 10 end

functor Filtered (K : ORDERED) = struct
  fun keep l = List.filter (fn x => x < K.below) l
end

structure Small = Filtered (Ten)
val kept = Small.keep [3, 12, 7, 40, 1]
