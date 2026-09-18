// Split out of test/emit_nir.test.ts (one test per file): the shared
// byte-identity harness lives in ./_helpers.ts.

import { test } from "vite-plus/test";

import { expect_byte_identical } from "./_helpers.ts";

test("raw aarch64 statements delegate byte-identically", () => {
	expect_byte_identical(
		`
var int x = 1
\`\`\`
#arch: aarch64
ldr x0, =5
\`\`\`
Console.write("\\{x}")
`,
		false,
		true,
	);
});
