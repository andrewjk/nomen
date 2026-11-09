import { expect, describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

describe("use-after-mv", () => {
	test("passing class to two mv functions", () => {
		const input = `
mv struct Box {
	var int value
}
func take = (mv Box b) {
}
var Box a = Box(42)
take(mv a)
take(mv a)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors.map((e) => e.message)).toContainEqual(
			expect.stringContaining("used after mv"),
		);
	});

	test("use of a variable moved before a branch errors inside the branch", () => {
		// The branch body is checked on a CLONED status; the clone used to
		// start with an empty moved-variable set, so a use-after-mv inside
		// an if body was missed. The clone must inherit the enclosing
		// function's moved facts.
		const input = `
mv struct Box {
	var int value
}
func take = (mv Box b) {
}
var Box a = Box(42)
take(mv a)
if true {
	take(mv a)
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.map((e) => e.message)).toContainEqual(
			expect.stringContaining("used after mv"),
		);
	});

	test("a move under an always-true condition moves the variable after the branch", () => {
		// The arm always runs, so its end-of-arm moved set is the whole
		// post-branch truth: the reconciliation copies it into the parent and
		// the post-branch move is a use-after-mv. (Before the reconciliation
		// this accepted — the branch-local move never reached the parent.)
		const input = `
mv struct Box {
	var int value
}
func take = (mv Box b) {
}
var Box a = Box(42)
if true {
	take(mv a)
}
take(mv a)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.map((e) => e.message)).toContainEqual(
			expect.stringContaining("used after mv"),
		);
	});

	test("a move on one arm of a runtime branch stays branch-local", () => {
		// The conservative direction the intersection merge preserves: only
		// the if arm moved `a`, the implicit-else path did not, so the
		// single-path fact does not reject after the branch.
		const input = `
mv struct Box {
	var int value
}
func take = (mv Box b) {
}
var Box a = Box(42)
var bool flag = a.value > 0
if flag {
	take(mv a)
}
take(mv a)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});

	test("a move in both arms moves the variable after the branch", () => {
		// The both-moved shape the reconciliation exists for: each arm's clone
		// ends with `a` moved, so the intersection marks it moved in the
		// parent — the post-branch move reads a moved variable.
		const input = `
mv struct Box {
	var int value
}
func take = (mv Box b) {
}
var Box a = Box(42)
var bool flag = a.value > 0
if flag {
	take(mv a)
} else {
	take(mv a)
}
take(mv a)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.map((e) => e.message)).toContainEqual(
			expect.stringContaining("used after mv"),
		);
	});

	test("re-initializing in both arms un-moves the variable after the branch", () => {
		// The false-reject direction: `a` was moved before the branch, and
		// each arm re-assigns it — the assignment deleted the name from each
		// arm's set, so the intersection un-moves it in the parent and the
		// read after the branch is valid.
		const input = `
mv struct Box {
	var int value
}
func take = (mv Box b) {
}
var Box a = Box(42)
var bool flag = a.value > 0
take(mv a)
if flag {
	a = Box(1)
} else {
	a = Box(2)
}
Console.write("\\{a.value}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});

	test("a move in a while body moves the variable after the loop", () => {
		// The body may run before the post-loop code, so a name still moved
		// at the body's end joins the enclosing scope's moved set.
		const input = `
mv struct Box {
	var int value
}
func take = (mv Box b) {
}
var Box a = Box(42)
var int n = 3
while n > 0 {
	take(mv a)
	n = n - 1
}
Console.write("\\{a.value}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.map((e) => e.message)).toContainEqual(
			expect.stringContaining("used after mv"),
		);
	});

	test("re-initializing in a while body keeps the variable valid after the loop", () => {
		// Every iteration ends with `a` re-assigned, so the body's end set no
		// longer holds it — nothing joins the parent and the read after the
		// loop is valid. (A body-local re-init still cannot un-move a name
		// the parent had moved: zero iterations leave it moved.)
		const input = `
mv struct Box {
	var int value
}
func take = (mv Box b) {
}
var Box a = Box(42)
var int n = 3
while n > 0 {
	take(mv a)
	a = Box(n)
	n = n - 1
}
Console.write("\\{a.value}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});

	test("a move in a for body moves the variable after the loop", () => {
		const input = `
mv struct Box {
	var int value
}
func take = (mv Box b) {
}
var Box a = Box(42)
for i of 0 .. 2 {
	take(mv a)
}
Console.write("\\{a.value}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.map((e) => e.message)).toContainEqual(
			expect.stringContaining("used after mv"),
		);
	});

	test("a move in both match arms moves the variable after the match", () => {
		// An exhaustive match always runs one arm; both arms end with `a`
		// moved, so the intersection across the fall-through arms marks it
		// moved in the parent.
		const input = `
enum State {
	case idle
	case busy
}
mv struct Box {
	var int value
}
func take = (mv Box b) {
}
var Box a = Box(42)
var State s = .idle
match s {
	case .idle { take(mv a) }
	case .busy { take(mv a) }
}
Console.write("\\{a.value}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.map((e) => e.message)).toContainEqual(
			expect.stringContaining("used after mv"),
		);
	});

	test("a move in every switch arm moves the variable after the switch", () => {
		// With an else, the switch is exhaustive — one arm always runs — and
		// all three arms end with `a` moved, so the intersection marks it
		// moved in the parent.
		const input = `
mv struct Box {
	var int value
}
func take = (mv Box b) {
}
var Box a = Box(42)
var int n = 1
switch {
	case n > 0 {
		take(mv a)
	}
	case n < 0 {
		take(mv a)
	}
} else {
	take(mv a)
}
Console.write("\\{a.value}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.map((e) => e.message)).toContainEqual(
			expect.stringContaining("used after mv"),
		);
	});

	test("a switch without else keeps the skip path non-moved", () => {
		// Without an else, every case condition may be false — that path
		// leaves the switch with the parent's (non-moved) state, so the
		// parent's facts join the intersection and the arm-local moves stay
		// branch-local.
		const input = `
mv struct Box {
	var int value
}
func take = (mv Box b) {
}
var Box a = Box(42)
var int n = 1
switch {
	case n > 0 {
		take(mv a)
	}
	case n < 0 {
		take(mv a)
	}
}
Console.write("\\{a.value}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});

	test("a body-local declaration's move does not persist past the loop", () => {
		// moved_variables is keyed by name: a body-local `o` is a fresh
		// declaration whose scope dies with the body, so its move must not
		// persist — the `o` the later for-loop binds is an unrelated variable.
		const input = `
mv struct Box {
	var int value
}
func take = (mv Box b) {
}
var int i = 0
while i < 2; i += 1 {
	var Box o = Box(i)
	take(mv o)
}
for o of 0 .. 2 {
	Console.write("\\{o}")
}
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});

	test("an arm-local shadow's move does not move the enclosing variable", () => {
		// Each arm declares its OWN `o` and moves that shadow; the enclosing
		// `o` is untouched, so the intersection must not mark it moved.
		const input = `
mv struct Box {
	var int value
}
func take = (mv Box b) {
}
var Box o = Box(42)
var bool flag = o.value > 0
if flag {
	var Box o = Box(1)
	take(mv o)
} else {
	var Box o = Box(2)
	take(mv o)
}
Console.write("\\{o.value}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});

	test("class field mutation after mv", () => {
		const input = `
mv struct Box {
	var int value
}
func take = (mv Box b) {
}
var Box a = Box(42)
take(mv a)
a.value = 10
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors.map((e) => e.message)).toContainEqual(
			expect.stringContaining("used after mv"),
		);
	});

	test("class used as struct init after mv", () => {
		const input = `
mv struct Box {
	var int value
}
mv struct Holder {
	var Box content
}
func take = (mv Box b) {
}
var Box a = Box(42)
take(mv a)
var Holder h = Holder(mv a)
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors.map((e) => e.message)).toContainEqual(
			expect.stringContaining("used after mv"),
		);
	});

	test("reading class after mv into struct", () => {
		const input = `
mv struct Box {
	var int value
}
mv struct Holder {
	var Box content
}
var Box a = Box(42)
var Holder h = Holder(mv a)
Console.write("\\{a.value}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors.map((e) => e.message)).toContainEqual(
			expect.stringContaining("used after mv"),
		);
	});

	test("reading class field after mv to function", () => {
		const input = `
mv struct Box {
	var int value
}
func take = (mv Box b) {
}
var Box a = Box(42)
take(mv a)
Console.write("\\{a.value}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors.map((e) => e.message)).toContainEqual(
			expect.stringContaining("used after mv"),
		);
	});

	test("mv then use different variable still works", async () => {
		const input = `
mv struct Box {
	var int value
}
var Box a = Box(1)
var Box b = Box(2)
func take = (mv Box x) {
}
take(mv a)
Console.write("\\{b.value}")
`;
		await build_and_check_output(input, "mov_use_other", "2");
	});

	test("mv into struct then use other fields still works", async () => {
		const input = `
mv struct Box {
	var int value
}
mv struct Holder {
	var int id
	var Box content
}
var Box b = Box(99)
var Holder h = Holder(1, mv b)
Console.write("\\{h.id}")
`;
		await build_and_check_output(input, "mov_struct_other_field", "1");
	});

	test("unused mv class param with owned field is reclaimed", async () => {
		const input = `
mv struct Box {
	var int value
}
mv struct Holder {
	var Box c
}
var Box a = Box(1)
var Holder h = Holder(mv Box(2))
func take = (mv Holder x) {
	var int z = 1
}
take(mv h)
Console.write("\\{a.value}")
`;
		await build_and_check_output(input, "mov_param_owned_field", "1");
	});

	test("unused mv class param with empty body is reclaimed", async () => {
		const input = `
mv struct Box {
	var int value
}
var Box a = Box(1)
var Box b = Box(2)
func take = (mv Box x) {
}
take(mv a)
Console.write("\\{b.value}")
`;
		await build_and_check_output(input, "mov_param_empty_body", "2");
	});
});
