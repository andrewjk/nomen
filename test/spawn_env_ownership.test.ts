import { describe, expect, test } from "vite-plus/test";

import build from "../src/build";
import build_and_check_output from "./build_and_check_output";
import check_output from "./check_output";
import { parse_raw } from "./parse_with_imports";

// CLOSURE.md Phase 3d: the spawn sugar's packed env is an OWNING
// struct. String arguments are duplicated at pack (the env frees its copy
// through the descriptor's destroy_env), and on the C backend an owning
// value-struct argument is copied and `<T>_destroy`ed — the pre-3d raw
// byte-copy aliased the donor's heap fields and dangled when the donor's
// scope exit ran before the task read them. Non-Sendable CLASS arguments
// may be borrowed inside a nursery (`async { }`), where the join at block
// exit provably bounds the borrow by the donors' lifetimes; anywhere else
// (and always for `.detach()`, which outlives every scope) they are
// rejected.

describe("spawn env ownership + nursery borrows (Phase 3d)", () => {
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

	test("a non-Sendable class argument is borrowed inside a nursery", async () => {
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
	Console.write_line("joined")
}
`;
		await build_and_check_output(input, "spawn_borrow_nursery", "7\njoined\n", true);
	});

	test("a borrowed argument must be a named local or parameter", () => {
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
		expect(parsed.errors[0].message).toContain("named local or parameter");
	});

	test("a non-Sendable class argument outside a nursery is still rejected", () => {
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
		expect(parsed.errors[0].message).toContain("nursery");
	});

	test("a detached task must own its arguments", () => {
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
		expect(parsed.errors[0].message).toContain("must own its arguments");
	});
});
