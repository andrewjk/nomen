import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// A loop-local owning copy (`const D prev = delims.at_or_panic(i)`) that is
// conditionally MOVED out in a branch (`start_delimiter = mv prev`) while a
// sibling path `continue`s: the continue path's cleanup skipped the local's
// destroy because the mv site's static record (the C frame splice / the
// aarch64 moved-set entry) says "moved out" — but at runtime the continue
// path never executed the move, so the copy's heap field leaked (LEAK: 1 per
// skipped iteration, the `at_or_panic` deep-copy).
//
// Both backends carry a runtime "owns" flag for exactly this shape on the
// scope-exit destroy (c_mv_owns_flags / mv_owns_flag, set at the mv site,
// guarding the destroy with `if (!flag)`). The fix routes the break/continue
// cleanup through the same flag instead of the static record:
// - aarch64: emit_cleanup_to_loop_depth emits the flag-guarded destroy for a
//   moved entry that owns a flag (mirroring emit_destroy_for_scope's
//   emit_moved_local_cleanup) instead of skipping it;
// - C: the value-struct `b = mv a` assignment keeps the donor's declaration
//   in its scope frame and sets the flag (mirroring the `f(mv x)` call-arg
//   path) instead of splicing it out, so reclaim_to_loop_body's free is
//   flag-guarded.

describe("loop-local owning copy conditionally moved in a branch", () => {
	const SRC = `
import System

pub mv struct D {
	pub var markup = ""
}

func probe = (ref List<D> delims, string pchar, out bool) {
	var start_delimiter = D()
	var i = delims.length
	while i > 0 {
		i -= 1
		const D prev = delims.at_or_panic(i)
		if prev.markup == pchar {
			start_delimiter = mv prev
			break
		}
		continue
	}
	return start_delimiter.markup == pchar
}

pub func main = (Init init) {
	var delims = List<D>()
	var d = D()
	d.markup = "[".to_string()
	delims.push(mv d)
	var r = probe(ref delims, "*")
	Console.write_line("r=\\{r}")
}
`;

	test("continue path frees the not-moved copy", async () => {
		await build_and_check_output(SRC, "cond_move_continue", "r=false\n", true);
	});
});
