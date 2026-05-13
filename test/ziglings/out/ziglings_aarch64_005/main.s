.p2align 2
int_to_string:
stp x29, x30, [sp, #-16]!
str x19, [sp, #-16]!
mov x19, x0
mov x29, sp
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
.return_Math_power:
ldp x29, x30, [sp], #16
ret
.p2align 2
.globl _main
_main:
stp x29, x30, [sp, #-16]!
sub sp, sp, #64
mov x29, sp
adr x0, _str_0
bl Console_write
ldr x0, =0
str x0, [x29, #8]
.for_0:
ldr x0, [x29, #8]
mov x2, x0
ldr x0, =4
cmp x2, x0
bge .end_0
adr x3, leet
ldr x1, [x29, #8]
mov x2, #8
mul x1, x1, x2
add x0, x3, x1
ldr x0, [x0]
str x0, [x29, #0]
add x0, x29, #0
ldr x0, [x0]
bl int_to_string
str x0, [x29, #16]
ldr x0, [x29, #16]
mov x1, x0
adr x0, _str_1
bl _string_interpolate_1
str x0, [x29, #24]
ldr x0, [x29, #24]
bl Console_write
ldr x0, [x29, #8]
add x0, x0, #1
str x0, [x29, #8]
b .for_0
.end_0:
adr x0, _str_2
bl Console_write
ldr x0, =0
str x0, [x29, #40]
.for_1:
ldr x0, [x29, #40]
mov x2, x0
ldr x0, =12
cmp x2, x0
bge .end_1
adr x3, bit_pattern
ldr x1, [x29, #40]
mov x2, #8
mul x1, x1, x2
add x0, x3, x1
ldr x0, [x0]
str x0, [x29, #32]
add x0, x29, #32
ldr x0, [x0]
bl int_to_string
str x0, [x29, #48]
ldr x0, [x29, #48]
mov x1, x0
adr x0, _str_3
bl _string_interpolate_1
str x0, [x29, #56]
ldr x0, [x29, #56]
bl Console_write
ldr x0, [x29, #40]
add x0, x0, #1
str x0, [x29, #40]
b .for_1
.end_1:
adr x0, _str_4
bl Console_write
.return_0:
mov x0, #0
add sp, sp, #64
ldp x29, x30, [sp], #16
ret
le: .quad 1, 3
.p2align 2
et: .quad 3, 7
.p2align 2
leet: .quad 1, 3, 3, 7
.p2align 2
bit_pattern: .quad 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1
.p2align 2

_str_0: .asciz "LEET: "
_str_1: .asciz "%s"
_str_2: .asciz ", Bits: "
_str_3: .asciz "%s"
_str_4: .asciz "\n"

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
