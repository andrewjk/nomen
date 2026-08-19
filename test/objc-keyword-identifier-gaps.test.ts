import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// On macOS the C backend emits Objective-C (`.m`) and compiles with
// `-framework ... -lobjc`. A user local named `id` — a perfectly ordinary
// identifier in Nomen — collides with ObjC's `id` type: the generated
// auto-free emits `free(id);`, and clang rejects it with
// `error: unexpected type name 'id': expected expression`. The aarch64
// backend (`.s`, assembled) is unaffected.
//
// Found by the differator port's benchmark harness (`src/bench.nm` used a
// `const string id` for the fixture id): the build failed at link with the
// clang error above. The compiler should either reserve ObjC keywords for
// the darwin/.m target or mangle emitted identifiers that collide with them
// (the same treatment C compilers give, say, `bool` in C89 interop).

describe("ObjC keyword identifiers in .m output: remaining gaps", () => {
	test("a local named 'id' must build and run on the C (ObjC) backend", async () => {
		const input = `import System

pub func main = () {
	var string id = "fixture-42"
	Console.write_line(id)
}
`;
		await build_and_check_output(input, "gap_objc_id_local", "fixture-42\n", true);
	});
});
