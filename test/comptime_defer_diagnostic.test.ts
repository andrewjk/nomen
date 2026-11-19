import { expect, test } from "vite-plus/test";

import { compile_module } from "./spec/_helpers.ts";

// FOLLOWUP, "`#for` in a generic-struct method whose iterable never binds":
// the diagnostics say WHICH parameter and WHICH specialization failed to
// bind, instead of an unlocatable "unknown type 'T'" pointing into the
// generic's source.

test("a member loop over the host's own type parameter names the host and param", () => {
	const errors = compile_module(`
		struct Holder<T> {
			#for f of META.info(T).fields {
				var #{f.name} = 0
			}
		}
		pub func main = () {}
	`);
	expect(
		errors.some(
			(e) =>
				e.message.includes("'Holder<T>' body scope cannot defer") &&
				e.message.includes(
					"'T' is the host's own type parameter and binds only per specialization",
				),
		),
	).toBe(true);
});

test("a mono specialization over a non-struct arg names the substitution site", () => {
	// `T` binds to the trait name; a trait has no field reflection, so the
	// deferred loop fails at the specialization — the message says WHICH
	// specialization, not just "unknown type 'Drawable'".
	const errors = compile_module(`
		trait Drawable {
			func draw = (self, out string)
		}
		struct Holder<T> {
			func count = (out int) {
				var n = 0
				#for f of META.info(T).fields {
					n = n + 1
				}
				return n
			}
		}
		pub func main = () {
			var h = Holder<Drawable>()
			var n = h.count()
			Console.write_line("ok")
		}
	`);
	expect(
		errors.some((e) => e.message.includes("'#for' in the Holder<Drawable> specialization")),
	).toBe(true);
	expect(errors.some((e) => e.message.includes("unknown type 'Drawable'"))).toBe(true);
});

test("an iterable naming a bare unknown word keeps the plain error", () => {
	const errors = compile_module(`
		struct Weird {
			#for f of META.info(Nope).fields {
				var #{f.name} = 0
			}
		}
		pub func main = () {}
	`);
	expect(errors.some((e) => e.message.includes("unknown type 'Nope'"))).toBe(true);
});
