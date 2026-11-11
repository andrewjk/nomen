import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// The scrutinee's hoisted argument temps (an array literal argument to the
// match value's call) must attach to the enclosing statement, not to a
// branch binding: the C builder emits the branch binding's declaration
// inside the arm, while the match value already references the temp. The
// nested if-expression form hits the same promotion through the if/else
// arm clones (the C builder also must not prefix `target = ` onto a
// nested if — its own branches assign the join target).
describe("match/if scrutinee hoisting", () => {
	test("scrutinee call args and nested if-expressions emit valid C", async () => {
		const input = `
import System

func find = (int[] hay, int needle, out Option<int>) {
	for v of hay {
		if v == needle {
			return Option.some(v)
		}
	}
	return Option.none
}

pub func main = (Init init) {
	const v = match find([1, 2, 3], 2) {
		case .some(x) -> x
		case .none -> 0
	}
	Console.write_line("\\{v}")

	const w = if true -> 1 else -> if false -> 2 else -> 3
	Console.write_line("\\{w}")
}
`;
		await build_and_check_output(input, "match_scrutinee_hoist", "2\n1", true, {
			platform: "macos",
			audit: false,
		});
	});
});
