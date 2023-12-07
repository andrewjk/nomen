import { test } from "uvu";
import assert from "uvu/assert";
import check from "../src/check";
import parse from "../src/parse";
import tokenize from "../src/tokenize";
import type AccessFieldNode from "../src/types/AccessFieldNode";
import type AccessNode from "../src/types/AccessNode";
import type AssignmentNode from "../src/types/AssignmentNode";
import type DeclarationNode from "../src/types/DeclarationNode";
import type InvocationNode from "../src/types/InvocationNode";
import type ValueNode from "../src/types/ValueNode";
import trim_test_data from "./trim_test_data";

test("debugging test", () => {
  let input = `
// TODO: Move these below Main
trait Animal {
	var name: string
	
	func speak() -> string {
		return "..."
	}
}

struct Dog: Animal {
	var name = "Dog"

	func speak() -> string {
		return "woof"
	}
}

struct Cat: Animal {
	var name = "Cat"

	func speak() -> string {
		return "meow"
	}
}

struct Lizard: Animal {
	var name = "Lizard"

	// Remove this when default function bodies are working
	func speak() -> string {
		return "hiss"
	}
}

func main() {
	/*
	// Test a simple range
	for i in 0..5 {
		Console.Write("hello, world! ")
		Console.Write(i + 1)
		Console.Write("\n")
	}

	Console.Write("\n")
*/
	const dog = Dog.init()
	Console.Write(dog.name)
	Console.Write(": ")
	Console.Write(dog.speak())

	Console.Write("\n")

	// Test an array of objects with traits
	const animals: Animal[] = [Dog.init(), Cat.init(), Lizard.init()]
	for a in animals {
		// TODO: Fields in traits??
		//Console.Write(a.name)
		//Console.Write(": ")
		Console.Write(a.speak())
		Console.Write("\n")
	}
}
`;
  input = `const y = [1, 2, 3]
for x in y {}`;
  const tokens = tokenize(input);
  const parsed = parse(tokens);
  const checked = check(parsed.root);
  //console.log(JSON.stringify(parsed.root, null, 2));
  //assert.equal(parsed.errors.concat(checked.errors), []);
  //assert.equal(result.ok, true);
  //assert.equal(result.errors.length, 1);
  //assert.equal(result.errors[0].i, 14);
  //assert.equal(result.errors[0].message, "Expected {");
});

test.run();
