import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// These tests exercise *polymorphic dispatch* — calling a method or accessing a
// field through a trait-typed receiver (a variable or parameter declared as the
// trait), which routes through the runtime vtable (`_get_trait_func` on C; the
// per-struct function-pointer table + resolver on aarch64). The rest of
// test/traits.test.ts only ever calls methods on *concrete* receivers, which
// lower to direct calls and never touch the vtable, so this file is the only
// runtime coverage of that path on either backend.

describe("trait dispatch (polymorphic)", () => {
	test("method call through trait-typed variable", async () => {
		const input = `
trait Speaker {
  func speak = (out string)
}

struct Dog: Speaker {
  func speak = (out string) {
    return "woof"
  }
}

struct Cat: Speaker {
  func speak = (out string) {
    return "meow"
  }
}

const Speaker a = Dog()
const Speaker b = Cat()
Console.write(a.speak())
Console.write("\\n")
Console.write(b.speak())
`;
		await build_and_check_output(input, "trait_dispatch_var", "woof\nmeow");
	});

	test("method with parameters dispatched through trait type", async () => {
		const input = `
trait Adder {
  func add = (self, int n, out int)
}

struct Count: Adder {
  var int value = 10
  func add = (self, int n, out int) {
    return self.value + n
  }
}

func combine = (Adder a, int n, out int) {
  return a.add(n)
}

Console.write("\\{combine(Count(), 5)}")
`;
		await build_and_check_output(input, "trait_dispatch_params", "15");
	});

	test("default method dispatched through trait type", async () => {
		const input = `
trait Counter {
  var int count
  func value = (self, out int) {
    return self.count
  }
}

struct MyCounter: Counter {
  var int count = 42
}

const Counter c = MyCounter()
Console.write("\\{c.value()}")
`;
		await build_and_check_output(input, "trait_dispatch_default", "42");
	});

	test("trait field access through trait-typed variable", async () => {
		const input = `
trait Named {
  var string name
}

struct Alice: Named {
  var string name = "Alice"
}

const Named n = Alice()
Console.write(n.name)
`;
		await build_and_check_output(input, "trait_dispatch_field", "Alice");
	});

	test("two structs dispatch correctly through one trait parameter", async () => {
		const input = `
trait Speaker {
  func speak = (out int)
}

struct Dog: Speaker {
  func speak = (out int) { return 1 }
}

struct Cat: Speaker {
  func speak = (out int) { return 2 }
}

func code = (Speaker s, out int) {
  return s.speak()
}

Console.write("\\{code(Dog())}\\{code(Cat())}")
`;
		await build_and_check_output(input, "trait_dispatch_two", "12");
	});
});
