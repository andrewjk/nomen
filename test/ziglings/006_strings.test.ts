import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import test_error from "../test_error";
import trim_test_build from "../trim_test_build";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

test("ziglings 006 strings -- errors", () => {
	const input = `
import System

pub func main = () -> {
    const ziggy = "stardust"

    const d = ziggy[???]

    const laugh = "ha " ???

    const major = "Major"
    const tom = "Tom"
    const major_tom = major ??? tom

    Console.write("d=\\{d} \\{laugh}\\{major_tom}\\n")
}
`;
	const expected = [
		test_error(input, "Unknown value: ???", 7, 21),
		test_error(input, "Unknown value: ???", 9, 25),
		test_error(input, "Unknown value: ???", 13, 29),
	];
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual(expected);
});

test("ziglings 006 strings -- fixed", () => {
	const input = `
import System

pub func main = () -> {
    const ziggy = "stardust"

    const d = ziggy[4]

    const laugh = "ha " * 3

    const major = "Major"
    const tom = "Tom"
    const major_tom = major + " " + tom

    Console.write("d=\\{d} \\{laugh}\\{major_tom}\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("ziglings 006 strings -- build", async () => {
	const input = `
import System

pub func main = () -> {
    const ziggy = "stardust"

    const d = ziggy[4]

    const laugh = "ha " * 3

    const major = "Major"
    const tom = "Tom"
    const major_tom = major + " " + tom

    Console.write("d=\\{d} \\{laugh}\\{major_tom}\\n")
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
adr x0, ziggy
mov x3, x0
ldrb w0, [x3, #4]
strb w0, [x29, #0]
add x0, x29, #0
ldrb w0, [x0]
bl char_to_string
str x0, [x29, #8]
adr x0, laugh
bl string_to_string
str x0, [x29, #16]
adr x0, major_tom
bl string_to_string
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
ziggy: .asciz "stardust"
.p2align 2
laugh: .asciz "ha ha ha "
.p2align 2
major: .asciz "Major"
.p2align 2
tom: .asciz "Tom"
.p2align 2
major_tom: .asciz "Major Tom"
.p2align 2

_str_0: .asciz "d=%s %s%s\\n"

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

	const expected_output = "d=d ha ha ha Major Tom";
	await check_output_aarch64("006", built, expected_output);
});
