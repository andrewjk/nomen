import { describe, expect, test } from "vite-plus/test";

import parse from "../src/parse";
import build_and_check_output from "./build_and_check_output";
import test_error from "./test_error";

// STRUCT_PLAN_3 Phase A — spelled `ref` bindings. `ref Box q = p` is the ONLY
// way to alias a class instance: `var Box q = p` is a compile error. The rules
// (§A3): mutation through a ref requires a `var` source; a ref is not
// reassignable; nothing moves through a ref. Positive tests run BOTH backends
// (the aarch64 alias-classification asymmetry this exposes was fixed — see
// BUGS.md #3).

describe("ref binding: runtime", () => {
	test("read a field through a ref alias", async () => {
		const input = `
class Box { var int v }
	var Box p = Box(1)
	ref Box q = p
	Console.write("\\{q.v}")
`;
		await build_and_check_output(input, "ref_binding_read", "1");
	});

	test("mutate through a ref alias is visible through the owner", async () => {
		const input = `
class Box { var int v }
	var Box p = Box(1)
	ref Box q = p
	q.v = 5
	Console.write("\\{q.v} \\{p.v}")
`;
		await build_and_check_output(input, "ref_binding_mutate", "5 5");
	});

	test("mutate through a ref alias via a method call", async () => {
		const input = `
class Box {
	var int v
	func bump = (ref self) {
		self.v = self.v + 1
	}
}
	var Box p = Box(1)
	ref Box q = p
	q.bump()
	q.bump()
	Console.write("\\{p.v}")
`;
		await build_and_check_output(input, "ref_binding_method_mutate", "3");
	});

	test("a ref alias declared in a nested scope mutates the owner", async () => {
		const input = `
class Box { var int v }
	var Box p = Box(1)
	if true {
		ref Box q = p
		q.v = 7
	}
	Console.write("\\{p.v}")
`;
		await build_and_check_output(input, "ref_binding_nested_scope", "7");
	});

	test("a ref alias declared in a loop body mutates the owner each iteration", async () => {
		const input = `
class Box { var int v }
	var Box p = Box(0)
	for i of 0..5 {
		ref Box q = p
		q.v = q.v + 1
	}
	Console.write("\\{p.v}")
`;
		await build_and_check_output(input, "ref_binding_loop", "5");
	});

	test("two aliases share one instance", async () => {
		const input = `
class Box { var int v }
	var Box p = Box(1)
	ref Box q = p
	ref Box r = p
	q.v = 4
	r.v = r.v + 1
	Console.write("\\{p.v}")
`;
		await build_and_check_output(input, "ref_binding_two_aliases", "5");
	});

	test("reassigning the OWNER leaves the alias on the old instance", async () => {
		const input = `
class Box { var int v }
	var Box p = Box(1)
	ref Box q = p
	p = Box(2)
	Console.write("\\{q.v} \\{p.v}")
`;
		await build_and_check_output(input, "ref_binding_owner_reassign", "1 2");
	});

	test("a ref alias may alias a field borrow", async () => {
		const input = `
class Box { var int v }
class Holder {
	move Box c
}
	var Holder h = Holder(move Box(6))
	ref Box q = h.c
	q.v = q.v + 1
	Console.write("\\{h.c.v}")
`;
		await build_and_check_output(input, "ref_binding_field_borrow", "7");
	});

	test("a root-scope ref alias is readable in main and at the root", async () => {
		const input = `
import System
class Box { var int v }
var Box p = Box(1)
ref Box q = p
Console.write("\\{q.v} \\{p.v}\\n")
pub func main = () {
	Console.write("\\{q.v}")
}
`;
		await build_and_check_output(input, "ref_binding_root_scope", "1 1\n1", true);
	});

	test("move transfer (prefix form) invalidates the source and destroys once", async () => {
		const input = `
class Box {
	var int v
	func #destroy = () {
		Console.write("D")
	}
}
	var Box p = Box(1)
	move Box r = p
	Console.write("\\{r.v}\\n")
`;
		await build_and_check_output(input, "ref_binding_prefix_move_transfer", "1\nD");
	});

	test("move transfer of an owning value struct (prefix form)", async () => {
		const input = `
struct H {
	move List<int> items
}
	var H p = H(List<int>())
	p.items.push(42)
	move H q = p
	const int v = q.items.pop()
	Console.write("\\{v}")
`;
		await build_and_check_output(input, "ref_binding_prefix_move_struct", "42");
	});

	test("a ref binding is destroyed exactly once with its owner", async () => {
		const input = `
class Box {
	var int v
	func #destroy = () {
		Console.write("D")
	}
}
	var Box p = Box(1)
	ref Box q = p
	Console.write("x\\n")
`;
		await build_and_check_output(input, "ref_binding_single_destroy", "x\nD");
	});
});

// ERRORS
describe("ref binding: errors", () => {
	test("an unspelled class alias is an error", () => {
		const input = `
class Box { var int v }
var Box p = Box(1)
var Box q = p
`;
		const expected = [
			test_error(
				input,
				"'p' is aliased — use 'ref' to share it, 'move' to transfer it, or '.copy()' for a deep copy",
				4,
				13,
			),
		];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("mutation through a ref requires a var source (§A3.1)", () => {
		const input = `
class Box { var int v }
const Box p = Box(1)
ref Box q = p
q.v = 5
`;
		const expected = [test_error(input, "cannot mutate through 'q' — source 'p' is not var", 5, 1)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("a ref binding is not reassignable (§A3.2)", () => {
		const input = `
class Box { var int v }
var Box p = Box(1)
ref Box q = p
q = Box(3)
`;
		const expected = [test_error(input, "'q' is a ref — reassign the owner, not the alias", 5, 1)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("move through a ref is rejected (§A3.3, expression form)", () => {
		const input = `
class Box { var int v }
var Box p = Box(1)
ref Box q = p
move Box r = move q
`;
		const expected = [test_error(input, "'q' is a ref — move the owner instead", 5, 19)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("move through a ref is rejected (§A3.3, prefix form)", () => {
		const input = `
class Box { var int v }
var Box p = Box(1)
ref Box q = p
move Box r = q
`;
		const expected = [test_error(input, "'q' is a ref — move the owner instead", 5, 14)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("'ref' cannot declare a function-typed binding", () => {
		const input = `
func f = (out int) {
	return 1
}
ref func (out int) g = f
`;
		const parsed = parse(input);
		expect(parsed.errors.map((e) => e.message)).toContainEqual(
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
				"'ref' binds an alias to a reference type (class); use 'view' for a slice of 'P'",
				6,
				1,
			),
		];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("'ref' requires an existing binding (fresh constructor)", () => {
		const input = `
class Box { var int v }
ref Box q = Box(1)
`;
		const expected = [
			test_error(input, "'ref' requires an existing binding to alias, got an owned value", 3, 13),
		];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("'ref' requires an existing binding (owned call result)", () => {
		const input = `
class Box { var int v }
func make = (out Box) {
	return Box(1)
}
ref Box q = make()
`;
		const expected = [
			test_error(input, "'ref' requires an existing binding to alias, got an owned value", 6, 13),
		];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("'ref' never takes ownership (move initializer)", () => {
		const input = `
class Box { var int v }
var Box p = Box(1)
ref Box q = move p
`;
		const parsed = parse(input);
		expect(parsed.errors.map((e) => e.message)).toContainEqual(
			"'ref' binds an alias — 'move' cannot transfer through it",
		);
	});
});
