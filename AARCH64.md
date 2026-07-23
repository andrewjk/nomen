# AARCH64 Backend Notes

## Overview

This document captures lessons learned, gotchas, and strategies discovered while building and converting the Nomen compiler's aarch64 backend.

---

## Key Learnings About Compiling to AARCH64

### Data Placement is Critical

AARCH64 requires strict instruction alignment. Any data declaration (`.byte`, `.float`, `.asciz`, `.space`) placed inline in the text section will misalign subsequent instructions, causing bus errors or illegal instruction crashes.

**Strategy**: Either:

- Move all data declarations to the end of the function (after the `ret`)
- Use `.p2align 2` after any inline data to realign to 4-byte boundaries
- Prefer stack allocation for function-local variables over inline data

### Stack Allocation Model

Function-local variables should generally be allocated on the stack rather than as inline data labels. This avoids alignment issues and follows standard calling conventions.

**Pattern**:

```asm
stp x29, x30, [sp, #-16]!    ; Save frame pointer and link register
sub sp, sp, #48               ; Allocate 48 bytes for local vars
mov x29, sp                   ; Set up frame pointer

; Access local var at offset 0
str x0, [x29, #0]
ldr x0, [x29, #8]

; Epilogue
add sp, sp, #48               ; Deallocate locals
ldp x29, x30, [sp], #16      ; Restore FP/LR
ret
```

### Size-Aware Memory Operations

Unlike x86 or C where everything is implicitly word-sized, AARCH64 requires explicit byte/halfword/word/doubleword operations:

| Size    | Load (unsigned)   | Load (signed)      | Store             |
| ------- | ----------------- | ------------------ | ----------------- |
| 1 byte  | `ldrb w0, [addr]` | `ldrsb x0, [addr]` | `strb w0, [addr]` |
| 2 bytes | `ldrh w0, [addr]` | `ldrsh x0, [addr]` | `strh w0, [addr]` |
| 4 bytes | `ldr w0, [addr]`  | `ldrsw x0, [addr]` | `str w0, [addr]`  |
| 8 bytes | `ldr x0, [addr]`  | -                  | `str x0, [addr]`  |

**Critical**: Using `str x0` to store a 1-byte value will overwrite the next 7 bytes of adjacent memory.

### Sign Extension

Signed integer types (`int8`, `int16`, `int32`) must use sign-extending loads (`ldrsb`, `ldrsh`, `ldrsw`) to properly propagate the sign bit into the full 64-bit register. Unsigned types use zero-extending loads (`ldrb`, `ldrh`, `ldr`).

### Float Types Are 8 Bytes

On this platform, `float` compiles to 8 bytes (`.double`), not 4. The `aarch64_size()` function returns 8 for float, and operations use `d0`/`d1` (64-bit float registers), not `s0`/`s1` (32-bit).

### Function Return Labels

Each function needs a unique return label. The label counter must be reset at the start of each build to avoid collisions. Without resetting, tests that run in sequence will see `.return_4`, `.return_5`, etc. instead of `.return_0`.

---

## Gotchas and Assumptions

### Gotcha: Inline Data in Text Section

Placing `n: .byte 50` inside a function body will cause the CPU to try to execute the data as instructions. The assembler will place the bytes at the current PC, and the next instruction fetch will read from an unaligned or invalid address.

**Fix**: Move data to after `ret`, or allocate on stack.

### Gotcha: `adr` Range Limitation

The `adr` instruction has a limited range (±1MB). For large binaries, `adrp` + `add` may be needed. In practice, for small test programs, `adr` works fine.

### Gotcha: macOS Variadic Functions

macOS's implementation of variadic functions (`printf`, `snprintf`, etc.) requires arguments to be saved in a specific parameter save area on the stack before the call. Even when passing in registers, the system may read from the stack.

**Fix**: For variadic calls, save register arguments to the stack first:

```asm
sub sp, sp, #128
str x0, [sp, #0]
str x1, [sp, #8]
str x2, [sp, #16]
str x3, [sp, #24]
; ... then load into registers for the call
```

### Gotcha: Simple Type Method Calls

For built-in types (`uint8`, `int8`, `float`), method calls like `n.to_string()` should pass the **value** in `x0`, not the address. The compiler must emit `ldr x0, [x0]` to dereference the address before calling the method.

### Assumption: Frame Pointer Always Used

We always set up `x29` as a frame pointer. This is slightly less efficient than omitting it, but makes debugging and stack unwinding much easier.

### Assumption: 16-byte Stack Alignment

We always align the total stack size to 16 bytes, following AARCH64 ABI requirements.

---

## Strategies and Tricks

### Mixed Allocation Strategy

We use a hybrid approach for variable declarations:

- **`var` declarations in functions**: Allocate on stack (via `sub sp, sp, #N`)
- **`const` declarations in functions**: Can remain as inline data after `ret`
- **Global declarations**: Always inline data

This gives the benefit of proper stack frames while keeping constants readable.

### Helper: `emit_data()` for Function Data

A helper function checks if we're currently inside a function (by checking `status.function_return_label`). If so, it appends data to a `function_data` buffer that gets emitted after the function's `ret`. If not, it emits immediately.

### Post-Processing Assembly for macOS

A `check_output_aarch64.ts` helper was created that:

1. Prepends `_` to libc symbol names (`printf` → `_printf`, `malloc` → `_malloc`)
2. Renames `main` to `_main`
3. Compiles with `clang -x assembler`
4. Runs the binary and checks output

### Raw Block Support

The `build_raw_node.ts` supports `#arch: aarch64` blocks, allowing inline assembly to be emitted only for the aarch64 backend. This is used in `System.nm` for the `to_string` methods.

### Label Counter Reset

At the start of each build, reset all label counters:

```typescript
reset_value_string_counter();
reset_op_string_counter();
reset_if_label_counter();
reset_for_label_counter();
reset_while_label_counter();
reset_func_label_counter(); // Added during this work
reset_access_temp_counter();
reset_func_call_temp_counter();
```

---

## macOS-Specific Requirements

### Symbol Naming

All C library functions need a `_` prefix on macOS:

- `printf` → `_printf`
- `malloc` → `_malloc`
- `snprintf` → `_snprintf`
- `exit` → `_exit`

### Entry Point

The program entry point must be `_main`, not `main`.

### Variadic Calling Convention

macOS AARCH64 uses a different variadic calling convention than Linux. Specifically:

- Arguments must be saved to the stack in the parameter save area before calling variadic functions
- `snprintf` and `printf` will read from the stack even when registers are used

### Float Register Passing

For variadic functions, floating-point arguments are passed in integer registers (`x0`–`x7`), not `v0`–`v7`. When calling `snprintf` with a `%f` format, the double value must be moved from `d0` to an integer register via `fmov`.

---

## Future Improvements

### 1. Remove Hardcoded `_` Prefixing

Instead of post-processing the assembly to add `_` prefixes, the backend should emit them directly when targeting macOS. This would make the generated assembly immediately usable without post-processing.

### 2. Proper Stack Frame Description

Currently, we manually manage stack sizes. A future improvement would be to compute the exact stack frame size needed for all locals at function entry and allocate once, rather than incrementally.

### 3. Register Allocation

Currently, all operations go through `x0`–`x7`. A proper register allocator would keep values in registers longer and reduce memory traffic.

### 4. Float Size Configuration

The decision to make `float` 8 bytes was pragmatic for this platform, but it may not be correct for all use cases. Consider making this configurable or using `float32` for 4-byte floats.

### 5. Inline Data Alignment

The current approach of emitting `.p2align 2` after inline data works but is fragile. A better approach would be to ensure all data is naturally aligned by padding or by placing data in a `.data` section.

### 6. Eliminate `function_data` Buffer

The `function_data` buffer that holds data to emit after `ret` is a workaround. A cleaner approach would be to:

- Always use stack allocation for function-local mutable data
- Place all string constants and float constants in a read-only data section

### 7. Support for Larger Programs

As programs grow, `adr` may exceed its ±1MB range. The backend should switch to `adrp` + `add` for addressing labels when needed.

### 8. Debug Information

Adding `.loc` directives or DWARF output would enable source-level debugging of generated assembly.

### 9. Stack Unwind Information

For proper exception handling and backtraces, `.cfi` directives should be added to establish the frame pointer chain.

### 10. Linux AARCH64 Support

The current backend is tuned for macOS. A Linux port would need:

- No `_` prefix on symbols
- Different variadic calling convention (may not need stack save area)
- `main` instead of `_main`

---

## Summary

Building an aarch64 backend from scratch revealed that the biggest challenges are not instruction selection but rather:

1. **Data alignment** - keeping instructions aligned
2. **Size correctness** - using proper byte/word/double operations
3. **Calling conventions** - especially macOS variadic functions
4. **Stack management** - proper frame pointer setup and local allocation

The aarch64 instruction set is clean and regular, but the ABI requirements (especially on macOS) are strict and unforgiving.
