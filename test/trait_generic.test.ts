import { expect, describe, test } from "vite-plus/test";

import parse from "../src/parse";
import build_and_check_output from "./build_and_check_output";
import test_error from "./test_error";

// Generic trait conformance: `trait Foo<T>` + `struct C: Foo<ConcreteType>`.
// Exercises the parser (TraitNode.type_params, struct conformance with
// `<Args>`), the checker (type-param scoping on the trait, arity validation),
// and both backends. Vtable dispatch is keyed by trait name, so type args do
// not change the vtable layout — a generic trait dispatches exactly like its
// non-generic counterpart.

describe("generic trait conformance", () => {
	test("marker generic trait conforms and round-trips through trait type", async () => {
		const input = `
trait Greetable<T> {
}

class Users: Greetable<User> {
	func speak = (out string) {
		return "ok"
	}
}

struct User {
	var string name = ""
}

func label = (Greetable v, out string) {
	return "view"
}

Console.write("\\{label(Users())}")
`;
		await build_and_check_output(input, "generic_trait_marker", "view");
	});

	test("generic trait abstract method dispatches through trait type", async () => {
		const input = `
trait Greetable<T> {
	func code = (self, out int)
}

class Users: Greetable<User> {
	func code = (self, out int) {
		return 7
	}
}

struct User {
	var string name = ""
}

func describe = (Greetable v, out int) {
	return v.code()
}

Console.write("\\{describe(Users())}")
`;
		await build_and_check_output(input, "generic_trait_dispatch", "7");
	});

	test("generic trait with several type params", async () => {
		const input = `
trait Mapper<K, V> {
	func key = (self, out int)
}

class M: Mapper<User, int> {
	func key = (self, out int) {
		return 42
	}
}

struct User {
	var string name = ""
}

func key_of = (Mapper m, out int) {
	return m.key()
}

Console.write("\\{key_of(M())}")
`;
		await build_and_check_output(input, "generic_trait_multi_param", "42");
	});

	test("heterogeneous ClassBuffer<Greetable> dispatches generic-trait conformers", async () => {
		// Two classes conform to the generic Greetable<T> with DIFFERENT type
		// args (Bone vs Mouse); both slot into a List<Greetable> and dispatch
		// destroy through the trait vtable. Mirrors cb_trait_multi but with a
		// parameterised trait, proving type args don't affect vtable dispatch.
		const input = `
trait Greetable<T> {
	func code = (self, out int)
}

class Dog: Greetable<Bone> {
	func code = (self, out int) { return 1 }
	func #destroy = (ref self) {
		Console.write("dog")
	}
}

class Cat: Greetable<Mouse> {
	func code = (self, out int) { return 2 }
	func #destroy = (ref self) {
		Console.write("cat")
	}
}

struct Bone {}
struct Mouse {}

if true {
	var List<Greetable> list = List<Greetable>()
	list.push(mov Dog())
	list.push(mov Cat())
}
Console.write(" done")
`;
		await build_and_check_output(input, "generic_trait_collection", "dogcat done");
	});
});

describe("nested type arguments (the `>>` tokenizer edge case)", () => {
	// `Greetable<Wrap<int>>` lexes as `Greetable < Wrap < int >>` because the
	// tokenizer greedily matches `>>` (the bitwise-shift operator). The parser
	// must split it back into two closing angles at the generic-close sites.
	test("nested type args in trait conformance: Greetable<Wrap<int>>", async () => {
		const input = `
trait Greetable<T> {
	func code = (self, out int)
}

struct Wrap {
	var int inner = 0
}

class W: Greetable<Wrap<int>> {
	func code = (self, out int) {
		return 9
	}
}

func code_of = (Greetable v, out int) {
	return v.code()
}

Console.write("\\{code_of(W())}")
`;
		await build_and_check_output(input, "generic_trait_nested_args", "9");
	});

	test("nested type args split `>>` in a value/type context (parse-level)", () => {
		// The tokenizer emits `>>` for the two abutting closes; the parser
		// must split it on both the type annotation and the constructor
		// literal. Asserted at the parse level because instantiating a
		// generic struct whose argument is itself generic (Box<Box<int>>)
		// exercises a separate nested-mononmorphization path; the `>>` split
		// itself is a parser concern.
		const input = `
struct Box<T> {
	pub var T value
}
var Box<int> inner = Box<int>(7)
var Box<Box<int>> outer = Box<Box<int>>(inner)
`;
		const parsed = parse(input);
		expect(parsed.errors).toEqual([]);
	});

	test("triple-nested type args: Tree<Node<Node<int>>>", async () => {
		// `>>>` lexes as `>>` + `>`; three successive close-angle peels must
		// drain both tokens.
		const input = `
trait Greetable<T> {
	func code = (self, out int)
}

struct A {}
struct B {}
struct C {}

class Triple: Greetable<List<List<int>>> {
	func code = (self, out int) {
		return 3
	}
}

func code_of = (Greetable v, out int) {
	return v.code()
}

Console.write("\\{code_of(Triple())}")
`;
		await build_and_check_output(input, "generic_trait_triple_nested", "3");
	});

	test("genuine shift operator still works after a generic close", async () => {
		// `Buffer<int>` closes with a single `>`, then `>> 1` is a real shift.
		const input = `
var int v = 8
var int shifted = v >> 1
Console.write("\\{shifted}")
`;
		await build_and_check_output(input, "shift_after_generic", "4");
	});
});

describe("generic trait conformance errors", () => {
	test("missing type arguments on a generic trait conformance", () => {
		const input = `
trait Greetable<T> {
}

class Users: Greetable {
}
`;
		const expected = [
			test_error(input, "Trait 'Greetable' expects 1 type argument(s) <T>, got none", 5, 1),
		];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("too many type arguments on a generic trait conformance", () => {
		const input = `
trait Greetable<T> {
}

class Users: Greetable<User, int> {
}

struct User {
	var string name = ""
}
`;
		const expected = [
			test_error(input, "Trait 'Greetable' expects 1 type argument(s), got 2", 5, 1),
		];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});

	test("type arguments on a non-generic trait conformance", () => {
		const input = `
trait Speaker {
}

class Dog: Speaker<int> {
}
`;
		const expected = [test_error(input, "Trait 'Speaker' expects 0 type argument(s), got 1", 5, 1)];
		const parsed = parse(input);
		expect(parsed.errors).toEqual(expected);
	});
});
