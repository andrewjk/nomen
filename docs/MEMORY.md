# Memory Management

Nomen uses automatic memory management with deterministic cleanup at scope boundaries. No garbage collector or reference counting is needed — the compiler inserts allocation and deallocation code at compile time.

This document describes memory behavior at two levels: what Nomen programmers can expect (user-facing semantics), and how the aarch64 backend generates code to achieve it (code generation internals).

## User-Facing Semantics

### Strings

Strings are heap-allocated. The compiler tracks which variables hold heap strings and frees them automatically when they go of scope or are reassigned.

```
var string name = "Alice"      // heap allocation
name = "Bob"                   // old string freed, new one allocated
// end of scope: "Bob" freed
```

String interpolation (`"\{expr}"`) creates temporary heap allocations that are freed at the end of the enclosing scope.

`string` is the **own** form (heap, freed at scope exit); `view string` is the non-mv `(ptr, len)` borrow. This own/borrow distinction is the string analog of `Array<T>` vs `view T` — see ARRAY.md.

`string` is a **declared mv type** (STRUCT_PLAN_3 D3). Copying one binding to another therefore needs a marker: `mv b = a` (transfer; `a` invalid afterwards) or `b = a.copy()` (deep copy; both usable). The same rule makes `return self.name`, `var n = obj.name` (field reads), a bare string parameter stored into a string field, and container stores (`xs.push(s)`, `m.set(k, v)`) demand `mv`/`.copy()`. String literals and `null` are fresh values — no marker. `view string` is the cheap read-only passing form.

**Fat-string representation**: `string` is a 16-byte `nomen_string { char* ptr; long len; }` value. `.length` is a field load (O(1), no strlen). The buffer stays NUL-terminated at `ptr[len]`, so libc/FFI consumers (`printf %s`, `fopen`, `stringWithUTF8String:`) work unchanged. Literal lengths are compile-time constants (`src/build_common/string_literal_length.ts` — unescape-aware; never use sizeof-1). Backend ABIs:

- **C**: string renders as `nomen_string` by value (`c_type.ts`). Raw `#arch: c` bodies see the SAME fat value — there is no thin ABI and no adapters: a C `char*` in a raw body is the explicit `.ptr` half, and a string RETURN must build the `(nomen_string){ ptr, len }` pair itself (foreign `func` declarations are the one exception — they marshal to thin `char*` and re-wrap returns via strlen, per SPEC's Foreign Functions). T-generic container raw bodies (Buffer_<T>, Array_<T>) are natively fat via checker substitution (`raw_c_type_name` → `nomen_string`).
- **aarch64**: strings ride as consecutive (ptr, len) register pairs — the same ABI `view T` uses — and 16-byte stack slots. String-receiver methods keep ptr in x19, len in x20; the pair occupies AAPCS slots 0–1, so first real param starts at x2. Call-site pair detection is by argument static type (generic callee params like `TK` stay generic post-mono). Watch the ldp/stp ±504 offset range — use the guarded helpers in `utils/string_pair.ts`.
- **Task/Channel payloads**: task result slots are sized to the full return type (`sizeof(T)`), so a fat string survives the thread boundary whole. `Task<T>.result` is a `mv out T` move-out accessor (owned transfer; unconsumed results are freed by `#destroy`). `Channel` nodes carry a two-word `(value, len)` payload: `send`/`receive` move uint64 words, `send_string`/`receive_string` marshal the fat pair (copy-in, move-out).

### Structs (Value Types)

Structs are allocated on the stack and copied by value. Assigning a struct creates an independent copy — modifications to one do not affect the other.

```
struct Point {
    var int x
    var int y
}

var Point a = Point(1, 2)
var Point b = a       // copy — a and b are independent
b.x = 99
// a.x is still 1
```

#### Destroy Functions

Structs can define a `#destroy` function that runs automatically when the struct goes out of scope:

```
struct Resource {
    var int handle

    func #destroy = () {
        self.handle = -1
    }
}

var Resource r = Resource(10)
// at scope exit: r.handle is set to -1
```

Destroy functions run at:

- Scope exit (end of `if` body, function body, loop body, etc.)
- `break` and `continue` in loops
- `return` statements
- Reassignment of a variable that held a struct with a destroy function

Nested struct fields with destroy functions are also cleaned up recursively.

### WeakHandle (checked back-pointers)

`WeakHandle<T>` (STRUCT_PLAN_3 N3) is the sanctioned back-pointer / OS-retained
shape: a handle into one process-wide (pointer, generation) slot table with a
free list, mutex-guarded (handles are consulted from workers). `WeakHandle<T>
(obj)` registers the instance (T must be a heap-resident instance — a `Box<T>`
— owned elsewhere; a fresh temporary or an inline local is rejected); the
tracked type's `#destroy` invalidates every slot holding the pointer
(generation bump — a recycled slot never resets its generation, so a stale
handle can never alias a new object); `.get()` returns the live pointer or
`null`. A handle owns nothing — move-safe by construction — and binds once, at
its declaration. Runtime emission is one shared blob (the C backend's system TU
defines it with external linkage in split builds; the aarch64 user companion
always carries its copy).

### Owning Structs (Move-Only Instances)

An `mv struct` is single-owner and move-only: it owns its heap resources
(strings, containers, `Box<T>` slots), bindings move instead of copy, and
storage stays inline. The declaration is the ownership contract — the checker
verifies it (a bare `struct` with a mv field is rejected: "mark the
struct `mv struct`, or remove the field").

```
mv struct Token {
    var int value
}

var Token p = Token(10)
mv Token q = p       // transfer — p is invalidated
// p.value             // error: 'p' used after mv
```

A plain binding copy of a mv value is a compile error: "use 'ref' to
share it, 'mv' to transfer it, or '.copy()' for a deep copy".

#### `Box<T>` — the owned heap slot

`Box<T>` is a mv struct with one pointer field: a heap-allocated `T` the
box owns. Boxing is forced where a value must outlive a move or break an
inline containment cycle — the compiler names the field that closes the
cycle. `Box<T>?` is a null pointer — the natural null slot.

```
mv struct Node {
    var int value
    var Box<Node>? next     // the cycle breaker
}
```

#### Spelled aliases with `ref`

Binding a variable to an existing heap-resident instance must say what it is
doing. `ref` is the spelled alias — both bindings name the same instance,
and mutation through the alias is visible (it is spelled now):

```
mv struct Token {
    var int value
}

var Token p = Token(10)
var Box<Token> b = Box<Token>(mv p)
ref Box<Token> q = b     // alias — b and q point at the same instance
q.value = 99
// b.value is now also 99
```

`ref` binding rules (STRUCT_PLAN_3 Phase A):

- A `ref` alias is not reassignable (`q = ...` is an error — reassign the owner).
- Mutation through a `ref` requires the source to be `var`.
- Ownership never transfers through a `ref` (`mv r = mv q` is an error —
  move the owner); `mv Box<Token> r = b` is the spelled transfer and
  invalidates `b`.
- `ref` requires a reference-shaped (pointer-backed) value and an existing
  binding to alias — `ref Box<Token> q = Box<Token>(...)` (a fresh instance)
  is an error, and a bare inline mv local takes `view`, not `ref`.

#### Automatic Deallocation

Each mv instance is destroyed exactly once, when its owner goes out of
scope:

- **Declaration**: `var Token t = Token(42)` stores the instance inline; a
  `Box<Token>` allocates the pointee and tracks the box
- **Scope exit**: `#destroy` runs and heap resources are freed when the
  owner's scope ends (a box destroys its pointee, then frees it)
- **Reassignment**: the displaced value is destroyed/freed before the new one
  is stored
- **Return**: returning a mv value transfers ownership to the caller
- **Aliases**: a `ref` alias owns nothing — scope exit never frees or
  destroys through it (the owner reclaims the instance once)

#### Destroy Functions

Owning structs can define `#destroy` functions, which run before the
instance's storage is reclaimed:

```
mv struct Counter {
    var int count

    func #destroy = () {
        self.count = 0
    }
}

var Counter c = Counter(5)
// at scope exit: c.count is set to 0, then heap resources are freed
```

#### Borrowed References

Owning instances obtained from field access or accessor methods are
**borrowed references** — they point at an instance owned elsewhere. The
compiler does not free borrowed references at scope exit. This prevents
double-frees when retrieving instances from containers:

```
mv struct Elephant {
    var int tag
}
var Elephant a = Elephant(65)        // a owns this instance
list.push(mv a)                     // ownership moves into the list; a is invalidated
var Elephant cur = list.at(0)        // cur is a borrowed reference — NOT freed at scope exit
// the list owns the instance; it is freed when the list is destroyed
```

> **Caveat — partial lifetime enforcement.** A borrowed reference taken from a
> field access (`var Box b = h.c`) is scope-checked: it may not escape the scope
> it was taken in (assigned to an outer-scope variable or returned). To extract
> ownership, use `mv` (with swap). Method-return borrows (e.g. `list.at(0)`)
> are likewise rooted at the receiver's lifetime and can't outlive it.
> (`list.pop()` is a `mv out T` — an owned return — so it can escape freely.)

#### Ownership Transfer with `mv`

The `mv` keyword explicitly transfers ownership. It works in three positions:

- **struct field / parameter**: `Holder(mv b)` / `func take = (mv Box<Token> t)` — ownership moves into the field/param; the source is invalidated.
- **assignment**: `b = mv a` — `a`'s value moves into `b`; `a` is invalidated (and `b`'s old value freed first).
- **declaration**: `mv Box<Token> b = mv a` — same, on initialization.

On FIELD declarations `mv` is dead weight: ownership follows the field's
TYPE. A mv-typed field is a move-only slot — transfer-on-store, no
copy-out, swap extraction, displaced stores reclaimed, borrow stores rejected
— and `mark_owning_auto_init_params` in src/check/check_struct_node.ts
auto-stamps the synthesized `#init` param, so `mv items = List<string>()`
and `var items = List<string>()` behave identically — prefer plain `var`.

A moved variable may not be used again until it is reassigned (which revalidates it):

```
mv struct Token { var int value }
var Token a = Token(42)
mv Token b = mv a    // ownership moves from a to b; a is invalidated
// a.value              // error: 'a' used after mv
a = Token(7)            // reassignment revalidates a
a.value = 9             // ok again
```

Because structs that own heap resources (containers, `Buffer`/`File`, or any
struct with a mv field) cannot be byte-copied without a double-free,
moving is the only way to transfer one between variables — a plain
`var List b = a` or `b = a` is rejected (`use .copy() or mv`).

**Moving a field out requires a swap.** A field cannot be left moved-out, so
extracting a mv field revalidates it with a replacement:

```
var Buffer<int> old = mv self.keys swap Buffer<int>()
// old takes the previous self.keys; self.keys is revalidated with a fresh Buffer
```

This is the idiom `Map`/`Set` `rehash` use to retire their old backing buffers.

### Generic Containers

Generic containers (`List<T>`, `Set<T>`, `Map<K,V>`, `LinkedList<T>`, `Tree<T>`, `Graph<T>`) use **type-erased storage**: all values are stored as 8-byte slots via `Buffer.store_int` / `Buffer.load_int`, regardless of `T`. This works because on aarch64, ints, pointers, and instance references are all 8 bytes.

```
pub struct List<T> {
    var int length = 0
    var Buffer items = Buffer()

    pub func push = (ref self, mv T value) {
        // ...
        var int v = value       // T coerces to int for storage
        self.items.store_int(self.length, v)
        // ...
    }

    pub func pop = (ref self, out T) {
        // ...
        return self.items.load_int(self.length)  // int coerces back to T
    }
}
```

Mutators (`push`/`add`/`add_node`/`set`) take **`mv T value`**: ownership of a mv-struct instance transfers into the container and the caller's variable is invalidated. This prevents an instance from being freed by its original owner while the container still holds the pointer.

When `T` is a mv struct, each slot stores a pointer to the instance. Retrieving it (`.at(i)`, `.pop()`, `.first()`) returns a **borrowed reference** — the container holds the pointer, not the caller's variable.

The arena containers (`LinkedList`, `Tree`, `Graph`) store values and child/edge indices in flat `Buffer`s with a single owner, so cleanup is a flat `free` of each buffer — no recursive pointer chasing. Node identifiers are stable `int` indices (`-1` means "none"/"end"); read `count`/`node_count` before `add` to obtain a node's index.

#### Compile-time bounds checking

`Array`/`Buffer`/`List` accessors carry parameter constraints (e.g. `at(index: index >= 0 && index < self.length)`, `Buffer.store_int(i: i >= 0 && i < self.cap)`). These are checked at every call site at compile time via flow-sensitive bounds analysis (loop ranges, `while`/`if` conditions, and return-contract propagation), so most out-of-bounds index access is rejected before running. Indices that the analyser cannot prove in bounds still error ("Parameter constraint cannot be verified") rather than silently compiling.

### Loops

Variables declared inside loop bodies are cleaned up at each iteration. `break` and `continue` clean up all intermediate scopes between the current position and the loop boundary.

### Summary of Cleanup Timing

| Event                | What happens                                                      |
| -------------------- | ----------------------------------------------------------------- |
| Scope exit           | Strings freed, struct destroys called, mv instances freed         |
| Reassignment         | Old value freed (strings and mv instances) or destroyed (structs) |
| `return`             | All locals cleaned up; returned values are "moved" (not freed)    |
| `break` / `continue` | All intermediate scopes cleaned up before jump                    |

---

## Borrow Lifetimes

Borrowed instance references — obtained from a field access (`h.c`), an
accessor return, or an intermediate variable — are **lifetime-checked at
compile time**. The default for extracting a reference to a mv instance
is a borrow tied to a scope; the compiler tracks a `scope_depth` per variable
and rejects any borrow that would escape to a shallower (outer) scope:

- `b = h.c` (direct field-access assignment) is rejected — use `mv` (with
  swap) to take ownership.
- `var Box<Token> tmp = p.a; stolen = tmp` (smuggling a borrow through an
  intermediate variable to an outer scope) is rejected.
- `cur = list.pop()` / `arr.first()` (an instance method returning a mv
  instance) is a borrow of the receiver, rooted at the receiver's lifetime —
  it can't be assigned to a variable that outlives the receiver.
- `return h.c` (returning a borrow rooted at a LOCAL from a function) is
  rejected. A borrow rooted at `self`, however, IS returnable — `return
self.c` / `return self.items.at_or_panic(i)` re-root the result at the
  receiver argument at the call site (the same convention as `view T`
  returns), which is what makes `state.node(idx)` accessors sound
  (test/borrowed_accessor_return.test.ts).

Constructors and static factories (`Box<Token>(...)`, `Array.with(...)`, free
functions returning fresh allocations) produce owned values and may escape
freely. (The container accessors sidestep this via type-erased `load_int`,
whose result is an `int` coerced to `T` at the call site — not an instance
borrow.)

To extract a field/element out of its owner, the user must use `mv` (with
`swap` of a replacement in). In-scope borrows (used within the same scope) are
allowed.

**Same-scope owner reassignment is sound** via deferred reclamation: replacing
the owner (`h = Holder(...)`) frees the old instance at scope exit, not at the
reassignment, so a borrow in the same scope stays valid. The replacement
instance is anchored in the variable's **declaration frame** (not the current
frame), so reassigning inside a nested scope such as a loop body does not free
the live instance each iteration — the variable keeps the last value and stays
valid after the loop.

The borrow-lifetime check is a scope-depth comparison, not full alias/lifetime
tracking — it doesn't model borrows flowing _through_ data structures. It
doesn't need to: every route that stores an instance reference INTO a
longer-lived structure hits an ownership boundary with its own rejection,
verified by probe (all rejected at compile time):

- pushing a borrow into a container (`keep.push(temp.at_or_panic(0))`, the
  element rooted at a callee's local) — "Cannot move a borrowed value into
  mv parameter … it would create shared ownership";
- the same via a field-access borrow (`keep.push(o.inner)`) or into a
  file-scope global container — same rejection;
- storing a borrow into a mv field (`dst.inner = src.inner`) — "cannot
  assign mv field 'X' from another owner, use move with swap";
- a mv-typed field on a bare `struct` is the Copyable-verifier error
  ("'S' cannot be Copyable — field 'f' owns heap memory --> mark the struct
  `mv struct S`, or remove the field"), so no struct can carry owned state
  silently.

The sanctioned escapes transfer ownership and are sound: `mv` (with swap)
out of a field, `move_T`/`pop` out of a container, and `field = owned_local`,
which is a transfer, not an alias (verified: the value survives the donor
scope with balanced frees).

## Known Soundness Gaps

These are memory-safety holes that are **not** currently caught at compile time.
Resolved gaps (borrowed references outliving their owner, mv-struct
copies, use-after-move, container-stored instance leaks) are listed at the end of
the section; borrow lifetimes are documented in their own section above.

### Tagged-union type confusion (not reachable)

The classic tagged-union memory-safety hazard — take a reference into an enum's
payload, overwrite the enum with a different case (changing the tag and the
overlapping payload bytes), then dereference the stale reference — cannot arise
in Nomen, because the language offers no way to create an interior reference into
an enum's payload:

- Enum case definitions accept only `Type name` payload fields — no `ref`
  modifier (`src/parse/parse_enum.ts`).
- `match` case bindings (`case .error(code)`) are **by-value copies** of the
  payload bytes into a fresh local, not aliases into the enum's storage
  (`src/build_c/build_match_node.ts`, `src/build_aarch64/build_access_node.ts`).
  The parser accepts only bare identifiers as bindings — there is no `ref`
  binding syntax for match arms (`src/parse/parse_match.ts`).
- Direct payload field access outside `match` (`e.code`) also loads by value.

The compiler's borrow machinery (`src/check/utils/borrow.ts`) does not model
enum payloads — it only tracks instance field/method borrows (the class-era
naming in the implementation). Nomen is safe here
solely because the front end never lets an interior reference into an enum
payload come into existence. **If `ref` bindings in `match`, an address-of
operator, or `ref` enum payload fields are ever added, an enum-aware
invalidation pass (analogous to `invalidate_borrows_of` for instance field
borrows) will be required.**

### Resolved

These were previously open gaps and are now enforced at compile time:

- **Borrowed references outliving their owner** are rejected at compile time
  (scope-depth lifetime check; every nested-structure store is closed by the
  mv-parameter and move-field rules). See "Borrow Lifetimes" above.
- **Owning-struct copies** (`var Own b = a`, `b = a`, and copies out of a field)
  are rejected — byte-copying a struct that owns heap resources would double-free.
  Transfer ownership with `mv` (and `swap` for a field), or deep-copy via
  `.copy()`.
- **Use-after-move** is rejected: a variable moved with `mv` may not be read
  again until it is reassigned (which revalidates it) or revalidated by a swap.
- **Container-stored instances are freed.** When `T` is a mv struct, a
  container's backing storage reclaims each stored instance in its `#destroy`
  (the `ClassBuffer` routing — the class-era naming persists for the
  pointer-slot tier) — so `mv`-into-container no longer leaks.
- **View-carrying structs crossing a call boundary** are rejected: as an
  argument (a container store is an argument), as a return (self-rooted
  included), and to an outer scope. Previously a container of view-carrying
  structs was not lifetime-checked against the borrow sources, and a method
  returning a self-rooted bundle left the caller's variable unpinned. See
  "scope-local bundle" in the struct-layout section above.

---

## Code Generation (aarch64 Backend)

This section describes how the aarch64 backend implements the memory model. All cleanup is inserted at compile time — there is no runtime GC.

### Struct Layout

Every struct instance has an 8-byte prefix (`VT_SIZE = 8`) reserved for a vtable/type-id slot. Fields are laid out sequentially after this prefix:

```
offset 0:  vtable slot (8 bytes, zeroed by _init)
offset 8:  first field
offset 8+sizeof(first): second field
...
```

`get_struct_size` returns `VT_SIZE + sum(field_sizes)`. Instances are stored
inline — a mv-struct local's storage is the stack slot itself. The
heap-resident forms hold 8-byte pointers instead: a `Box<T>` binding is a
pointer to the heap pointee, and container slots of mv structs store
pointers (the class-era runtime tier — the implementation's internal "class"
naming persists for it). `ref T` struct fields are rejected at compile time
(`fields cannot be 'ref'`) because a non-mv borrow field could outlive
its target — use a mv field, `Box<T>`, or a `view T` field.

**`view T` fields** are allowed: a view is a self-contained 16-byte (ptr, len) pair (`nomen_view` in C; two slots on aarch64), so storing one in a struct is a plain value copy — sound to byte-copy (it aliases nothing owned) and nothing is freed at destroy (non-mv). A struct with `view` fields is a **scope-local bundle**: its escape routes are closed structurally, because a callee's frame is checked without the caller's borrow facts and no annotation-free tracker can follow a stored borrow through one. The checker tracks where an instance's view fields were borrowed from:

- **No crossing a call boundary.** Passing a view-carrying struct as an argument is rejected (`cannot pass a 'Line' as an argument — structs with 'view' fields are scope-local`) — container stores (`list.push(l)`, `arr.set(i, l)`) are call arguments, so no container can ever hold one. Returning one is rejected too (`cannot return a 'Line' — structs with 'view' fields are scope-local`), including the self-rooted method case; assign-to-outer-scope is rejected by the borrow-depth check. Methods may still be _called on_ a bundle (the receiver is rooted at a tracked caller variable), and plain `view T` arguments/returns are unaffected (call-scoped borrows).
- Storing a view into a field (`line.text = doc.slice(0, 5)`, or constructing `Line(doc.slice(…))`) records the source on the instance's variable; storing a view-carrying struct into an embedded field (`o.inner = inner`) merges the stored value's owners into the root. Reassigning or ref-mutating a source invalidates dependent instances: reading an invalidated view field is a compile error until the field is re-pointed.
- Copying such a struct (`var Line b = a`) transfers the dependencies — the copy aliases the same sources.
- The zero-copy record pattern over a long-lived buffer is expressed with `(start, length)` integer records + re-slicing instead of stored views; under the boundary rules the records provably cannot outlive the source, so no runtime identity check is needed.

Auto-generated `_init` functions use correctly-sized store instructions (`strb` for 1-byte fields like `char`/`bool`, `strh` for 2-byte, `str` for 4-byte, `str` with `x` register for 8-byte) to avoid heap buffer overflows on heap instances malloc'd to exact size.

### Heap Tracking Data Structures

The `BuildStatus` object (`src/build_c/BuildStatus.ts`) carries several tracking structures during code generation:

```typescript
// Per-scope cleanup frame (pushed/popped by build_block_node)
heap_cleanup_stack: {
    heap_strings: Set<string>                            // variable names holding heap strings
    heap_slots: { offset: number, var_name?: string }[]  // anchor slots for class instances
    struct_decls: { name, type_name, type_args? }[]      // structs needing destroy
}[]

// Global tracking
heap_strings: Set<string>               // all heap string variable names
heap_string_arrays: Map<string, number> // string[] variable name → element count
heap_class_arrays: Map<string, number>  // class array variable name → length
heap_array_vars: Set<string>            // heap-allocated array variables
moved: Set<string>                      // variables whose ownership was transferred
heap_returning_functions: Set<string>   // functions that return fresh heap allocations
moved_class_params: Map<string, string> // moved class params (name → saved register)
last_result_is_heap: boolean            // whether the last-built expression produced fresh heap
```

### Scope Lifecycle

Every block (`{ }`) pushes a cleanup frame onto `heap_cleanup_stack`. Declarations in that scope register themselves in the top frame. At scope exit, `emit_destroy_for_scope` generates cleanup code and the frame is popped.

```
build_block_node:
    push cleanup frame
    build statements → declarations register in top frame
    emit_destroy_for_scope → generates cleanup assembly
    pop cleanup frame
```

### Strings

**Tracking**: When a declaration's initializer produces a heap allocation (`last_result_is_heap`), `mark_heap_string(status, name)` adds the variable name to both the global `heap_strings` set and the current scope's cleanup frame.

**Scope exit cleanup**:

```asm
ldr x0, [x29, #<var_offset>]    // load string pointer
bl _nomen_free_wrap                // free it
```

**Reassignment**: The old string is freed before storing the new one. The new value is preserved across the free call via push/pop because `_nomen_free_wrap` clobbers caller-saved registers.

### Heap Instances (the class-tier runtime)

Heap-resident instances — `Box<T>` pointees, container-stored mv structs —
use an **anchor slot** system to manage heap deallocation across variable
aliasing. (The implementation's internal naming for this tier is still
"class"; the language-level shapes are `Box<T>` and mv-struct slots.)

#### Anchor Slots

Every `malloc` for a heap instance stores the pointer in a dedicated 8-byte **anchor slot** on the stack, separate from the variable that references the instance. The anchor slot holds the allocation address and is freed at scope exit.

```asm
mov x0, #<struct_size>          // instance size (VT_SIZE + fields)
bl _nomen_malloc_wrap             // malloc → x0 = heap pointer
str x0, [x29, #<anchor>]        // anchor: save pointer for cleanup
str x0, [x29, #<var>]           // variable: also store for access
// ... call <Struct>_init ...
```

Each anchor slot records:

- `offset`: stack position of the slot
- `var_name`: which variable this anchor belongs to (for move tracking)

#### Scope Exit

At scope exit, anchor slots are freed after all destroy bodies have run:

1. Call `<Struct>_destroy` on instances that have destroy functions (passing the heap pointer)
2. Free string arrays and heap strings
3. Free all anchor slots (skipping those marked as "moved")

#### Heap-Instance Variable Reassignment

When reassigning a variable that holds a heap instance, the compiler distinguishes between:

- **Constructor calls** (`cur = Box<Token>(...)`): always anchor the new allocation
- **Heap-returning function calls** (`cur = make_box()`): anchor only if `last_result_is_heap` is true
- **Borrowed references** (`cur = list.value(0)`): never anchor — the reference is owned elsewhere

This distinction prevents double-frees when retrieving instance pointers from generic containers. The `last_result_is_heap` flag is set by `heap_returning_functions` membership at the call site.

For **constructor reassignment** (`cur = Box<Token>(...)`), the old instance's cleanup is **deferred to scope exit** rather than run eagerly: the old anchor slot is disowned (its `var_name` cleared) and tagged with a `destroy_type`, and `defer_anchor_destroy` returns the declaration-frame index it lived in. The replacement is anchored in that same declaration frame (`anchor_heap_pointer` takes the frame index), so it survives nested scopes like loop bodies instead of being freed each iteration. At scope/return/break exit, `free_anchor_slot` runs the type's `#destroy` and field destroys before freeing the instance. This keeps borrows of the old instance's fields valid for the rest of the scope (e.g. `b = cur.field; cur = Box<Token>(...)` no longer dangles `b`). Cross-scope borrows are rejected by the borrow-lifetime check (see above).

Other reassignment paths do not create a fresh anchor and so are unaffected: a heap-returning factory (`cur = mk()`) or a variable copy stores the new pointer into the variable's **existing** anchor slot (freeing the old eagerly), and string reassignment uses `heap_strings` rather than anchor slots. These are covered by `test/reassignment-loop.test.ts`.

#### Borrowed Reference Detection

Instance-typed declarations initialized from field accesses (`is_borrowed_class_ref` in `build_declaration_node.ts` — the class-era function name persists) are excluded from `scoped_declarations` and destroy tracking — they are treated as borrowed references, not owned instances.

#### Ownership Transfer with `mv`

When a heap instance is passed with `mv`, the source variable is added to the `moved` set. The `mark_moved_if_struct` function handles this by checking whether the value is a local variable, has an anchor slot, or is a moved parameter. Moved variables are skipped at every cleanup point.

For `mv` instance parameters, the original pointer value is saved to a stack slot at function entry. At return, each saved slot is compared to the return value — if they differ, the parameter's instance is freed (it was moved in but not returned). If they match, it is kept (ownership transferred to caller via return).

#### Returning Heap Instances

When a heap instance is returned from a function, the return variable is marked as "moved". The return cleanup (`emit_heap_slots_cleanup_for_return`) skips anchor slots for moved variables. The caller detects that the function returns an instance type (via `heap_returning_functions`) and anchors the returned pointer in its own scope.

A function is added to `heap_returning_functions` when:

- It returns a `string` from a heap-producing expression (interpolation, `to_string`, etc.)
- It returns an instance type — a `Box<T>` pointee or container-tier mv struct (detected in `build_function_node`)

### Heap-Returning Function Detection

The `scan_heap_returning_functions` pass pre-scans all function return statements for heap string production. Known built-ins (`int_to_string`, `char_to_string`, `Console_read_line`, etc.) are seeded into the set. Functions are also added dynamically during building when their return expressions produce heap values.

### Break and Continue

`break` and `continue` call `emit_cleanup_to_loop_depth`, which cleans up all scopes between the current position and the loop's entry depth. The loop records its `cleanup_depth` (the `heap_cleanup_stack` length at loop entry) so the cleanup knows how many scope frames to unwind.

### Move Semantics

Variables can be marked as "moved" to exclude them from cleanup. This happens when:

- A mv struct is returned from a function
- An instance is assigned from an inner scope to an outer-scope variable
- A value is passed with the `mv` keyword

The `moved` set is checked at every cleanup point (scope exit, return, break, continue). Anchor slots with a matching `var_name` are skipped.

### Audit Mode

When building with `{ audit: true }`, all allocations go through wrapper functions that track allocation counts:

```asm
// Normal mode
bl _malloc
bl _free

// Audit mode
bl _nomen_malloc_wrap     // increments counter
bl _nomen_free_wrap       // decrements counter
```

At program exit, `nomen_audit_check()` reports any remaining allocations as `LEAK: N allocation(s)`. This is used by memory tests to verify no memory is leaked.

### Implementation Files

| File                                             | Purpose                                                                                                                                                                                                     |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/build_c/BuildStatus.ts`                     | `BuildStatus` interface with `heap_cleanup_stack`, `heap_strings`, `heap_string_arrays`, `heap_class_arrays`, `moved`, `heap_returning_functions`, `last_result_is_heap` data structures                    |
| `src/build_aarch64/utils/auto_destroy.ts`        | `anchor_heap_pointer`, `emit_destroy_for_scope`, `emit_destroy_for_decl`, `emit_field_destroys`, `emit_cleanup_to_loop_depth`, `mark_moved_if_struct`, `find_anchor_slot`, `has_struct_fields_with_destroy` |
| `src/build_aarch64/utils/struct_layout.ts`       | `get_struct_size`, `get_type_size`, `get_field_offset`, `emit_struct_copy` — VT_SIZE prefix, typed sizes per field                                                                                          |
| `src/build_aarch64/utils/audit.ts`               | `emit_malloc`, `emit_free`, `emit_strdup` wrappers                                                                                                                                                          |
| `src/build_aarch64/utils/scan_heap_returns.ts`   | Pre-scans function returns to detect heap-returning functions                                                                                                                                               |
| `src/build_aarch64/build_struct_node.ts`         | Struct codegen: auto `_init` with typed stores (`emit_typed_store`), `_destroy`, custom `#init`, struct method building                                                                                     |
| `src/build_aarch64/build_block_node.ts`          | Pushes/pops cleanup frames                                                                                                                                                                                  |
| `src/build_aarch64/build_declaration_node.ts`    | Heap-instance constructor malloc + anchor, string tracking via `check_heap()`, borrowed reference detection (`is_borrowed_class_ref`)                                                                       |
| `src/build_aarch64/build_assignment_node.ts`     | Instance reassignment with conditional anchoring (`last_result_is_heap`), string free-before-store, swap support                                                                                            |
| `src/build_aarch64/build_return_node.ts`         | Return cleanup with move semantics, heap-returning detection                                                                                                                                                |
| `src/build_aarch64/build_function_node.ts`       | Function prologue/epilogue, callee-saved register allocation, `mv` param save slots, instance-return detection                                                                                              |
| `src/build_aarch64/build_break_node.ts`          | Break with scope cleanup                                                                                                                                                                                    |
| `src/build_aarch64/build_continue_node.ts`       | Continue with scope cleanup                                                                                                                                                                                 |
| `src/build_aarch64/build_while_loop_node.ts`     | Records `cleanup_depth` for loop                                                                                                                                                                            |
| `src/build_aarch64/build_for_loop_node.ts`       | Records `cleanup_depth` for loop                                                                                                                                                                            |
| `src/audit_runtime.c`                            | C-side malloc/free counter implementation                                                                                                                                                                   |
| `test/memory-leaks.test.ts`                      | Leak detection tests (24 tests)                                                                                                                                                                             |
| `test/memory-double-free.test.ts`                | Double-free prevention tests (29 tests)                                                                                                                                                                     |
| `test/memory-use-after-free.test.ts`             | Use-after-free prevention tests                                                                                                                                                                             |
| `test/memory-errors.test.ts`                     | Memory error detection tests                                                                                                                                                                                |
| `test/class.test.ts` / `test/class_move.test.ts` | Instance allocation, move semantics, destroy, cross-scope assignment                                                                                                                                        |
| `test/containers.test.ts`                        | Generic containers with instance pointers (LinkedList, Tree, Graph)                                                                                                                                         |
| `test/uaf-via-container.test.ts`                 | `mv`-into-container ownership transfer; container-stored-instance leak limitation                                                                                                                           |
| `test/reassignment-loop.test.ts`                 | Instance/string reassignment inside loops across each codegen path (constructor, factory, ref-param, nested-if)                                                                                             |
| `test/memory-soundness-gaps.test.ts`             | Borrow-lifetime rejection (field/method/function escapes) + deferred-reclamation regression tests                                                                                                           |
