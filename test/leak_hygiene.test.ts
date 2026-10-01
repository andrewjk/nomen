import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { run_test_file } from "../cli/src/test.ts";
import build_and_check_output from "./build_and_check_output";

// Ownership-hygiene regressions: every shape here used to leak under
// --audit (build_and_check_output/run_test_file fail on any LEAK line).

describe("ownership: chained receiver temps", () => {
	// A string-returning call used as a RECEIVER (`f().to_lowercase()`) is an
	// owned temp: the C backend strdup's every string return, and the aarch64
	// heap-returning classification marks the pair owned. The call site must
	// free it after the chained method consumes it — the C backend wraps the
	// call in a free-after-use statement expression, the aarch64 backend frees
	// the spilled receiver pair (frees_string_receiver). Before both fixes the
	// temp leaked on every chained call (the allmark sanitizer's per-node
	// tag/attribute checks made this ~44k allocations per suite run).
	test("string method on a call-result receiver is freed", async () => {
		const input = `
func make_string = (out string) {
	return "HELLO"
}
var string name = make_string().to_lowercase()
Console.write_line(name)
`;
		await build_and_check_output(input, "chained_receiver_temp", "hello\n");
	});

	test("string method on an accessor-temp receiver is freed", async () => {
		const input = `
func make_list = (out List<string>) {
	var list = List<string>()
	list.push("HELLO")
	return list
}
var list = make_list()
var string name = list.at_or_panic(0).to_lowercase()
Console.write_line(name)
`;
		await build_and_check_output(input, "chained_access_receiver_temp", "hello\n");
	});
});

describe("ownership: scope-exit cleanup with class anchors", () => {
	// A scope holding ANY class-typed local takes the anchor-slot cleanup walk
	// (emit_destroy_for_scope's heap_slots branch) — which was missing the
	// heap_array_vars arm entirely, leaking every hoisted heap `Array<T>`
	// literal (and its owned string elements) in that scope. The no-anchor
	// walk always had the arm, so the leak only fired when a class local
	// shared the scope with an array literal.
	test("array literal temp frees in a scope with a class anchor", async () => {
		const input = `
class Holder {
	var items = List<string>()
}

func count_of = (Array<string> names, out int) {
	return names.length
}

var h = Holder()
var count = count_of(["a", "b", "c"])
Console.write_line(count.to_string())
`;
		await build_and_check_output(input, "anchor_scope_array_literal", "3\n");
	});
});

describe("ownership: container field move-assign (C backend)", () => {
	// `box.items = move list` must splice the source local from its scope
	// frame AND reclaim the displaced field value. The C backend's container
	// move-assign block looked the field type up by RAW name (`List`), which
	// never matches the monomorphized struct (`List_string`) — the block was
	// silently skipped for every generic container field. Fixed with
	// resolve_struct_type; this test would leak 2 on C before it.
	// The aarch64 backend's displaced-value reclaim for this shape is still
	// open (FOLLOWUP.md, "Container field move-assign displaces the old value
	// on aarch64"), so this test deliberately runs the C backend only.
	test("C: displaced list is reclaimed and the source is spliced", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nomen-moveassign-"));
		const file = path.join(dir, "container_move_assign.test.nm");
		fs.writeFileSync(
			file,
			`import System
import System::Test

class Box {
	var items = List<string>()
}

pub func test_move_assign = (ref Tester t) {
	var b = Box()
	b.items.push("one")
	var next = List<string>()
	next.push("two")
	b.items = move next
	t.expect(b.items.at_or_panic(0) == "two", "moved in")
}
`,
		);
		try {
			const result = await run_test_file(file, "core", "c", true, undefined, false);
			expect(result.phase).toBeUndefined();
			expect(result.crashed).toBeUndefined();
			expect(result.ok).toBe(true);
			expect(result.leaks).toEqual([]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}, 90_000);
});
