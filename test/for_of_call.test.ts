import { test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

/**
 * `for x of <call>()` — iterating an array returned by a CALL — crashed the
 * C backend: the loop header read the list type's compile-time `length`,
 * which a call-returned `int[]` doesn't carry (`build_node(undefined)`).
 * Materializing the call into a heap temp also matters for correctness — a
 * bare call in the header would re-invoke on every condition check and
 * element load.
 *
 * The fix materializes the call once (`struct Array_<T>* _list_N = <call>();`),
 * registers the temp in heap_array_vars, and iterates via the existing heap
 * path; the temp's declaration joins the enclosing scope frame so
 * break/continue never free it mid-loop while normal/return paths do.
 */

const SRC = `
import System

func triple = (out int[]) {
	return [4, 5, 6]
}

pub func main = () {
	var int sum = 0
	for v of triple() {
		if v == 5 {
			continue
		}
		sum = sum + v
	}
	Console.write("\\{sum}\\n")
}
`;

test("for x of call(): call-returned arrays iterate once, freed at exit", async () => {
	await build_and_check_output(SRC, "for_of_call", "10\n", true);
});
