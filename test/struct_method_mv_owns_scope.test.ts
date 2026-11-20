import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// C backend: the mv-owns flag map (`c_mv_owns_flags`) is keyed by bare
// variable NAME. `build_function_node` resets it per free function, but
// `build_struct_functions` — the separate struct-method emission path — did
// not, so a method's flag entry leaked into a LATER method's build: an
// owning `mv`-struct local named `sb` in `early` registered `_mv_owns_sb`,
// and the later `late` (whose `sb` is a plain struct that needs destroy but
// is not owning, so it registers no flag of its own) emitted its scope-exit
// destroy guarded by `if (!_mv_owns_sb)` with no declaration in its frame —
// an undeclared-identifier compile error of the generated C (surfaced by
// BigInt.mul_toom3's `var sb = BigInt()` vs Format.float_grouped's
// StringBuilder `sb`). The test program must compile and run.

const SRC = `
import System

// Owning (string field): declaring a local of this type registers a
// _mv_owns_<name> flag in the method's frame.
mv struct Bag {
	mv label = ""
}

// Needs a destroy walk (the user #destroy) but is NOT owning, so a local of
// this type registers no flag — its scope-exit destroy is unconditional.
struct Counter {
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
