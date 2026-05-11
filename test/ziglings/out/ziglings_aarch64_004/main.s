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
.globl _main
_main:
stp x29, x30, [sp, #-16]!
sub sp, sp, #64
mov x29, sp
mov x0, #1
strb w0, [x29, #0]
mov x0, #3
strb w0, [x29, #1]
mov x0, #5
strb w0, [x29, #2]
mov x0, #7
strb w0, [x29, #3]
mov x0, #11
strb w0, [x29, #4]
mov x0, #13
strb w0, [x29, #5]
mov x0, #17
strb w0, [x29, #6]
mov x0, #19
strb w0, [x29, #7]
add x3, x29, #0
ldr x0, =2
strb w0, [x3, #0]
add x0, x29, #0
mov x3, x0
ldrb w0, [x3, #0]
strb w0, [x29, #8]
add x0, x29, #0
mov x3, x0
ldrb w0, [x3, #3]
strb w0, [x29, #9]
mov x0, #8
str x0, [x29, #16]
add x0, x29, #8
ldrb w0, [x0]
bl uint8_to_string
str x0, [x29, #24]
add x0, x29, #9
ldrb w0, [x0]
bl uint8_to_string
str x0, [x29, #32]
add x0, x29, #16
ldr x0, [x0]
bl int_to_string
str x0, [x29, #40]
ldr x0, [x29, #40]
mov x3, x0
ldr x0, [x29, #32]
mov x2, x0
ldr x0, [x29, #24]
mov x1, x0
adr x0, _str_0
bl _string_interpolate_3
str x0, [x29, #48]
ldr x0, [x29, #48]
mov x1, x0
bl Console_write
.return_0:
mov x0, #0
add sp, sp, #64
ldp x29, x30, [sp], #16
ret

_str_0: .asciz "First: %s, Fourth: %s, Length: %s\n"

.p2align 2
_string_interpolate_3:
stp x29, x30, [sp, #-16]!
mov x29, sp
sub sp, sp, #80
str x0, [sp, #72]
str x1, [sp, #0]
str x2, [sp, #8]
str x3, [sp, #16]
mov x0, xzr
mov x1, xzr
ldr x2, [sp, #72]
ldr x3, [sp, #0]
ldr x4, [sp, #8]
ldr x5, [sp, #16]
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
ldr x5, [sp, #16]
bl _snprintf
ldr x0, [sp, #64]
add sp, sp, #80
ldp x29, x30, [sp], #16
ret
