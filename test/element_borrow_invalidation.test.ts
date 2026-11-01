import { describe, expect, test } from "vite-plus/test";

import { parse_program } from "./parse_with_imports";

// Element-borrow invalidation: the `ref T x = container.<read>(i)` alias is a
// pointer INTO the container's slab, so anything that frees or displaces that
// storage must kill it:
//   - a `ref`-ARGUMENT call (consume(ref xs) — the sanctioned callee-mutates
//     shape) may pop/realloc through the alias;
//   - a container REASSIGNMENT (xs = other) destroys the old slab eagerly.
// Both follow the `ref self` receiver path's contract: reading the alias
// afterwards is rejected with the invalidated-borrow error.

const PROGRAM = `
import System

mv struct Rec {
	var tags = List<string>()
	var int id = 0
}

func consume = (ref List<Rec> xs) { xs.pop() }

pub func main = (Init init) {
	var List<Rec> xs = List<Rec>()
	var Rec r = Rec()
	r.id = 7
	xs.push(mv r)
BODY
}
`;

function check(body: string) {
	return parse_program(PROGRAM.replace("BODY", body));
}

describe("element borrow invalidation (check)", () => {
	test("a ref-argument call between the alias and its read is rejected", () => {
		const parsed = check(`
		ref Rec a = xs.at(0)
		consume(ref xs)
		Console.write("\\{a.id}")`);
		expect(parsed.errors.some((e) => e.message.includes("invalidated"))).toBe(true);
	});

	test("a container reassignment between the alias and its read is rejected", () => {
		const parsed = check(`
		ref Rec a = xs.at(0)
		xs = List<Rec>()
		Console.write("\\{a.id}")`);
		expect(parsed.errors.some((e) => e.message.includes("invalidated"))).toBe(true);
	});

	test("a ref-argument call before the alias is taken is fine", () => {
		// The pass sweeps length facts (the callee may pop), so the later
		// rewrite re-proves the bounds contract under a guard — the
		// documented spelling.
		const parsed = check(`
		consume(ref xs)
		if xs.length > 0 {
			ref Rec a = xs.at(0)
			Console.write("\\{a.id}")
		}`);
		expect(parsed.errors).toEqual([]);
	});

	test("a container reassignment after the alias's last read is fine", () => {
		const parsed = check(`
		ref Rec a = xs.at(0)
		Console.write("\\{a.id}")
		xs = List<Rec>()`);
		expect(parsed.errors).toEqual([]);
	});
});
