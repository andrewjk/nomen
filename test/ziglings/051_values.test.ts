import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

// The original Zig exercise teaches value vs reference semantics using three
// ways to access a struct variable:
//   1. Value copy (independent - modifying doesn't affect original)
//   2. Mutable pointer (shared - modifying affects original)
//   3. Const pointer (still shared - pointer is const, data is mutable)
//
// The fix is making levelUp() take a pointer so it can modify the caller's data.
//
// INCOMPATIBILITIES:
// - Nomen has no function variable assignment (no `const print = std.debug.print`).
//   Uses `Console.write` directly.
// - Nomen has no distinction between `*T` (mutable pointer) and `*const T`
//   (const pointer). Access patterns 2 and 3 both use `var ref`.
// - Nomen does not have compound assignment on struct fields through ref params
//   (`c.experience += xp`), so `c.experience = c.experience + xp` is used.

test("ziglings 051 values -- errors", () => {
	const input = `
import System

struct Character {
    var int gold
    var int health = 100
    var int experience = 0
}

func levelUp = (Character c, int xp) {
    c.experience = c.experience + xp
}

pub func main = () {
    var Character glorp = Character(30)

    var Character glorp_access1 = glorp
    glorp_access1.gold = 111
    Console.write("1:\\{glorp.gold == glorp_access1.gold}!. ")

    var ref Character glorp_access2 = glorp
    glorp_access2.gold = 222
    Console.write("2:\\{glorp.gold == glorp_access2.gold}!. ")

    var ref Character glorp_access3 = glorp
    glorp_access3.gold = 333
    Console.write("3:\\{glorp.gold == glorp_access3.gold}!. ")

    Console.write("XP before:\\{glorp.experience}, ")
    levelUp(glorp, 200)
    Console.write("after:\\{glorp.experience}.\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors.length).toBeGreaterThan(0);
});

test("ziglings 051 values -- fixed", () => {
	const input = `
import System

struct Character {
    var int gold
    var int health = 100
    var int experience = 0
}

func levelUp = (ref Character c, int xp) {
    c.experience = c.experience + xp
}

pub func main = () {
    var Character glorp = Character(30)

    var Character glorp_access1 = glorp
    glorp_access1.gold = 111
    Console.write("1:\\{glorp.gold == glorp_access1.gold}!. ")

    var ref Character glorp_access2 = glorp
    glorp_access2.gold = 222
    Console.write("2:\\{glorp.gold == glorp_access2.gold}!. ")

    var ref Character glorp_access3 = glorp
    glorp_access3.gold = 333
    Console.write("3:\\{glorp.gold == glorp_access3.gold}!. ")

    Console.write("XP before:\\{glorp.experience}, ")
    levelUp(ref glorp, 200)
    Console.write("after:\\{glorp.experience}.\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("ziglings 051 values -- build", async () => {
	const input = `
import System

struct Character {
    var int gold
    var int health = 100
    var int experience = 0
}

func levelUp = (ref Character c, int xp) {
    c.experience = c.experience + xp
}

pub func main = () {
    var Character glorp = Character(30)

    var Character glorp_access1 = glorp
    glorp_access1.gold = 111
    Console.write("1:\\{glorp.gold == glorp_access1.gold}!. ")

    var ref Character glorp_access2 = glorp
    glorp_access2.gold = 222
    Console.write("2:\\{glorp.gold == glorp_access2.gold}!. ")

    var ref Character glorp_access3 = glorp
    glorp_access3.gold = 333
    Console.write("3:\\{glorp.gold == glorp_access3.gold}!. ")

    Console.write("XP before:\\{glorp.experience}, ")
    levelUp(ref glorp, 200)
    Console.write("after:\\{glorp.experience}.\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64(
		"0511",
		built,
		"1:false!. 2:true!. 3:true!. XP before:0, after:200.\n",
	);
});
