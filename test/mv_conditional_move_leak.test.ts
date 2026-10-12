import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

/*
 * A conditionally-moved owning `mv` value struct used to leak its
 * `#init`-strdup'd string-field default on the not-moved path: the
 * build-time `moved` set suppressed the scope-exit destroy unconditionally.
 * The local now carries a runtime "moved" flag; the destroy is guarded on
 * it so the not-moved path still frees the struct's fields.
 */

const STRUCT = `
pub mv struct D {
	pub var markup = ""
}

func take = (mv D d, out bool) {
	return d.markup.length == 0
}
`;

describe("conditional move of an mv struct with a string-field default", () => {
	test("returning branch: not-moved path frees the default", async () => {
		const input = `${STRUCT}
func probe = (bool b, out bool) {
	var d = D()
	if b {
		return take(mv d)
	}
	return false
}

const bool b = (Time.now_ms() % 2) == 3
var r = probe(b)
Console.write_line("r=\\{r}")
`;
		await build_and_check_output(input, "mv_cond_move_return", "r=false\n");
	});

	test("fall-through branch: not-moved path frees the default", async () => {
		const input = `${STRUCT}
func probe = (bool b, out bool) {
	var d = D()
	if b {
		take(mv d)
	}
	return d.markup.length == 0
}

const bool b = (Time.now_ms() % 2) == 3
var r = probe(b)
Console.write_line("r=\\{r}")
`;
		await build_and_check_output(input, "mv_cond_move_fallthrough", "r=true\n");
	});

	test("taken branch: no double-free when the move happens", async () => {
		const input = `${STRUCT}
func probe = (bool b, out bool) {
	var d = D()
	if b {
		return take(mv d)
	}
	return false
}

const bool b = (Time.now_ms() % 2) != 3
var r = probe(b)
Console.write_line("r=\\{r}")
`;
		await build_and_check_output(input, "mv_cond_move_taken", "r=true\n");
	});

	test("unconditional move still frees exactly once", async () => {
		const input = `${STRUCT}
func probe = (out bool) {
	var d = D()
	return take(mv d)
}

var r = probe()
Console.write_line("r=\\{r}")
`;
		await build_and_check_output(input, "mv_uncond_move", "r=true\n");
	});

	test("no move: default freed at scope exit", async () => {
		const input = `${STRUCT}
func probe = (out bool) {
	var d = D()
	return d.markup.length == 0
}

var r = probe()
Console.write_line("r=\\{r}")
`;
		await build_and_check_output(input, "mv_no_move", "r=true\n");
	});
});
