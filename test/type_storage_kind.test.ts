import { describe, expect, test } from "vite-plus/test";

import Type from "../src/nodes/Type.ts";

// Regression test for the `storage_kind` consolidation (FOLLOWUP.md
// "Array storage kind — consolidate ad-hoc booleans on `Type`"). The three
// legacy booleans (`is_array`, `is_array_heap`, `is_view`) are now accessor
// pairs backed by a single `storage_kind` discriminant, so an inconsistent
// combination is no longer representable. These tests pin the invariant.

describe("Type storage_kind discriminant", () => {
	test("plain type has no storage kind and no array/view flags", () => {
		const t = new Type("int");
		expect(t.storage_kind).toBe(undefined);
		expect(t.is_array).toBe(undefined);
		expect(t.is_array_heap).toBe(undefined);
		expect(t.is_view).toBe(undefined);
	});

	test("constructor is_array=true produces a stack_array", () => {
		const t = new Type("int", undefined, true);
		expect(t.storage_kind).toBe("stack_array");
		expect(t.is_array).toBe(true);
		expect(t.is_array_heap).toBe(undefined);
		expect(t.is_view).toBe(undefined);
	});

	test("setting is_array_heap=true promotes to heap_array and keeps is_array", () => {
		const t = new Type("int");
		t.is_array_heap = true;
		expect(t.storage_kind).toBe("heap_array");
		expect(t.is_array).toBe(true);
		expect(t.is_array_heap).toBe(true);
		expect(t.is_view).toBe(undefined);
	});

	test("setting is_view=true clears any array form (mutual exclusion)", () => {
		const t = new Type("int");
		t.is_array_heap = true;
		expect(t.storage_kind).toBe("heap_array");
		t.is_view = true;
		expect(t.storage_kind).toBe("view");
		// The array flags must NOT still read true once view is set.
		expect(t.is_array).toBe(undefined);
		expect(t.is_array_heap).toBe(undefined);
		expect(t.is_view).toBe(true);
	});

	test("setting is_array=true on a view does not silently combine", () => {
		const t = new Type("string");
		t.is_view = true;
		expect(t.storage_kind).toBe("view");
		// Promoting to an array overrides the view (an array can't also be a
		// non-owning view under the consolidated discriminant).
		t.is_array = true;
		expect(t.is_array).toBe(true);
		expect(t.is_view).toBe(undefined);
		expect(t.storage_kind).toBe("stack_array");
	});

	test("clearing is_array demotes any array form to a plain type", () => {
		const t = new Type("int");
		t.is_array_heap = true;
		t.is_array = false;
		expect(t.storage_kind).toBe(undefined);
		expect(t.is_array).toBe(undefined);
		expect(t.is_array_heap).toBe(undefined);
	});

	test("clearing is_array_heap demotes heap_array to stack_array", () => {
		const t = new Type("int");
		t.is_array_heap = true;
		t.is_array_heap = false;
		expect(t.storage_kind).toBe("stack_array");
		expect(t.is_array).toBe(true);
		expect(t.is_array_heap).toBe(undefined);
	});

	test("clearing is_view leaves a plain type", () => {
		const t = new Type("string");
		t.is_view = true;
		t.is_view = false;
		expect(t.storage_kind).toBe(undefined);
		expect(t.is_view).toBe(undefined);
	});
});
