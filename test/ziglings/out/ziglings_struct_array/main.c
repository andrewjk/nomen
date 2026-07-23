.p2align 2
Point_init:
stp x29, x30, [sp, #-16]!
mov x29, sp
str xzr, [x0]
str x1, [x0, #8]
str x2, [x0, #16]
.return_Point_init:
ldp x29, x30, [sp], #16
ret
.p2align 2
int_to_string:
stp x29, x30, [sp, #-16]!
str x19, [sp, #-16]!
mov x19, x0
// no stack needed
mov x29, sp
sub sp, sp, #128
str x0, [sp, #0]
str x1, [sp, #8]
str x2, [sp, #16]
str x3, [sp, #24]
mov x0, xzr
mov x1, xzr
adr x2, .Lfmt_int_ld
mov x3, x19
bl _snprintf
add x0, x0, #1
str x0, [sp, #64]
bl _malloc
str x0, [sp, #72]
ldr x0, [sp, #72]
ldr x1, [sp, #64]
adr x2, .Lfmt_int_ld
mov x3, x19
bl _snprintf
ldr x0, [sp, #72]
add sp, sp, #128
b .Lend_int_to_string
.Lfmt_int_ld: .asciz "%ld"
.p2align 2
.Lend_int_to_string:
.return_int_to_string:
ldr x19, [sp], #16
ldp x29, x30, [sp], #16
ret
.p2align 2
int_parse:
stp x29, x30, [sp, #-16]!
sub sp, sp, #16
mov x29, sp
str x0, [x29, #0]
bl _atoi
.return_int_parse:
add sp, sp, #16
ldp x29, x30, [sp], #16
ret
.p2align 2
uint_to_string:
stp x29, x30, [sp, #-16]!
str x19, [sp, #-16]!
mov x19, x0
// no stack needed
mov x29, sp
sub sp, sp, #128
str x0, [sp, #0]
str x1, [sp, #8]
str x2, [sp, #16]
str x3, [sp, #24]
mov x0, xzr
mov x1, xzr
adr x2, .Lfmt_uint_ld
mov x3, x19
bl _snprintf
add x0, x0, #1
str x0, [sp, #64]
bl _malloc
str x0, [sp, #72]
ldr x0, [sp, #72]
ldr x1, [sp, #64]
adr x2, .Lfmt_uint_ld
mov x3, x19
bl _snprintf
ldr x0, [sp, #72]
add sp, sp, #128
b .Lend_uint_to_string
.Lfmt_uint_ld: .asciz "%ld"
.p2align 2
.Lend_uint_to_string:
.return_uint_to_string:
ldr x19, [sp], #16
ldp x29, x30, [sp], #16
ret
.p2align 2
int8_to_string:
stp x29, x30, [sp, #-16]!
str x19, [sp, #-16]!
mov x19, x0
// no stack needed
mov x29, sp
sub sp, sp, #128
str x0, [sp, #0]
str x1, [sp, #8]
str x2, [sp, #16]
str x3, [sp, #24]
mov x0, xzr
mov x1, xzr
adr x2, .Lfmt_int8_d
mov x3, x19
bl _snprintf
add x0, x0, #1
str x0, [sp, #64]
bl _malloc
str x0, [sp, #72]
ldr x0, [sp, #72]
ldr x1, [sp, #64]
adr x2, .Lfmt_int8_d
mov x3, x19
bl _snprintf
ldr x0, [sp, #72]
add sp, sp, #128
b .Lend_int8_to_string
.Lfmt_int8_d: .asciz "%d"
.p2align 2
.Lend_int8_to_string:
.return_int8_to_string:
ldr x19, [sp], #16
ldp x29, x30, [sp], #16
ret
.p2align 2
uint8_to_string:
stp x29, x30, [sp, #-16]!
str x19, [sp, #-16]!
mov x19, x0
// no stack needed
mov x29, sp
sub sp, sp, #128
str x0, [sp, #0]
str x1, [sp, #8]
str x2, [sp, #16]
str x3, [sp, #24]
mov x0, xzr
mov x1, xzr
adr x2, .Lfmt_uint8_d
mov x3, x19
bl _snprintf
add x0, x0, #1
str x0, [sp, #64]
bl _malloc
str x0, [sp, #72]
ldr x0, [sp, #72]
ldr x1, [sp, #64]
adr x2, .Lfmt_uint8_d
mov x3, x19
bl _snprintf
ldr x0, [sp, #72]
add sp, sp, #128
b .Lend_uint8_to_string
.Lfmt_uint8_d: .asciz "%d"
.p2align 2
.Lend_uint8_to_string:
.return_uint8_to_string:
ldr x19, [sp], #16
ldp x29, x30, [sp], #16
ret
.p2align 2
float_to_string:
stp x29, x30, [sp, #-16]!
str x19, [sp, #-16]!
mov x19, x0
// no stack needed
mov x29, sp
sub sp, sp, #128
str x0, [sp, #0]
str x1, [sp, #8]
str x2, [sp, #16]
str x3, [sp, #24]
str d0, [sp, #64]
mov x0, xzr
mov x1, xzr
adr x2, .Lfmt_float_f
fmov d0, x19
bl _snprintf
add x0, x0, #1
str x0, [sp, #64]
bl _malloc
str x0, [sp, #72]
ldr x0, [sp, #72]
ldr x1, [sp, #64]
adr x2, .Lfmt_float_f
fmov d0, x19
bl _snprintf
ldr x0, [sp, #72]
add sp, sp, #128
b .Lend_float_to_string
.Lfmt_float_f: .asciz "%f"
.p2align 2
.Lend_float_to_string:
.return_float_to_string:
ldr x19, [sp], #16
ldp x29, x30, [sp], #16
ret
.p2align 2
char_to_string:
stp x29, x30, [sp, #-16]!
str x19, [sp, #-16]!
mov x19, x0
// no stack needed
mov x29, sp
sub sp, sp, #128
str x0, [sp, #0]
str x1, [sp, #8]
str x2, [sp, #16]
str x3, [sp, #24]
mov x0, xzr
mov x1, xzr
adr x2, .Lfmt_char_c
mov x3, x19
bl _snprintf
add x0, x0, #1
str x0, [sp, #64]
bl _malloc
str x0, [sp, #72]
ldr x0, [sp, #72]
ldr x1, [sp, #64]
adr x2, .Lfmt_char_c
mov x3, x19
bl _snprintf
ldr x0, [sp, #72]
add sp, sp, #128
b .Lend_char_to_string
.Lfmt_char_c: .asciz "%c"
.p2align 2
.Lend_char_to_string:
.return_char_to_string:
ldr x19, [sp], #16
ldp x29, x30, [sp], #16
ret
.p2align 2
string_to_string:
stp x29, x30, [sp, #-16]!
str x19, [sp, #-16]!
mov x19, x0
// no stack needed
mov x29, sp
mov x0, x19
.return_string_to_string:
ldr x19, [sp], #16
ldp x29, x30, [sp], #16
ret
.p2align 2
string_at:
stp x29, x30, [sp, #-16]!
str x19, [sp, #-16]!
mov x19, x0
sub sp, sp, #16
mov x29, sp
str x1, [x29, #0]
// x19 = self (pointer), x1 = index
ldrb w0, [x19, x1]
.return_string_at:
add sp, sp, #16
ldr x19, [sp], #16
ldp x29, x30, [sp], #16
ret
.p2align 2
string_set:
stp x29, x30, [sp, #-16]!
sub sp, sp, #32
mov x29, sp
str x0, [x29, #0]
str x1, [x29, #8]
str x2, [x29, #16]
// x19 = self (pointer), x1 = index, w2 = value
strb w2, [x19, x1]
.return_string_set:
add sp, sp, #32
ldp x29, x30, [sp], #16
ret
.p2align 2
string_add:
stp x29, x30, [sp, #-16]!
str x19, [sp, #-16]!
mov x19, x0
sub sp, sp, #16
mov x29, sp
str x1, [x29, #0]
stp x20, x21, [sp, #-16]!
mov x20, x1
bl _strlen
mov x21, x0
mov x0, x20
bl _strlen
add x0, x21, x0
add x0, x0, #1
bl _malloc
mov x21, x0
mov x1, x19
bl _strcpy
mov x0, x21
mov x1, x20
bl _strcat
mov x0, x21
ldp x20, x21, [sp], #16
.return_string_add:
add sp, sp, #16
ldr x19, [sp], #16
ldp x29, x30, [sp], #16
ret
.p2align 2
string_mul:
stp x29, x30, [sp, #-16]!
str x19, [sp, #-16]!
mov x19, x0
sub sp, sp, #16
mov x29, sp
str x1, [x29, #0]
stp x20, x21, [sp, #-16]!
stp x22, xzr, [sp, #-16]!
mov x20, x1
bl _strlen
mov x21, x0
mul x0, x0, x20
add x0, x0, #1
bl _malloc
str x0, [x29, #8]
mov x22, x0
.Lmul_loop:
cbz x20, .Lmul_done
mov x0, x22
mov x1, x19
mov x2, x21
bl _memcpy
add x22, x22, x21
sub x20, x20, #1
b .Lmul_loop
.Lmul_done:
strb wzr, [x22]
ldr x0, [x29, #8]
ldp x22, xzr, [sp], #16
ldp x20, x21, [sp], #16
.return_string_mul:
add sp, sp, #16
ldr x19, [sp], #16
ldp x29, x30, [sp], #16
ret
.p2align 2
Console_init:
stp x29, x30, [sp, #-16]!
mov x29, sp
str xzr, [x0]
.return_Console_init:
ldp x29, x30, [sp], #16
ret
.p2align 2
Console_write:
stp x29, x30, [sp, #-16]!
sub sp, sp, #16
mov x29, sp
str x0, [x29, #0]
sub sp, sp, #16
mov x1, x0
str x1, [sp]
adr x0, .Lfmt_console_s
bl _printf
add sp, sp, #16
b .Lend_Console_write
.Lfmt_console_s: .asciz "%s"
.p2align 2
.Lend_Console_write:
.return_Console_write:
add sp, sp, #16
ldp x29, x30, [sp], #16
ret
.p2align 2
Console_write_line:
stp x29, x30, [sp, #-16]!
sub sp, sp, #16
mov x29, sp
str x0, [x29, #0]
sub sp, sp, #16
mov x1, x0
str x1, [sp]
adr x0, .Lfmt_console_snl
bl _printf
add sp, sp, #16
b .Lend_Console_write_line
.Lfmt_console_snl: .asciz "%s\n"
.p2align 2
.Lend_Console_write_line:
.return_Console_write_line:
add sp, sp, #16
ldp x29, x30, [sp], #16
ret
.p2align 2
Console_read_line:
stp x29, x30, [sp, #-16]!
// no stack needed
mov x29, sp
sub sp, sp, #32
mov x0, #16
bl _malloc
str x0, [sp, #0]
mov x1, #16
str x1, [sp, #8]
str xzr, [sp, #16]
bl _getchar
str w0, [sp, #24]
.Lconsole_readline_loop:
ldr w0, [sp, #24]
cmp w0, #0
blt .Lconsole_readline_done
cmp w0, #10
beq .Lconsole_readline_done
ldr x0, [sp, #16]
add x0, x0, #1
ldr x1, [sp, #8]
cmp x0, x1
ble .Lconsole_readline_store
ldr x1, [sp, #8]
lsl x1, x1, #1
str x1, [sp, #8]
ldr x0, [sp, #0]
bl _realloc
str x0, [sp, #0]
.Lconsole_readline_store:
ldr x0, [sp, #0]
ldr x1, [sp, #16]
ldr w2, [sp, #24]
strb w2, [x0, x1]
ldr x0, [sp, #16]
add x0, x0, #1
str x0, [sp, #16]
bl _getchar
str w0, [sp, #24]
b .Lconsole_readline_loop
.Lconsole_readline_done:
ldr x0, [sp, #0]
ldr x1, [sp, #16]
strb wzr, [x0, x1]
ldr x0, [sp, #0]
add sp, sp, #32
b .return_Console_read_line
adr x0, _str_0
b .return_Console_read_line
.return_Console_read_line:
ldp x29, x30, [sp], #16
ret
.p2align 2
Console_read_char:
stp x29, x30, [sp, #-16]!
// no stack needed
mov x29, sp
bl _getchar
.return_Console_read_char:
ldp x29, x30, [sp], #16
ret
.p2align 2
Console_platform:
stp x29, x30, [sp, #-16]!
// no stack needed
mov x29, sp
adr x0, .Lconsole_plat_macos
bl _strdup
b .return_Console_platform
.Lconsole_plat_macos: .asciz "macos"
.p2align 2
adr x0, _str_1
b .return_Console_platform
.return_Console_platform:
ldp x29, x30, [sp], #16
ret
.p2align 2
bool_to_string:
stp x29, x30, [sp, #-16]!
str x19, [sp, #-16]!
mov x19, x0
// no stack needed
mov x29, sp
sub sp, sp, #128
str x0, [sp, #0]
str x1, [sp, #8]
str x2, [sp, #16]
str x3, [sp, #24]
mov x0, xzr
mov x1, xzr
cbz x19, .Lfalse_bool
adr x2, .Lfmt_bool_true
mov x3, x19
bl _snprintf
add x0, x0, #1
str x0, [sp, #64]
bl _malloc
str x0, [sp, #72]
ldr x0, [sp, #72]
ldr x1, [sp, #64]
adr x2, .Lfmt_bool_true
mov x3, x19
bl _snprintf
ldr x0, [sp, #72]
add sp, sp, #128
b .Lend_bool_to_string
.Lfalse_bool:
adr x2, .Lfmt_bool_false
mov x3, x19
bl _snprintf
add x0, x0, #1
str x0, [sp, #64]
bl _malloc
str x0, [sp, #72]
ldr x0, [sp, #72]
ldr x1, [sp, #64]
adr x2, .Lfmt_bool_false
mov x3, x19
bl _snprintf
ldr x0, [sp, #72]
add sp, sp, #128
b .Lend_bool_to_string
.Lfmt_bool_true: .asciz "true"
.Lfmt_bool_false: .asciz "false"
.p2align 2
.Lend_bool_to_string:
.return_bool_to_string:
ldr x19, [sp], #16
ldp x29, x30, [sp], #16
ret
.p2align 2
Array_Point_init:
stp x29, x30, [sp, #-16]!
mov x29, sp
str xzr, [x0]
str x1, [x0, #8]
.return_Array_Point_init:
ldp x29, x30, [sp], #16
ret
.p2align 2
Array_Point_at:
stp x29, x30, [sp, #-16]!
str x19, [sp, #-16]!
mov x19, x0
sub sp, sp, #16
mov x29, sp
str x8, [x29, #0]
str x1, [x29, #8]
// x19 = self (first elem), x1 = index
mov x2, #24
mul x1, x1, x2
ldr x0, [x19, x1]
.return_Array_Point_at:
add sp, sp, #16
ldr x19, [sp], #16
ldp x29, x30, [sp], #16
ret
.p2align 2
Array_Point_first:
stp x29, x30, [sp, #-16]!
str x19, [sp, #-16]!
mov x19, x0
sub sp, sp, #16
mov x29, sp
str x8, [x29, #0]
// x19 = self (first elem)
ldr x0, [x19]
.return_Array_Point_first:
add sp, sp, #16
ldr x19, [sp], #16
ldp x29, x30, [sp], #16
ret
.p2align 2
Array_Point_set:
stp x29, x30, [sp, #-16]!
str x19, [sp, #-16]!
mov x19, x0
str x20, [sp, #-16]!
mov x20, x2
sub sp, sp, #16
mov x29, sp
str x1, [x29, #0]
// x19 = self (first elem), x1 = index, x2 = (*value)
mov x3, #24
mul x1, x1, x3
// Only use the 8-byte store when 24 is exactly 8 (int/string/ptr).
// For smaller types (char/bool/int8/etc.) strb/strh/str w/ would
// clobber adjacent slots, so fall through to a size-aware store.
cmp x3, #8
b.ne .LArray_Point__set_byte
str x2, [x19, x1]
b .LArray_Point__set_done
.LArray_Point__set_byte:
strb w2, [x19, x1]
.LArray_Point__set_done:
.return_Array_Point_set:
add sp, sp, #16
ldr x20, [sp], #16
ldr x19, [sp], #16
ldp x29, x30, [sp], #16
ret
.p2align 2
Array_Point_at_end:
stp x29, x30, [sp, #-16]!
str x19, [sp, #-16]!
mov x19, x0
sub sp, sp, #16
mov x29, sp
str x8, [x29, #0]
// x19 = self (first elem), length at [x19 - 8]
ldr x0, [x19, #-8]
sub x0, x0, #1
mov x1, #24
mul x0, x0, x1
ldr x0, [x19, x0]
.return_Array_Point_at_end:
add sp, sp, #16
ldr x19, [sp], #16
ldp x29, x30, [sp], #16
ret
.p2align 2
Array_Point_with:
stp x29, x30, [sp, #-16]!
str x19, [sp, #-16]!
mov x19, x0
sub sp, sp, #16
mov x29, sp
str x8, [x29, #0]
str x1, [x29, #8]
// x0 = (*value), x1 = count
// Returns x0 = heap-allocated array pointer ([ptr]=length, [ptr+8..]=data).
// This is a regular static function: the caller receives the pointer in x0,
// so no sret/x8 buffer is involved.
stp x19, x20, [sp, #-16]!
stp x1, x0, [sp, #-16]!        // [sp]=count, [sp+8]=(*value)
// ptr = malloc(8 + count * 24)
mov x2, #24
mul x0, x1, x2
add x0, x0, #8
bl _malloc
mov x19, x0                    // x19 = ptr
// Store the length prefix and set up the data area.
ldr x1, [sp]                   // count
str x1, [x19]                  // [ptr] = count
add x20, x19, #8               // x20 = data area
cbz x1, .LArray_Point_array_with_end
ldr x0, [sp, #8]               // (*value)
mov x2, #0                     // i = 0
.LArray_Point_array_with_loop:
mov x3, #24
mul x4, x2, x3                 // offset = i * 24
add x5, x20, x4                // addr = data + offset
// Store the (*value) (in x0) into [x5] using a width that matches
// 24. For 24 <= 8 the (*value) is in x0 directly (char/int/
// pointer); for 24 > 8 (struct) x0 is a pointer to the bytes
// and we copy them one by one.
cmp x3, #8
b.gt .LArray_Point_array_with_copy_loop
cmp x3, #4
b.eq .LArray_Point_array_with_store4
cmp x3, #2
b.eq .LArray_Point_array_with_store2
cmp x3, #1
b.eq .LArray_Point_array_with_store1
// 24 == 8 (int/string-ptr/class-ptr): single 8-byte store
str x0, [x5]
b .LArray_Point_array_with_next
.LArray_Point_array_with_store4:
str w0, [x5]
b .LArray_Point_array_with_next
.LArray_Point_array_with_store2:
strh w0, [x5]
b .LArray_Point_array_with_next
.LArray_Point_array_with_store1:
strb w0, [x5]
b .LArray_Point_array_with_next
.LArray_Point_array_with_copy_loop:
// Struct element (24 > 8): x0 is a pointer to the bytes — copy
// them one by one so adjacent slots aren't clobbered.
mov x6, #0                     // j = 0
.LArray_Point_array_with_byte:
ldrb w7, [x0, x6]
strb w7, [x5, x6]
add x6, x6, #1
cmp x6, x3
blt .LArray_Point_array_with_byte
.LArray_Point_array_with_next:
add x2, x2, #1
ldr x1, [sp]
cmp x2, x1
blt .LArray_Point_array_with_loop
.LArray_Point_array_with_end:
mov x0, x19                    // return heap pointer
add sp, sp, #16
ldp x19, x20, [sp], #16
.return_Array_Point_with:
add sp, sp, #16
ldr x19, [sp], #16
ldp x29, x30, [sp], #16
ret
.p2align 2
Array_Point_add:
stp x29, x30, [sp, #-16]!
str x19, [sp, #-16]!
mov x19, x0
str x20, [sp, #-16]!
mov x20, x1
sub sp, sp, #16
mov x29, sp
str x8, [x29, #0]
// x19 = self (first elem), x20 = other (first elem), x8 = return buf (first elem)
// Length prefix is at [base - 8]
// Save return buffer (clobbered by _memcpy)
str x8, [sp, #-16]!
// Load lengths and store result length
ldr x2, [x19, #-8]
ldr x3, [x20, #-8]
add x4, x2, x3
ldr x8, [sp]
str x4, [x8, #-8]
// self_bytes = self_len * 24
mov x5, #24
mul x5, x2, x5
// memcpy(return_buf, self, self_bytes)
mov x0, x8
mov x1, x19
mov x2, x5
bl _memcpy
// Reload return buf and self_len (clobbered by memcpy)
ldr x8, [sp]
ldr x2, [x19, #-8]
mov x5, #24
mul x5, x2, x5
// other_bytes
ldr x3, [x20, #-8]
mov x6, #24
mul x6, x3, x6
// memcpy(return_buf + self_bytes, other, other_bytes)
add x0, x8, x5
mov x1, x20
mov x2, x6
bl _memcpy
add sp, sp, #16
.return_Array_Point_add:
add sp, sp, #16
ldr x20, [sp], #16
ldr x19, [sp], #16
ldp x29, x30, [sp], #16
ret
.p2align 2
Array_Point_mul:
stp x29, x30, [sp, #-16]!
str x19, [sp, #-16]!
mov x19, x0
sub sp, sp, #16
mov x29, sp
str x8, [x29, #0]
str x1, [x29, #8]
// x19 = self (first elem), x1 = multiplier, x8 = return buf (first elem)
// Save return buf and multiplier
stp x8, x1, [sp, #-16]!
// self_len and self_bytes
ldr x2, [x19, #-8]
mov x5, #24
mul x5, x2, x5
// result_len = self_len * multiplier
mul x3, x2, x1
ldr x8, [sp]
str x3, [x8, #-8]
// Loop: copy self to result multiplier times
mov x4, #0
.LArray_Point_array_mul_loop:
ldr x1, [sp, #8]
cmp x4, x1
b.ge .LArray_Point_array_mul_end
// dest = return_buf + x4 * self_bytes
ldr x8, [sp]
mul x6, x4, x5
add x0, x8, x6
// memcpy(dest, self, self_bytes)
mov x1, x19
mov x2, x5
bl _memcpy
add x4, x4, #1
b .LArray_Point_array_mul_loop
.LArray_Point_array_mul_end:
add sp, sp, #16
.return_Array_Point_mul:
add sp, sp, #16
ldr x19, [sp], #16
ldp x29, x30, [sp], #16
ret
.p2align 2
.globl _main
_main:
stp x29, x30, [sp, #-16]!
sub sp, sp, #288
mov x29, sp
mov x0, #3
str x0, [x29, #0]
mov x0, #2
str x0, [x29, #88]
mov x0, #1
str x0, [x29, #80]
ldr x1, [x29, #80]
ldr x2, [x29, #88]
add x0, x29, #8
bl Point_init
mov x0, #4
str x0, [x29, #104]
mov x0, #3
str x0, [x29, #96]
ldr x1, [x29, #96]
ldr x2, [x29, #104]
add x0, x29, #32
bl Point_init
mov x0, #6
str x0, [x29, #120]
mov x0, #5
str x0, [x29, #112]
ldr x1, [x29, #112]
ldr x2, [x29, #120]
add x0, x29, #56
bl Point_init
mov x0, #0
mov x1, x0
add x9, x29, #8
mov x2, #24
mul x1, x1, x2
add x0, x9, x1
ldr x0, [x0, #8]
bl int_to_string
str x0, [x29, #128]
mov x0, #0
mov x1, x0
add x9, x29, #8
mov x2, #24
mul x1, x1, x2
add x0, x9, x1
ldr x0, [x0, #16]
bl int_to_string
str x0, [x29, #136]
ldr x0, [x29, #136]
str x0, [x29, #176]
ldr x0, [x29, #128]
str x0, [x29, #168]
adr x0, _str_2
str x0, [x29, #160]
ldr x1, [x29, #168]
ldr x2, [x29, #176]
ldr x0, [x29, #160]
bl _string_interpolate_2
str x0, [x29, #144]
ldr x0, [x29, #144]
bl Console_write
mov x0, #1
mov x1, x0
add x9, x29, #8
mov x2, #24
mul x1, x1, x2
add x0, x9, x1
ldr x0, [x0, #8]
bl int_to_string
str x0, [x29, #184]
mov x0, #1
mov x1, x0
add x9, x29, #8
mov x2, #24
mul x1, x1, x2
add x0, x9, x1
ldr x0, [x0, #16]
bl int_to_string
str x0, [x29, #192]
ldr x0, [x29, #192]
str x0, [x29, #224]
ldr x0, [x29, #184]
str x0, [x29, #216]
adr x0, _str_3
str x0, [x29, #208]
ldr x1, [x29, #216]
ldr x2, [x29, #224]
ldr x0, [x29, #208]
bl _string_interpolate_2
str x0, [x29, #200]
ldr x0, [x29, #200]
bl Console_write
mov x0, #2
mov x1, x0
add x9, x29, #8
mov x2, #24
mul x1, x1, x2
add x0, x9, x1
ldr x0, [x0, #8]
bl int_to_string
str x0, [x29, #232]
mov x0, #2
mov x1, x0
add x9, x29, #8
mov x2, #24
mul x1, x1, x2
add x0, x9, x1
ldr x0, [x0, #16]
bl int_to_string
str x0, [x29, #240]
ldr x0, [x29, #240]
str x0, [x29, #272]
ldr x0, [x29, #232]
str x0, [x29, #264]
adr x0, _str_4
str x0, [x29, #256]
ldr x1, [x29, #264]
ldr x2, [x29, #272]
ldr x0, [x29, #256]
bl _string_interpolate_2
str x0, [x29, #248]
ldr x0, [x29, #248]
bl Console_write
ldr x0, [x29, #128]
bl _free
ldr x0, [x29, #136]
bl _free
ldr x0, [x29, #144]
bl _free
ldr x0, [x29, #184]
bl _free
ldr x0, [x29, #192]
bl _free
ldr x0, [x29, #200]
bl _free
ldr x0, [x29, #232]
bl _free
ldr x0, [x29, #240]
bl _free
ldr x0, [x29, #248]
bl _free
.return_0:
mov x0, #0
add sp, sp, #288
ldp x29, x30, [sp], #16
ret

_str_0: .asciz ""
_str_1: .asciz ""
_str_2: .asciz "%s %s\n"
_str_3: .asciz "%s %s\n"
_str_4: .asciz "%s %s"

.p2align 2
_string_interpolate_2:
stp x29, x30, [sp, #-16]!
mov x29, sp
sub sp, sp, #80
str x0, [sp, #72]
str x1, [sp, #0]
str x2, [sp, #8]
mov x0, xzr
mov x1, xzr
ldr x2, [sp, #72]
ldr x3, [sp, #0]
ldr x4, [sp, #8]
bl _snprintf
add x0, x0, #1
str x0, [sp, #56]
bl _malloc
str x0, [sp, #64]
ldr x0, [sp, #64]
ldr x1, [sp, #56]
ldr x2, [sp, #72]
ldr x3, [sp, #0]
ldr x4, [sp, #8]
bl _snprintf
ldr x0, [sp, #64]
add sp, sp, #80
ldp x29, x30, [sp], #16
ret
