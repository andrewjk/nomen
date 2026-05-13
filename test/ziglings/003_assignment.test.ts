import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import test_error from "../test_error";
import trim_test_build from "../trim_test_build";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

test("ziglings 003 assignment -- errors", () => {
	const input = `
import System

pub func main = () {
    const uint8 n = 50
    n = n + 5

    const uint8 pi = 314159

    const uint8 negative_eleven = -11

    Console.write("\\{n} \\{pi} \\{negative_eleven}\\n")
}
`;
	const expected = [
		test_error(input, "Assignment to const: n", 6, 5),
		test_error(input, "Type mismatch in declaration: int (expected uint8)", 8, 22),
		test_error(input, "Type mismatch in declaration: int (expected uint8)", 10, 35),
	];
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual(expected);
});

test("ziglings 003 assignment -- parse", () => {
	const input = `
import System

pub func main = () {
    var uint8 n = 50
    n = n + 5

    const float pi = 3.14159

    const int8 negative_eleven = -11

    Console.write("\\{n} \\{pi} \\{negative_eleven}\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("ziglings 003 assignment -- build", async () => {
	const input = `
import System

pub func main = () {
    var uint8 n = 50
    n = n + 5

    const float pi = 3.14159

    const int8 negative_eleven = -11

    Console.write("\\{n} \\{pi} \\{negative_eleven}\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	const expected = `
.p2align 2
main:
stp x29, x30, [sp, #-16]!
sub sp, sp, #48
mov x29, sp
mov x0, #50
strb w0, [x29, #0]
ldr x2, =5
ldrb w0, [x29, #0]
mov x1, x0
add x0, x1, x2
add x1, x29, #0
strb w0, [x1]
add x0, x29, #0
ldrb w0, [x0]
bl uint8_to_string
str x0, [x29, #8]
adr x0, pi
ldr x0, [x0]
bl float_to_string
str x0, [x29, #16]
adr x0, negative_eleven
ldrsb x0, [x0]
bl int8_to_string
str x0, [x29, #24]
ldr x0, [x29, #24]
mov x3, x0
ldr x0, [x29, #16]
mov x2, x0
ldr x0, [x29, #8]
mov x1, x0
adr x0, _str_0
bl _string_interpolate_3
str x0, [x29, #32]
ldr x0, [x29, #32]
bl Console_write
.return_0:
mov x0, #0
add sp, sp, #48
ldp x29, x30, [sp], #16
ret
pi: .double 3.14159
negative_eleven: .byte -11
.p2align 2
_str_0: .asciz "%s %s %s\\n"
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
`;
	expect(trim_test_build(built.code.substring(built.code.indexOf("\n.p2align 2\nmain:")))).toEqual(
		trim_test_build(expected),
	);

	const expected_output = "55 3.141590 -11";
	await check_output_aarch64("003", built, expected_output);
});
