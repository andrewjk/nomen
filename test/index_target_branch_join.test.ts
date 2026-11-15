import path from "node:path";

import { expect, test } from "vite-plus/test";

import build from "../src/build";
import { get_library } from "../src/lib";
import parse from "../src/parse";
import check_output from "./check_output";

// Assignment-position branching RHS with an INDEX target (`p[i] = match …`).
// The lowering joins the branch value into a temp and stores it through the
// captured element address (the C lvalue-capture arm; the aarch64
// `build_index_store` join). Raw pointer indexing is `unsafe`-gated, so the
// shape lives in a library fixture (test/fixtures/index_join_lib) — this is
// the only place the join can be RUN; user code can never spell it.

const index_join_lib = get_library(path.resolve(import.meta.dirname, "fixtures/index_join_lib"));

function compile(input: string, arch: "aarch64" | "c") {
	const parsed = parse(input, index_join_lib);
	expect(parsed.errors).toEqual([]);
	const result = build(parsed.root, { arch });
	expect(result.errors ?? []).toEqual([]);
	return result;
}

test("an index-target match store runs on both backends", async () => {
	const input = `import System
pub func main = () {
	print_int(write_and_read(0, 0))
	print_space()
	print_int(write_and_read(0, 1))
	print_space()
	print_int(write_and_read(0, 9))
}
`;
	for (const arch of ["c", "aarch64"] as const) {
		await check_output("index_join_match_" + arch, compile(input, arch), "10 20 30", {
			arch,
			audit: true,
		});
	}
});

test("an index-target switch/if store runs on both backends", async () => {
	const input = `import System
pub func main = () {
	print_int(write_two(0))
	print_space()
	print_int(write_two(1))
	print_space()
	print_int(write_two(9))
}
`;
	for (const arch of ["c", "aarch64"] as const) {
		await check_output("index_join_switch_" + arch, compile(input, arch), "6 6 7", {
			arch,
			audit: true,
		});
	}
});
