import { describe, expect, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import { parse_raw } from "./parse_with_imports";

// CLOSURE.md Phase 3d, ASYNC.md: the spawn sugar's packed env is
// an OWNING struct. String arguments are duplicated at pack (the env frees
// its copy through the descriptor's destroy_env), and a mv value-struct
// argument is copied and `<T>_destroy`ed. `Sendable` gates exactly the
// SHARED case — a class/trait reference passed as a plain argument aliases
// the instance — and everything else is exempt: moved arguments (a `mv T`
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

	test("a mv value-struct argument outside a nursery is rejected (R1)", () => {
		// STRUCT_PLAN_3 N1a R1: a mv value struct passed bare to a spawn
		// is a region-checked BORROW inside `async { }` (the join bounds it).
		// OUTSIDE a nursery there is no join to bound a borrow, and the env
		// deep-copy is unsound for mv structs (only string fields are
		// deep-copied — a container field would share its buffer), so the
		// bare-mv shape is rejected outright. (The pre-tranche shape —
		// a string-only Payload env-copied past its donor's scope — was the
		// one case the old copy path handled; the compile error now names
		// the two sound spellings.)
		const input = `import System

struct Payload {
	var string name
}

func work = (Payload p) {
	Time.sleep_ms(50)
	Console.write_line(p.name)
}

pub func main = () {
	if true {
		var Payload p = Payload("owned")
		Thread(work(p)).start()
	}
	Console.write_line("done")
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors.some((e) => e.message.includes("owns heap memory"))).toBe(true);
	});

	test("a non-Sendable class MOVED in (a mv parameter) is exempt", () => {
		const input = `import System

pub mv struct Conn {
	var int id = 0
}

func work = (mv Conn c) {
	Console.write_line(c.id.to_string())
}

pub func main = () {
	var Conn c = Conn()
	c.id = 7
	var t = Thread(work(mv c)).start()
	t.wait()
}
`;
		const parsed = parse_raw(input);
		const messages = parsed.errors.map((e) => e.message);
		expect(messages.filter((m) => m.includes("not Sendable"))).toEqual([]);
	});

	test("a bare mv reference inside a nursery is a legal region borrow (R1)", () => {
		const input = `import System

pub mv struct Conn {
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
		// STRUCT_PLAN_3 R1: a bare mv arg is a region-checked const
		// borrow inside `async { }` — the join bounds it. The class-era
		// Sendable gate is retired with the class tier.
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
	});

	test("a temporary mv argument packs into the task env", () => {
		const input = `import System

pub mv struct Conn {
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
		// A fresh value has no donor to borrow from — the env owns it.
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
	});

	test("a non-Sendable class argument outside a nursery is rejected", () => {
		const input = `import System

pub mv struct Conn {
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
		// R1: outside a nursery there is no join to bound the borrow — the
		// error names the two sound spellings.
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toContain("owns heap memory");
	});

	test("a moved argument to a daemon is the sanctioned spelling", () => {
		const input = `import System

pub mv struct Conn {
	var int id = 0
}

func work = (mv Conn c) {
	Console.write_line(c.id.to_string())
}

pub func main = () {
	var Conn c = Conn()
	c.id = 7
	async {
		Thread(work(mv c)).detach()
	}
}
`;
		// N2/R4: a daemon owns its captures — `mv` transfers the instance;
		// the env destroys it when the daemon ends.
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
	});
});
