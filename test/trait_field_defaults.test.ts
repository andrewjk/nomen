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
});
