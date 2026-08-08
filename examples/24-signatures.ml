(* A signature says what a structure shows. Everything else stays inside. *)

signature STACK = sig
  type 'a stack
  val empty : 'a stack
  val push : 'a * 'a stack -> 'a stack
  val pop : 'a stack -> ('a * 'a stack) option
  val depth : 'a stack -> int
end

(* `:>` is OPAQUE ascription. The type stays abstract, so nobody outside can
   rely on a stack being a list, and you are free to change your mind later. *)
structure Stack :> STACK = struct
  type 'a stack = 'a list
  val empty = nil
  fun push (x, s) = x :: s
  fun pop nil = NONE
    | pop (h :: t) = SOME (h, t)
  fun depth s = length s
  fun secret s = s          (* not in the signature, so not visible outside *)
end

val s = Stack.push (2, Stack.push (1, Stack.empty))
val howDeep = Stack.depth s
val popped = Stack.pop s

(* `Stack.secret` is not there to be called, which is the point of the
   signature. Uncomment the next line and the checker will say so.

   val leaked = Stack.secret s *)

(* A queue, with the same shape of interface over different insides. *)
signature QUEUE = sig
  type 'a queue
  val empty : 'a queue
  val enqueue : 'a * 'a queue -> 'a queue
  val toList : 'a queue -> 'a list
end

structure Queue :> QUEUE = struct
  type 'a queue = 'a list
  val empty = nil
  fun enqueue (x, q) = q @ [x]
  fun toList q = q
end

val q = Queue.enqueue (2, Queue.enqueue (1, Queue.empty))
val inOrder = Queue.toList q
