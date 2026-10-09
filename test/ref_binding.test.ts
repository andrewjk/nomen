import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { get_library } from "../src/lib";
import parse from "../src/parse";
import build_and_check_output from "./build_and_check_output";
import test_error from "./test_error";

const system = get_library(path.resolve("core"));

function check(source: string) {
	return parse(source, system, undefined, { allow_internal: true }).errors;
}

// STRUCT_PLAN_3 Phase A — spelled `ref` bindings. `ref Box<Cell> q = p` is the ONLY
// way to alias a class instance: `var Box<Cell> q = p` is a compile error. The rules
// (§A3): mutation through a ref requires a `var` source; a ref is not
// reassignable; nothing moves through a ref. Positive tests run BOTH backends
// (the aarch64 alias-classification asymmetry this exposes was fixed — see
// BUGS.md #3).

describe("ref binding: runtime", () => {
	test("read a field through a ref alias", async () => {
		const input = `
mv struct Cell { var int v }
	var Box<Cell> p = Box<Cell>(Cell(1))
	ref Box<Cell> q = p
	Console.write("\\{q.v}")
`;
		await build_and_check_output(input, "ref_binding_read", "1");
	});

	test("mutate through a ref alias is visible through the owner", async () => {
		const input = `
mv struct Cell { var int v }
	var Box<Cell> p = Box<Cell>(Cell(1))
	ref Box<Cell> q = p
	q.v = 5
	Console.write("\\{q.v} \\{p.v}")
`;
		await build_and_check_output(input, "ref_binding_mutate", "5 5");
	});

	test("mutate through a ref alias via a method call", async () => {
		const input = `
mv struct Cell {
	var int v
	func bump = (ref self) {
		self.v = self.v + 1
	}
}
	var Box<Cell> p = Box<Cell>(Cell(1))
	ref Box<Cell> q = p
	q.bump()
	q.bump()
	Console.write("\\{p.v}")
`;
		await build_and_check_output(input, "ref_binding_method_mutate", "3");
	});

	test("a ref alias declared in a nested scope mutates the owner", async () => {
		const input = `
mv struct Cell { var int v }
	var Box<Cell> p = Box<Cell>(Cell(1))
	if true {
		ref Box<Cell> q = p
		q.v = 7
	}
	Console.write("\\{p.v}")
`;
		await build_and_check_output(input, "ref_binding_nested_scope", "7");
	});

	test("a ref alias declared in a loop body mutates the owner each iteration", async () => {
		const input = `
mv struct Cell { var int v }
	var Box<Cell> p = Box<Cell>(Cell(0))
	for i of 0..5 {
		ref Box<Cell> q = p
		q.v = q.v + 1
	}
	Console.write("\\{p.v}")
`;
		await build_and_check_output(input, "ref_binding_loop", "5");
	});

	test("two aliases share one instance", async () => {
		const input = `
mv struct Cell { var int v }
	var Box<Cell> p = Box<Cell>(Cell(1))
	ref Box<Cell> q = p
	ref Box<Cell> r = p
	q.v = 4
	r.v = r.v + 1
	Console.write("\\{p.v}")
`;
		await build_and_check_output(input, "ref_binding_two_aliases", "5");
	});

	test("reassigning the OWNER leaves the alias on the old instance", async () => {
		const input = `
mv struct Cell { var int v }
	var Box<Cell> p = Box<Cell>(Cell(1))
	ref Box<Cell> q = p
	p = Box<Cell>(Cell(2))
	Console.write("\\{q.v} \\{p.v}")
`;
		await build_and_check_output(input, "ref_binding_owner_reassign", "1 2");
	});

	test("a ref alias may alias a field borrow", async () => {
		const input = `
mv struct Cell { var int v }
mv struct Holder {
	var Box<Cell> c
}
	var Holder h = Holder(mv Box<Cell>(Cell(6)))
	ref Box<Cell> q = h.c
	q.v = q.v + 1
	Console.write("\\{h.c.v}")
`;
		await build_and_check_output(input, "ref_binding_field_borrow", "7");
	});

	test("a root-scope ref alias is readable in main and at the root", async () => {
		const input = `
import System
mv struct Cell { var int v }
var Box<Cell> p = Box<Cell>(Cell(1))
ref Box<Cell> q = p
Console.write("\\{q.v} \\{p.v}\\n")
pub func main = () {
	Console.write("\\{q.v}")
}
`;
		await build_and_check_output(input, "ref_binding_root_scope", "1 1\n1", true);
	});

	test("mv transfer (prefix form) invalidates the source and destroys once", async () => {
		const input = `
mv struct Cell {
	var int v
	func #destroy = () {
		Console.write("D")
	}
}
	var Box<Cell> p = Box<Cell>(Cell(1))
	mv Box<Cell> r = p
	Console.write("\\{r.v}\\n")
`;
		await build_and_check_output(input, "ref_binding_prefix_move_transfer", "1\nD");
	});

	test("mv transfer of a mv value struct (prefix form)", async () => {
		const input = `
mv struct H {
	var List<int> items
}
	var H p = H(List<int>())
	p.items.push(42)
	mv H q = p
	const int v = q.items.pop()
	Console.write("\\{v}")
`;
		await build_and_check_output(input, "ref_binding_prefix_move_struct", "42");
	});

	test("a ref binding is destroyed exactly once with its owner", async () => {
		const input = `
mv struct Cell {
	var int v
	func #destroy = () {
		Console.write("D")
	}
}
	var Box<Cell> p = Box<Cell>(Cell(1))
	ref Box<Cell> q = p
	Console.write("x\\n")
`;
		await build_and_check_output(input, "ref_binding_single_destroy", "x\nD");
	});
});

// ERRORS
describe("ref binding: errors", () => {
	test("an unspelled class alias is an error", () => {
		const input = `
import System
mv struct Cell { var int v }
var Box<Cell> p = Box<Cell>(Cell(1))
var Box<Cell> q = p
`;
		const expected = [
			test_error(
				input,
				"'p' is aliased — use 'ref' to share it, 'mv' to transfer it, or '.copy()' for a deep copy",
				5,
				19,
			),
		];
		expect(check(input)).toEqual(expected);
	});

	test("mutation through a ref requires a var source (§A3.1)", () => {
		const input = `
import System
mv struct Cell { var int v }
const Box<Cell> p = Box<Cell>(Cell(1))
ref Box<Cell> q = p
q.v = 5
`;
		const expected = [test_error(input, "cannot mutate through 'q' — source 'p' is not var", 6, 1)];
		expect(check(input)).toEqual(expected);
	});

	test("a ref binding is not reassignable (§A3.2)", () => {
		const input = `
import System
mv struct Cell { var int v }
var Box<Cell> p = Box<Cell>(Cell(1))
ref Box<Cell> q = p
q = Box<Cell>(Cell(3))
`;
		const expected = [test_error(input, "'q' is a ref — reassign the owner, not the alias", 6, 1)];
		expect(check(input)).toEqual(expected);
	});

	test("mv through a ref is rejected (§A3.3, expression form)", () => {
		const input = `
import System
mv struct Cell { var int v }
var Box<Cell> p = Box<Cell>(Cell(1))
ref Box<Cell> q = p
mv Box<Cell> r = mv q
`;
		const expected = [test_error(input, "'q' is a ref — mv the owner instead", 6, 21)];
		expect(check(input)).toEqual(expected);
	});

	test("mv through a ref is rejected (§A3.3, prefix form)", () => {
		const input = `
import System
mv struct Cell { var int v }
var Box<Cell> p = Box<Cell>(Cell(1))
ref Box<Cell> q = p
mv Box<Cell> r = q
`;
		const expected = [test_error(input, "'q' is a ref — mv the owner instead", 6, 18)];
		expect(check(input)).toEqual(expected);
	});

	test("'ref' cannot declare a function-typed binding", () => {
		const input = `
func f = (out int) {
	return 1
}
ref func (out int) g = f
`;
		expect(check(input).map((e) => e.message)).toContainEqual(
			"'ref' cannot declare a function-typed binding",
		);
	});

	test("'ref' requires a reference type (value structs use view)", () => {
		const input = `
struct P {
	var int v
}
var P origin = P(1)
ref P r = origin
`;
		const expected = [
			test_error(
				input,
				"'ref' binds an alias to a heap-resident instance (a Box<T>); use 'view' for a slice of 'P'",
				6,
				1,
			),
		];
		expect(check(input)).toEqual(expected);
	});

	test("'ref' requires an existing binding (fresh constructor)", () => {
		const input = `
import System
mv struct Cell { var int v }
ref Box<Cell> q = Box<Cell>(Cell(1))
`;
		const expected = [
			test_error(input, "'ref' requires an existing binding to alias, got an owned value", 4, 19),
		];
		expect(check(input)).toEqual(expected);
	});

	test("'ref' requires an existing binding (owned call result)", () => {
		const input = `
import System
mv struct Cell { var int v }
func make = (out Box<Cell>) {
	return Box<Cell>(Cell(1))
}
ref Box<Cell> q = make()
`;
		const expected = [
			test_error(input, "'ref' requires an existing binding to alias, got an owned value", 7, 19),
		];
		expect(check(input)).toEqual(expected);
	});

	test("'ref' never takes ownership (mv initializer)", () => {
		const input = `
import System
mv struct Cell { var int v }
var Box<Cell> p = Box<Cell>(Cell(1))
ref Box<Cell> q = mv p
`;
		expect(check(input).map((e) => e.message)).toContainEqual(
			"'ref' binds an alias — 'mv' cannot transfer through it",
		);
	});
});
