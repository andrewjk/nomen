import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import trim_test_build from "../trim_test_build";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

test("ziglings 007 strings 2 -- errors", () => {
	const input = `
import System

pub func main = () {
    const lyrics =
        Ziggy played guitar
        Jamming good with Andrew Kelley
        And the Spiders from Mars

    Console.write("\\{lyrics}\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors.length).toBeGreaterThan(0);
});

test("ziglings 007 strings 2 -- fixed", () => {
	const input = `
import System

pub func main = () {
    const lyrics =
        "Ziggy played guitar
        "Jamming good with Andrew Kelley
        "And the Spiders from Mars

    Console.write("\\{lyrics}\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("ziglings 007 strings 2 -- build", async () => {
	const input = `
import System

pub func main = () {
    const lyrics =
        "Ziggy played guitar
        "Jamming good with Andrew Kelley
        "And the Spiders from Mars

    Console.write("\\{lyrics}\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	const expected = `
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
sub sp, sp, #16
mov x29, sp
str x0, [x29, #0]
str x1, [x29, #8]
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
add sp, sp, #16
ldp x29, x30, [sp], #16
ret
.p2align 2
bool_to_string:
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
main:
stp x29, x30, [sp, #-16]!
sub sp, sp, #16
mov x29, sp
adr x0, lyrics
bl string_to_string
str x0, [x29, #0]
ldr x0, [x29, #0]
mov x1, x0
adr x0, _str_0
bl _string_interpolate_1
str x0, [x29, #8]
ldr x0, [x29, #8]
bl Console_write
.return_0:
mov x0, #0
add sp, sp, #16
ldp x29, x30, [sp], #16
ret
lyrics: .asciz "Ziggy played guitar\\nJamming good with Andrew Kelley\\nAnd the Spiders from Mars"
.p2align 2

_str_0: .asciz "%s\\n"
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
`;
	expect(
		trim_test_build(
			built.code.substring(
				built.code.indexOf("\nstp x29, x30, [sp, #-16]!\nsub sp, sp, #16\nmov x29, sp\n"),
			),
		),
	).toEqual(trim_test_build(expected));

	const expected_output =
		"Ziggy played guitar\nJamming good with Andrew Kelley\nAnd the Spiders from Mars";
	await check_output_aarch64("007", built, expected_output);
});
