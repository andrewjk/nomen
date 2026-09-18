// Split out of test/emit_nir.test.ts (one test per file): the shared
// byte-identity harness lives in ./_helpers.ts.

import { test } from "vite-plus/test";

import { expect_byte_identical } from "./_helpers.ts";

test("enum-with-data match with payload bindings emits NIR-natively", () => {
	// Module-level enum + match-with-payloads: parsed raw (parse_with_imports
	// wraps the source inside main, where enums can't be declared).
	expect_byte_identical(
		`
import System

enum MyShape {
    case circle(int radius)
    case unit
}

func area_of = (MyShape s, out int) {
    var int area = 0
    match s {
        case .circle(r) -> area = 3 * r
        case .unit -> area = 1
        else -> area = 0
    }
    return area
}

pub func main = () {
    Console.write("\\{area_of(MyShape.circle(2))} \\{area_of(MyShape.unit)}")
}
`,
		true,
	);
});
