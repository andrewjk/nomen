import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import trim_test_build from "../trim_test_build";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

test("ziglings 007 strings 2 -- errors", () => {
	const input = `
import System

pub func main = () -> {
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

pub func main = () -> {
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

pub func main = () -> {
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
