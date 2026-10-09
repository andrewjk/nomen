import { expect, describe, test } from "vite-plus/test";

import { parse_raw } from "./parse_with_imports";

// Deep-const for collections: extracting a `Box<T>` element from a const source
// yields a read-only (`is_const_ref`) reference — field writes, ref/move
// forwarding, and mutating (`ref self`) dispatch through it are rejected.
// See FOLLOWUP.md "Deep-const for collections".

const WIDGET = `
pub owning struct Widget {
	var string title = "default"
	pub func set_title = (ref self, string t) {
		self.title = t.copy()
	}
}
`;

/** Filter out the `.at(i)` constraint-verification noise (list length unknown). */
function filter_constraint(errors: { message: string }[]) {
	return errors.filter((e) => !e.message.includes("Parameter constraint cannot be verified"));
}

describe("deep-const — extraction from const source", () => {
	test("field write through extracted const_ref is rejected", () => {
		const input = `
import System
${WIDGET}
func leak = (List<Box<Widget>> list) {
	var w = list.at(0)
	w.title = "mutated"
}
`;
		const parsed = parse_raw(input);
		const messages = filter_constraint(parsed.errors).map((e) => e.message);
		expect(messages).toContain("Cannot mutate field of const reference: w");
	});

	test("ref param forwarding of const_ref is rejected", () => {
		const input = `
import System
${WIDGET}
func take_ref = (ref Box<Widget> w) {
	w.title = "changed"
}
func leak = (List<Box<Widget>> list) {
	take_ref(ref list.at(0))
}
`;
		const parsed = parse_raw(input);
		const messages = filter_constraint(parsed.errors).map((e) => e.message);
		expect(messages).toContain(
			"Cannot pass a const reference to ref parameter 'w' — extract from a non-const source or use a plain (copy) parameter",
		);
	});

	test("move param forwarding of const_ref is rejected", () => {
		const input = `
import System
${WIDGET}
func take_mov = (move Box<Widget> w) {
	w.title = "changed"
}
func leak = (List<Box<Widget>> list) {
	take_mov(move list.at(0))
}
`;
		const parsed = parse_raw(input);
		const messages = filter_constraint(parsed.errors).map((e) => e.message);
		expect(messages).toContain(
			"Cannot pass a const reference to move parameter 'w' — extract from a non-const source or use a plain (copy) parameter",
		);
	});

	test("mutating method dispatch on const_ref is rejected", () => {
		const input = `
import System
${WIDGET}
func leak = (List<Box<Widget>> list) {
	var w = list.at(0)
	w.set_title("x")
}
`;
		const parsed = parse_raw(input);
		const messages = filter_constraint(parsed.errors).map((e) => e.message);
		expect(messages).toContain("Cannot call mutating method 'set_title' on a const reference");
	});

	test("explicit type annotation cannot strip const_ref", () => {
		const input = `
import System
${WIDGET}
func leak = (List<Box<Widget>> list) {
	var Box<Widget> w = list.at(0)
	w.title = "mutated"
}
`;
		const parsed = parse_raw(input);
		const messages = filter_constraint(parsed.errors).map((e) => e.message);
		expect(messages).toContain("Cannot mutate field of const reference: w");
	});
});

describe("deep-const — opt-outs and escapes", () => {
	test("value-type elements are not const-ified (int list)", () => {
		const input = `
import System
func ok = (List<int> list) {
	var n = list.at(0)
	n = 5
}
`;
		const parsed = parse_raw(input);
		expect(filter_constraint(parsed.errors)).toEqual([]);
	});

	test("ref (mutable borrow) list extraction is not const-ified", () => {
		const input = `
import System
${WIDGET}
func ok = (ref List<Box<Widget>> list) {
	var Box<Widget> w = list.at(0)
	w.title = "ok"
}
`;
		const parsed = parse_raw(input);
		expect(filter_constraint(parsed.errors)).toEqual([]);
	});

	test("reading a field through const_ref is allowed", () => {
		const input = `
import System
${WIDGET}
func read = (List<Box<Widget>> list) {
	var t = list.at(0).title.copy()
	Console.write(t)
}
`;
		const parsed = parse_raw(input);
		expect(filter_constraint(parsed.errors)).toEqual([]);
	});
});
