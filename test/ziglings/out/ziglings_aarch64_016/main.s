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
mov x0, #0
str x0, [x29, #0]
mov x0, #0
str x0, [x29, #8]
ldr x0, =0
str x0, [x29, #24]
.for_0:
ldr x0, [x29, #24]
mov x2, x0
ldr x0, =4
cmp x2, x0
bge .end_0
adr x3, bits
ldr x1, [x29, #24]
mov x2, #1
mul x1, x1, x2
add x0, x3, x1
ldrb w0, [x0]
strb w0, [x29, #16]
ldr x0, [x29, #8]
str x0, [x29, #32]
ldr x0, [x29, #32]
mov x1, x0
ldr x0, =2
bl Math_power
str x0, [x29, #40]
add x1, x29, #0
ldr x1, [x1]
str x1, [sp, #-16]!
ldrb w0, [x29, #16]
mov x2, x0
ldr x0, [x29, #40]
mov x1, x0
mul x0, x1, x2

ldr x1, [sp], #16
add x0, x1, x0
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
ldr x0, [x29, #24]
add x0, x0, #1
str x0, [x29, #24]
b .for_0
.end_0:
add x0, x29, #0
ldr x0, [x0]
bl int_to_string
str x0, [x29, #48]
ldr x0, [x29, #48]
mov x1, x0
adr x0, _str_0
bl _string_interpolate_1
str x0, [x29, #56]
ldr x0, [x29, #56]
bl Console_write
.return_0:
mov x0, #0
add sp, sp, #64
ldp x29, x30, [sp], #16
ret
bits: .byte 1, 0, 1, 1
.p2align 2

_str_0: .asciz "The value of bits '1101': %s.\n"

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
