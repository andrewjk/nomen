import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// A FORCE-HEAP variable (`stored` receives a heap value on one branch, so the
// scan proves its reassign/scope-exit frees are emitted unconditionally) must
// own heap on EVERY path — including its birth. A `var stored = <borrow>`
// declaration (a field read kept in a local, a param, a view-derived pair)
// used to store the raw ALIAS: the unconditional scope-exit free then
// reclaimed the SOURCE's bytes while the owning container still held them,
// and the container's teardown freed them a second time (the allmark sanitize
// crash — `sanitize_filter_attributes`'s `var string stored = attr.value`).
// The variable-init declaration branch now strdups + records when the target
// is force-heap and the source is not itself recorded heap — the same
// contract the literal-init branch already enforced, and the C backend's
// `nomen_str_dup` at build_c/build_declaration_node.ts. The assignment-path
// twin: `x = <unrecorded var>` is a borrow reception too — the stale
// `last_result_is_heap` flag must never mark the target (mirrors the
// field-read fix it sits beside).
//
// The shipped double free only fired when the conditional heap reassignment
// was NOT taken (`title` is not a clobbered attribute name) — `stored` then
// still held the borrow while the force-heap contract disciplined its
// scope-exit free. The shape below mirrors that: the value already has the
// "keep-" prefix, so the reassignment branch exists for the scan but never
// executes. Run without --audit: the invalid free aborts libmalloc (the
// regression), and the surrounding shape carries unrelated bounded leaks.
describe("force-heap string declarations own their storage", () => {
	test("borrow-initialized force-heap local is not freed as a borrow", async () => {
		const input = `
struct Attr {
	var string value = ""
}

struct Box {
	move List<Attr> items
}

var box = Box(List<Attr>())
var a = Attr()
a.value = "keep-hello"
box.items.push(move a)
var filtered = List<Attr>()
var kept = Attr()
filtered.push(move kept)
var i = 0
while i < box.items.length; i += 1 {
	var it = box.items.at_or_panic(i)
	var string value = it.value
	var string stored = value
	if !stored.starts_with("keep-") {
		stored = "keep-" + value
	}
	Console.write("saw=\\{stored}\\n")
}
box.items = move filtered
Console.write("count=\\{box.items.length} kept=\\{box.items.at_or_panic(0).value}\\n")
`;
		await build_and_check_output(
			input,
			"force_heap_decl_borrow",
			"saw=keep-hello\ncount=1 kept=\n",
			false,
			{ audit: false },
		);
	});

	test("the assignment-path twin: an unrecorded source never marks the target", async () => {
		const input = `
struct Attr {
	var string value = ""
}

struct Box {
	move List<Attr> items
}

var box = Box(List<Attr>())
var a = Attr()
a.value = "hello"
box.items.push(move a)
var it = box.items.at_or_panic(0)
var string borrow = it.value
var target = borrow
Console.write("target=\\{target} field=\\{box.items.at_or_panic(0).value}\\n")
`;
		await build_and_check_output(
			input,
			"force_heap_decl_borrow_assign",
			"target=hello field=hello\n",
		);
	});
});
