import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// Unconsumed string results used to leak in race-mode (and default)
// nurseries: the join released each future without freeing the fat string
// the trampoline had stored in the result slot — and the aarch64 task
// temporaries run their #destroy BEFORE the join, when the cell is still
// zero, so their free arm never fired either. A future now records fat
// string slots at construction (slot_fat) and the LAST release frees an
// unconsumed result; result() zeroes the cell on move-out and Task's
// #destroy zeroes after its own free, so the buffer is freed exactly once
// no matter which path gets to it first. Both backends, audit on.

describe("string-returning tasks free their unconsumed results", () => {
	test("unbound spawns in race and default nurseries", async () => {
		const input = `import System

func shout = (string key, out string) {
	Time.sleep_ms(30)
	return key + "!"
}

pub func main = () {
	async(mode: race) {
		Thread(shout("a")).start()
		Thread(shout("b")).start()
	}
	async {
		Thread(shout("c")).start()
	}
	Console.write_line("joined")
}
`;
		await build_and_check_output(input, "race_string_unconsumed", "joined\n", true);
	});

	test("consumed, bound-unconsumed, closure-form, and escaped-handle shapes stay balanced", async () => {
		const input = `import System

func shout = (string key, out string) {
	Time.sleep_ms(30)
	return key + "!"
}

func num = (uint64 n, out uint64) {
	Time.sleep_ms(10)
	return n * 2
}

pub func main = () {
	async {
		var w = Thread(shout("d")).start()
		var u = Thread(num(20)).start()
		Console.write_line(w.result())
		Console.write_line(u.result_uint64().to_string())
	}
	async {
		var z = Thread(shout("e")).start()
	}
	async(mode: race) {
		Fiber(() => shout("f")).start()
		var g = Fiber(() => shout("g")).start()
		Console.write_line(g.result())
	}
	var esc = Thread(num(50)).start()
	async {
		Thread(shout("h")).start()
	}
	Console.write_line(esc.result_uint64().to_string())
	Console.write_line("end")
}
`;
		await build_and_check_output(input, "race_string_matrix", "d!\n40\ng!\n100\nend\n", true);
	});
});
