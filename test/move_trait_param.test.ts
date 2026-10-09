import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import { parse_raw } from "./parse_with_imports";

// A trait-typed value is a reference to a heap instance (a pointer with a
// vtable), so `mv Trait` transfers ownership exactly like `mv Class` — the
// callee reclaims it through the trait's `<Trait>_destroy` shim. This unblocks
// the allmark port's `RendererSet.add(mv Renderer r)` shape (the old
// workaround repeated push + map.set at every call site because `mv Trait`
// was rejected by the checker).

const PRELUDE = `import System

trait Animal {
	pub func speak = (self, out string)
}

mv struct Dog : Animal {
	pub func speak = (self, out string) {
		return "woof"
	}
}

mv struct Cat : Animal {
	pub func speak = (self, out string) {
		return "meow"
	}
}
`;

function run(name: string, expected: string, body: string) {
	const input = PRELUDE + "\n" + body;
	const parsed = parse_raw(input);
	if (parsed.errors.length) {
		throw new Error(`${name} REJECTED: ${parsed.errors.map((e) => e.message).join(" | ")}`);
	}
	return build_and_check_output(input, name, expected, true);
}

describe("mv trait parameters", () => {
	test("mv Trait param is accepted and freed by the callee (audit)", async () => {
		await run(
			"mv_trait_param_empty",
			"done\n",
			`
pub func take = (mv Animal a) {
}

pub func main = (Init init) {
	take(Dog())
	Console.write("done\\n")
}
`,
		);
	});

	test("mv Trait param stored into a List<Trait> (the RendererSet.add shape)", async () => {
		await run(
			"mv_trait_add_list",
			"woof meow\ndone\n",
			`
pub mv struct Registry {
	pub var List<Animal> items = List<Animal>()

	pub func add = (ref self, mv Animal r) {
		self.items.push(mv r)
	}
}

pub func main = (Init init) {
	var Registry reg = Registry()
	reg.add(Dog())
	reg.add(Cat())
	Console.write("\\{reg.items.at_or_panic(0).speak()} \\{reg.items.at_or_panic(1).speak()}\\n")
	Console.write("done\\n")
}
`,
		);
	});

	test("mv Trait param stored into a Map<string, Trait>", async () => {
		await run(
			"mv_trait_add_map",
			"meow\ndone\n",
			`
pub mv struct Registry {
	pub var Map<string, Animal> by_name = Map<string, Animal>()

	pub func add = (ref self, string name, mv Animal r) {
		self.by_name.set(mv name, mv r)
	}
}

pub func main = (Init init) {
	var Registry reg = Registry()
	reg.add("c", Cat())
	Console.write("\\{reg.by_name.get_or("c", Dog()).speak()}\\n")
	Console.write("done\\n")
}
`,
		);
	});

	test("read-only (non-mv) trait params still work unchanged", async () => {
		await run(
			"mv_trait_readonly",
			"woof\ndone\n",
			`
pub func show = (Animal a) {
	Console.write("\\{a.speak()}\\n")
}

pub func main = (Init init) {
	show(Dog())
	Console.write("done\\n")
}
`,
		);
	});
});
