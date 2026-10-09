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
});
