import { describe, expect, test } from "vite-plus/test";

import { compile_module } from "./_helpers.ts";

describe("readme: concurrency — nursery", () => {
	test("async block spawns and joins tasks", () => {
		const input = `
func fetch = (uint64 id) {
    Console.write_line("fetching \\{id}")
}

pub func main = () {
    async {
        Thread(fetch(1)).start()
        Thread(fetch(2)).start()
        Thread(fetch(3)).start()
    }
}
`;
		expect(compile_module(input)).toEqual([]);
	});
});

describe("readme: concurrency — Task handle", () => {
	test("Thread(...).start() returns a Task handle", () => {
		const input = `
func compute = (uint64 n) => n + 1

pub func main = () {
    async {
        var t = Thread(compute(41)).start()
        t.wait()
        const r = t.result()
        Console.write("\\{r}")
    }
}
`;
		expect(compile_module(input)).toEqual([]);
	});
});

describe("readme: concurrency — Fiber", () => {
	test("a fiber parks while it waits", () => {
		const input = `
func compute = (uint64 n, out uint64) {
    return n + 1
}

pub func main = () {
    async {
        var f = Fiber(compute(41)).start()
        const r = f.result()               // parks, not blocks
        Console.write("\\{r}")
    }
}
`;
		expect(compile_module(input)).toEqual([]);
	});
});
