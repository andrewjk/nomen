import fs from "node:fs";

import { expect, test } from "vite-plus/test";

import {
	current_lib_source_hash,
	ensure_system_lib,
	system_lib_fresh,
	system_paths,
} from "./system_lib";

// The split-build stale system-object hazard (formerly FOLLOWUP.md): a
// prebuilt system.o must only ever be LINKED into fresh user TUs when it was
// built from the CURRENT System library source. A stale object (a library
// edit the prebuild worker never rebuilt — failed worker, watch session) must
// be treated exactly like a missing one: single-TU fallback.

test("prebuilt system objects are fresh after the globalSetup prebuild", () => {
	expect(current_lib_source_hash()).toMatch(/^[0-9a-f]{16}$/);
	for (const arch of ["c", "aarch64"] as const) {
		for (const audit of [true, false]) {
			expect(system_lib_fresh(arch, audit)).toBe(true);
		}
	}
});

test("a stale/missing library-source marker disables the split, and a warm rebuild self-heals it", async () => {
	// Perturb the PLAIN C variant only: audited-variant objects are read by
	// every other test's split decision, and those runs must stay on the fast
	// split path.
	const plain = system_paths("c", false);
	const recorded = fs.readFileSync(plain.libhash, "utf8");
	try {
		// A marker from a DIFFERENT library state → not fresh.
		fs.writeFileSync(plain.libhash, "0123456789abcdef");
		expect(system_lib_fresh("c", false)).toBe(false);

		// A missing marker (crash between the object rename and the marker
		// write) → not fresh too, never "trust the old object".
		fs.rmSync(plain.libhash, { force: true });
		expect(system_lib_fresh("c", false)).toBe(false);

		// A WARM rebuild rewrites the marker (the .hash already proved the
		// object was built from the current source) — no rebuild, split back.
		const rebuilt = await ensure_system_lib(false);
		expect(rebuilt).toBe(false);
		expect(fs.readFileSync(plain.libhash, "utf8")).toBe(current_lib_source_hash());
		expect(system_lib_fresh("c", false)).toBe(true);

		// A missing object is the classic single-TU fallback.
		const held = `${plain.obj}.held`;
		fs.renameSync(plain.obj, held);
		expect(system_lib_fresh("c", false)).toBe(false);
		fs.renameSync(held, plain.obj);
		expect(system_lib_fresh("c", false)).toBe(true);
	} finally {
		fs.writeFileSync(plain.libhash, recorded);
	}
});
