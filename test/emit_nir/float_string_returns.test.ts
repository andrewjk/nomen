// Split out of test/emit_nir.test.ts (one test per file): the shared
// byte-identity harness lives in ./_helpers.ts.

import { test } from "vite-plus/test";

import { expect_byte_identical } from "./_helpers.ts";

test("float and string returns keep byte-identity through the expression seam", () => {
	expect_byte_identical(`
func half_of = (float v, out float) {
    return v / 2.0
}
func scale = (float x, out float) {
    if x > 1.0 {
        return x * 2.5
    }
    return half_of(x) + 0.5
}
func greet = (string who, out string) {
    if who == "world" {
        return "hi " + who
    }
    return who
}
Console.write("\\{scale(2.0)} \\{scale(0.5)} \\{greet("world")} \\{greet("bob")}")
`);
});
