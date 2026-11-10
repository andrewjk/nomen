/**
 * The System-library surface the JS backend supports natively. The library's
 * own Nomen bodies are not emitted (they are raw/unsafe-heavy); instead these
 * containers map onto JS representations:
 *
 *   List<T>        → a JS array
 *   Set<T>         → a JS Set
 *   Map<K, V>      → a JS Map
 *   Box<T>         → `{ __value }` (the checker rewrites transparent access
 *                    `box.f` to `box.__value.f`)
 *   StringBuilder  → `{ s }`
 *
 * Method dispatch is by the RECEIVER's declared type name plus the method
 * name; anything unmapped falls through to `__unsupported` in the caller.
 */

/** Constructors for the supported library types (`List<int>()`,
 *  `Box<int>(x)`, …). The checker monomorphizes the callee name
 *  (`List_int`, `Map_string_int`, `Box_P`), so match by prefix. */
export function library_constructor(name: string, args: string[]): string | undefined {
	if (name === "List" || name.startsWith("List_")) {
		return args.length ? `[${args.join(", ")}]` : "[]";
	}
	if (name === "Set" || name.startsWith("Set_")) {
		return "new Set()";
	}
	if (name === "Map" || name.startsWith("Map_")) {
		return args.length ? `new Map(${args[0]})` : "new Map()";
	}
	if (name === "Box" || name.startsWith("Box_")) {
		return `({ __value: ${args[0] ?? "null"} })`;
	}
	if (name === "StringBuilder") return `({ s: "" })`;
	return undefined;
}

/** A method call on a `List<T>` receiver (a JS array). */
export function list_method(name: string, list: string, args: string[]): string | undefined {
	switch (name) {
		case "length":
			return `BigInt(${list}.length)`;
		case "at":
		case "at_or_panic":
			return `__list_at(${list}, ${args[0]})`;
		// The checker rewrites `for x of a_list` (non-scalar elements) into an
		// index loop that loads each element through `slot_ptr`.
		case "slot_ptr":
			return `${list}[Number(${args[0]})]`;
		case "at_or":
			return `__list_at_or(${list}, ${args[0]}, ${args[1]})`;
		case "set":
		case "set_or_panic":
			return `(${list}[Number(${args[0]})] = ${args[1]})`;
		case "push":
			return `${list}.push(${args[0]})`;
		case "pop":
			return `${list}.pop()`;
		case "remove_at_or_panic":
			return `${list}.splice(Number(${args[0]}), 1)[0]`;
		case "slice":
			return `${list}.slice(Number(${args[0]}), Number(${args[1]}))`;
		case "copy":
			return `${list}.slice()`;
		case "clear":
			return `(${list}.length = 0)`;
	}
	return undefined;
}

/** A method call on a `Set<T>` receiver (a JS Set). */
export function set_method(name: string, set: string, args: string[]): string | undefined {
	switch (name) {
		case "add":
			return `${set}.add(${args[0]})`;
		case "has":
			return `${set}.has(${args[0]})`;
		case "get":
		case "get_or_panic":
			return `__set_get(${set}, ${args[0]})`;
		case "get_or":
			return `(${set}.has(${args[0]}) ? ${set}.get(${args[0]}) : ${args[1]})`;
		case "remove":
			return `${set}.delete(${args[0]})`;
		case "copy":
			return `new Set(${set})`;
		case "length":
			return `BigInt(${set}.size)`;
	}
	return undefined;
}

/** A method call on a `Map<K, V>` receiver (a JS Map). */
export function map_method(name: string, map: string, args: string[]): string | undefined {
	switch (name) {
		case "set":
			return `${map}.set(${args[0]}, ${args[1]})`;
		case "get":
		case "get_or_panic":
			return `__map_get(${map}, ${args[0]})`;
		case "get_or":
			return `(${map}.has(${args[0]}) ? ${map}.get(${args[0]}) : ${args[1]})`;
		case "has":
			return `${map}.has(${args[0]})`;
		case "remove":
			return `${map}.delete(${args[0]})`;
		case "copy":
			return `new Map(${map})`;
		case "length":
			return `BigInt(${map}.size)`;
	}
	return undefined;
}

/** A method call on a `StringBuilder` receiver (`{ s }`). */
export function string_builder_method(
	name: string,
	sb: string,
	args: string[],
): string | undefined {
	switch (name) {
		case "append":
		case "append_string":
		case "append_string_view":
		case "append_int":
		case "append_float":
		case "append_char":
		case "seed":
			return `(${sb}.s += __to_string(${args[0]}))`;
		case "length":
			return `BigInt(${sb}.s.length)`;
		case "to_string":
			return `${sb}.s`;
		case "truncate":
			return `(${sb}.s = ${sb}.s.slice(0, Number(${args[0]})))`;
		case "chomp":
			return `(${sb}.s = ${sb}.s.replace(/\\n$/, ""))`;
		case "ends_with":
			return `${sb}.s.endsWith(${args[0]})`;
		case "take_since":
			return `__sb_take_since(${sb}, ${args[0]})`;
		case "clear":
			return `(${sb}.s = "")`;
		case "ensure":
			// Capacity is implicit in a JS string.
			return "undefined";
	}
	return undefined;
}
