import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// The ANONYMOUS override constructor return (`return [ .. R(), f = local ]`,
// a func_call with `field_overrides`) was excluded from return-boundary
// normalization: the override store left the field ALIASING the local's
// pair, and the callee's scope-exit reclaim freed the buffer under the
// returned struct (use-after-free). The boundary now normalizes
// override-constructor returns (and forwarded-with-override returns from
// registered normalizers) — an overridden field is strdup'd unless the
// override value owns heap — and the classification registers those
// functions so caller bindings record and free every string field.

describe("override-constructor return normalization", () => {
	test("heap local override does not dangle (callee reclaims its own copy)", async () => {
		const input = `
import System

struct Pair {
	var string a = "default"
	var string b
}

func make_pair = (string seed, out Pair) {
	var string mine = "heap" + "!"
	return [ .. Pair(seed), a = mine ]
}

pub func main = (Init init) {
	var Pair p = make_pair("x")
	Console.write("a=\\{p.a}\\n")
	Console.write("b=\\{p.b}\\n")
}
`;
		await build_and_check_output(input, "override_ctor_heap_local", "a=heap!\nb=x\n", true);
	});

	test("override from a fresh call result transfers raw (no extra copy)", async () => {
		const input = `
import System

struct Pair {
	var string a = "default"
	var string b
}

func fresh = (out string) {
	return "fresh" + "!"
}

func make_pair = (string seed, out Pair) {
	return [ .. Pair(seed), a = fresh() ]
}

pub func main = (Init init) {
	var Pair p = make_pair("x")
	Console.write("a=\\{p.a}\\n")
	Console.write("b=\\{p.b}\\n")
}
`;
		await build_and_check_output(input, "override_ctor_fresh_result", "a=fresh!\nb=x\n", true);
	});

	test("override via move transfers the local's buffer", async () => {
		const input = `
import System

struct Pair {
	var string a = "default"
	var string b
}

func make_pair = (string seed, out Pair) {
	var string mine = "heap" + "!"
	return [ .. Pair(seed), a = move mine ]
}

pub func main = (Init init) {
	var Pair p = make_pair("x")
	Console.write("a=\\{p.a}\\n")
	Console.write("b=\\{p.b}\\n")
}
`;
		await build_and_check_output(input, "override_ctor_move_local", "a=heap!\nb=x\n", true);
	});

	test("forwarded call with overrides normalizes through the base", async () => {
		const input = `
import System

struct Pair {
	var string a = "default"
	var string b
}

func make_base = (string seed, out Pair) {
	var string s = seed + "-base"
	return Pair(s)
}

func make_override = (string seed, out Pair) {
	var string mine = "heap" + "!"
	return [ .. make_base(seed), a = mine ]
}

pub func main = (Init init) {
	var Pair p = make_override("x")
	Console.write("a=\\{p.a}\\n")
	Console.write("b=\\{p.b}\\n")
}
`;
		await build_and_check_output(input, "override_ctor_forwarded", "a=heap!\nb=x-base\n", true);
	});

	test("call-site override on a registered normalizer stays balanced", async () => {
		const input = `
import System

struct Pair {
	var string a = "default"
	var string b
}

func make_base = (string seed, out Pair) {
	var string s = seed + "-base"
	return Pair(s)
}

pub func main = (Init init) {
	var Pair p = [ .. make_base("x"), a = "override" ]
	Console.write("a=\\{p.a}\\n")
	Console.write("b=\\{p.b}\\n")
}
`;
		await build_and_check_output(
			input,
			"override_ctor_site_override",
			"a=override\nb=x-base\n",
			true,
		);
	});

	test("plain constructor return normalization unchanged", async () => {
		const input = `
import System

struct Pair {
	var string a = "default"
	var string b
}

func make_pair = (string seed, out Pair) {
	var string s = seed + "-s"
	return Pair(s)
}

pub func main = (Init init) {
	var Pair p = make_pair("x")
	Console.write("b=\\{p.b}\\n")
}
`;
		await build_and_check_output(input, "override_ctor_plain_regression", "b=x-s\n", true);
	});

	test("returned value consumed as a call argument stays sound", async () => {
		const input = `
import System

struct Pair {
	var string a = "default"
	var string b
}

func make_pair = (string seed, out Pair) {
	var string mine = "heap" + "!"
	return [ .. Pair(seed), a = mine ]
}

pub func main = (Init init) {
	var Pair p = make_pair("x")
	Console.write("a=\\{p.a}\\n")
	Console.write("len=\\{p.a.length}\\n")
}
`;
		await build_and_check_output(input, "override_ctor_expr_consumer", "a=heap!\nlen=5\n", true);
	});
});
