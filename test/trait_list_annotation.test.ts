import { expect, describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import { parse_raw } from "./parse_with_imports";

// An explicit `List<SomeTrait>` local annotation used to trip "struct fields
// cannot be trait types" (the annotated-declaration path skipped the
// ClassBuffer rewrite). Pin the annotated form on both backends.

describe("explicit trait-typed container annotations", () => {
	test("annotated List<Animal> local pushes, dispatches, and frees", async () => {
		const input = `
import System

trait Animal {
	pub func speak = (self, out string)
}

class Dog : Animal {
	pub func speak = (self, out string) {
		return "woof"
	}
}

class Cat : Animal {
	pub func speak = (self, out string) {
		return "meow"
	}
}

pub func main = (Init init) {
	var List<Animal> animals = List<Animal>()
	animals.push(Dog())
	animals.push(Cat())
	var Animal first = animals.at_or_panic(0)
	var Animal second = animals.at_or_panic(1)
	Console.write("\\{first.speak()} \\{second.speak()}\\n")
	Console.write("done\\n")
}
`;
		const parsed = parse_raw(input);
		expect(parsed.errors).toEqual([]);
		await build_and_check_output(input, "trait_list_annotation_local", "woof meow\ndone\n", true);
	});
});
