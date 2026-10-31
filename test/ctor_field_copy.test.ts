import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// The synthesized copy body no longer hands the shell constructor a raw
// `self.<field>` borrow for a required nested-copyable-struct field — that
// byte-copied borrow seeded an ALIASED field (the ctor-alias hazard in
// FOLLOWUP.md), and every displaced-store path had to dodge it via the
// `displaced_is_alias` stamp. The body now passes an OWNED `.copy()` temp
// (the spelling the "cannot copy field ... by value" diagnostics
// prescribe): the ctor seed byte-copies the temp's bytes under the
// documented mv-transfer convention (the temp's own cleanup is
// suppressed), so the copy's field owns fresh independent state in one
// pass. Containers keep the field-store route (their `.copy()` is legal
// only as a container-store RHS); `mv` ctor args keep their transfer
// semantics (single ownership — no auto-clone).

describe("ctor field seeds and the synthesized copy body", () => {
	test("mv donor keeps its transfer semantics (audit clean)", async () => {
		const input = `
import System

mv struct Inner {
	var string text = ""
}

mv struct Mid {
	var Inner inner
}

pub func main = (Init init) {
	var i = Inner()
	i.text = "abc"
	var m = Mid(mv i)
	m.inner.text = "changed"
	Console.write("m: \\{m.inner.text}\\n")
}
`;
		await build_and_check_output(input, "ctor_field_mv_donor", "m: changed\n", true);
	});

	test("copy() of a struct with a required struct field is independent (audit clean)", async () => {
		const input = `
import System

mv struct Inner {
	var string text = ""
}

mv struct Mid {
	var Inner inner
}

pub func main = (Init init) {
	var i = Inner()
	i.text = "abc"
	var m = Mid(mv i)
	var m2 = m.copy()
	m2.inner.text = "xyz"
	Console.write("m: \\{m.inner.text}\\n")
	Console.write("m2: \\{m2.inner.text}\\n")
}
`;
		// The copy's `inner` seed comes from the body's owned `.copy()` temp,
		// so mutating m2's field must not touch m's.
		await build_and_check_output(input, "ctor_field_copy_body", "m: abc\nm2: xyz\n", true);
	});

	test("container field: mv keeps the transfer convention (audit clean)", async () => {
		const input = `
import System

mv struct Holder {
	mv List<string> items
}

pub func main = (Init init) {
	var l = List<string>()
	l.push("a")
	var h = Holder(mv l)
	h.items.push("b")
	Console.write("h: \\{h.items.length} \\{h.items.at_or_panic(0)}\\n")
}
`;
		await build_and_check_output(input, "ctor_field_container", "h: 2 a\n", true);
	});

	test("nested in a loop: repeated construction + teardown stays audit clean", async () => {
		const input = `
import System

mv struct Inner {
	var string text = ""
}

mv struct Mid {
	var Inner inner
}

pub func main = (Init init) {
	var total = 0
	var int n = 0
	while n < 8 {
		var i = Inner()
		i.text = "t\\{n}"
		var m = Mid(mv i)
		total = total + m.inner.text.length
		var m2 = m.copy()
		total = total + m2.inner.text.length
		n += 1
	}
	Console.write("\\{total}\\n")
}
`;
		// "t0".."t7" are 2 chars each: (2 + 2) * 8 = 32
		await build_and_check_output(input, "ctor_field_loop", "32\n", true);
	});
});
