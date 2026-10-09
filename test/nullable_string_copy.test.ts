import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// `.copy()` on a `string?` receiver preserves null: null in → null out, a
// non-null receiver gets a fresh owned copy. The plain call lowered both
// shapes through `string_copy` — a null receiver malloc'd into a NON-NULL
// empty string (found by a migration probe), and the aarch64 build crashed
// on the divergence. Both backends guard the call on the ptr half and yield
// a zero pair for null; the checker stamps the result `string?`.

describe("nullable string copy preserves null", () => {
	test("null local, non-null local, rvalue receiver, plain copy", async () => {
		await build_and_check_output(
			`
func get = (out string?) {
	return null
}
func real = (out string?) {
	return "abc"
}
var string? maybe = get()
var string? copied = maybe.copy()
if copied == null {
	Console.write("null")
} else {
	Console.write("len:\\{copied.length}")
}
var string? r = real()
var string? copied2 = r.copy()
if copied2 == null {
	Console.write(" null")
} else {
	Console.write(" len:\\{copied2.length}")
}
var string? copied3 = real().copy()
if copied3 == null {
	Console.write(" null")
} else {
	Console.write(" len:\\{copied3.length}")
}
var string plain = "xy"
var string copied4 = plain.copy()
Console.write(" plain:\\{copied4}")
`,
			"nullable_string_copy",
			"null len:3 len:3 plain:xy",
		);
	});
});
