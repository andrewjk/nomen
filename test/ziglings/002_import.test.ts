import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import test_error from "../test_error";
import trim_test_build from "../trim_test_build";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

test("ziglings 002 import -- errors", () => {
	const input = `
import ???

pub func main = () -> {
    Console.write("Standard Library.\\n")
}
`;
	const expected = [test_error(input, "Unknown value: Console", 5, 5)];
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual(expected);
});

test("ziglings 002 import -- parse", () => {
	const input = `
import System

pub func main = () -> {
    Console.write("Standard Library.\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("ziglings 002 import -- build", async () => {
	const input = `
import System

pub func main = () -> {
    Console.write("Standard Library.\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	const expected = `
.p2align 2
main:
stp x29, x30, [sp, #-16]!
mov x29, sp
adr x0, _str_0
mov x1, x0
bl Console_write
.return_0:
mov x0, #0
ldp x29, x30, [sp], #16
ret

_str_0: .asciz "Standard Library.\\n"
`;
	expect(trim_test_build(built.code.substring(built.code.indexOf("\n.p2align 2\nmain:")))).toEqual(
		trim_test_build(expected),
	);

	const expected_output = "Standard Library.";
	await check_output_aarch64("002", built, expected_output);
});
