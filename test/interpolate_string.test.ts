import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import parse_with_imports from "../tests/ziglings/parse_with_imports";
import trim_test_build from "./trim_test_build";

// BUILD
describe("interpolate string build", () => {
	test("interpolate string", () => {
		const input = `
import System

const x = 5
const z = "\\{x} is less than \\{x + 5}!"
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		const expected = `
x: .quad 5
_param_0: .space 8
adr x0, x
ldr x0, [x0]
bl int_to_string
adr x1, _param_0
str x0, [x1]
_param_1: .space 8
ldr x2, =5
adr x0, x
ldr x0, [x0]
mov x1, x0
add x0, x1, x2
bl int_to_string
adr x1, _param_1
str x0, [x1]
z: .space 8
adr x0, _param_1
ldr x0, [x0]
mov x2, x0
adr x0, _param_0
ldr x0, [x0]
mov x1, x0
adr x0, _str_0
bl _string_interpolate_2
adr x1, z
str x0, [x1]

_str_0: .asciz "%s is less than %s!"
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
`;
		expect(parsed.errors).toEqual([]);
		expect(trim_test_build(result.code.substring(result.code.indexOf("x: .quad 5")))).toEqual(
			trim_test_build(expected),
		);
	});
});
