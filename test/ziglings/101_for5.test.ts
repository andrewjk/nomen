import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

// INCOMPATIBILITIES:
// - Zig uses `for (roles, gold, experience, 1..) |c, g, e, i|` (multi-object for
//   with index range starting at 1). Echo doesn't support multi-object for loops.
//   Workaround: for-of with manual index counter, `(i + 1)` for 1-based numbering.
// - Zig uses `switch (c) { .wizard => "Wizard", ... }`. Echo uses match with
//   return from case blocks.
// - Zig uses `const Role = enum { ... }`. Echo uses `enum Role { case ... }`.

test("ziglings 101 for5 -- errors", () => {
	const input = `
import System

enum Role {
    case wizard
    case thief
    case bard
    case warrior
}

func role_name = (Role r, out string) {
    match r {
        case .wizard => "Wizard"
        case .thief => "Thief"
        case .bard => "Bard"
        case .warrior => "Warrior"
    }
}

pub func main = () {
    var Role[] roles = [Role.wizard, Role.bard, Role.bard, Role.warrior]
    var int[] gold = [25, 11, 5, ???]
    var int[] experience = [40, 17, 55, 21]

    var int i = 0
    for r of roles; i += 1 {
        var string name = role_name(r)
        Console.write("\\{i + 1}. \\{name} (Gold: \\{gold[i]}, XP: \\{experience[i]})\\n")
    }
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors.length).toBeGreaterThan(0);
});

test("ziglings 101 for5 -- fixed", () => {
	const input = `
import System

enum Role {
    case wizard
    case thief
    case bard
    case warrior
}

func role_name = (Role r, out string) {
    match r {
        case .wizard => "Wizard"
        case .thief => "Thief"
        case .bard => "Bard"
        case .warrior => "Warrior"
    }
}

pub func main = () {
    var Role[] roles = [Role.wizard, Role.bard, Role.bard, Role.warrior]
    var int[] gold = [25, 11, 5, 7392]
    var int[] experience = [40, 17, 55, 21]

    var int i = 0
    for r of roles; i += 1 {
        var string name = role_name(r)
        Console.write("\\{i + 1}. \\{name} (Gold: \\{gold[i]}, XP: \\{experience[i]})\\n")
    }
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("ziglings 101 for5 -- build", async () => {
	const input = `
import System

enum Role {
    case wizard
    case thief
    case bard
    case warrior
}

func role_name = (Role r, out string) {
    match r {
        case .wizard => "Wizard"
        case .thief => "Thief"
        case .bard => "Bard"
        case .warrior => "Warrior"
    }
}

pub func main = () {
    var Role[] roles = [Role.wizard, Role.bard, Role.bard, Role.warrior]
    var int[] gold = [25, 11, 5, 7392]
    var int[] experience = [40, 17, 55, 21]

    var int i = 0
    for r of roles; i += 1 {
        var string name = role_name(r)
        Console.write("\\{i + 1}. \\{name} (Gold: \\{gold[i]}, XP: \\{experience[i]})\\n")
    }
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64(
		"101",
		built,
		"1. Wizard (Gold: 25, XP: 40)\n" +
			"2. Bard (Gold: 11, XP: 17)\n" +
			"3. Bard (Gold: 5, XP: 55)\n" +
			"4. Warrior (Gold: 7392, XP: 21)\n",
	);
});
