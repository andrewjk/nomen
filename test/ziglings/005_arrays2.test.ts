import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import test_error from "../test_error";
import trim_test_build from "../trim_test_build";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

test("ziglings 005 arrays 2 -- errors", () => {
	const input = `
import System

pub func main = () {
    const le = [ 1, 3 ]
    const et = [ 3, 7 ]

    const leet = ???

    const bit_pattern = [ ??? ] * 3

    Console.write("LEET: ")

    for n of leet {
        Console.write("\\{n}")
    }

    Console.write(", Bits: ")

    for n of bit_pattern {
        Console.write("\\{n}")
    }

    Console.write("\\n")
}
`;
	const expected = [
		test_error(input, "Unknown value: ???", 8, 18),
		test_error(input, "Unknown value: ???", 10, 27),
		test_error(input, "Unknown value: leet", 14, 14),
		test_error(input, "Unknown value: n", 15, 26),
		test_error(input, "Unknown value: bit_pattern", 20, 14),
		test_error(input, "Unknown value: n", 21, 26),
	];
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual(expected);
});

test("ziglings 005 arrays 2 -- fixed", () => {
	const input = `
import System

pub func main = () {
    const le = [ 1, 3 ]
    const et = [ 3, 7 ]

    const leet = le + et

    const bit_pattern = [ 1, 0, 0, 1] * 3

    Console.write("LEET: ")

    for n of leet {
        Console.write("\\{n}")
    }

    Console.write(", Bits: ")

    for n of bit_pattern {
        Console.write("\\{n}")
    }

    Console.write("\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("ziglings 005 arrays 2 -- build", async () => {
	const input = `
import System

pub func main = () {
  const le = [ 1, 3 ]
  const et = [ 3, 7 ]

  const leet = le + et

  const bit_pattern = [ 1, 0, 0, 1] * 3

  Console.write("LEET: ")

  for n of leet {
      Console.write("\\{n}")
  }

  Console.write(", Bits: ")

  for n of bit_pattern {
      Console.write("\\{n}")
  }

  Console.write("\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	const expected = `
.p2align 2
main:
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
.for_inc_0:
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
.for_inc_1:
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
_str_4: .asciz "\\n"

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
	expect(trim_test_build(built.code.substring(built.code.indexOf("\n.p2align 2\nmain:")))).toEqual(
		trim_test_build(expected),
	);

	const expected_output = "LEET: 1337, Bits: 100110011001";
	await check_output_aarch64("005", built, expected_output);
});
