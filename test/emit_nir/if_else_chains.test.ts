// Split out of test/emit_nir.test.ts (one test per file): the shared
// byte-identity harness lives in ./_helpers.ts.

import { test } from "vite-plus/test";

import { expect_byte_identical } from "./_helpers.ts";

test("if/else chains are byte-identical through the NIR emission path", () => {
	expect_byte_identical(`
var int score = 71
var int grade = 0
if score >= 90 {
    grade = 4
} else {
    grade = 1
}
if score > 100 {
    grade = 9
}
if grade == 1 {
    grade = grade + 2
}
Console.write("\\{grade}")
`);
});
