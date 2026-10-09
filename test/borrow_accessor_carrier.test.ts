import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// STRUCT_PLAN_3 B1 residual: the checker-hoisted `_recv_N` carrier of a
// container borrow accessor (`xs.at(i).tags.length`) is an expression-temp
// consumer — it keeps the slot's alias so its destroy must NOT free the
// aliased string fields. But `load_T` deep-copies the element's `List`/`Buffer`
// fields into the carrier (so a BINDING's destroy can reclaim them), so the
// carrier previously leaked exactly those copies once per expression use. The
// carrier now reclaims the deep-copied containers while leaving the aliased
// strings/structs alone. Both backends, audit on.
describe("borrow-accessor expression-temp carriers", () => {
	test("reclaims a deep-copied container field of the loaded element", async () => {
		const input = `
owning struct Group {
  var List<int> items = List<int>()
}
var groups = List<Group>()
var g = Group()
g.items.push(1)
g.items.push(2)
groups.push(move g)
for i of 0 .. groups.length {
  Console.write("\\{groups.at(i).items.length}")
}
`;
		await build_and_check_output(input, "borrow_accessor_carrier_container", "2");
	});

	test("reclaims the container while leaving the aliased string field alone", async () => {
		const input = `
owning struct Person {
  var string name
  var List<int> items = List<int>()
}
var people = List<Person>()
var p = Person("Ada")
p.items.push(1)
p.items.push(2)
people.push(move p)
for i of 0 .. people.length {
  Console.write("\\{people.at(i).name}:\\{people.at(i).items.length} ")
}
`;
		await build_and_check_output(input, "borrow_accessor_carrier_mixed", "Ada:2 ");
	});

	test("a bound borrow-accessor result still owns (and frees) its containers", async () => {
		// Counterpoint: a real BINDING (`var g = groups.at(i)`) keeps the
		// owning path — its destroy reclaims the containers recursively.
		const input = `
owning struct Group {
  var List<int> items = List<int>()
}
var groups = List<Group>()
var g = Group()
g.items.push(1)
g.items.push(2)
groups.push(move g)
var int total = 0
for i of 0 .. groups.length {
  var Group copy = groups.at(i)
  total = total + copy.items.length
}
Console.write("\\{total}")
`;
		await build_and_check_output(input, "borrow_accessor_carrier_binding", "2");
	});
});
