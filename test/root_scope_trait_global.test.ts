import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// BUGS.md #5's shaped gap for trait-typed root globals: a root-scope
// `var Trait g = Concrete()` must keep MODULE-scope storage (so every other
// function resolves the symbol) and its handle binding must be visible from
// every function body (trait_class_frames / class_vars are per-body). Each
// test declares the trait and conformer at root, so `build_and_check_output`
// is called with `raw = true` — the root statements run as main's prologue.
describe("root-scope trait-typed globals", () => {
	test("a constructor-initialized trait global is readable from a function", async () => {
		const input = `
import System
trait Greeter { func greet = (self, out string) }
mv struct Dog : Greeter {
	func greet = (self, out string) { return "woof" }
}
var Greeter g = Dog()
func call_greet = (out string) {
	return g.greet()
}
pub func main = () {
	Console.write("\\{call_greet()}")
}
`;
		await build_and_check_output(input, "root_trait_global", "woof", true);
	});

	test("a trait global with an owned field is destroyed at program exit", async () => {
		const input = `
import System
trait Speaker { func speak = (self, out string) }
mv struct Dog : Speaker {
	var string name
	func speak = (self, out string) { return self.name.copy() }
	func #destroy = (ref self) {
		Console.write("|destroy:" + self.name)
	}
}
var Speaker s = Dog("Rex")
func call_speak = (out string) {
	return s.speak()
}
pub func main = () {
	Console.write(call_speak())
}
`;
		await build_and_check_output(input, "root_trait_global_str", "Rex|destroy:Rex", true);
	});

	test("a trait global works as a bare call argument and with method args", async () => {
		const input = `
import System
trait Greeter { func greet = (self, int n, out string) }
mv struct Dog : Greeter {
	func greet = (self, int n, out string) { return "woof" + n.to_string() }
}
var Greeter g = Dog()
func use = (Greeter p, out string) {
	return p.greet(3)
}
func readg = (out string) {
	return g.greet(7)
}
pub func main = () {
	Console.write("\\{readg()} \\{use(g)}")
}
`;
		await build_and_check_output(input, "root_trait_global_arg", "woof7 woof3", true);
	});

	test("a trait global passed between non-main functions", async () => {
		const input = `
import System
trait Greeter { func greet = (self, int n, out string) }
mv struct Dog : Greeter {
	func greet = (self, int n, out string) { return "woof" + n.to_string() }
}
var Greeter g = Dog()
func use = (Greeter p, out string) {
	return p.greet(5)
}
func relay = (out string) {
	return use(g)
}
pub func main = () {
	Console.write("\\{relay()}")
}
`;
		await build_and_check_output(input, "root_trait_global_relay", "woof5", true);
	});

	test("a trait global from a free-function return and a moved trait local", async () => {
		const input = `
import System
trait Greeter { func greet = (self, out string) }
mv struct Dog : Greeter {
	func greet = (self, out string) { return "woof" }
}
func make = (out Greeter) {
	return Dog()
}
var Greeter g = make()
var Greeter h = mv g
func readg = (out string) {
	return h.greet()
}
pub func main = () {
	Console.write("\\{readg()}")
}
`;
		await build_and_check_output(input, "root_trait_global_return", "woof", true);
	});
});
