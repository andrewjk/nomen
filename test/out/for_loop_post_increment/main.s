.p2align 2
int_to_string:
stp x29, x30, [sp, #-16]!
str x19, [sp, #-16]!
mov x19, x0
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
uint_to_string:
stp x29, x30, [sp, #-16]!
str x19, [sp, #-16]!
mov x19, x0
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
mov x29, sp
mov x0, x19
.return_string_to_string:
ldr x19, [sp], #16
ldp x29, x30, [sp], #16
ret
.p2align 2
Array_init:
stp x29, x30, [sp, #-16]!
mov x29, sp
str xzr, [x0]
str x1, [x0, #8]
.return_Array_init:
ldp x29, x30, [sp], #16
ret
.p2align 2
Array_add:
stp x29, x30, [sp, #-16]!
str x19, [sp, #-16]!
mov x19, x0
mov x29, sp
.return_Array_add:
ldr x19, [sp], #16
ldp x29, x30, [sp], #16
ret
.p2align 2
Array_mul:
stp x29, x30, [sp, #-16]!
str x19, [sp, #-16]!
mov x19, x0
mov x29, sp
.return_Array_mul:
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
mov x29, sp
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
ldp x29, x30, [sp], #16
ret
.p2align 2
Math_init:
stp x29, x30, [sp, #-16]!
mov x29, sp
str xzr, [x0]
.return_Math_init:
ldp x29, x30, [sp], #16
ret
.p2align 2
Math_power:
stp x29, x30, [sp, #-16]!
mov x29, sp
mov x2, #1
mov x3, #0
b .Lchk_Math_power
.Lloop_Math_power:
mul x2, x2, x0
add x3, x3, #1
.Lchk_Math_power:
cmp x3, x1
blt .Lloop_Math_power
mov x0, x2
.return_Math_power:
ldp x29, x30, [sp], #16
ret
.p2align 2
.globl _main
_main:
stp x29, x30, [sp, #-16]!
sub sp, sp, #48
mov x29, sp
mov x0, #0
str x0, [x29, #0]
ldr x0, =0
str x0, [x29, #16]
.for_0:
ldr x0, [x29, #16]
mov x2, x0
ldr x0, =3
cmp x2, x0
bge .end_0
adr x3, nums
ldr x1, [x29, #16]
mov x2, #8
mul x1, x1, x2
add x0, x3, x1
ldr x0, [x0]
str x0, [x29, #8]
ldr x0, [x29, #8]
mov x2, x0
ldr x0, [x29, #0]
mov x1, x0
add x0, x1, x2

add x1, x29, #0
str x0, [x1]
.for_update_0:
add x1, x29, #8
ldr x1, [x1]
str x1, [sp, #-16]!
ldr x0, =1
ldr x1, [sp], #16
add x0, x1, x0
add x1, x29, #8
str x0, [x1]
ldr x0, [x29, #16]
add x0, x0, #1
str x0, [x29, #16]
b .for_0
.end_0:
add x0, x29, #0
ldr x0, [x0]
bl int_to_string
str x0, [x29, #24]
ldr x0, [x29, #24]
mov x1, x0
adr x0, _str_0
bl _string_interpolate_1
str x0, [x29, #32]
ldr x0, [x29, #32]
bl Console_write
.return_0:
mov x0, #0
add sp, sp, #48
ldp x29, x30, [sp], #16
ret
nums: .quad 1, 2, 3
.p2align 2

_str_0: .asciz "%s"

.p2align 2
_string_interpolate_1:
stp x29, x30, [sp, #-16]!
mov x29, sp
sub sp, sp, #80
str x0, [sp, #72]
str x1, [sp, #0]
mov x0, xzr
mov x1, xzr
ldr x2, [sp, #72]
ldr x3, [sp, #0]
bl _snprintf
add x0, x0, #1
str x0, [sp, #56]
bl _malloc
str x0, [sp, #64]
ldr x0, [sp, #64]
ldr x1, [sp, #56]
ldr x2, [sp, #72]
ldr x3, [sp, #0]
bl _snprintf
ldr x0, [sp, #64]
add sp, sp, #80
ldp x29, x30, [sp], #16
ret
