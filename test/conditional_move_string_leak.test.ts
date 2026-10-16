import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// A loop-local owning string (`const string polled = build_status(i)`) that is
// conditionally MOVED out in a branch (`prev = mv polled`) while sibling
// iterations skip the branch: the mv site's static record (the C frame splice
// / the aarch64 heap_strings delete + moved-set entry) said "moved out" for
// the WHOLE body, so the not-taken iterations never freed the fresh heap
// string — one leak per skipped iteration.
//
// Both backends carry a runtime "owns" flag for owning string locals (the
// same conditional-move contract as owning `mv` structs / the conditional
// `return <local>`): the mv assignment site keeps the donor's ownership
// record and sets the flag instead of suppressing the free statically, and
// the scope-exit / break / continue cleanups free under `flag == 0`.
// - C: the `s = mv t` string assignment keeps the donor's declaration in its
//   scope frame and defers `_mv_owns_<name> = 1` (mirroring the `f(mv x)`
//   call-arg and value-struct `b = mv a` paths); free_scoped_declarations'
//   flag-guarded free decides.
// - aarch64: the explicit-move transfer keeps the source's heap_strings mark
//   and marks the runtime moved flag (mark_local_moved_flag), so the moved
//   entry's cleanup (emit_moved_local_cleanup / the loop-depth walk) is
//   flag-guarded.

describe("loop-local owning string conditionally moved in a branch", () => {
	const SRC = `
import System

func build_status = (int i, out string) {
	if i < 3 {
		return "same".to_string()
	}
	return "changed".to_string()
}

pub func main = (Init init) {
	var prev = ""
	var i = 0
	while i < 5 {
		const string polled = build_status(i)
		if polled != prev {
			prev = mv polled
		}
		i += 1
	}
	Console.write_line("prev=\\{prev}")
}
`;

	test("not-moved iterations free the loop-local string", async () => {
		await build_and_check_output(SRC, "cond_move_string_leak", "prev=changed\n", true);
	});
});
