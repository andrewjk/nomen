import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import parse from "../src/parse";
import test_error from "./test_error";
import trim_test_build from "./trim_test_build";

// BUILD
describe("trait build", () => {
	test("trait", () => {
		const input = `
trait Person {}

struct Frank: Person {}
`;
		const parsed = parse(input);
		const result = build(parsed.root, { arch: "aarch64" });
		const expected = `
.p2align 2
Frank_init:
stp x29, x30, [sp, #-16]!
mov x29, sp
str xzr, [x0]
.return_Frank_init:
ldp x29, x30, [sp], #16
ret
`;
		expect(parsed.errors).toEqual([]);
		expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
	});

	test("trait with fields", () => {
		const input = `
trait Person {
  var string name
  var int age = 0
}

struct Frank: Person {
  var string name = "Frank"
}
`;
		const parsed = parse(input);
		const result = build(parsed.root, { arch: "aarch64" });
		const expected = `
.p2align 2
Frank_init:
stp x29, x30, [sp, #-16]!
mov x29, sp
str xzr, [x0]
adr x1, _str_Frank_init_name
str x1, [x0, #8]
.return_Frank_init:
ldp x29, x30, [sp], #16
ret

_str_Frank_init_name: .asciz "Frank"
`;
		expect(parsed.errors).toEqual([]);
		expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
	});

	test("trait with functions", () => {
		const input = `
trait Person {
  func greet = () {}
}

struct Frank: Person {
  func greet = (out string) {
    return "hi"
  }
}
`;
		const parsed = parse(input);
		const result = build(parsed.root, { arch: "aarch64" });
		const expected = `
.p2align 2
Frank_init:
stp x29, x30, [sp, #-16]!
mov x29, sp
str xzr, [x0]
.return_Frank_init:
ldp x29, x30, [sp], #16
ret
.p2align 2
Frank_greet:
stp x29, x30, [sp, #-16]!
mov x29, sp
adr x0, _str_0
b .return_Frank_greet
.return_Frank_greet:
ldp x29, x30, [sp], #16
ret

_str_0: .asciz "hi"
`;
		expect(parsed.errors).toEqual([]);
		expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
	});

	test("trait with implemented functions", () => {
		const input = `
trait Person {
  func greet = (out string) {
    return "hi"
  }
}

struct Frank: Person {}
`;
		const parsed = parse(input);
		const result = build(parsed.root, { arch: "aarch64" });
		const expected = `
.p2align 2
Frank_init:
stp x29, x30, [sp, #-16]!
mov x29, sp
str xzr, [x0]
.return_Frank_init:
ldp x29, x30, [sp], #16
ret
`;
		expect(parsed.errors).toEqual([]);
		expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
	});

	test("struct with multiple traits", () => {
		const input = `
trait Person {
  func greet = (out string) {
    return "hi"
  }
}

trait Dancer {
  func dance = () {}
}

struct Frank: Person, Dancer {
  func greet = (out string) {
    return "hi, frank"
  }
  func dance = () {}
}
`;
		const parsed = parse(input);
		const result = build(parsed.root, { arch: "aarch64" });
		const expected = `
.p2align 2
Frank_init:
stp x29, x30, [sp, #-16]!
mov x29, sp
str xzr, [x0]
.return_Frank_init:
ldp x29, x30, [sp], #16
ret
.p2align 2
Frank_greet:
stp x29, x30, [sp, #-16]!
mov x29, sp
adr x0, _str_0
b .return_Frank_greet
.return_Frank_greet:
ldp x29, x30, [sp], #16
ret
.p2align 2
Frank_dance:
stp x29, x30, [sp, #-16]!
mov x29, sp
.return_Frank_dance:
ldp x29, x30, [sp], #16
ret

_str_0: .asciz "hi, frank"
`;
		expect(parsed.errors).toEqual([]);
		expect(trim_test_build(result.code)).toEqual(trim_test_build(expected));
	});
});

// ERRORS
describe("trait errors", () => {
	test("invalid syntax", () => {
		const input = `
trait Person People {}
`;
		const expected = [test_error(input, "Expected {", 2, 14)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("child trait", () => {
		const input = `
trait Person {
  trait People {}
}
`;
		const expected = [test_error(input, "Trait cannot appear here", 3, 3)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("child assignment", () => {
		const input = `
trait Person {
  var int x
  x = 5
}
`;
		const expected = [test_error(input, "Assignment cannot appear here", 4, 3)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("unknown trait", () => {
		const input = `
struct Frank: Person {
}
`;
		const expected = [test_error(input, "Unknown trait: Person", 2, 1)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});
});
