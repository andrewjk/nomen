import { describe, expect, test } from "vite-plus/test";

import { compile_module } from "./_helpers.ts";

describe("readme: concurrency — nursery", () => {
	test("named nursery spawns and joins tasks", () => {
		const input = `
func fetch = (uint64 id) {
    Console.write_line("ok")
}

pub func main = () {
    async nursery {
        nursery.spawn(fetch(1))
        nursery.spawn(fetch(2))
        nursery.spawn(fetch(3))
    }
}
`;
		expect(compile_module(input)).toEqual([]);
	});
});

describe("readme: concurrency — Task handle", () => {
	test("nursery.spawn returns a Task handle", () => {
		const input = `
func compute = (uint64 n) => n + 1

pub func main = () {
    async nursery {
        var t = nursery.spawn(compute(41))
        t.wait()
        var uint64 r = t.result_uint64()
    }
}
`;
		expect(compile_module(input)).toEqual([]);
	});
});
