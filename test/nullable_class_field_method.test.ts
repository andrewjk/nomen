import { test } from "vite-plus/test";

import build_and_check_output from "./build_and_check_output";

/**
 * Nullable CLASS-field writes through methods (aarch64 SIGTRAP, pre-existing):
 *
 * The non-nullable class-field write path destroys+frees the old field value.
 * With a nullable field whose old value is null, the cbz guard placed its
 * skip label BEFORE the free, so the free ran on every write — the audited
 * free wrapper trapped on the null slot on the FIRST method call, before any
 * output. The same shape existed in the auto-generated <Struct>_destroy
 * (emit_field_destroys), where a class field still null at destroy time was
 * freed unconditionally after the guard.
 *
 * Found alongside: a heap-classified string method's literal return returned
 * rodata to a freeing caller — the literal-strdup check gated on
 * `function_return_type`, which is unset for primitive-returning struct
 * methods (current_return_is_string's fallback now covers it).
 *
 * The program uses `mov` params per the ownership model (mutators storing
 * into an owning field take `mov T`).
 */

const SRC = `
import System

class Box {
	var int v
	func to_string = (self, out string) {
		return "\\{self.v}"
	}
}

class Wall {
	mov Box? art = null
	func set_art = (ref self, mov Box b) {
		self.art = b
	}
	func show = (self, out string) {
		if self.art == null {
			return "art=null"
		}
		return "art=\\{self.art.v}"
	}
}

pub func main = () {
	var Wall w = Wall()
	Console.write("\\{w.show()}\\n")
	w.set_art(mov Box(1))
	Console.write("\\{w.show()}\\n")
	w.set_art(mov Box(2))
	Console.write("\\{w.show()}\\n")
}
`;

test("nullable class-field method writes: null-guarded free, owned returns", async () => {
	await build_and_check_output(
		SRC,
		"nullable_class_field_method",
		"art=null\nart=1\nart=2\n",
		true,
	);
});
