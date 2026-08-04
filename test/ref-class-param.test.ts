import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

// A `ref` CLASS param is passed the ADDRESS of the caller's pointer slot (so the
// callee can reassign it — see reassignment-loop.test.ts). The callee loads the
// instance into its register, so ordinary field reads/writes through the param
// must still target the instance, not the slot. These guard against an OOB
// read/write regression where field access treated the &slot address as the
// instance pointer.
describe("ref class param field access", () => {
	test("read a field through a ref class param", async () => {
		const input = `
class Box { var int v }
func readv = (ref Box b, out int) {
    return b.v
}
var Box a = Box(5)
var int r = readv(ref a)
Console.write("\\{r}")
`;
		await build_and_check_output(input, "ref_class_field_read", "5");
	});

	test("write a field through a ref class param", async () => {
		const input = `
class Box { var int v }
func setv = (ref Box b, int n) {
    b.v = n
}
var Box a = Box(5)
setv(ref a, 9)
Console.write("\\{a.v}")
`;
		await build_and_check_output(input, "ref_class_field_write", "9");
	});

	test("reassign a ref class param then read a field of the new instance", async () => {
		const input = `
class Box { var int v }
class Holder { mov Box c }
func replace = (ref Holder h, int n) {
    h = Holder(mov Box(n))
}
var Holder h = Holder(mov Box(0))
replace(ref h, 7)
replace(ref h, 8)
Console.write("\\{h.c.v}\\n")
`;
		await build_and_check_output(input, "ref_class_reassign_read", "8\n");
	});

	test("ref class param with owned field reassigned in a loop", async () => {
		const input = `
class Box { var int v }
class Holder { mov Box c }
func replace = (ref Holder h, int n) {
    h = Holder(mov Box(n))
}
var Holder h = Holder(mov Box(0))
var int i = 1
while i <= 4 {
    replace(ref h, i)
    i = i + 1
}
Console.write("\\{h.c.v}\\n")
`;
		await build_and_check_output(input, "ref_class_field_loop", "4\n");
	});
});

// A method call on a `ref` class param passes the instance as the callee's
// `self`. The C backend represents a `ref` class param as a double pointer
// (`struct T **`), while a method's `self` is a single pointer (`struct T *`),
// so the call site must dereference once (`(*c).method()` / `Method((*c))`).
// Without that, mutations inside the method land in the wrong memory and never
// propagate back (this was the root cause of `nomen test --arch c` reporting
// 0|0 assertion counts for every test — the Tester methods mutated the wrong
// slot).
describe("ref class param method calls", () => {
	test("method call on a ref class param persists mutation", async () => {
		const input = `
class Counter {
    var int count = 0
    pub func bump = (ref self) {
        self.count = self.count + 1
    }
}
func run = (ref Counter c) {
    c.bump()
    c.bump()
    c.bump()
}
var Counter counter = Counter()
run(ref counter)
Console.write("\\{counter.count}\\n")
`;
		await build_and_check_output(input, "ref_class_method_call", "3\n");
	});
});

// Forwarding a `ref` class param to ANOTHER `ref` param. The aarch64 backend
// keeps a ref class param's instance in a callee-saved register and the
// address of the caller's pointer slot in ref_class_slots; the call site must
// pass that slot address (not the instance) so the callee's entry sequence can
// dereference it. Passing the instance made the callee dereference the instance
// pointer itself, corrupting memory (crash). The reassignment/read-after cases
// also exercise the post-call register reload: after the callee writes a new
// instance through the slot, the param's register is stale until reloaded.
describe("ref class param forwarded to another ref param", () => {
	test("field mutation through a forwarded ref class param", async () => {
		const input = `
class Box { var int v }
func inner = (ref Box b) {
    b.v = 9
}
func outer = (ref Box b) {
    inner(ref b)
}
var Box a = Box(5)
outer(ref a)
Console.write("\\{a.v}\\n")
`;
		await build_and_check_output(input, "ref_class_forwarded_mutation", "9\n");
	});

	test("reassignment through a forwarded ref class param propagates", async () => {
		const input = `
class Box { var int v }
func inner = (ref Box b) {
    b = Box(9)
}
func outer = (ref Box b) {
    inner(ref b)
}
var Box a = Box(5)
outer(ref a)
Console.write("\\{a.v}\\n")
`;
		await build_and_check_output(input, "ref_class_forwarded_reassign", "9\n");
	});

	test("read forwarded ref param after the callee reassigned it", async () => {
		const input = `
class Box { var int v }
func inner = (ref Box b) {
    b = Box(42)
}
func outer = (ref Box b) {
    inner(ref b)
    Console.write("\\{b.v}\\n")
}
var Box a = Box(5)
outer(ref a)
Console.write("\\{a.v}\\n")
`;
		await build_and_check_output(input, "ref_class_forwarded_read_after", "42\n42\n");
	});
});

// Forwarding a `ref` class param to a METHOD's `ref` param. Methods did not
// treat `ref` class params like top-level functions: the C backend never
// populated ref_class_params (so the body used `b->v` against a `struct T **`),
// and the aarch64 backend had no ref-class-param prologue (so the param's
// register held the caller slot address while the body read it as the
// instance). Reassignment never propagated back. Both backends now mirror the
// top-level function convention (double pointer / ref_class_slots), and the
// call sites forward the slot address instead of the instance.
describe("ref class param forwarded to a method ref param", () => {
	test("field mutation through a forwarded ref class param to a method", async () => {
		const input = `
class Box { var int v }
class Mutator {
    func bump = (ref Box b) {
        b.v = b.v + 1
    }
}
func outer = (ref Box b) {
    var Mutator m = Mutator()
    m.bump(ref b)
}
var Box a = Box(5)
outer(ref a)
Console.write("\\{a.v}\\n")
`;
		await build_and_check_output(input, "ref_class_method_forward_mutation", "6\n");
	});

	test("reassignment through a forwarded ref class param to a method propagates", async () => {
		const input = `
class Box { var int v }
class Mutator {
    func replace = (ref Box b) {
        b = Box(9)
    }
}
func outer = (ref Box b) {
    var Mutator m = Mutator()
    m.replace(ref b)
}
var Box a = Box(5)
outer(ref a)
Console.write("\\{a.v}\\n")
`;
		await build_and_check_output(input, "ref_class_method_forward_reassign", "9\n");
	});

	test("read forwarded ref param after the method reassigned it", async () => {
		const input = `
class Box { var int v }
class Mutator {
    func replace = (ref Box b) {
        b = Box(42)
    }
}
func outer = (ref Box b) {
    var Mutator m = Mutator()
    m.replace(ref b)
    Console.write("\\{b.v}\\n")
}
var Box a = Box(5)
outer(ref a)
Console.write("\\{a.v}\\n")
`;
		await build_and_check_output(input, "ref_class_method_forward_read_after", "42\n42\n");
	});
});
