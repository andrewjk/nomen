// Split out of test/emit_nir.test.ts (one test per file): the shared
// byte-identity harness lives in ./_helpers.ts.

import { test } from "vite-plus/test";

import { expect_byte_identical } from "./_helpers.ts";

test("value-position match/if/switch join through the seam byte-identically", () => {
	// The Container.nm pattern: match/if/switch as a DECLARATION initializer.
	// Each lowers to a `flow` expr; the declaration's init site descends the
	// seam, whose flow arm routes the original node to the join-slot
	// builders (status.return_assign stores each arm's value).
	expect_byte_identical(`
func classify = (int v, out int) {
    var int kind = match v {
        case 0 -> 100
        case 1 -> 200
        else -> 300
    }
    var int bump = if kind > 150 -> 5
                   else -> 1
    var int wrap = switch {
        case kind == 100 -> 7
        else -> 9
    }
    return kind + bump + wrap
}
Console.write("\\{classify(0)} \\{classify(1)} \\{classify(9)}")
`);
});
