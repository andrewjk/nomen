import { describe, test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

describe("List push", () => {
	test("push and read back via pop", async () => {
		const input = `
var List<int> list = List<int>()
list.push(10)
list.push(20)
list.push(30)
const int a = list.pop()
const int b = list.pop()
Console.write("\\{a} \\{b}")
`;
		await build_and_check_output(input, "list_push_pop", "30 20");
	});

	test("push multiple and pop all", async () => {
		const input = `
var List<int> list = List<int>()
list.push(1)
list.push(2)
list.push(3)
list.push(4)
list.push(5)
const int a = list.pop()
const int b = list.pop()
const int c = list.pop()
const int d = list.pop()
const int e = list.pop()
Console.write("\\{a}\\{b}\\{c}\\{d}\\{e}")
`;
		await build_and_check_output(input, "list_push_pop_all", "54321");
	});

	test("push triggers resize", async () => {
		const input = `
var List<int> list = List<int>()
list.push(1)
list.push(2)
list.push(3)
list.push(4)
list.push(5)
list.push(6)
list.push(7)
list.push(8)
list.push(9)
Console.write("\\{list.length}")
`;
		await build_and_check_output(input, "list_resize", "9");
	});

	test("push and pop interleaved", async () => {
		const input = `
var List<int> list = List<int>()
list.push(10)
const int a = list.pop()
list.push(20)
list.push(30)
const int b = list.pop()
Console.write("\\{a} \\{b}")
`;
		await build_and_check_output(input, "list_interleaved", "10 30");
	});
});

describe("List length", () => {
	test("length tracks pushes and pops", async () => {
		const input = `
var List<int> list = List<int>()
list.push(1)
list.push(2)
list.push(3)
Console.write("\\{list.length}")
const int x = list.pop()
Console.write("\\{list.length}")
`;
		await build_and_check_output(input, "list_length", "32");
	});
});

describe("List of value structs", () => {
	// Regression: List<T> used the 8-byte Buffer `_int` primitives, so a
	// multi-field value struct read back as garbage / crashed. It now uses the
	// size-aware `_T` primitives (memcpy-based), backed by the monomorphizer
	// retyping `self`/param/body value nodes and the C backend emitting the
	// element struct's typedef to the header for by-value returns.
	const PT = `struct Pt {
  var int x
  var int y
}`;

	test("push and read back via at", async () => {
		const input = `
${PT}
var List<Pt> pts = List<Pt>()
var Pt a = Pt(1, 2)
pts.push(a)
var Pt b = Pt(3, 4)
pts.push(b)
for i of 0 .. pts.length {
  var Pt p = pts.at(i)
  Console.write("\\{p.x},\\{p.y} ")
}
`;
		await build_and_check_output(input, "list_struct_push_at", "1,2 3,4 ");
	});

	test("set replaces an element", async () => {
		const input = `
${PT}
var List<Pt> pts = List<Pt>()
var Pt a = Pt(1, 1)
pts.push(a)
var Pt b = Pt(2, 2)
pts.push(b)
var Pt c = Pt(3, 3)
pts.push(c)
var Pt d = Pt(9, 9)
var int i = 1
if i >= 0 && i < pts.length {
  pts.set(i, d)
}
for i of 0 .. pts.length {
  var Pt p = pts.at(i)
  Console.write("\\{p.x},\\{p.y} ")
}
`;
		await build_and_check_output(input, "list_struct_set", "1,1 9,9 3,3 ");
	});

	test("pop returns and removes the last element", async () => {
		const input = `
${PT}
var List<Pt> pts = List<Pt>()
var Pt a = Pt(1, 1)
pts.push(a)
var Pt b = Pt(2, 2)
pts.push(b)
var Pt p = pts.pop()
Console.write("\\{p.x},\\{p.y} \\{pts.length}")
`;
		await build_and_check_output(input, "list_struct_pop", "2,2 1");
	});
});

describe("List of owning value structs", () => {
	// Regression: Buffer<T> for a value struct T that owns heap data (e.g. a
	// string field) used to shallow-copy the struct into the slot, so the slot
	// and the source shared the string pointer. Buffer.#destroy freed only the
	// slab (not per-element), so the string leaked; and when the list was
	// returned from a function, the hoisted temps that owned the strings were
	// freed at the function's scope exit, leaving the caller reading freed
	// memory (use-after-free). The fix: the constructor strdup's string args
	// (so the struct field is always a heap copy), store_T deep-copies string
	// fields into the slot (independent copy), replace_T destroys the old slot
	// value before overwriting, and #destroy calls T_destroy per element. A
	// T_destroy is auto-generated for value structs with owning fields; struct
	// locals read from `.at()`/`.first()` are borrows (not destroyed, since the
	// slot owns the strings).
	const OWNING = `struct Person {
  var string name
  var int age
}`;

	test("push/at with string fields", async () => {
		const input = `
${OWNING}
var List<Person> people = List<Person>()
people.push(Person("Alice", 30))
people.push(Person("Bob", 25))
for i of 0 .. people.length {
  var Person p = people.at(i)
  Console.write("\\{p.name} \\{p.age} ")
}
`;
		await build_and_check_output(input, "list_owning_push_at", "Alice 30 Bob 25 ");
	});

	test("returned from function (no use-after-free)", async () => {
		const input = `
${OWNING}
func make_people = (out List<Person>) {
  var List<Person> people = List<Person>()
  people.push(Person("Alice", 30))
  people.push(Person("Bob", 25))
  return people
}
var List<Person> everyone = make_people()
for i of 0 .. everyone.length {
  var Person p = everyone.at(i)
  Console.write("\\{p.name} \\{p.age} ")
}
`;
		await build_and_check_output(input, "list_owning_return", "Alice 30 Bob 25 ");
	});

	test("set replaces element (old value freed)", async () => {
		const input = `
${OWNING}
var List<Person> people = List<Person>()
people.push(Person("Alice", 30))
people.push(Person("Bob", 25))
people.push(Person("Carol", 40))
var int i = 1
if i >= 0 && i < people.length {
  people.set(i, Person("Dave", 50))
}
for i of 0 .. people.length {
  var Person p = people.at(i)
  Console.write("\\{p.name} \\{p.age} ")
}
`;
		await build_and_check_output(input, "list_owning_set", "Alice 30 Dave 50 Carol 40 ");
	});

	test("heap-allocated strings from concatenation", async () => {
		const input = `
${OWNING}
func make_name = (string first, string last, out string) {
  return first + " " + last
}
var List<Person> people = List<Person>()
people.push(Person(make_name("Alice", "Smith"), 30))
people.push(Person(make_name("Bob", "Jones"), 25))
for i of 0 .. people.length {
  var Person p = people.at(i)
  Console.write("\\{p.name} ")
}
`;
		await build_and_check_output(input, "list_owning_heap_strings", "Alice Smith Bob Jones ");
	});

	// Nested owning value struct: a value struct whose field is ANOTHER value
	// struct that owns a string. Previously this LEAKED on aarch64 (the outer
	// auto-destroy never called the inner struct's auto-generated _destroy) and
	// failed to compile on C (the inner struct's full typedef wasn't pulled
	// into the header, so `struct Outer { struct Inner inner; }` was an
	// incomplete type). Both fixed.
	test("nested owning value struct (push/at)", async () => {
		const input = `
struct Inner {
  var string text
}
struct Outer {
  var int n
  var Inner inner
}
var List<Outer> xs = List<Outer>()
xs.push(Outer(1, Inner("a")))
xs.push(Outer(2, Inner("b")))
for i of 0 .. xs.length {
  var Outer o = xs.at(i)
  Console.write(o.inner.text)
}
`;
		await build_and_check_output(input, "list_owning_nested", "ab");
	});

	test("nested owning value struct (set replaces — old freed)", async () => {
		const input = `
struct Inner {
  var string text
}
struct Outer {
  var int n
  var Inner inner
}
var List<Outer> xs = List<Outer>()
xs.push(Outer(1, Inner("a")))
xs.push(Outer(2, Inner("b")))
xs.push(Outer(3, Inner("c")))
var int i = 1
if i >= 0 && i < xs.length {
  xs.set(i, Outer(9, Inner("X")))
}
for i of 0 .. xs.length {
  var Outer o = xs.at(i)
  Console.write(o.inner.text)
}
`;
		await build_and_check_output(input, "list_owning_nested_set", "aXc");
	});

	test("two-level nested owning value struct", async () => {
		// Outer { Mid mid } where Mid { Inner inner } where Inner { string }:
		// exercises the destroy + deep-copy recursion two levels deep.
		const input = `
struct Inner {
  var string text
}
struct Mid {
  var Inner inner
}
struct Outer {
  var int n
  var Mid mid
}
var List<Outer> xs = List<Outer>()
xs.push(Outer(1, Mid(Inner("a"))))
xs.push(Outer(2, Mid(Inner("b"))))
for i of 0 .. xs.length {
  var Outer o = xs.at(i)
  Console.write(o.mid.inner.text)
}
`;
		await build_and_check_output(input, "list_owning_nested_deep", "ab");
	});
});

describe("List<string>", () => {
	// Regression: a `List<string>` compiled but crashed at runtime on the
	// aarch64 backend (SIGABRT) and on cleanup. The monomorphized
	// `List<string>.at`/`.slice` bodies call `self.items.load_T(i)`, and
	// because the monomorphized body's `self.items` access node carries no
	// type, `value_is_owned_string` could not resolve `load_T` and fell back
	// to the conservative "owned heap string" classification. That marked
	// `.at`/`.slice` as heap-returning, so every call site freed the returned
	// `char*` — a borrow of the buffer's slot (or a static literal address) —
	// crashing on the free. The fix treats `.at`/`.first`/`.slice`/`load_T`
	// (without `owned_return`) as borrows in `value_is_owned_string`, mirroring
	// the C backend's `is_string_borrow`. `pop` (mov out T) stays owned.

	test("push and read back via at", async () => {
		const input = `
var List<string> xs = List<string>()
xs.push("hello")
xs.push("world")
for i of 0 .. xs.length {
  Console.write(xs.at(i))
}
`;
		await build_and_check_output(input, "list_string_push_at", "helloworld");
	});

	test("set replaces an element", async () => {
		const input = `
var List<string> xs = List<string>()
xs.push("a")
xs.push("b")
var int i = 0
if i >= 0 && i < xs.length {
  xs.set(i, "X")
}
for i of 0 .. xs.length {
  Console.write(xs.at(i))
}
`;
		await build_and_check_output(input, "list_string_set", "Xb");
	});

	test("at result used in a comparison (borrow not freed)", async () => {
		// Two `.at` calls inside one `==` must each survive until the
		// comparison runs — neither is an owned temporary to free. Uses
		// loop-bounded indices so the access constraint discharges.
		const input = `
var List<string> xs = List<string>()
xs.push("x")
xs.push("x")
var bool same = false
for i of 0 .. xs.length {
  for j of 0 .. xs.length {
    if xs.at(i) == xs.at(j) {
      same = true
    }
  }
}
Console.write("\\{same}")
`;
		await build_and_check_output(input, "list_string_at_compare", "true");
	});

	// Regression: `List<string>.pop` of an element that was `push`'d as a
	// bare literal previously crashed on the aarch64 backend (SIGABRT). `pop`
	// is `mov out T` (owned_return), so the caller anchors and frees the
	// result — but the Buffer<string> slot held a shallow copy of the literal
	// (a `char*` into rodata), so the free aborted. The aarch64 backend now
	// strdup's the `move_T` result at the `pop` return (mirroring the C
	// backend), so the caller frees a fresh heap copy. Push/at/set/iterate
	// (the borrow paths) were always unaffected.

	test("pop a literal element", async () => {
		const input = `
var List<string> xs = List<string>()
xs.push("hello")
xs.push("world")
const string a = xs.pop()
const string b = xs.pop()
Console.write(a)
Console.write(b)
`;
		await build_and_check_output(input, "list_string_pop_literal", "worldhello");
	});

	test("pop a heap-string variable pushed by value", async () => {
		const input = `
var string h = "ab" + "cd"
var List<string> xs = List<string>()
xs.push(h)
const string a = xs.pop()
Console.write(a)
`;
		await build_and_check_output(input, "list_string_pop_heap", "abcd");
	});

	test("pop returned across a function boundary", async () => {
		const input = `
func drain_last = (ref List<string> xs, out string) {
  return xs.pop()
}
var List<string> xs = List<string>()
xs.push("one")
xs.push("two")
const string r = drain_last(ref xs)
Console.write(r)
Console.write("\\{xs.length}")
`;
		await build_and_check_output(input, "list_string_pop_across", "two1");
	});

	test("set then pop", async () => {
		const input = `
var List<string> xs = List<string>()
xs.push("a")
xs.push("b")
var int i = 1
if i >= 0 && i < xs.length {
  xs.set(i, "B")
}
const string x = xs.pop()
Console.write(x)
`;
		await build_and_check_output(input, "list_string_set_pop", "B");
	});

	// Regression: a heap-string element (from concatenation) that stays in the
	// list until it is destroyed must not leak. The slot owns an independent
	// heap copy (store_T strdup's), freed by #destroy (per-slot free + slab).
	// Previously #destroy freed only the slab, so the heap copy leaked.
	test("heap concat elements destroyed with the list (no leak)", async () => {
		const input = `
var List<string> xs = List<string>()
xs.push("ab" + "cd")
xs.push("ef" + "gh")
xs.push("ij" + "kl")
for i of 0 .. xs.length {
  Console.write(xs.at(i))
}
`;
		await build_and_check_output(input, "list_string_heap_destroy", "abcdefghijkl");
	});

	// Regression: a heap-string expression passed to `push` (a `mov T value`
	// param) must not leak the original. The buffer strdup's its own copy and
	// the caller retains + frees the original — ownership transfer of a string
	// arg would orphan it. Covered by the leak detector on both backends.
	test("heap concat pushed via expression (no leak)", async () => {
		const input = `
func fill = (ref List<string> xs) {
  xs.push("xx" + "yy")
  xs.push("zz" + "ww")
}
var List<string> xs = List<string>()
fill(ref xs)
const string a = xs.pop()
Console.write(a)
`;
		await build_and_check_output(input, "list_string_heap_push_expr", "zzww");
	});
});

describe("List<T> as a parameter / return type only", () => {
	// Regression: a generic container that appeared ONLY as a parameter or
	// return type — with no `List<T>()` construction elsewhere to trigger
	// monomorphization — lowered to a bare incomplete `struct List` in the
	// signature instead of `struct List_T`. Parameter/return/local-declaration
	// types now materialize their monomorphized form at check time.

	test("List<int> parameter type monomorphizes", async () => {
		const input = `
func sum_list = (List<int> xs, out int) {
  var int total = 0
  var int i = 0
  while i < xs.length {
    total = total + xs.at(i)
    i = i + 1
  }
  return total
}

var List<int> nums = List<int>()
nums.push(10)
nums.push(20)
nums.push(30)
const int s = sum_list(nums)
Console.write("\\{s}")
`;
		await build_and_check_output(input, "list_int_param_only", "60");
	});

	test("List<string> parameter type monomorphizes", async () => {
		const input = `
func first_or = (List<string> xs, string fallback, out string) {
  if xs.length > 0 {
    const string t = xs.at(0)
    return t
  }
  return fallback
}

var List<string> names = List<string>()
names.push("alice")
names.push("bob")
const string r = first_or(names, "none")
Console.write(r)
`;
		await build_and_check_output(input, "list_string_param_only", "alice");
	});

	test("out List<int> return type monomorphizes", async () => {
		const input = `
func make_nums = (out List<int>) {
  var List<int> xs = List<int>()
  xs.push(7)
  xs.push(8)
  return xs
}

var List<int> r = make_nums()
Console.write("\\{r.length}")
`;
		await build_and_check_output(input, "list_int_return_only", "2");
	});
});
