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

`string` is the **own** form (heap, freed at scope exit); `view string` is the non-owning `(ptr, len)` borrow. This own/borrow distinction is the string analog of `Array<T>` vs `view T` — see ARRAY.md.

**Fat-string representation**: `string` is a 16-byte `nomen_string { char* ptr; long len; }` value. `.length` is a field load (O(1), no strlen). The buffer stays NUL-terminated at `ptr[len]`, so libc/FFI consumers (`printf %s`, `fopen`, `stringWithUTF8String:`) work unchanged. Literal lengths are compile-time constants (`src/build_common/string_literal_length.ts` — unescape-aware; never use sizeof-1). Backend ABIs:

- **C**: string renders as `nomen_string` by value (`c_type.ts`); raw `#arch: c` bodies written against thin `char*` are emitted under a `_raw_` label with a marshalling adapter that synthesizes `len` once via strlen at the creation boundary (`src/build_c/utils/raw_string_abi.ts`). T-generic container raw bodies (Buffer_<T>, Array_<T>) are natively fat via checker substitution (`raw_c_type_name` → `nomen_string`).
- **aarch64**: strings ride as consecutive (ptr, len) register pairs — the same ABI `view T` uses — and 16-byte stack slots. String-receiver methods keep ptr in x19, len in x20; the pair occupies AAPCS slots 0–1, so first real param starts at x2. Call-site pair detection is by argument static type (generic callee params like `TK` stay generic post-mono). Watch the ldp/stp ±504 offset range — use the guarded helpers in `utils/string_pair.ts`.
- **Task/Channel payloads**: task result slots are sized to the full return type (`sizeof(T)`), so a fat string survives the thread boundary whole. `Task<T>.result` is a `mov out T` move-out accessor (owned transfer; unconsumed results are freed by `#destroy`). `Channel` nodes carry a two-word `(value, len)` payload: `send`/`receive` move uint64 words, `send_string`/`receive_string` marshal the fat pair (copy-in, move-out).

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

### Classes (Reference Types)

Classes are always heap-allocated and passed by pointer. Assigning a class variable to another creates a shared reference — both variables point to the same instance.

```
class Box {
    var int value
}

var Box p = Box(10)
var Box q = p          // shared reference — p and q point to the same instance
q.value = 99
// p.value is now also 99
```

#### Automatic Deallocation

Each class instance is freed exactly once, when the owning reference goes out of scope:

- **Declaration**: `var Box b = Box(42)` allocates and tracks the instance
- **Scope exit**: the instance is freed when the scope where it was anchored ends
- **Reassignment**: `b = Box(99)` frees the old instance before storing the new pointer
- **Return**: returning a class transfers ownership to the caller — the function does not free it

#### Destroy Functions

Classes can define `#destroy` functions, which run before the instance memory is freed:

```
class Counter {
    var int count

    func #destroy = () {
        self.count = 0
    }
}

var Counter c = Counter(5)
// at scope exit: c.count is set to 0, then the heap allocation is freed
```

#### Borrowed References

Class values obtained from field access or accessor methods are **borrowed references** — they point to an instance owned elsewhere. The compiler does not free borrowed references at scope exit. This prevents double-frees when retrieving class pointers from containers:

```
var Elephant a = Elephant('A')     // a owns this instance
list.push(mov a)                   // ownership moves into the list; a is invalidated
var Elephant cur = list.at(0)      // cur is a borrowed reference — NOT freed at scope exit
// the list owns the instance; it is freed when the list is destroyed
```

> **Caveat — partial lifetime enforcement.** A borrowed reference taken from a
> field access (`var Box b = h.c`) is scope-checked: it may not escape the scope
> it was taken in (assigned to an outer-scope variable or returned). To extract
> ownership, use `mov` (with swap). Method-return borrows (e.g. `list.at(0)`)
> are likewise rooted at the receiver's lifetime and can't outlive it.
> (`list.pop()` is a `mov out T` — an owned return — so it can escape freely.)

#### Ownership Transfer with `mov`

The `mov` keyword explicitly transfers ownership. It works in three positions:

- **struct field / parameter**: `Holder(mov b)` / `func take = (mov Box b)` — ownership moves into the field/param; the source is invalidated.
- **assignment**: `b = mov a` — `a`'s value moves into `b`; `a` is invalidated (and `b`'s old value freed first).
- **declaration**: `var Box b = mov a` — same, on initialization.

A moved variable may not be used again until it is reassigned (which revalidates it):

```
class Box { var int value }
var Box a = Box(42)
var Box b = mov a      // ownership moves from a to b; a is invalidated
// a.value             // error: 'a' used after move
a = Box(7)             // reassignment revalidates a
a.value = 9            // ok again
```

Because structs that own heap resources (containers, `Buffer`/`File`/`ClassBuffer`,
or any struct with a class field) cannot be byte-copied without a double-free,
moving is the only way to transfer one between variables — a plain `var List b = a`
or `b = a` is rejected (`use .copy() or mov`).

**Moving a field out requires a swap.** A field cannot be left moved-out, so
extracting an owning field revalidates it with a replacement:

```
var Buffer<int> old = mov self.keys swap Buffer<int>()
// old takes the previous self.keys; self.keys is revalidated with a fresh Buffer
```

This is the idiom `Map`/`Set` `rehash` use to retire their old backing buffers.

### Generic Containers

Generic containers (`List<T>`, `Set<T>`, `Map<K,V>`, `LinkedList<T>`, `Tree<T>`, `Graph<T>`) use **type-erased storage**: all values are stored as 8-byte slots via `Buffer.store_int` / `Buffer.load_int`, regardless of `T`. This works because on aarch64, ints, pointers, and class references are all 8 bytes.

```
pub struct List<T> {
    var int length = 0
    var Buffer items = Buffer()

    pub func push = (ref self, mov T value) {
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

Mutators (`push`/`add`/`add_node`/`set`) take **`mov T value`**: ownership of a class instance transfers into the container and the caller's variable is invalidated. This prevents a class from being freed by its original owner while the container still holds the pointer.

When `T` is a class type, the stored value is a pointer. Retrieving it (`.at(i)`, `.pop()`, `.first()`) returns a **borrowed reference** — the container holds the pointer, not the caller's variable.

The arena containers (`LinkedList`, `Tree`, `Graph`) store values and child/edge indices in flat `Buffer`s with a single owner, so cleanup is a flat `free` of each buffer — no recursive pointer chasing. Node identifiers are stable `int` indices (`-1` means "none"/"end"); read `count`/`node_count` before `add` to obtain a node's index.

#### Compile-time bounds checking

`Array`/`Buffer`/`List` accessors carry parameter constraints (e.g. `at(index: index >= 0 && index < self.length)`, `Buffer.store_int(i: i >= 0 && i < self.cap)`). These are checked at every call site at compile time via flow-sensitive bounds analysis (loop ranges, `while`/`if` conditions, and return-contract propagation), so most out-of-bounds index access is rejected before running. Indices that the analyser cannot prove in bounds still error ("Parameter constraint cannot be verified") rather than silently compiling.

### Loops

Variables declared inside loop bodies are cleaned up at each iteration. `break` and `continue` clean up all intermediate scopes between the current position and the loop boundary.

### Summary of Cleanup Timing

| Event                | What happens                                                              |
| -------------------- | ------------------------------------------------------------------------- |
| Scope exit           | Strings freed, struct/class destroys called, class instances freed        |
| Reassignment         | Old value freed (strings and classes) or destroyed (structs with destroy) |
| `return`             | All locals cleaned up; returned values are "moved" (not freed)            |
| `break` / `continue` | All intermediate scopes cleaned up before jump                            |

---

## Known Soundness Gaps

These are memory-safety holes that are **not** currently caught at compile time.
Resolved gaps (owning-struct copies, use-after-move, container-stored class
leaks) are listed at the end of the section.

### Borrowed references outliving their owner (use-after-free)

Borrowed class references — obtained from a field access (`h.c`), an accessor
return, or an intermediate variable — used to carry no lifetime information, so
a borrow could outlive the instance it points into (UAF).

**Field-access and method-return borrows are now lifetime-checked at compile
time.** The default for extracting a class reference is a borrow tied to a
scope; the compiler tracks a `scope_depth` per variable and rejects any borrow
that would escape to a shallower (outer) scope:

- `b = h.c` (direct field-access assignment) is rejected — use `mov` (with
  swap) to take ownership.
- `var Box tmp = p.a; stolen = tmp` (smuggling a borrow through an intermediate
  variable to an outer scope) is rejected.
- `cur = list.pop()` / `arr.first()` (an instance method returning a class) is
  a borrow of the receiver, rooted at the receiver's lifetime — it can't be
  assigned to a variable that outlives the receiver.
- `return h.c` (returning a borrow from a function) is rejected.

Constructors and static factories (`Box(1)`, `Array.with(...)`, free functions
returning fresh allocations) produce owned values and may escape freely. (The
container accessors sidestep this via type-erased `load_int`, whose result is
an `int` coerced to `T` at the call site — not a class borrow.)

To extract a field/element out of its owner, the user must use `mov` (with
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
tracking; deeper escapes through nested data structures aren't modelled. (The
common cases — direct field access, smuggling through an intermediate variable,
method returns, and `return` of a borrow — are all caught.)

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
enum payloads — it only tracks class field/method borrows. Nomen is safe here
solely because the front end never lets an interior reference into an enum
payload come into existence. **If `ref` bindings in `match`, an address-of
operator, or `ref` enum payload fields are ever added, an enum-aware
invalidation pass (analogous to `invalidate_borrows_of` for class field
borrows) will be required.**

### Resolved

These were previously open gaps and are now enforced at compile time:

- **Owning-struct copies** (`var Own b = a`, `b = a`, and copies out of a field)
  are rejected — byte-copying a struct that owns heap resources would double-free.
  Transfer ownership with `mov` (and `swap` for a field), or deep-copy via
  `.copy()`.
- **Use-after-move** is rejected: a variable moved with `mov` may not be read
  again until it is reassigned (which revalidates it) or revalidated by a swap.
- **Container-stored classes are freed.** When `T` is a class, a container's
  backing storage is a `ClassBuffer`, whose `#destroy` frees each stored
  instance — so `mov`-into-container no longer leaks.

---

## Code Generation (aarch64 Backend)

This section describes how the aarch64 backend implements the memory model. All cleanup is inserted at compile time — there is no runtime GC.

### Struct Layout

Every struct/class instance has an 8-byte prefix (`VT_SIZE = 8`) reserved for a vtable/type-id slot. Fields are laid out sequentially after this prefix:

```
offset 0:  vtable slot (8 bytes, zeroed by _init)
offset 8:  first field
offset 8+sizeof(first): second field
...
```

`get_struct_size` returns `VT_SIZE + sum(field_sizes)`. Classes are always stored as 8-byte pointers (the instance is heap-allocated; the variable holds a pointer to it). `mov T` fields holding a class store the 8-byte pointer (and transfer ownership — see Move Semantics). Note: `ref T` struct/class fields are rejected at compile time (`fields cannot be 'ref'`) because a non-owning borrow field could outlive its target — use a value field (copied), a `mov` field, or a `view T` field.

**`view T` fields** are allowed: a view is a self-contained 16-byte (ptr, len) pair (`nomen_view` in C; two slots on aarch64), so storing one in a struct is a plain value copy — sound to byte-copy (it aliases nothing owned) and nothing is freed at destroy (non-owning). This enables the borrow-into-parent pattern: many small records referencing slices of one long-lived buffer, e.g. `Line { var view string text }` collected into a `List<Line>` over the source document. The checker tracks where an instance's view fields were borrowed from:

- Storing a view into a field (`line.text = doc.slice(0, 5)`, or constructing `Line(doc.slice(…))`) records the source on the instance's variable. Returning that instance is rejected ("its 'view' field(s) borrow from this scope") unless every borrow roots at `self` — the same re-rooting convention slice methods use; assigning it to an outer-scope variable is rejected by the borrow-depth check.
- Reassigning or ref-mutating a source invalidates dependent instances: reading an invalidated view field is a compile error until the field is re-pointed.
- Copying such a struct (`var Line b = a`) transfers the dependencies — the copy aliases the same sources.
- Known limitation: a container of view-carrying structs is NOT lifetime-checked against the borrow sources (`lines.push(l)` does not prove `lines` dies before every source). Keep sources alive as long as the container.

Auto-generated `_init` functions use correctly-sized store instructions (`strb` for 1-byte fields like `char`/`bool`, `strh` for 2-byte, `str` for 4-byte, `str` with `x` register for 8-byte) to avoid heap buffer overflows on class instances malloc'd to exact size.

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
moved_class_params: Map<string, string> // mov'd class params (name → saved register)
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

### Classes

Classes use an **anchor slot** system to manage heap deallocation across variable aliasing.

#### Anchor Slots

Every `malloc` for a class instance stores the pointer in a dedicated 8-byte **anchor slot** on the stack, separate from the variable that references the instance. The anchor slot holds the allocation address and is freed at scope exit.

```asm
mov x0, #<struct_size>          // class size (VT_SIZE + fields)
bl _nomen_malloc_wrap             // malloc → x0 = heap pointer
str x0, [x29, #<anchor>]        // anchor: save pointer for cleanup
str x0, [x29, #<var>]           // variable: also store for access
// ... call ClassName_init ...
```

Each anchor slot records:

- `offset`: stack position of the slot
- `var_name`: which variable this anchor belongs to (for move tracking)

#### Scope Exit

At scope exit, anchor slots are freed after all destroy bodies have run:

1. Call `ClassName_destroy` on class instances that have destroy functions (passing the heap pointer)
2. Free string arrays and heap strings
3. Free all anchor slots (skipping those marked as "moved")

#### Class Variable Reassignment

When reassigning a class variable, the compiler distinguishes between:

- **Constructor calls** (`cur = Box(42)`): always anchor the new allocation
- **Heap-returning function calls** (`cur = make_box()`): anchor only if `last_result_is_heap` is true
- **Borrowed references** (`cur = list.value(0)`): never anchor — the reference is owned elsewhere

This distinction prevents double-frees when retrieving class pointers from generic containers. The `last_result_is_heap` flag is set by `heap_returning_functions` membership at the call site.

For **constructor reassignment** (`cur = Box(42)`), the old instance's cleanup is **deferred to scope exit** rather than run eagerly: the old anchor slot is disowned (its `var_name` cleared) and tagged with a `destroy_type`, and `defer_anchor_destroy` returns the declaration-frame index it lived in. The replacement is anchored in that same declaration frame (`anchor_heap_pointer` takes the frame index), so it survives nested scopes like loop bodies instead of being freed each iteration. At scope/return/break exit, `free_anchor_slot` runs the type's `#destroy` and field destroys before freeing the instance. This keeps borrows of the old instance's fields valid for the rest of the scope (e.g. `b = cur.field; cur = Box(...)` no longer dangles `b`). Cross-scope borrows are rejected by the borrow-lifetime check (see above).

Other reassignment paths do not create a fresh anchor and so are unaffected: a heap-returning factory (`cur = mk()`) or a variable copy stores the new pointer into the variable's **existing** anchor slot (freeing the old eagerly), and string reassignment uses `heap_strings` rather than anchor slots. These are covered by `test/reassignment-loop.test.ts`.

#### Borrowed Reference Detection

Class-typed declarations initialized from field accesses (`is_borrowed_class_ref` in `build_declaration_node.ts`) are excluded from `scoped_declarations` and destroy tracking — they are treated as borrowed references, not owned instances.

#### Ownership Transfer with `mov`

When a class is passed with `mov`, the source variable is added to the `moved` set. The `mark_moved_if_struct` function handles this by checking whether the value is a local variable, has an anchor slot, or is a class parameter. Moved variables are skipped at every cleanup point.

For `mov` class parameters, the original pointer value is saved to a stack slot at function entry. At return, each saved slot is compared to the return value — if they differ, the parameter's instance is freed (it was moved in but not returned). If they match, it is kept (ownership transferred to caller via return).

#### Returning Classes

When a class is returned from a function, the return variable is marked as "moved". The return cleanup (`emit_heap_slots_cleanup_for_return`) skips anchor slots for moved variables. The caller detects that the function returns a class type (via `heap_returning_functions`) and anchors the returned pointer in its own scope.

A function is added to `heap_returning_functions` when:

- It returns a `string` from a heap-producing expression (interpolation, `to_string`, etc.)
- It returns a class type (detected in `build_function_node`)

### Heap-Returning Function Detection

The `scan_heap_returning_functions` pass pre-scans all function return statements for heap string production. Known built-ins (`int_to_string`, `char_to_string`, `Console_read_line`, etc.) are seeded into the set. Functions are also added dynamically during building when their return expressions produce heap values.

### Break and Continue

`break` and `continue` call `emit_cleanup_to_loop_depth`, which cleans up all scopes between the current position and the loop's entry depth. The loop records its `cleanup_depth` (the `heap_cleanup_stack` length at loop entry) so the cleanup knows how many scope frames to unwind.

### Move Semantics

Variables can be marked as "moved" to exclude them from cleanup. This happens when:

- A class or struct is returned from a function
- A class is assigned from an inner scope to an outer-scope variable
- A class is passed with the `mov` keyword

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
| `src/build_aarch64/build_struct_node.ts`         | Struct/class codegen: auto `_init` with typed stores (`emit_typed_store`), `_destroy`, custom `#init`, struct method building                                                                               |
| `src/build_aarch64/build_block_node.ts`          | Pushes/pops cleanup frames                                                                                                                                                                                  |
| `src/build_aarch64/build_declaration_node.ts`    | Class constructor malloc + anchor, string tracking via `check_heap()`, borrowed reference detection (`is_borrowed_class_ref`)                                                                               |
| `src/build_aarch64/build_assignment_node.ts`     | Class reassignment with conditional anchoring (`last_result_is_heap`), string free-before-store, swap support                                                                                               |
| `src/build_aarch64/build_return_node.ts`         | Return cleanup with move semantics, heap-returning detection                                                                                                                                                |
| `src/build_aarch64/build_function_node.ts`       | Function prologue/epilogue, callee-saved register allocation, `mov` param save slots, class-return detection                                                                                                |
| `src/build_aarch64/build_break_node.ts`          | Break with scope cleanup                                                                                                                                                                                    |
| `src/build_aarch64/build_continue_node.ts`       | Continue with scope cleanup                                                                                                                                                                                 |
| `src/build_aarch64/build_while_loop_node.ts`     | Records `cleanup_depth` for loop                                                                                                                                                                            |
| `src/build_aarch64/build_for_loop_node.ts`       | Records `cleanup_depth` for loop                                                                                                                                                                            |
| `src/audit_runtime.c`                            | C-side malloc/free counter implementation                                                                                                                                                                   |
| `test/memory-leaks.test.ts`                      | Leak detection tests (24 tests)                                                                                                                                                                             |
| `test/memory-double-free.test.ts`                | Double-free prevention tests (29 tests)                                                                                                                                                                     |
| `test/memory-use-after-free.test.ts`             | Use-after-free prevention tests                                                                                                                                                                             |
| `test/memory-errors.test.ts`                     | Memory error detection tests                                                                                                                                                                                |
| `test/class.test.ts` / `test/class-move.test.ts` | Class allocation, move semantics, destroy, cross-scope assignment (35 tests combined)                                                                                                                       |
| `test/containers.test.ts`                        | Generic containers with class pointers (LinkedList, Tree, Graph)                                                                                                                                            |
| `test/uaf-via-container.test.ts`                 | `mov`-into-container ownership transfer; container-stored-class leak limitation                                                                                                                             |
| `test/reassignment-loop.test.ts`                 | Class/string reassignment inside loops across each codegen path (constructor, factory, ref-param, nested-if)                                                                                                |
| `test/memory-soundness-gaps.test.ts`             | Borrow-lifetime rejection (field/method/function escapes) + deferred-reclamation regression tests                                                                                                           |
