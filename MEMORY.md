# Memory Management

Echo uses automatic memory management with deterministic cleanup at scope boundaries. No garbage collector or reference counting is needed — the compiler inserts allocation and deallocation code at compile time.

This document describes memory behavior at two levels: what Echo programmers can expect (user-facing semantics), and how the aarch64 backend generates code to achieve it (code generation internals).

## User-Facing Semantics

### Strings

Strings are heap-allocated. The compiler tracks which variables hold heap strings and frees them automatically when they go out of scope or are reassigned.

```
var string name = "Alice"      // heap allocation
name = "Bob"                   // old string freed, new one allocated
// end of scope: "Bob" freed
```

String interpolation (`"\{expr}"`) creates temporary heap allocations that are freed at the end of the enclosing scope.

```
Console.write("\{x}")     // temporary string freed at scope exit
```

### String Arrays

Arrays of strings (`string[]`) are stack-allocated containers where each element is a heap pointer. At scope exit, each element is freed individually.

```
var string[] names = ["Alice", "Bob", "Charlie"]
// at scope exit: each element pointer is freed, then the stack array is reclaimed
```

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

#### Destroy Blocks

Structs can define a `destroy` block that runs automatically when the struct goes out of scope:

```
struct Resource {
    var int handle

    destroy = {
        self.handle = -1
    }
}

var Resource r = Resource(10)
// at scope exit: r.handle is set to -1
```

Destroy blocks run at:

- Scope exit (end of `if` body, function body, loop body, etc.)
- `break` and `continue` in loops
- `return` statements
- Reassignment of a variable that held a struct with a destroy block

Nested struct fields with destroy blocks are also cleaned up recursively.

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

Each class instance is freed exactly once, when the last reference goes out of scope:

- **Declaration**: `var Box b = Box(42)` allocates and tracks the instance
- **Scope exit**: the instance is freed when the scope where it was anchored ends
- **Reassignment**: `b = Box(99)` frees the old instance before storing the new pointer
- **Return**: returning a class transfers ownership to the caller — the function does not free it

```
func make_box = (int x, out Box) {
    var Box b = Box(x)
    return b         // ownership transferred to caller
}
var Box result = make_box(42)   // caller now owns the instance
// result freed at caller's scope exit
```

#### Destroy Blocks

Classes can define `destroy` blocks, which run before the instance memory is freed:

```
class Counter {
    var int count

    destroy = {
        self.count = 0
    }
}

var Counter c = Counter(5)
// at scope exit: c.count is set to 0, then the heap allocation is freed
```

#### Cross-Scope Assignment

When a class from an inner scope is assigned to an outer-scope variable, ownership transfers:

```
var Counter c = Counter(0)
if condition {
    var Counter inner = Counter(5)
    c = inner          // c now points to Counter(5); Counter(0) is freed
}                      // inner is not freed here — c owns it now
Console.write("\{c.count}")   // prints 5
// Counter(5) freed at outer scope exit
```

### Loops

Variables declared inside loop bodies are cleaned up at each iteration. `break` and `continue` clean up all intermediate scopes between the current position and the loop boundary:

```
while condition {
    var Resource r = Resource(1)
    if should_skip {
        continue        // r is cleaned up before jumping back to loop start
    }
    if should_exit {
        break           // r is cleaned up before jumping to loop end
    }
}
```

### Summary of Cleanup Timing

| Event                | What happens                                                              |
| -------------------- | ------------------------------------------------------------------------- |
| Scope exit           | Strings freed, struct/class destroys called, class instances freed        |
| Reassignment         | Old value freed (strings and classes) or destroyed (structs with destroy) |
| `return`             | All locals cleaned up; returned values are "moved" (not freed)            |
| `break` / `continue` | All intermediate scopes cleaned up before jump                            |

---

## Code Generation (aarch64 Backend)

This section describes how the aarch64 backend implements the memory model. All cleanup is inserted at compile time — there is no runtime GC.

### Heap Tracking Data Structures

The `BuildStatus` object carries several tracking structures during code generation:

```typescript
// Per-scope cleanup frame
heap_cleanup_stack: {
    heap_strings: Set<string>                          // variable names holding heap strings
    heap_slots: { offset: number, var_name?: string }[] // anchor slots for class instances
    struct_decls: { name, type_name, type_args? }[]    // structs needing destroy
}[]

// Global tracking
heap_strings: Set<string>               // all heap string variable names
heap_string_arrays: Map<string, number> // variable name → element count
moved: Set<string>                      // variables whose ownership was transferred
heap_returning_functions: Set<string>   // functions that return heap allocations
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
bl _echo_free_wrap                // free it
```

**Reassignment**: The old string is freed before storing the new one:

```asm
ldr x0, [x29, #<var_offset>]    // load old pointer
bl _echo_free_wrap                // free old
// ... build new value into x0 ...
str x0, [x29, #<var_offset>]    // store new pointer
```

### String Arrays

**Tracking**: `heap_string_arrays` maps variable names to their element count. At cleanup, each element pointer is freed individually:

```asm
add x0, x29, #<array_offset>
ldr x0, [x0, #0]              // element 0
bl _echo_free_wrap
add x0, x29, #<array_offset>
ldr x0, [x0, #8]              // element 1
bl _echo_free_wrap
// ... repeat for each element
```

### Structs

**Tracking**: Structs with `destroy` blocks (or with fields that have destroy blocks) are tracked via `track_struct_decl(status, name, type_name)` which adds them to the current scope's `struct_decls`.

**Scope exit cleanup**: For each tracked struct, the `_destroy` function is called with the struct's stack address:

```asm
add x0, x29, #<struct_offset>
bl StructName_destroy
```

**Nested fields**: `emit_field_destroys` recursively walks struct fields. For each field that is itself a struct with a destroy block, it emits a destroy call at the correct offset:

```asm
add x0, x29, #<struct_offset>
add x0, x0, #<field_offset>
bl InnerStruct_destroy
```

### Classes

Classes use an **anchor slot** system to manage heap deallocation across variable aliasing.

#### Anchor Slots

Every `malloc` for a class instance stores the pointer in a dedicated 8-byte **anchor slot** on the stack, separate from the variable that references the instance. The anchor slot is immutable — it always holds the allocation address and is freed at scope exit.

```asm
mov x0, #16                   // struct size
bl _echo_malloc_wrap           // malloc → x0 = heap pointer
str x0, [x29, #<anchor>]      // anchor: save pointer for cleanup
str x0, [x29, #<var>]         // variable: also store for access
// ... call ClassName_init ...
```

Each anchor slot records:

- `offset`: stack position of the slot
- `var_name`: which variable this anchor belongs to (for move tracking)

#### Scope Exit

At scope exit, anchor slots are freed after all destroy bodies have run:

1. Call `ClassName_destroy` on class instances that have destroy blocks (passing the heap pointer, not the stack slot)
2. Free string arrays and heap strings
3. Free all anchor slots (skipping those marked as "moved")

```asm
// Step 1: destroy bodies
ldr x0, [x29, #<var_offset>]     // load heap pointer
bl Counter_destroy

// Step 2: string cleanup
ldr x0, [x29, #<string_offset>]
bl _echo_free_wrap

// Step 3: free anchor slots
ldr x0, [x29, #<anchor_offset>]
bl _echo_free_wrap
```

#### Reassignment

When a class variable is reassigned, the old instance is freed via the anchor slot before storing the new pointer:

```asm
// x0 = new pointer (from malloc or another variable)
str x0, [sp, #-16]!              // save new pointer on stack
ldr x0, [x29, #<anchor>]         // load old pointer from anchor
bl _echo_free_wrap                // free old instance
ldr x3, [sp], #16                // restore new pointer
str x3, [x29, #<anchor>]         // update anchor
str x3, [x29, #<var>]            // update variable slot
```

The new pointer is saved to the stack (push/pop) because `_echo_free_wrap` clobbers caller-saved registers (x0–x18).

#### Alias Assignment

When assigning one class variable to another (`var Box q = p` or `p = q`), no allocation or deallocation occurs — only a pointer copy. The anchor slot of the destination is updated to point to the source's allocation. The `mark_moved_if_struct` function marks the source as "moved" so the source scope's cleanup skips it, transferring ownership.

#### Returning Classes

When a class is returned from a function, `mark_moved_if_struct` adds the variable to `status.moved`. The return cleanup (`emit_heap_slots_cleanup_for_return`) skips anchor slots for moved variables. The caller detects that the function returns a class type (via `heap_returning_functions`) and anchors the returned pointer in its own scope.

```asm
// Inside function (return path):
ldr x0, [x29, #<var_offset>]    // load return value
mov x20, x0                      // save to callee-saved register
// ... cleanup other locals ...
// anchor for returned var is SKIPPED (moved)
mov x0, x20                      // restore return value
b .return_label

// Caller:
bl make_box                      // call returns heap pointer in x0
str x0, [x29, #<anchor>]         // anchor it in caller's scope
str x0, [x29, #<var>]            // store to variable
```

### Break and Continue

`break` and `continue` call `emit_cleanup_to_loop_depth`, which cleans up all scopes between the current position and the loop's entry depth. The loop records its `cleanup_depth` (the `heap_cleanup_stack` length at loop entry) so the cleanup knows how many scope frames to unwind.

```asm
// break inside a nested scope in a loop body:
// cleanup inner scope's anchor slots
ldr x0, [x29, #<inner_anchor>]
bl _echo_free_wrap
// cleanup inner scope's struct destroys
add x0, x29, #<struct_offset>
bl Resource_destroy
// jump to loop end
b .end_while_3
```

### Move Semantics

Variables can be marked as "moved" to exclude them from cleanup. This happens when:

- A class or struct is returned from a function
- A class is assigned from an inner scope to an outer scope variable

The `moved` set is checked at every cleanup point (scope exit, return, break, continue). Anchor slots with a matching `var_name` are skipped.

### Audit Mode

When building with `{ audit: true }`, all allocations go through wrapper functions that track allocation counts:

```asm
// Normal mode
bl _malloc
bl _free

// Audit mode
bl _echo_malloc_wrap     // increments counter
bl _echo_free_wrap       // decrements counter
```

At program exit, `echo_audit_check()` reports any remaining allocations as `LEAK: N allocation(s)`. This is used by tests in `test/memory.test.ts` to verify no memory is leaked.

### Implementation Files

| File                                          | Purpose                                                                                                                                                                                  |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/build/BuildStatus.ts`                    | `heap_cleanup_stack`, `heap_strings`, `heap_string_arrays`, `moved` data structures                                                                                                      |
| `src/build_aarch64/utils/auto_destroy.ts`     | `anchor_heap_pointer`, `emit_destroy_for_scope`, `emit_destroy_for_decl`, `emit_cleanup_to_loop_depth`, `mark_moved_if_struct`, `find_anchor_slot`, `emit_heap_slots_cleanup_for_return` |
| `src/build_aarch64/utils/audit.ts`            | `emit_malloc`, `emit_free`, `emit_strdup` wrappers                                                                                                                                       |
| `src/build_aarch64/build_block_node.ts`       | Pushes/pops cleanup frames                                                                                                                                                               |
| `src/build_aarch64/build_declaration_node.ts` | Class constructor malloc + anchor, string tracking via `check_heap()`                                                                                                                    |
| `src/build_aarch64/build_assignment_node.ts`  | Class reassignment with anchor update, string free-before-store                                                                                                                          |
| `src/build_aarch64/build_return_node.ts`      | Return cleanup with move semantics                                                                                                                                                       |
| `src/build_aarch64/build_function_node.ts`    | Detects class-returning functions                                                                                                                                                        |
| `src/build_aarch64/build_break_node.ts`       | Break with scope cleanup                                                                                                                                                                 |
| `src/build_aarch64/build_continue_node.ts`    | Continue with scope cleanup                                                                                                                                                              |
| `src/build_aarch64/build_while_loop_node.ts`  | Records `cleanup_depth` for loop                                                                                                                                                         |
| `src/build_aarch64/build_for_loop_node.ts`    | Records `cleanup_depth` for loop                                                                                                                                                         |
| `test/audit_runtime.c`                        | C-side malloc/free counter implementation                                                                                                                                                |
| `test/memory.test.ts`                         | 54 tests covering strings, structs, classes, loops, returns                                                                                                                              |
