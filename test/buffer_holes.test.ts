import { expect, describe, test } from "vite-plus/test";

import build, { default_platform } from "../src/build";
import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

// The residual Buffer holes (FOLLOWUP.md): the raw slot primitives are
// `internal` (only System containers reach them), but the primitives
// themselves leaked:
//
// 1. `store` on an occupied, non-aliasing slot leaked the displaced value's
//    owned pointer state (containers, boxes, classes, closures, enum
//    payloads) — only the plain string fields had the B1 displaced-old
//    reclaim. The mv store_T specializations now reclaim each owned leaf
//    in place BEFORE the slot overwrite, guarded per leaf on pointer
//    identity against the incoming value (the aliased round-trip keeps the
//    slot's own state).
//
// 2. `alloc(n)` dropped the old slab pointer — the live elements' owned
//    state plus the slab itself leaked. The specialized bodies now
//    per-element destroy the old slab (constructed-stamp guarded) before
//    the exact-cap calloc; the raw (scalar/trivial) body frees the old slab.

const HOLDER_PROGRAM = `
mv struct Holder {
	var List<string> items = List<string>()
}

var List<Holder> xs = List<Holder>()
var Holder a = Holder()
a.items.push("a")
xs.push(mv a)
var Holder b = Holder()
b.items.push("b")
xs.push(mv b)
var Holder c = Holder()
c.items.push("c")
xs.set_or_panic(0, mv c)
Console.write_line("\\{xs.at_or_panic(0).items.length}")
`;

describe("residual Buffer holes", () => {
	test("List of container-holding mv elements is audit-clean (both backends)", async () => {
		// Every push lowers to store_T on a fresh slot — the new displaced
		// pass runs (as a guarded no-op on zeroed slot state) on the hot
		// path; set() lowers to replace_T (the full destroy). Any break in
		// the pass's register discipline or guard shapes shows up as a
		// crash, a STALE-FREE, or a LEAK under the audit runtime.
		await build_and_check_output(HOLDER_PROGRAM, "buffer_holes_holder_list", "1\n");
	});

	test("mv store_T reclaims the displaced slot's containers (C shape)", () => {
		const parsed = parse_with_imports(HOLDER_PROGRAM);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, {
			arch: "c",
			audit: true,
			platform: default_platform(),
		});
		const src = String(result.code ?? result);
		// The store body's displaced-container reclaim: guarded on the slot's
		// slab pointer (non-null) and its identity against the incoming
		// value, destroying in place BEFORE the overwrite. The identity path
		// is the List's inner Buffer slab (Holder.items → List.items →
		// Buffer.data).
		expect(src).toContain(
			"if (_slots[i].items.items.data && _slots[i].items.items.data != val->items.items.data) { List_string_destroy(&_slots[i].items); }",
		);
		// The displaced reclaim runs before the overwrite (the guard reads
		// the slot's pre-copy state).
		expect(src.indexOf("List_string_destroy(&_slots[i].items)")).toBeLessThan(
			src.indexOf("_slots[i] = (*val);"),
		);
	});

	test("specialized alloc reclaims the old slab (C shape)", () => {
		const parsed = parse_with_imports(HOLDER_PROGRAM);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, {
			arch: "c",
			audit: true,
			platform: default_platform(),
		});
		const src = String(result.code ?? result);
		const alloc = src.match(
			/long Buffer_Holder_alloc\(struct Buffer_Holder \*self, long size\)[\s\S]{0,400}/,
		);
		expect(alloc).toBeTruthy();
		// Per-element destroy of the old slab (constructed-stamp guarded),
		// then the slab itself, then the exact-cap calloc.
		expect(alloc![0]).toContain("if (_old_slots[_i]._vt) { Holder_destroy(&_old_slots[_i]); }");
		expect(alloc![0]).toContain("nomen_free_wrap(_old_slots);");
		expect(alloc![0]).toContain("nomen_calloc_wrap(size, sizeof(struct Holder));");
		expect(alloc![0]).toContain("return self->cap;");
	});

	test("modify_T reclaims the displaced slot's containers (C shape)", () => {
		const parsed = parse_with_imports(HOLDER_PROGRAM);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, {
			arch: "c",
			audit: true,
			platform: default_platform(),
		});
		const src = String(result.code ?? result);
		// The modify body reclaims the slot's displaced container when the
		// fn's returned value does not alias it (the same guarded pass
		// store_T uses, with the returned value as the incoming side).
		expect(src).toContain(
			"if (_slots[i].items.items.data && _slots[i].items.items.data != _new.items.items.data) { List_string_destroy(&_slots[i].items); }",
		);
	});

	test("specialized alloc + displaced reclaim emit on aarch64", () => {
		const parsed = parse_with_imports(HOLDER_PROGRAM);
		expect(parsed.errors).toEqual([]);
		const result = build(parsed.root, {
			arch: "aarch64",
			audit: true,
			platform: default_platform(),
		});
		const asm = String(result.code ?? result);
		// The store path calls the container destroy in place (the displaced
		// reclaim), and alloc calls the element destroy over the old slab.
		expect(asm).toContain("bl List_string_destroy");
		expect(asm).toContain("bl _nomen_calloc_wrap");
	});
});
