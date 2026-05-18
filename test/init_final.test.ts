import { expect, describe, test } from "vite-plus/test";

import build from "../src/build";
import parse from "../src/parse";
import check_output from "./check_output";
import parse_with_imports from "./parse_with_imports";

describe("custom init build", () => {
	test("struct with custom init", async () => {
		const input = `
struct Counter {
    var int count

    init = (self, int start) {
        self.count = start
    }
}

const c = Counter(5)
Console.write("\\{c.count}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("custom_init", result, "5");
	});

	test("struct with custom init and computed field", async () => {
		const input = `
struct Point {
    var int x
    var int y
    var int sum

    init = (self, int x, int y) {
        self.x = x
        self.y = y
        self.sum = x + y
    }
}

const p = Point(3, 4)
Console.write("\\{p.sum}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("custom_init_computed", result, "7");
	});

	test("struct with custom init using default field", async () => {
		const input = `
struct Config {
    var int timeout = 30
    var int retries

    init = (self, int retries) {
        self.retries = retries
    }
}

const cfg = Config(3)
Console.write("\\{cfg.timeout}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("custom_init_default", result, "30");
	});

	test("pub struct with pub init", async () => {
		const input = `
pub struct Widget {
    var string name

    pub init = (self, string name) {
        self.name = name
    }
}

const w = Widget("test")
Console.write(w.name)
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("pub_init", result, "test");
	});
});

describe("final functions build", () => {
	test("struct with final function", async () => {
		const input = `
struct Resource {
    var int handle

    final func release = (var self) {
        self.handle = 0
    }
}

const r = Resource(42)
Console.write("\\{r.handle}")
r.release()
Console.write("\\{r.handle}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("final_func", result, "420");
	});

	test("struct with final function that returns", async () => {
		const input = `
struct SafeInt {
    var int value

    final func unwrap = (self, out int) {
        return self.value
    }
}

const s = SafeInt(99)
const v = s.unwrap()
Console.write("\\{v}")
`;
		const parsed = parse_with_imports(input);
		const result = build(parsed.root, { arch: "aarch64" });
		expect(parsed.errors).toEqual([]);
		await check_output("final_return", result, "99");
	});
});

describe("init and final parse errors", () => {
	test("init outside struct", () => {
		const input = `
init = (int x) {
    Console.write(x)
}
`;
		const parsed = parse(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
	});
});

describe("final function enforcement", () => {
	test("error when final function not called", () => {
		const input = `
struct Resource {
    var int handle

    final func release = (var self) {
        self.handle = 0
    }
}

const r = Resource(42)
Console.write("\\{r.handle}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBe(1);
		expect(parsed.errors[0].message).toBe(
			"Final function 'release' must be called before 'r' goes out of scope",
		);
	});

	test("no error when final function is called", () => {
		const input = `
struct Resource {
    var int handle

    final func release = (var self) {
        self.handle = 0
    }
}

const r = Resource(42)
r.release()
Console.write("\\{r.handle}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});

	test("error when final function not called on second instance", () => {
		const input = `
struct Resource {
    var int handle

    final func release = (var self) {
        self.handle = 0
    }
}

const r1 = Resource(1)
r1.release()
const r2 = Resource(2)
Console.write("\\{r2.handle}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors.length).toBe(1);
		expect(parsed.errors[0].message).toBe(
			"Final function 'release' must be called before 'r2' goes out of scope",
		);
	});

	test("struct without final function produces no error", () => {
		const input = `
struct Counter {
    var int count

    func reset = (var self) {
        self.count = 0
    }
}

const c = Counter(5)
Console.write("\\{c.count}")
`;
		const parsed = parse_with_imports(input);
		expect(parsed.errors).toEqual([]);
	});
});
