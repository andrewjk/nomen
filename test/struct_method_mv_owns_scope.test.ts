import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// C backend: the mv-owns flag map (`c_mv_owns_flags`) is keyed by bare
// variable NAME. `build_function_node` resets it per free function, but
// `build_struct_functions` — the separate struct-method emission path — did
// not, so a method's flag entry leaked into a LATER method's build (surfaced
// by BigInt.mul_toom3's `var sb = BigInt()` vs Format.float_grouped's
// StringBuilder `sb`). Note: a destructor requires the single-owner
// (`mv struct`) form, so a destroy-bearing local is always owning and
// registers its own flag — the original "destroy without owning" shape can no
// longer be written. This test keeps the per-body flag discipline pinned with
// same-named owning locals in two methods. It must compile and run.

const SRC = `
import System

// Owning (string field): declaring a local of this type registers a
// _mv_owns_<name> flag in the method's frame.
mv struct Bag {
	mv label = ""
}

// Destroy-bearing (hence single-owner — declared mv struct).
mv struct Counter {
	var n = 0

	func bump = (ref self {}) {
		self.n += 1
	}

	func #destroy = (ref self) {
		self.n = 0
	}
}

pub struct Holder {
	pub func early = (ref self {}) {
		var sb = Bag()
		Console.write_line("bag=\\{sb.label.length}")
	}

	pub func late = (ref self {}) {
		var sb = Counter()
		sb.bump()
		Console.write_line("n=\\{sb.n}")
	}
}

pub func main = (Init init) {
	var h = Holder()
	h.early()
	h.late()
}
`;

describe("struct methods: mv-owns flags are per-body", () => {
	test("a later method's same-named local reuses no earlier method's flag", async () => {
		await build_and_check_output(SRC, "struct_method_mv_owns_scope", "bag=0\nn=1\n", true);
	});
});
