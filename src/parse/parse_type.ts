import add_error from "../add_error.ts";
import ParameterNode from "../nodes/ParameterNode.ts";
import Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";
import type ParseStatus from "./ParseStatus.ts";

/** Does `value` start like a type name (word-shaped)? Used to disambiguate
 *  the `ptr T` pointer marker from a local variable named `ptr`. */
function is_word_token(value: string): boolean {
	return /^[A-Za-z_]\w*$/.test(value);
}
import accept from "./utils/accept.ts";
import consume from "./utils/consume.ts";
import expect from "./utils/expect.ts";
import expect_close_angle from "./utils/expect_close_angle.ts";
import get_index from "./utils/get_index.ts";
import parse_qualified_name from "./utils/parse_qualified_name.ts";
import peek_current from "./utils/peek_current.ts";

export default function parse_type(status: ParseStatus): Type {
	// Tuple type: `[T1, T2, ...]`
	if (peek_current(status) === "[") {
		const start = get_index(status);
		accept("[", status);
		// Anonymous enum type: `[.ok(int), .error]` — a case list whose
		// entries start with `.` (a tuple element can never start with `.`).
		if (peek_current(status) === ".") {
			return parse_anon_enum_type(status);
		}
		const tuple_types: Type[] = [];
		if (peek_current(status) !== "]") {
			tuple_types.push(parse_type(status));
			while (accept(",", status)) {
				// Allow trailing comma
				if (peek_current(status) === "]") break;
				tuple_types.push(parse_type(status));
			}
		}
		expect("]", status);
		// Variadic tuple type: follows `...` prefix handled by caller
		const type = new Type("tuple");
		type.start = start;
		type.tuple_types = tuple_types;
		// Variadic tuple marker — caller may set is_array via the ... prefix
		if (accept("?", status)) {
			type.is_nullable = true;
		}
		return type;
	}

	// `ptr T` — a raw typed pointer, only legal in library `unsafe` code
	// (the checker enforces the unsafe context; the parser only parses it).
	// Only a pointer MARKER when a type name follows (`var ptr = 5` keeps
	// `ptr` available as an inferred-local name).
	const is_pointer =
		peek_current(status) === "ptr" && is_word_token(status.tokens[status.i + 1]?.value ?? "");
	if (is_pointer) {
		consume(status);
	}
	const is_view = accept("view", status);
	const is_ref = accept("ref", status);
	const start = get_index(status);
	// `Controls::Button` — qualified references flatten to the bare name
	const { base } = parse_qualified_name(status, consume(status), start);
	const type = new Type(base);
	type.start = start;
	if (is_view) type.is_view = true;
	if (is_ref) type.is_ref = true;
	if (accept("<", status)) {
		type.type_args = [parse_type(status)];
		while (accept(",", status)) {
			type.type_args.push(parse_type(status));
		}
		expect_close_angle(status);
	}
	if (accept("?", status)) {
		type.is_nullable = true;
	}
	if (accept("[", status)) {
		type.is_array = true;
		if (peek_current(status) !== "]") {
			type.length = new ValueNode(get_index(status), consume(status));
		}
		expect("]", status);
	}
	if (is_pointer) {
		// A pointer is a bare machine word — no views/refs/arrays of
		// pointers, and no pointer-to-array. (Pointer-to-pointer would also
		// parse here as `ptr ptr T`; reject it with the same rule.)
		if (type.is_view || type.is_ref || type.is_array || type.is_pointer) {
			add_error(status, `ptr type cannot be combined with view/ref/array or another ptr`, start);
		}
		type.is_pointer = true;
		type.is_view = undefined;
		type.is_ref = undefined;
		type.storage_kind = undefined;
		type.is_nullable = undefined;
		type.length = undefined;
	}
	// `Array<T>` is the generic heap `Array` struct (monomorphized to
	// `Array_<T>`), NOT a raw `T[]` stack array. Keep `is_array` (so the whole
	// array dispatch/bounds/for-of machinery applies) but mark it
	// `is_array_heap` so the check/build can distinguish it deterministically
	// from a raw `T[]`/`T[N]` annotation and from an array-literal VALUE (both
	// stay plain `is_array` without the flag). This replaces the old
	// order-dependent "does the mono struct exist?" build-time gate — see the
	// ROADBLOCKS `Array<T>.set` entry.
	if (type.is_array === undefined && type.name === "Array" && type.type_args?.length === 1) {
		const elem = type.type_args[0];
		if (elem.name === "func") {
			add_error(status, `Func<...> cannot be an array or container element type`, start);
		}
		type.name = elem.name;
		type.is_array = true;
		type.is_nullable = elem.is_nullable;
		type.is_array_heap = true;
		type.type_args = undefined;
	}
	// `Func<T1, ..., Tn>` — the alias spelling of a func type (SPEC,
	// "Function-Typed Parameters"): every type argument but the LAST is a
	// parameter; the last is the result. `void` in the result slot means no
	// result — the same as omitting `out` in the `func (...)` spelling. The
	// alias always desugars to the one-word `func` type, so it composes with
	// signatures at any depth (`Func<Func<int, int>, int>`).
	if (type.name === "Func" && type.type_args?.length) {
		if (type.is_array || type.is_pointer || type.is_view || type.is_ref) {
			add_error(status, `Func<...> cannot be combined with '[]'/'ptr'/'view'/'ref'`, start);
			return type;
		}
		const args = type.type_args;
		const func_type = new Type("func");
		func_type.start = type.start;
		// `Func<...>?` — the nullable marker carries onto the func type.
		if (type.is_nullable) {
			func_type.is_nullable = true;
		}
		// Always a (possibly empty) array: consumers detect a func-typed
		// binding/value by `func_params !== undefined`.
		func_type.func_params = [];
		for (let i = 0; i < args.length - 1; i++) {
			if (args[i].name === "void") {
				add_error(
					status,
					`'void' is only allowed as the result (last) type argument of Func<...>`,
					start,
				);
				continue;
			}
			const param = new ParameterNode(start, "");
			if (args[i].name === "func") {
				// A nested func parameter carries its signature on the
				// ParameterNode (the convention every consumer reads).
				param.type = new Type("func");
				param.func_params = args[i].func_params;
				param.func_return_type = args[i].func_return_type;
			} else {
				param.type = args[i];
			}
			func_type.func_params.push(param);
		}
		const result = args[args.length - 1];
		if (result.name !== "void") func_type.func_return_type = result;
		return func_type;
	}
	return type;
}

/**
 * Anonymous enum type: `[.ok(int), .error]`. Each case is `.name` optionally
 * followed by a parenthesized payload type list. The leading `[` has already
 * been consumed by the caller; a leading `.` cannot begin a tuple element, so
 * the two bracket forms are unambiguous.
 */
function parse_anon_enum_type(status: ParseStatus): Type {
	const cases: { name: string; types: Type[] }[] = [];
	if (peek_current(status) !== "]") {
		parse_anon_enum_case(cases, status);
		while (accept(",", status)) {
			// Allow trailing comma
			if (peek_current(status) === "]") break;
			parse_anon_enum_case(cases, status);
		}
	}
	expect("]", status);
	const type = new Type("anon_enum");
	type.enum_cases = cases;
	if (accept("?", status)) {
		type.is_nullable = true;
	}
	return type;
}

function parse_anon_enum_case(cases: { name: string; types: Type[] }[], status: ParseStatus) {
	const start = get_index(status);
	expect(".", status);
	const name = consume(status);
	const types: Type[] = [];
	if (accept("(", status)) {
		if (peek_current(status) !== ")") {
			types.push(parse_type(status));
			while (accept(",", status)) {
				if (peek_current(status) === ")") break;
				types.push(parse_type(status));
			}
		}
		expect(")", status);
	}
	if (cases.some((c) => c.name === name)) {
		add_error(status, `Duplicate enum case: ${name}`, start);
	}
	cases.push({ name, types });
}
