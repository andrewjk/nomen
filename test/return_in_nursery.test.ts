import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// A `return` lexically inside an `async { }` block must route through the
// block's nursery join before leaving the function. Emitting the return
// ahead of the join skipped the per-future wait+release (leaking every
// task's machinery — future, result slot, cancel flag, closure, env) and
// broke the structured-concurrency contract: block-scoped resources could
// die under still-running tasks. Both backends now re-emit the join
// sequence on the return path (innermost nursery first).

describe("return inside an async block joins the nursery", () => {
	test("return of a value computed inside the block (the demo's leak shape)", async () => {
		const input = `import System

func work = (string letter, out string) {
	Time.sleep_ms(30)
	return letter
}

func run_fetch = (out string) {
	async {
		var ta = Thread(work("A")).start()
		var tb = Thread(work("B")).start()
		return ta.result() + tb.result()
	}
}

pub func main = () {
	Console.write_line(run_fetch())
}
`;
		await build_and_check_output(input, "ret_async_string", "AB\n", true);
	});

	test("early return from an if inside the block", async () => {
		const input = `import System

func work = (uint64 n, out uint64) {
	Time.sleep_ms(30)
	return n * 2
}

func pick = (uint64 n, out uint64) {
	async {
		if n > 0 {
			var t = Thread(work(n)).start()
			return t.result_uint64()
		}
		var uint64 m = 21
		var f = Fiber(work(m)).start()
		Console.write_line("fallback")
		var uint64 _ = f.result_uint64()
	}
	return 0
}

pub func main = () {
	Console.write_line(pick(10).to_string())
}
`;
		await build_and_check_output(input, "ret_async_if", "20\n", true);
	});

	test("void return inside the block", async () => {
		const input = `import System

func work = (uint64 n, out uint64) {
	Time.sleep_ms(30)
	return n
}

func coord = (Channel done) {
	async {
		var t = Thread(work(5)).start()
		done.send(t.result_uint64())
		if true {
			return
		}
	}
}

pub func main = () {
	var Channel done = Channel()
	coord(done)
	Console.write_line(done.receive().to_string())
}
`;
		await build_and_check_output(input, "ret_async_void", "5\n", true);
	});

	test("return inside a loop inside the block (nested nursery join)", async () => {
		const input = `import System

func work = (uint64 n, out uint64) {
	Time.sleep_ms(20)
	return n + 1
}

func first_over = (uint64 limit, out uint64) {
	async {
		var int i = 0
		while i < 5 {
			var t = Thread(work(i)).start()
			var uint64 r = t.result_uint64()
			if r > limit {
				return r
			}
			i += 1
		}
	}
	return 0
}

pub func main = () {
	Console.write_line(first_over(2).to_string())
}
`;
		await build_and_check_output(input, "ret_async_loop", "3\n", true);
	});
});
