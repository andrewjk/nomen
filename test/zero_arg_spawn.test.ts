import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// `Thread(fn())` / `Fiber(fn())` where the wrapped function takes no
// arguments. The aarch64 ctor helper's C signature used to emit a leading
// comma from the nursery-capture params (`ctor(, unsigned long long …)`)
// and clang rejected the companion — only when the construction sat inside
// an `async { }` block (the capture path). Outside any nursery the plain
// `()` signature was already valid.

describe("zero-argument deferred-call constructions", () => {
	test("zero-arg Thread and Fiber inside a nursery (both backends)", async () => {
		const input = `import System

func tick = (out uint64) {
	return 7
}

func greet = (out string) {
	return "hi"
}

pub func main = () {
	async {
		var t = Thread(tick()).start()
		var u = Fiber(greet()).start()
		Console.write_line(t.result_uint64().to_string())
		Console.write_line(u.result())
	}
}
`;
		await build_and_check_output(input, "zeroarg_nursery", "7\nhi\n", true);
	});

	test("zero-arg constructions outside a nursery (regression)", async () => {
		const input = `import System

func tick = (out uint64) {
	return 7
}

pub func main = () {
	var t = Fiber(tick()).start()
	Console.write_line(t.result_uint64().to_string())
}
`;
		await build_and_check_output(input, "zeroarg_plain", "7\n", true);
	});

	test("zero-arg capture-free closure inside a nursery (both backends)", async () => {
		const input = `import System

func greet = (out string) {
	return "hi"
}

pub func main = () {
	async {
		var u = Fiber(() => greet()).start()
		Console.write_line(u.result())
	}
}
`;
		await build_and_check_output(input, "zeroarg_closure", "hi\n", true);
	});
});
