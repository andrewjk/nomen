import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import test_error from "../test_error";
import trim_test_build from "../trim_test_build";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

test("ziglings 004 arrays -- errors", () => {
	const input = `
import System

pub func main = () -> {
  const uint8[] some_primes = [ 1, 3, 5, 7, 11, 13, 17, 19 ]

  some_primes[0] = 2

  const first = some_primes[0]
  const fourth = some_primes[???]
  const length = some_primes.???

  Console.write("First: \\{first}, Fourth: \\{fourth}, Length: \\{length}\\n")
}
`;
	const expected = [
		test_error(input, "Assignment to const: some_primes", 7, 3),
		test_error(input, "Unknown value: ???", 10, 30),
		test_error(input, "Field not found: ???", 11, 30),
		test_error(input, "Unknown value: length", 13, 64),
	];
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual(expected);
});

test("ziglings 004 arrays -- fixed", () => {
	const input = `
import System

pub func main = () -> {
  var uint8[] some_primes = [ 1, 3, 5, 7, 11, 13, 17, 19 ]

  some_primes[0] = 2

  const first = some_primes[0]
  const fourth = some_primes[3]
  const length = some_primes.length

  Console.write("First: \\{first}, Fourth: \\{fourth}, Length: \\{length}\\n")
}`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("ziglings 004 arrays -- build", async () => {
	const input = `
import System

pub func main = () -> {
  var uint8[] some_primes = [ 1, 3, 5, 7, 11, 13, 17, 19 ]

  some_primes[0] = 2

  const first = some_primes[0]
  const fourth = some_primes[3]
  const length = some_primes.length

  Console.write("First: \\{first}, Fourth: \\{fourth}, Length: \\{length}\\n")
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
str x3, [sp, #-16]!
ldr x0, =2
ldr x3, [sp], #16
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

_str_0: .asciz "First: %s, Fourth: %s, Length: %s\\n"

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

	const expected_output = "First: 2, Fourth: 7, Length: 8";
	await check_output_aarch64("004", built, expected_output);
});
