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
		let type: Type;
		if (peek_current(status) === ".") {
			type = parse_anon_enum_type(status);
		} else {
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
			type = new Type("tuple");
			type.start = start;
			type.tuple_types = tuple_types;
			// Variadic tuple marker — caller may set is_array via the ... prefix
			if (accept("?", status)) {
				type.is_nullable = true;
			}
		}
		// `[T1, T2][]` / `[.ok, .err][]` — an array whose element is a
		// tuple / anonymous enum (both materialize to a struct, so the
		// single storage_kind holds). Exactly one suffix level: raw nesting
		// (`[T1, T2][][]`) has no type representation.
		apply_array_suffix(type, status);
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
	// Variable-mode enum (PERF_PLAN item 13): `Enum.case` — a case-qualified
	// type (`Res.ok`, `Option<int>.some`). The type's name flattens to the
	// mangled mono form (`Res_ok`) — the same flattening generic
	// instantiations use — and `case_enum`/`case_name` record the base enum
	// + case so the checker can validate them and materialize the
	// single-case mono (see resolve_case_enum_type). Over a GENERIC enum the
	// name stays the bare generic (the `Option_int` mono must materialize
	// first — mono-of-a-mono order), so the checker derives the mangled
	// form after the generic mono exists.
	if (accept(".", status)) {
		const case_start = get_index(status);
		const case_name = consume(status);
		if (!/^[A-Za-z_]\w*$/.test(case_name)) {
			add_error(status, `Invalid enum case name: ${case_name}`, case_start);
		} else {
			type.case_enum = type.name;
			type.case_name = case_name;
			if (!type.type_args?.length) {
				// Double-underscore join: the mangled mono name must not collide
				// with the BASE enum's C tag constants (`Res_err`/`Res_ok` —
				// `Res_ok` would steal the constant's identifier in the emitted
				// C), nor with generic-mono spellings (`Result_int_string`).
				type.name = `${type.name}__${case_name}`;
			}
		}
	}
	if (accept("?", status)) {
		type.is_nullable = true;
	}
	apply_array_suffix(type, status);
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
			add_error(status, `a func type cannot be an array or container element type`, start);
		}
		if (elem.is_array) {
			// `Array<Array<...>>` / `Array<int[]>` — a heap array whose element
			// is itself an array. A Type carries ONE storage_kind, so an
			// array-of-arrays has no representation; reject with the honest
			// error instead of silently collapsing to the inner type (which
			// would make `Array<Array<int>>` indistinguishable from
			// `Array<int>`).
			add_error(
				status,
				`nested arrays are not supported — 'Array<...>' cannot take an array element type`,
				start,
			);
			return type;
		}
		// `Array<[int, string]>` — the element is a tuple. The tuple has no
		// name of its own (it materializes to a generated struct at check
		// time), so the flattening below would collapse it to the bare name
		// "tuple" and lose the element types. Carry the tuple shape on the
		// array type instead; materialize_type turns the pair into the
		// materialized `_Tuple_...` struct name (preserving heap storage).
		if (elem.name === "tuple" && elem.tuple_types?.length) {
			type.name = elem.name;
			type.tuple_types = elem.tuple_types;
			type.is_array = true;
			type.is_array_heap = true;
			type.is_nullable = elem.is_nullable;
			type.type_args = undefined;
			return type;
		}
		type.name = elem.name;
		type.is_array = true;
		type.is_array_heap = true;
		type.is_nullable = elem.is_nullable;
		// Keep a GENERIC element's own args (`Array<Box<Cell>>` → name Box,
		// args [Cell]): materialize_type flattens the element to its mono
		// name once the mono can be materialized (check time).
		type.type_args = elem.type_args;
	}
	// `Func<T1, ..., Tn>` — REMOVED syntax (the alias spelling of a func
	// type). One clear retirement error; the desugar still runs so nothing
	// downstream cascades (the `class` retirement pattern).
	if (type.name === "Func" && type.type_args?.length) {
		add_error(
			status,
			`Func<...> has been removed — spell func types as 'func (params, out result)'`,
			start,
		);
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
 * Apply the `[]` / `[N]` array suffix(es) to a parsed type. Exactly ONE
 * suffix level is representable (`Type` carries a single `storage_kind`),
 * so a second `[]` is a clear parse error rather than a silently-collapsed
 * type: raw nesting (`int[][]`, `[T1, T2][][]`) is not supported. Works for
 * tuple / anonymous-enum types too (`[T1, T2][]`, `[.ok, .err][]`) — the
 * suffix makes the type an array whose element is the materialized struct,
 * which `materialize_type` handles at check time.
 */
function apply_array_suffix(type: Type, status: ParseStatus): void {
	if (!accept("[", status)) return;
	type.is_array = true;
	if (peek_current(status) !== "]") {
		type.length = new ValueNode(get_index(status), consume(status));
	}
	expect("]", status);
	if (accept("[", status)) {
		add_error(
			status,
			`nested raw arrays are not supported — declare a non-array element type, or use [T1, T2][] for tuples`,
			type.start ?? get_index(status),
		);
		// Consume the trailing brackets so parsing can resume cleanly
		while (peek_current(status) !== "]") consume(status);
		expect("]", status);
	}
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
