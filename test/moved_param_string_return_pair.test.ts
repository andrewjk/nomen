import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// The aarch64 moved-param teardown spilled only x0 around its reclaim calls.
// A string return rides the (x0=ptr, x1=len) fat pair, and the `bl
// <T>_destroy` clobbers x1 — the caller received (ptr, 0): the string PRINTED
// fine (Console.write walks to NUL / the bytes are still there) but every
// `.length`/`==` read saw an empty string. Found by the allmark port (1980
// failing spec tests — `transform`'s `move ParseResult` carries an Arena
// whose auto-destroy chain writes x1); the nomen suite missed it because the
// Box/List destroy bodies happened never to touch x1. The teardown now
// stp/ldp's the full pair when the return type is a plain string — which
// also fixes the pre-existing same-shape hole for moved CLASS params.

function src(body: string): string {
	return `
import System

${body}
`;
}

describe("moved-param teardown preserves a fat-string return", () => {
	test("value-struct param owning an Arena (audit clean)", async () => {
		const input = src(`
struct Store {
	move Arena<string> slots
}

func keep = (move Store store, move out string) {
	return "done"
}

pub func main = () {
	var store = Store(Arena<string>())
	var h1 = store.slots.alloc("one")
	var h2 = store.slots.alloc("two")
	Console.write("slots=\\{store.slots.get(h1)}\\{store.slots.get(h2)}\\n")
	var s = keep(move store)
	Console.write("s=\\{s} len=\\{s.length}\\n")
}
`);
		await build_and_check_output(input, "moved_param_pair_value", "slots=onetwo\ns=done len=4\n", true);
	});

	test("class param owning an Arena (audit clean)", async () => {
		const input = src(`
class Holder {
	move Arena<string> slots
}

func keep = (move Holder holder, move out string) {
	return "done"
}

pub func main = () {
	var holder = Holder(Arena<string>())
	var h1 = holder.slots.alloc("one")
	var h2 = holder.slots.alloc("two")
	Console.write("slots=\\{holder.slots.get(h1)}\\{holder.slots.get(h2)}\\n")
	var s = keep(move holder)
	Console.write("s=\\{s} len=\\{s.length}\\n")
}
`);
		await build_and_check_output(input, "moved_param_pair_class", "slots=onetwo\ns=done len=4\n", true);
	});
});
