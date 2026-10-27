import path from "node:path";

import { expect, test } from "vite-plus/test";

import { get_library } from "../src/lib";
import parse from "../src/parse";
import build_and_check_output from "./build_and_check_output";

const system = get_library(path.resolve("core"));

// Core-trust bounds gating: `.at` compiles to UNCHECKED loads, so an
// unverifiable runtime index must be a compile error everywhere EXCEPT
// System-library code (whose internals maintain their own invariants) and
// calls to `internal` library members (unreachable from production user
// code — the CLI never sets `allow_internal`). The old gate also trusted
// any struct whose name's first `_-segment` was `Buffer`/`BigInt` (a
// heuristic for monos like `Buffer_int`), which let user structs ship
// unchecked loads/stores by naming alone.

function check_errors(source: string) {
	return parse(`import System\n${source}`, system, undefined, { allow_internal: true }).errors;
}

test("a runtime index into .at is rejected in plain user code", () => {
	const errors = check_errors(`
func probe = (List<int> xs, int i, out int) {
	return xs.at(i)
}
`);
	expect(errors.some((e) => e.message.includes("Parameter constraint cannot be verified"))).toBe(
		true,
	);
});

test("a runtime index into .at is rejected inside a user struct named Buffer_*", () => {
	const errors = check_errors(`
struct Buffer_Foo {
	pub func probe = (self, List<int> xs, int i, out int) {
		return xs.at(i)
	}
}
`);
	expect(errors.some((e) => e.message.includes("Parameter constraint cannot be verified"))).toBe(
		true,
	);
});

test("a runtime index into .at is rejected inside a user struct named BigInt_*", () => {
	const errors = check_errors(`
struct BigInt_Helper {
	pub func probe = (self, List<int> xs, int i, out int) {
		return xs.at(i)
	}
}
`);
	expect(errors.some((e) => e.message.includes("Parameter constraint cannot be verified"))).toBe(
		true,
	);
});

test("an unproven literal index is rejected inside a user struct named Buffer_*", () => {
	// The list's length is runtime, so even a literal index is unverifiable —
	// and the Buffer_* naming must not excuse it.
	const errors = check_errors(`
struct Buffer_Foo {
	pub func probe = (self, List<int> xs, out int) {
		return xs.at(9)
	}
}
var Buffer_Foo f = Buffer_Foo()
var List<int> xs = List<int>()
xs.push(1)
Console.write("\\{f.probe(xs)}")
`);
	expect(errors.some((e) => e.message.includes("Parameter constraint cannot be verified"))).toBe(
		true,
	);
});

test("library code keeps its trust (List works end to end)", async () => {
	const input = `
var List<int> xs = List<int>()
xs.push(1)
xs.push(2)
Console.write("\\{xs.length} \\{xs.pop()}")
`;
	await build_and_check_output(input, "core_trust_list_ok", "2 2");
});

test("BigInt internals still work (runtime-index limb loads)", async () => {
	const input = `
var BigInt a = BigInt(42)
Console.write("\\{a.sign} \\{a.len} \\{(a.get(0) as int)}")
`;
	await build_and_check_output(input, "core_trust_bigint_ok", "1 1 42");
});

test("internal Buffer primitives stay callable from trusted-internal contexts", () => {
	// `internal` members are the System containers' own unchecked primitives;
	// their unverifiable constraints are exempt keyed on the callee's
	// internal+library flags (production user code can't name them at all).
	const errors = check_errors(`
mv struct Packed {
	var int v
}
struct Driver {
	func drive = (ref self, mv Box<Packed> seed, out int) {
		var ClassBuffer<Box<Packed>> cb = ClassBuffer<Box<Packed>>()
		cb.alloc_int(2)
		cb.store(0, mv seed)
		Console.write("\\{cb.load(0).v}")
		return 0
	}
}
var Driver d = Driver()
d.drive(Box<Packed>(Packed(7)))
`);
	expect(errors).toEqual([]);
});
