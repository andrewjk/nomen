import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// Trait-declared default fields must be laid out and initialized on the
// conforming struct: the C backend emits them into the typedef (the C
// compiler sizes them), but the aarch64 layout/size model and ctors omitted
// them — a trait `string` default lived past the malloc'd instance, so reads
// returned garbage (SIGSEGV) and the default was never applied.

describe("trait field defaults", () => {
	test("class and value struct inherit trait default fields", async () => {
		const input = `
trait Tagged {
	var string tag = "trait-default"
	var int count = 7
}

mv struct G : Tagged {
	pub var string own = "own-default"
}

struct V : Tagged {
	var int x = 1
}

var g = G()
Console.write("\\{g.tag} \\{g.count} \\{g.own}\\n")
var v = V()
Console.write("\\{v.tag} \\{v.count} \\{v.x}\\n")
`;
		await build_and_check_output(
			input,
			"trait_field_defaults",
			"trait-default 7 own-default\ntrait-default 7 1\n",
		);
	});

	// A write to a trait-declared string field through a TRAIT-typed receiver
	// must be uniform-heap for a mv/class conformer: the trait-target
	// write path must dup the incoming value and reclaim the displaced one, or
	// the field holds rodata that the conformer's destroy later frees
	// (AUDIT-STALE-FREE).
	test("trait-typed receiver string-field write is uniform-heap", async () => {
		const input = `
trait Tagged {
	var string tag = "init"
}

mv struct G : Tagged {
	func #destroy = () {
	}
}

	var g = G()
var Tagged t = mv g
t.tag = "reset"
Console.write("\\{t.tag}\\n")
`;
		await build_and_check_output(input, "trait_field_write", "reset\n");
	});

	// A trait-DEFAULT body (shared across conformers — not a struct override)
	// that reads or writes `self.<trait-field>` — or reads ANY parameter —
	// used to reference them as GLOBAL SYMBOLS (`adr x0, self` / `adr x0, n`)
	// on aarch64, so the generated assembly failed to link (undefined
	// `self`/`n`). The default body's params now bind to their ABI homes:
	// by-value self parks in x19, a `ref`/`var` self and every other param
	// spill to stack homes (fat string pairs as 16-byte slots).
	test("trait-default body reads a field and takes a string param", async () => {
		const input = `
trait Named {
	var string name = "anon"
	func greet = (self, out string) {
		return "hi " + self.name
	}
}

struct Alice : Named {
}

var Alice a = Alice()
Console.write(a.greet())
`;
		await build_and_check_output(input, "trait_default_read", "hi anon");
	});

	test("trait-default body writes a field through ref self with a param", async () => {
		const input = `
trait Named {
	var string name = "anon"
	func rename = (ref self, string n) {
		self.name = n.copy()
	}
	func greet = (self, out string) {
		return "hi " + self.name
	}
}

mv struct Alice : Named {
}

var Alice a = Alice()
a.rename("rex")
Console.write(a.greet())
`;
		await build_and_check_output(input, "trait_default_write", "hi rex");
	});

	test("trait-default body takes scalar and struct params", async () => {
		const input = `
trait Scored {
	var int score = 0
	func bump = (ref self, int by) {
		self.score = self.score + by
	}
	func report = (self, string prefix, out string) {
		return "\\{prefix}\\{self.score}"
	}
}

struct S : Scored {
}

var S s = S()
s.bump(4)
s.bump(3)
Console.write(s.report("score:"))
`;
		await build_and_check_output(input, "trait_default_params", "score:7");
	});

	// A MIXED conformer set (an mv/class conformer next to a plain value
	// struct) used to free the displaced value on EVERY trait-field reassign
	// — but a non-mv conformer seeds the field with rodata, so the runtime
	// conformer being the non-mv one meant free(rodata) (AUDIT-STALE-FREE).
	// The displaced free now fires only when every conformer owns; mixed
	// sets skip it (bounded: rodata is not an audit allocation, and a
	// heap-displaced seed on the owning conformer leaks by the documented
	// non-mv-corner posture). Output-only run: a fresh-RHS write into the
	// non-owning conformer's field also leaks by that same posture.
	test("mixed conformer set: trait-field reassign never frees rodata", async () => {
		const input = `
trait Tagged {
	var string tag = "seed"
}

mv struct G : Tagged {
}

struct V : Tagged {
}

var V v = V()
var Tagged t = mv v
t.tag = "fresh"
Console.write(t.tag)
`;
		await build_and_check_output(input, "trait_field_mixed_reassign", "fresh", false, {
			audit: false,
		});
	});

	// A trait-declared field on a conformer NESTED inside another struct:
	// (1) a custom `#init` left the trait default UNINITIALIZED (stack
	// garbage — the first write "reclaimed" it, freeing garbage), and (2)
	// the enclosing struct's destroy walk skipped the nested conformer
	// entirely (the field predicates missed trait-declared state), so the
	// written value leaked. The custom-init path now seeds trait defaults
	// (both backends) and the destroy predicate treats a nested conformer's
	// trait-declared fields as destroy-worthy.
	test("trait string field on a nested conformer", async () => {
		const input = `
trait Holds {
	var string label = "inner-seed"
}
mv struct Inner : Holds {
	pub func #init = (self) {
	}
}
mv struct Outer {
	var Inner a
	pub func #init = (self) {
		self.a = Inner()
	}
}
var Outer o = Outer()
o.a.label = "set".to_string()
Console.write(o.a.label)
`;
		await build_and_check_output(input, "trait_field_nested", "set");
	});

	// A fixed-size array LOCAL of conformer elements: the scope-exit walk
	// resolved the ELEMENT struct by name (array-ness is a Type flag) and
	// destroyed element 0 only — every later element's owned trait-declared
	// label leaked. The walk now iterates elements in place (element field
	// writes need `unsafe` indexing, so the ctor-seeded labels are the owned
	// state the audit exercises).
	test("fixed array local of trait conformers destroys every element", async () => {
		const input = `
trait Holds {
	var string label = "seed"
}
mv struct Elem : Holds {
}
var Elem[2] elems = [Elem(), Elem()]
Console.write_line("ok")
`;
		await build_and_check_output(input, "trait_array_local", "ok\n");
	});

	// A fixed-size array FIELD of conformer elements (an array-literal ctor
	// arg): the aarch64 ctor copied the field at a pointer-width stride
	// (8 bytes — corrupting element 1 and leaving the tail unwritten), the C
	// ctor memcpy'd the row SHALLOW (sharing the donor labels its cleanup
	// frees), and both destroy walks treated the array as one element
	// (`o.elems.label` is not even valid C). The ctor now word-copies at the
	// element stride and detaches owning elements' string fields; the destroy
	// walks iterate elements. The donor row (a moved-stamped hoisted temp)
	// still reclaims its own originals.
	test("fixed array field of trait conformers destroys every element", async () => {
		const input = `
trait Holds {
	var string label = "seed"
}
mv struct Elem : Holds {
}
mv struct Outer {
	var Elem[2] elems
}
var Outer o = Outer([Elem(), Elem()])
Console.write_line("ok")
`;
		await build_and_check_output(input, "trait_array_field", "ok\n");
	});
});
