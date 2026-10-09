import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// A `mv` value-struct param (`mv Box box`, Box mv a container field)
// used to leak BOTH ways (audit on):
//
// 1. The callee had NO teardown for it at all — the param rides by address
//    (the caller's storage), so whatever its fields still held at return
//    (a List's slab + slot strings) was orphaned. Both backends now register
//    mv value-struct moved params for a scope-exit `<T>_destroy` at the
//    saved address (contents reclaimed; the caller's storage never freed) —
//    mirroring the moved class-param teardown.
// 2. `box.items = mv List<Attr>()` (a fresh-call RHS — the checker treats
//    fresh constructor/function returns as moves) skipped the displaced-field
//    reclaim, which only fired for a bare moved-variable RHS. The displaced
//    value's resources (2 allocations for a 1-element List<Attr>) leaked —
//    on a GLOBAL box too, not just through a param. Both backends now reclaim
//    the displaced value for any fresh-call field store.
//
// The `mv`-onward shapes (forwarding the param, returning it) stay excluded
// via the shared consumed-scan; a `field = mv local` swap-assign keeps its
// existing path.

function src(body: string): string {
	return `
import System

mv struct Attr { var string value = "" }
mv struct Box  { mv List<Attr> items }

${body}
`;
}

describe("moved value-struct param teardown", () => {
	test("param whose field is untouched is reclaimed at exit (audit clean)", async () => {
		const input = src(`
func keep = (mv Box box, mv out string) {
	return "done"
}

pub func main = () {
	var box = Box(List<Attr>())
	var a = Attr()
	a.value = "hello"
	box.items.push(mv a)
	var s = keep(mv box)
	Console.write("s=\\{s}\\n")
}
`);
		await build_and_check_output(input, "moved_param_no_store", "s=done\n", true);
	});

	test("param field replaced then repopulated is fully reclaimed", async () => {
		const input = src(`
func keep = (mv Box box, mv out string) {
	box.items = mv List<Attr>()
	var b = Attr()
	b.value = "world"
	box.items.push(mv b)
	return "done"
}

pub func main = () {
	var box = Box(List<Attr>())
	var a = Attr()
	a.value = "hello"
	box.items.push(mv a)
	var s = keep(mv box)
	Console.write("s=\\{s}\\n")
}
`);
		await build_and_check_output(input, "moved_param_replace_push", "s=done\n", true);
	});

	test("method taking the moved param reclaims it (audit clean)", async () => {
		const input = src(`
struct Wiper {
	var int tag = 0
	func wipe = (ref self, mv Box box, mv out string) {
		box.items = mv List<Attr>()
		var b = Attr()
		b.value = "world"
		box.items.push(mv b)
		return "done"
	}
}

pub func main = () {
	var box = Box(List<Attr>())
	var a = Attr()
	a.value = "hello"
	box.items.push(mv a)
	var w = Wiper()
	var s = w.wipe(mv box)
	Console.write("s=\\{s}\\n")
}
`);
		await build_and_check_output(input, "moved_param_method", "s=done\n", true);
	});

	test("mixed param (container + string field) is fully reclaimed", async () => {
		const input = src(`
mv struct Tagged {
	var List<Attr> items
	var string label = ""
}

func keep = (mv Tagged t, mv out string) {
	var b = Attr()
	b.value = "world"
	t.items.push(mv b)
	t.label = "kept"
	return t.label.copy()
}

pub func main = () {
	var t = Tagged(List<Attr>())
	var a = Attr()
	a.value = "hello"
	t.items.push(mv a)
	var s = keep(mv t)
	Console.write("s=\\{s}\\n")
}
`);
		await build_and_check_output(input, "moved_param_mixed_fields", "s=kept\n", true);
	});
});

describe("fresh-call field store displaced reclaim", () => {
	test("global box: ctor-call RHS reclaims the displaced list", async () => {
		const input = src(`
pub func main = () {
	var box = Box(List<Attr>())
	var a = Attr()
	a.value = "hello"
	box.items.push(mv a)
	box.items = mv List<Attr>()
	Console.write("len=\\{box.items.length}\\n")
}
`);
		await build_and_check_output(input, "fresh_call_field_global", "len=0\n", true);
	});

	test("function-return RHS reclaims the displaced list (audit clean)", async () => {
		const input = src(`
func fresh = (out List<Attr>) {
	return List<Attr>()
}

pub func main = () {
	var box = Box(List<Attr>())
	var a = Attr()
	a.value = "hello"
	box.items.push(mv a)
	box.items = fresh()
	Console.write("len=\\{box.items.length}\\n")
}
`);
		await build_and_check_output(input, "fresh_call_field_fn_rhs", "len=0\n", true);
	});
});
