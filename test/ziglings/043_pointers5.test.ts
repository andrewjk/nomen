import { expect, test } from "vite-plus/test";

import build from "../../src/build";
import check_output_aarch64 from "./check_output_aarch64";
import parse_with_imports from "./parse_with_imports";

test("ziglings 043 pointers5 -- errors", () => {
	const input = `
import System

enum Role {
  case wizard
  case thief
  case bard
  case warrior
}

struct Character {
  var Role role
  var int gold
  var int health
  var int experience
}

pub func main = () {
    var Character glorp = Character(Role.wizard, 10, 100, 20)
    printCharacter(???)
}

func printCharacter = (ref Character c) {
    match c.role {
        case .wizard -> Console.write("Wizard")
        case .thief -> Console.write("Thief")
        case .bard -> Console.write("Bard")
        case .warrior -> Console.write("Warrior")
    }
    Console.write(" (G:\\{c.gold} H:\\{c.health} XP:\\{c.experience})\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors.length).toBeGreaterThan(0);
});

test("ziglings 043 pointers5 -- fixed", () => {
	const input = `
import System

enum Role {
  case wizard
  case thief
  case bard
  case warrior
}

struct Character {
  var Role role
  var int gold
  var int health
  var int experience
}

pub func main = () {
    var Character glorp = Character(Role.wizard, 10, 100, 20)
    printCharacter(ref glorp)
}

func printCharacter = (ref Character c) {
    match c.role {
        case .wizard -> Console.write("Wizard")
        case .thief -> Console.write("Thief")
        case .bard -> Console.write("Bard")
        case .warrior -> Console.write("Warrior")
    }
    Console.write(" (G:\\{c.gold} H:\\{c.health} XP:\\{c.experience})\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
});

test("ziglings 043 pointers5 -- build", async () => {
	const input = `
import System

enum Role {
  case wizard
  case thief
  case bard
  case warrior
}

struct Character {
  var Role role
  var int gold
  var int health
  var int experience
}

pub func main = () {
    var Character glorp = Character(Role.wizard, 10, 100, 20)
    printCharacter(ref glorp)
}

func printCharacter = (ref Character c) {
    match c.role {
        case .wizard -> Console.write("Wizard")
        case .thief -> Console.write("Thief")
        case .bard -> Console.write("Bard")
        case .warrior -> Console.write("Warrior")
    }
    Console.write(" (G:\\{c.gold} H:\\{c.health} XP:\\{c.experience})\\n")
}
`;
	const parsed = parse_with_imports(input);
	expect(parsed.errors).toEqual([]);
	const built = build(parsed.root, { arch: "aarch64" });
	await check_output_aarch64("043", built, "Wizard (G:10 H:100 XP:20)\n");
});
