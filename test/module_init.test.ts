import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import check_output from "./check_output";
import { parse_raw } from "./parse_with_imports";
import { load_system_fn_names, load_system_struct_names, system_lib_fresh } from "./system_lib";

describe("module-level statements", () => {
	test("module-level var + async compile and run in a split build", async () => {
		// Module-scope runtime statements (a class-typed `var` initialized by
		// a call, an `async { }` block) cannot live at file scope: the C
		// backend rejects the call initializer ("initializer element is not a
		// compile-time constant") and the bare compound statement, and the
		// aarch64 backend cannot even build the class declaration (its
		// storage anchor assumes a stack frame). Both backends now splice the
		// collected statements into main's body as a prologue (see
		// FOLLOWUP.md). The split (user TU + prebuilt system.o) is the shape
		// that regressed; single-TU falls back automatically.
		const input = `
import System

var Channel ch = Channel()

async {
	ch.send(1)
}

pub func main = () {
	var int v = ch.receive() as int
	Console.write_line("\\{v}")
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		const system_names = load_system_struct_names();
		const system_fn_names = load_system_fn_names();
		for (const arch of ["c", "aarch64"] as const) {
			// A STALE system object (library edit the prebuild worker never
			// rebuilt) is treated like a MISSING one: single TU — pairing a
			// stale system.o with a fresh user TU is the struct-layout-crash
			// hazard.
			const split = system_lib_fresh(arch, true);
			const options = { arch, audit: true };
			const result = split
				? build(parsed.root, { ...options, emit_mode: "user", system_struct_names: system_names })
				: build(parsed.root, options);
			await check_output(`modlevel_split_${arch}`, result, "1\n", {
				...options,
				system_lib: split,
				system_fn_names,
			});
		}
	});
});
