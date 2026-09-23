import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import build_and_check_output from "./build_and_check_output";
import check_output from "./check_output";
import { parse_raw } from "./parse_with_imports";

// CLOSURE.md Phase 3d, ASYNC.md: the spawn sugar's packed env is
// an OWNING struct. String arguments are duplicated at pack (the env frees
// its copy through the descriptor's destroy_env), and an owning value-struct
// argument is copied and `<T>_destroy`ed. `Sendable` gates exactly the
// SHARED case — a class/trait reference passed as a plain argument aliases
// the instance — and everything else is exempt: moved arguments (a `move T`
// parameter takes exclusive ownership) and copied values. The nursery-borrow
// exception is retired: a non-Sendable class/trait cannot cross into a task,
// inside a nursery or out.

describe("spawn env ownership + shrunk Sendable (Phase 3d, ASYNC.md)", () => {
	test("a string argument is deep-copied into the task env", async () => {
		const input = `import System

func shout = (string msg) {
	Console.write_line(msg)
}

pub func main = () {
	var string s = "original"
	var t = Thread(shout(s)).start()
	s = "changed" // frees the old buffer; the env's copy must not care
	t.wait()
}
`;
		await build_and_check_output(input, "spawn_env_string", "original\n", true);
	});

	test("an owning value-struct argument stays valid after the donor's scope (c)", async () => {
		const input = `import System

struct Payload {
	var string name
}

func work = (Payload p) {
	Time.sleep_ms(50) // let the donor's scope exit run first
	Console.write_line(p.name)
}

pub func main = () {
	if true {
		var Payload p = Payload("owned")
		Thread(work(p)).start()
	}
	Console.write_line("done")
	// process exit drains the pool: the task wakes after its sleep, reads
	// the env's OWN copy, and prints
}
`;
		// The aarch64 arg staging passes one word per non-string arg, so a
		// by-value struct argument is a pre-existing limitation there —
		// run the C backend only.
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		const built = build(parsed.root, { arch: "c", audit: true });
		await check_output("spawn_env_owning_struct", built, "done\nowned\n", {
			arch: "c",
			audit: true,
		});
	});

	test("a non-Sendable class MOVED in (a move parameter) is exempt", () => {
		const input = `import System

pub class Conn {
	var int id = 0
}

func work = (move Conn c) {
	Console.write_line(c.id.to_string())
}

pub func main = () {
	var Conn c = Conn()
	c.id = 7
	var t = Thread(work(move c)).start()
	t.wait()
}
`;
		const parsed = parse_raw(input);
		const messages = parsed.errors.map((e) => e.message);
		expect(messages.filter((m) => m.includes("not Sendable"))).toEqual([]);
	});

	test("a non-Sendable class reference inside a nursery is still rejected", () => {
		const input = `import System

pub class Conn {
	var int id = 0
}

func work = (Conn c) {
	Console.write_line(c.id.to_string())
}

pub func main = () {
	var Conn c = Conn()
	c.id = 7
	async {
		Thread(work(c)).start()
	}
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("not Sendable");
	});

	test("a temporary non-Sendable class argument is rejected", () => {
		const input = `import System

pub class Conn {
	var int id = 0
}

func work = (Conn c) {
	Console.write_line(c.id.to_string())
}

pub func main = () {
	async {
		Thread(work(Conn())).start()
	}
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("not Sendable");
	});

	test("a non-Sendable class argument outside a nursery is rejected", () => {
		const input = `import System

pub class Conn {
	var int id = 0
}

func work = (Conn c) {
	Console.write_line(c.id.to_string())
}

pub func main = () {
	var Conn c = Conn()
	Thread(work(c)).start()
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("not Sendable");
		expect(parsed.errors[0].message).toContain("marked Sendable");
	});

	test("a detached task's shared arguments are rejected like any spawn", () => {
		const input = `import System

pub class Conn {
	var int id = 0
}

func work = (Conn c) {
	Console.write_line(c.id.to_string())
}

pub func main = () {
	var Conn c = Conn()
	async {
		Thread(work(c)).detach()
	}
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("not Sendable");
	});
});
