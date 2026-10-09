import { describe, expect, test } from "vite-plus/test";

import parse from "../src/parse";
import build_and_check_output from "./build_and_check_output";
import test_error from "./test_error";

// STRUCT_PLAN_3 Phase B B1/B1a — declared ownership. `mv struct X` /
// `mv enum X` declare the type move-only: bindings mv instead of copy,
// and the declared flag WINS over the inferred ownership walk (a string-only
// `mv struct` is still move-only — the declaration says the type owns;
// the compiler no longer second-guesses it). The Copyable verifier (declared
// subset) rejects a bare struct/enum with a DECLARED-mv member, naming
// the fix exactly as the plan words it.

describe("mv struct (B1)", () => {
	test("a declared-mv struct binding moves (runtime)", async () => {
		const input = `
mv struct Config {
	var string name
}
func probe = () {
	var Config c = Config("x")
	mv Config c2 = c
	Console.write_line(c2.name)
}
probe()
`;
		await build_and_check_output(input, "owning_struct_move", "x\n");
	});

	test("copying a declared-mv struct binding is an error", () => {
		const input = `
mv struct Config {
	var string name
}
var Config c = Config("x")
var Config c2 = c
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([
			test_error(
				input,
				"cannot copy 'Config' by value — it owns heap resources; use .copy() or mv",
				6,
				17,
			),
		]);
	});

	test("the Copyable verifier rejects a bare struct with a declared-mv field", () => {
		const input = `
mv struct Config {
	var string name
}
struct Wrapper {
	var Config c
}
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([
			test_error(
				input,
				"'Wrapper' cannot be Copyable — field 'c' owns heap memory --> mark the struct `mv struct Wrapper`, or remove the field",
				6,
				2,
			),
		]);
	});

	test("the declared flag wins over the inferred walk (string-only field still move-only)", () => {
		const input = `
mv struct Tag {
	var string label
}
var Tag t = Tag("a")
var Tag copy = t
`;
		const parsed = parse(input);
		expect(parsed.errors.some((e) => e.message.includes("cannot copy 'Tag' by value"))).toBe(true);
	});
});

describe("generic mv struct monos (R tranche 4)", () => {
	test("a mono of a declared-mv generic keeps the move-only flag", () => {
		const input = `
mv struct Holder<T> {
	var int count
}
var Holder<int> h = Holder(1)
var Holder<int> h2 = h
`;
		const parsed = parse(input);
		expect(parsed.errors.some((e) => e.message.includes("cannot copy 'Holder' by value"))).toBe(
			true,
		);
	});

	test("moving a mono binding builds and runs (runtime)", async () => {
		const input = `
import System

mv struct Holder<T> {
	var int count
}

	pub func main = () {
		var Holder<int> h = Holder<int>(7)
		mv Holder<int> h2 = h
		Console.write_line(h2.count.to_string())
	}
`;
		await build_and_check_output(input, "owning_mono_move", "7\n", true);
	});

	test("constructing a generic mono without call-site type args links the mono init", async () => {
		const input = `
import System

mv struct Holder<T> {
	var int count
}

pub func main = () {
	var Holder<int> h = Holder(7)
	Console.write_line(h.count.to_string())
}
`;
		await build_and_check_output(input, "generic_inferred_ctor", "7\n", true);
	});
});

describe("mv enum (B1a)", () => {
	test("the Copyable verifier rejects a bare enum with a declared-mv payload", () => {
		const input = `
mv struct Config {
	var string name
}
enum Holder {
	case some(Config c)
	case none
}
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([
			test_error(
				input,
				"'Holder' cannot be Copyable — case '.some' owns heap memory (its 'c' payload is `mv`) --> mark it `mv enum Holder`",
				6,
				12,
			),
		]);
	});

	test("copying a declared-mv enum binding is an error", () => {
		const input = `
mv struct Config {
	var string name
}
mv enum Holder {
	case some(Config c)
	case none
}
var Holder h = Holder.some(Config("x"))
var Holder copy = h
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([
			test_error(input, "cannot copy 'Holder' by value — it is a `mv enum`; use mv", 10, 19),
		]);
	});
});
