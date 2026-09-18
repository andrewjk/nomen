// Split out of test/emit_nir.test.ts (one test per file): the shared
// byte-identity harness lives in ./_helpers.ts.

import { test } from "vite-plus/test";

test("NIR-native for/match binaries run correctly", async () => {
	// Behavioral belt-and-braces for the tranche-2 paths: array-iteration for
	// (with nested if), for-ref writeback, and enum-with-data match arms with
	// payload bindings. nums=[3,1,2] → sum of >1 elements = 3+2 = 5; ref loop
	// decrements each element once → sum = 2+0+1 = 3; area(circle 2) = 6,
	// area(unit) = 1. (Console.write adds no newline → "536 1".)
	const { default: build_and_check_output } = await import("../build_and_check_output");
	await build_and_check_output(
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
    var int[] nums = [3, 1, 2]
    var int sum = 0
    for n of nums {
        if n > 1 {
            sum = sum + n
        }
    }
    Console.write("\\{sum}")
    for ref n of nums {
        n = n - 1
    }
    var int total = 0
    for n of nums {
        total = total + n
    }
    Console.write("\\{total}")
    var MyShape s = MyShape.circle(2)
    var int area = 0
    match s {
        case .circle(r) -> area = 3 * r
        case .unit -> area = 1
        else -> area = 0
    }
    Console.write("\\{area} \\{area_of(MyShape.unit)}")
}
`,
		"emit_nir_for_match",
		"536 1",
		true,
	);
});
