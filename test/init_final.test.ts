import { expect, describe, test } from "vite-plus/test";

import parse from "../src/parse";
import build_and_check_output from "./build_and_check_output";
import parse_with_imports from "./parse_with_imports";

describe("custom init build", () => {
	test("struct with custom init", async () => {
		const input = `
struct Counter {
    var int count

    func #init = (self, int start) {
        self.count = start
    }
}

const c = Counter(5)
Console.write("\\{c.count}")
`;
		await build_and_check_output(input, "custom_init", "5");
	});

	test("struct with custom init and computed field", async () => {
		const input = `
struct Point {
    var int x
    var int y
    var int sum

    func #init = (self, int x, int y) {
        self.x = x
        self.y = y
        self.sum = x + y
    }
}

const p = Point(3, 4)
Console.write("\\{p.sum}")
`;
		await build_and_check_output(input, "custom_init_computed", "7");
	});

	test("struct with custom init using default field", async () => {
		const input = `
struct Config {
    var int timeout = 30
    var int retries

    func #init = (self, int retries) {
        self.retries = retries
    }
}

const cfg = Config(3)
Console.write("\\{cfg.timeout}")
`;
		await build_and_check_output(input, "custom_init_default", "30");
	});

	test("pub struct with pub init", async () => {
		const input = `
pub struct Widget {
    var string name

    pub func #init = (self, string name) {
        self.name = name
    }
}

const w = Widget("test")
Console.write(w.name)
`;
		await build_and_check_output(input, "pub_init", "test");
	});
});

describe("destroy blocks build", () => {
	test("struct with destroy block", async () => {
		const input = `
struct Resource {
    var int handle

    func #destroy = () {
        self.handle = 0
    }
}

const r = Resource(42)
Console.write("\\{r.handle}")
`;
		await build_and_check_output(input, "destroy_basic", "42");
	});
});

describe("#init and #destroy parse errors", () => {
	test("#init outside struct", () => {
		const input = `
func #init = (int x) {
    Console.write(x)
}
`;
		const parsed = parse(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
	});
});

describe("auto-destroy enforcement", () => {
	test("auto-destroy runs at scope exit", async () => {
		const input = `
struct Resource {
    var int handle

    func #destroy = () {
        self.handle = 0
    }
}

const r = Resource(42)
Console.write("\\{r.handle}")
`;
		await build_and_check_output(input, "auto_destroy_basic", "42");
	});

	test("auto-destroy on second instance", async () => {
		const input = `
struct Resource {
    var int handle

    func #destroy = () {
        self.handle = 0
    }
}

const r1 = Resource(1)
const r2 = Resource(2)
Console.write("\\{r2.handle}")
`;
		await build_and_check_output(input, "auto_destroy_second", "2");
	});

	test("struct without destroy block produces no error", () => {
		const input = `
struct Counter {
    var int count

    func reset = (ref self) {
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

describe("move on return", () => {
	test("returning struct field does not move the struct", async () => {
		const input = `
struct Resource {
    var int handle

    func #destroy = () {
        self.handle = 0
    }
}

func get_handle = (out int) {
    const r = Resource(42)
    return r.handle
}

Console.write("\\{get_handle()}")
`;
		await build_and_check_output(input, "return_field_no_move", "42");
	});
});

describe("ownership transfer", () => {
	test("struct assigned to struct field via init", async () => {
		const input = `
struct Inner {
    var int value

    func #destroy = () {
        self.value = 0
    }
}

struct Outer {
    var Inner child
}

const inner = Inner(42)
var Outer outer
outer.child = inner
Console.write("\\{outer.child.value}")
`;
		await build_and_check_output(input, "assign_to_field", "42");
	});

	test("recursive destroy of struct fields", async () => {
		const input = `
struct File {
    var int handle

    func #destroy = () {
        self.handle = 0
    }
}

struct FileManager {
    var int id
    var File file
}

const f = File(10)
const mgr = FileManager(1, f)
Console.write("\\{mgr.id}")
`;
		await build_and_check_output(input, "recursive_destroy", "1");
	});
});
