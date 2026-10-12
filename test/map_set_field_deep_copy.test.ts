import { describe, expect, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";
import { parse_raw } from "./parse_with_imports";

// The `Map`/`Set` half of the container-element field deep copy (FOLLOWUP.md,
// "Owning container fields in container elements"): a value struct with a
// `Map`/`Set` member stored in a `List` reads back through `at` as a struct
// copy, and the binding's container fields are reclaimed unconditionally at
// scope exit — so the loaded copy must own INDEPENDENT slabs or the caller
// and the slot double-free. `load_T`'s deep-copy half composes the mono
// `<Map>_copy`/`<Set>_copy` (each a fresh `Map()`/`Set()` whose members
// round-trip `Buffer.copy`). Audit ON: the shallow load used to abort at
// teardown (stale free).

describe("Map member in a List element", () => {
	test("read back owns an independent Map", async () => {
		const input = `
struct Holder {
	var data = Map<string, int>()
}

var list = List<Holder>()
var h = Holder()
h.data.set("k", 7)
list.push(mv h)
var loaded = list.at_or_panic(0)
Console.write("n=\\{loaded.data.length}\\n")
loaded.data.remove("k")
var again = list.at_or_panic(0)
Console.write("still=\\{again.data.get_or_panic("k")}\\n")
`;
		await build_and_check_output(input, "container_field_map", "n=1\nstill=7\n");
	});
});

describe("Set member in a List element", () => {
	test("read back owns an independent Set", async () => {
		const input = `
struct Holder {
	var data = Set<int>()
}

var list = List<Holder>()
var h = Holder()
h.data.add(7)
list.push(mv h)
var loaded = list.at_or_panic(0)
Console.write("n=\\{loaded.data.length}\\n")
loaded.data.remove(7)
var again = list.at_or_panic(0)
Console.write("still=\\{again.data.length}\\n")
`;
		await build_and_check_output(input, "container_field_set", "n=1\nstill=1\n");
	});
});

describe("Map.copy", () => {
	test("is independent from its source", async () => {
		const input = `
var m = Map<string, int>()
m.set("a", 1)
m.set("b", 2)
var c = m.copy()
c.set("c", 3)
c.remove("a")
Console.write("c=\\{c.length} m=\\{m.length}\\n")
Console.write("m_a=\\{m.get_or_panic("a")} c_c=\\{c.get_or_panic("c")}\\n")
`;
		await build_and_check_output(input, "map_copy_independent", "c=2 m=2\nm_a=1 c_c=3\n");
	});
});

describe("Set.copy", () => {
	test("is independent from its source", async () => {
		const input = `
var s = Set<int>()
s.add(1)
s.add(2)
var c = s.copy()
c.add(3)
c.remove(1)
Console.write("c=\\{c.length} s=\\{s.length}\\n")
`;
		await build_and_check_output(input, "set_copy_independent", "c=2 s=2\n");
	});
});

// A class/trait key or value routes the member to `ClassBuffer`, which has no
// `copy` — a cloned body would call a nonexistent `<...>_copy`. The call is
// rejected with targeted guidance (mirroring the `List.copy` gate); the
// monomorphizer never clones the body for such an instantiation.
describe("Map/Set copy rejection for class/trait elements", () => {
	test("Map with trait values rejects copy", () => {
		const input = `
import System

trait Animal {
	pub func speak = (self, out string)
}

mv struct Dog : Animal {
	pub func speak = (self, out string) {
		return "woof"
	}
}

pub func main = (Init init) {
	var m = Map<string, Animal>()
	m.set("d", Dog())
	var c = m.copy()
	Console.write("\\{c.length}\\n")
}
`;
		const parsed = parse_raw(input);
		// Follow-on "Unknown value: c" errors from the rejected declaration are
		// expected noise — the rejection is the FIRST error.
		expect(parsed.errors.length).toBeGreaterThan(0);
		expect(parsed.errors[0].message).toBe(
			"Map.copy() is not available when the key or value type is a class or trait — " +
				"its store is a ClassBuffer with no copy, so the copy would share the stored " +
				"instances (a double free). Keep one mv map and index into it, or rebuild the " +
				"map with fresh instances.",
		);
	});

	// NOTE: no Set twin for this rejection — `Set<T: Hashable + Equatable>`
	// cannot instantiate with a trait element (no trait-conformance syntax),
	// so the shape is unreachable from user code; the gate in check_access_node
	// still covers it defensively.
});

// The REJECTION must not poison instantiations that never call copy: a plain
// `Map<string, Animal>` + set/get program still compiles and runs (the variadic
// init gating already covers that shape — this pins it alongside the copy skip).
describe("Map with trait values without copy still works", () => {
	test("set/get/destroy soundly next to the copy skip", async () => {
		const input = `
trait Animal {
	pub func speak = (self, out string)
}

mv struct Dog : Animal {
	pub func speak = (self, out string) {
		return "woof"
	}
}

var m = Map<string, Animal>()
m.set("d", Dog())
var Animal a = m.get_or_panic("d")
Console.write("\\{a.speak()} \\{m.length}\\n")
`;
		await build_and_check_output(input, "map_trait_values_no_copy", "woof 1\n");
	});
});
