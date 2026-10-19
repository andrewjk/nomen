import { describe, expect, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import { parse_raw } from "./parse_with_imports";

// Prototype: the `#handle` construction hook. Declaring `#handle` on a
// struct synthesizes `<Name>Handle` — a NON-mv twin (copies never destroy,
// so the capture-MOVES rule never fires) with mirrors of every public
// bare-self method and a `Handle(owner)` minter. Expected semantics:
//   - the mint is a snapshot (later owner writes don't show in the copy)
//   - captures are copies: the owner stays usable after wiring
describe("#handle construction hook", () => {
	test("mint, capture, snapshot", { timeout: 300000 }, async () => {
		const input = `
import System

pub mv struct Counter {
	var uint64 handle = 0

	pub func #init = (self) {
		self.handle = 42
	}

	pub func value = (self, out uint64) {
		return self.handle
	}

	pub func #handle = () {}
}

pub struct Holder {
	var CounterHandle counter
}

pub func main = (Init init) {
	var Counter c = Counter()

	// Mint a view of the owner: a copy that owns nothing.
	var CounterHandle ch = CounterHandle(c)

	// Capture the view into a closure — a copy again; the owner stays
	// fully usable.
	var func (out uint64) get = () => ch.value()

	// Mutating the owner after the mint does not affect the snapshot.
	c.handle = 99

	var Holder h = Holder(CounterHandle(c))
	Console.write_line("\\{h.counter.value()}")
	Console.write_line("\\{get()}")
	Console.write_line("\\{c.value()}")
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(input, "handle_proto", "99\n42\n99", true, {
			audit: false,
		});
	});
});
