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
 *   Buffer<T>      → a JS array (capacity is the array length)
 *   ClassBuffer<T> → a JS array (elements are object references)
 *
 * Method dispatch is by the RECEIVER's declared type name plus the method
 * name; anything unmapped falls through to a warning stub in the caller.
 */

/** Strip a monomorphization suffix: `List_int` → `List`, `StableList_X` →
 *  `StableList`. Longest prefixes first so `StringBuilder` wins over `String`. */
export function library_base_name(name: string): string {
	for (const base of [
		"StringBuilder",
		"ClassBuffer",
		"StableList",
		"Buffer",
		"Atomic",
		"Channel",
		"Fiber",
		"Mutex",
		"Nursery",
		"List",
		"Task",
		"Thread",
		"Set",
		"Map",
		"Box",
	]) {
		if (name === base || name.startsWith(`${base}_`)) return base;
	}
	return name;
}

/** Is `name` a `Buffer<T>` (value slots) or `ClassBuffer<T>` (class slots)? */
export function is_buffer_type(name: string): boolean {
	return (
		name === "Buffer" ||
		name.startsWith("Buffer_") ||
		name === "ClassBuffer" ||
		name.startsWith("ClassBuffer_")
	);
}

/** `ClassBuffer<T>` stores class references, so its stores are not copies. */
export function is_class_buffer_type(name: string): boolean {
	return name === "ClassBuffer" || name.startsWith("ClassBuffer_");
}

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
	if (name === "StableList" || name.startsWith("StableList_")) return "[]";
	// Concurrency primitives are plain single-threaded values (see
	// `concurrency_method`): a channel is two in-memory queues, a mutex/atomic
	// is just its state.
	if (name === "Channel" || name.startsWith("Channel_")) return "({ values: [], strings: [] })";
	if (name === "Mutex" || name.startsWith("Mutex_")) return "({})";
	if (name === "Atomic" || name.startsWith("Atomic_")) return "({ word: 0n })";
	if (name === "Nursery" || name.startsWith("Nursery_")) return "({})";
	// The slot buffers back the linked/chunked containers. An array carries
	// the slots; `.cap` reads map to its length (see `is_buffer_type`).
	if (is_buffer_type(name)) return "[]";
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

/** A method call on a `Buffer<T>` / `ClassBuffer<T>` receiver (a JS array).
 *  The array length is the buffer's capacity; slots are grown on demand. */
export interface BufferOptions {
	/** `ClassBuffer<T>`: slots hold references, so stores are not copies. */
	class_elements: boolean;
	/** Zero value for a freshly grown slot (shown for non-suffixed methods). */
	zero: string;
	/** Copy object-valued elements on `load`, matching Nomen's value
	 *  semantics for struct/enum slots. */
	copy_loads: boolean;
}

export function buffer_method(
	name: string,
	buf: string,
	args: string[],
	options: BufferOptions,
): string | undefined {
	const zero = /_(int|u32|u8)$/.test(name) ? "0n" : name.endsWith("_float") ? "0" : options.zero;
	const store_value = (value: string) => (options.class_elements ? value : `__copy(${value})`);
	const load_value = (index: string) =>
		options.copy_loads ? `__copy(${buf}[Number(${index})])` : `${buf}[Number(${index})]`;
	switch (name) {
		case "alloc":
		case "alloc_int":
		case "alloc_u32":
		case "alloc_u8":
		case "alloc_float":
			return `__buffer_alloc(${buf}, ${args[0]}, ${zero})`;
		case "grow":
		case "grow_int":
		case "grow_u32":
		case "grow_float":
			return `__buffer_grow(${buf}, ${args[0]}, ${zero})`;
		case "load":
		case "load_from":
		case "load_int":
		case "load_u32":
		case "load_u8":
		case "load_float":
			return load_value(args[0]);
		case "store":
		case "replace":
		case "set":
			return `(${buf}[Number(${args[0]})] = ${store_value(args[1])})`;
		case "store_int":
		case "replace_int":
		case "store_u32":
		case "store_u8":
		case "store_float":
		case "store_take":
			return `(${buf}[Number(${args[0]})] = ${args[1]})`;
		case "store_or_int":
		case "store_or_u32":
			return `(${buf}[Number(${args[0]})] |= ${args[1]})`;
		case "move":
		case "move_int":
			return `__buffer_move(${buf}, ${args[0]})`;
		case "modify":
			return `__buffer_modify(${buf}, ${args[0]}, ${args[1]})`;
		case "shift":
			return `__buffer_shift(${buf}, ${args[0]}, ${args[1]})`;
		case "move_range":
			return `__buffer_move_range(${buf}, ${args[0]}, ${args[1]}, ${args[2]})`;
		case "zero":
		case "zero_int":
		case "zero_u32":
			return `__buffer_zero(${buf}, ${args[0]}, ${zero})`;
		case "slice":
			return `${buf}.slice(Number(${args[0]}), Number(${args[1]}))`;
		case "copy":
			return `__copy(${buf})`;
		case "destroy_at":
			return "undefined";
		case "clear_view":
			return `(${buf}.length = 0)`;
	}
	return undefined;
}

/** BigInt's raw per-limb accessors, over the `digits` Buffer (a JS array).
 *  `data_ptr` hands back the array itself, so the loop-hoisted `get_at`/
 *  `set_at` forms index it directly. */
export function bigint_method(name: string, self: string, args: string[]): string | undefined {
	switch (name) {
		case "get":
			return `${self}.digits[Number(${args[0]})]`;
		case "set":
			return `(${self}.digits[Number(${args[0]})] = ${args[1]})`;
		case "data_ptr":
			return `${self}.digits`;
		case "get_at":
			return `${args[0]}[Number(${args[1]})]`;
		case "set_at":
			return `(${args[0]}[Number(${args[1]})] = ${args[2]})`;
		case "div128":
			return `__div128(${args[0]}, ${args[1]}, ${args[2]})`;
	}
	return undefined;
}

/** A method call on a `StableList<T>` receiver (a JS array). */
export function stable_list_method(name: string, list: string, args: string[]): string | undefined {
	switch (name) {
		case "push":
			return `${list}.push(__copy(${args[0]}))`;
		case "at":
		case "at_or_panic":
			return `__list_at(${list}, ${args[0]})`;
		// The checker lowers `ref T x = sl.at(i)` (interior mutation) to this
		// element-borrow primitive; the element itself is the alias.
		case "slot_ptr":
			return `${list}[Number(${args[0]})]`;
		case "at_or":
			return `__list_at_or(${list}, ${args[0]}, ${args[1]})`;
		case "copy":
			return `__copy(${list})`;
	}
	return undefined;
}

/**
 * Concurrency surface, run synchronously. The JS backend has no scheduler, so:
 *  - `Thread`/`Fiber.start` runs the deferred thunk now and returns a finished
 *    `Task`; `detach` runs and discards it;
 *  - `Task.result`/`result_uint64`/`is_done` read that finished result,
 *    `wait` is a no-op, `cancel`/`current_cancelled` are inert;
 *  - `Channel` is two in-memory FIFOs (receive yields zero when empty);
 *  - `Mutex.lock`/`unlock` and `Atomic`'s operations are plain value updates.
 */
export function concurrency_method(
	base: string,
	name: string,
	self: string,
	args: string[],
	is_static: boolean,
): string | undefined {
	switch (base) {
		case "Thread":
		case "Fiber":
			if (is_static) return undefined;
			if (name === "start") return `__spawn_start(${self})`;
			if (name === "detach") return `__spawn_detach(${self})`;
			return undefined;
		case "Nursery":
			if (name === "start") return `__nursery_start(${self}, ${args[0]})`;
			return undefined;
		case "Task":
			if (is_static) {
				if (name === "current_cancelled") return "false";
				if (name === "set_pool_size") return args[0] ?? "0n";
				if (name === "shutdown_pool") return "undefined";
				return undefined;
			}
			switch (name) {
				case "wait":
					return `__task_wait(${self})`;
				case "result":
					return `__task_result(${self})`;
				case "result_uint64":
					return `__task_result_uint64(${self})`;
				case "is_done":
					return "true";
				case "cancel":
					return "undefined";
			}
			return undefined;
		case "Channel":
			switch (name) {
				case "send":
					return `__channel_send(${self}, ${args[0]})`;
				case "send_string":
					return `__channel_send_string(${self}, ${args[0]})`;
				case "receive":
					return `__channel_receive(${self})`;
				case "receive_string":
					return `__channel_receive_string(${self})`;
			}
			return undefined;
		case "Mutex":
			if (name === "lock" || name === "unlock") return "undefined";
			return undefined;
		case "Atomic":
			switch (name) {
				case "load":
					return `${self}.word`;
				case "store":
					return `(${self}.word = ${args[0]})`;
				case "fetch_add":
					return `__atomic_fetch_add(${self}, ${args[0]})`;
				case "swap":
					return `__atomic_swap(${self}, ${args[0]})`;
			}
			return undefined;
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
