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
sub sp, sp, #16
mov x29, sp
adr x0, _str_0
bl Console_write
ldr x0, =0
str x0, [x29, #8]
.for_0:
ldr x0, [x29, #8]
mov x2, x0
ldr x0, =5
cmp x2, x0
bge .end_0
adr x3, story
ldr x1, [x29, #8]
mov x2, #1
mul x1, x1, x2
add x0, x3, x1
ldrb w0, [x0]
strb w0, [x29, #0]
ldr x2, =104
ldrb w0, [x29, #0]
mov x1, x0
cmp x1, x2
cset x0, eq

cmp x0, #0
beq end_0
adr x0, _str_1
bl Console_write
end_0:
ldr x2, =115
ldrb w0, [x29, #0]
mov x1, x0
cmp x1, x2
cset x0, eq

cmp x0, #0
beq end_1
adr x0, _str_2
bl Console_write
end_1:
ldr x2, =110
ldrb w0, [x29, #0]
mov x1, x0
cmp x1, x2
cset x0, eq

cmp x0, #0
beq end_2
adr x0, _str_3
bl Console_write
end_2:
ldr x0, [x29, #8]
add x0, x0, #1
str x0, [x29, #8]
b .for_0
.end_0:
adr x0, _str_4
bl Console_write
.return_0:
mov x0, #0
add sp, sp, #16
ldp x29, x30, [sp], #16
ret
story: .byte 104, 104, 115, 110, 104
.p2align 2

_str_0: .asciz "A Dramatic Story: "
_str_1: .asciz ":-)  "
_str_2: .asciz ":-(  "
_str_3: .asciz ":-|  "
_str_4: .asciz "The End.\n"
