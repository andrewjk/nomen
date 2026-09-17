import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

/*
 * status.moved scoping for struct METHOD bodies (aarch64)
 *
 * build_function_node resets status.moved per function, but
 * build_struct_node built every method/#init/#destroy body sharing ONE
 * moved set: a bare `return response` of a value-struct local in an
 * earlier method marked the bare NAME for every later method body of the
 * same struct. A later method's unrelated same-named heap-string local
 * then had its return-path free suppressed (the finalized loop skips any
 * name in the set) — "LEAK: 1 allocation(s)" under audit.
 */

describe("status.moved is scoped per method body", () => {
	test("same-named local in a later method still frees on return", async () => {
		const input = `
struct Pnt {
	var int x = 0
	var int y = 0
}

struct Holder {
	func make = (out Pnt) {
		var Pnt response = Pnt()
		response.x = 7
		return response
	}
	func drop_it = () {
		var string response = 42.to_string()
		Console.write(response)
		Console.write("\\n")
		return
	}
}

var Holder h = Holder()
var Pnt p = h.make()
Console.write(p.x.to_string())
Console.write("\\n")
h.drop_it()
`;
		await build_and_check_output(input, "moved_method_scope", "7\n42\n");
	});
});
