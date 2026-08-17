import add_error from "../add_error.ts";
import Type from "../nodes/Type.ts";
import ValueNode from "../nodes/ValueNode.ts";
import type ParseStatus from "./ParseStatus.ts";
import accept from "./utils/accept.ts";
import consume from "./utils/consume.ts";
import expect from "./utils/expect.ts";
import expect_close_angle from "./utils/expect_close_angle.ts";
import get_index from "./utils/get_index.ts";
import peek_current from "./utils/peek_current.ts";

export default function parse_type(status: ParseStatus): Type {
	// Tuple type: `[T1, T2, ...]`
	if (peek_current(status) === "[") {
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
		type.tuple_types = tuple_types;
		// Variadic tuple marker — caller may set is_array via the ... prefix
		if (accept("?", status)) {
			type.is_nullable = true;
		}
		return type;
	}

	const is_view = accept("view", status);
	const is_ref = accept("ref", status);
	const type = new Type(consume(status));
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
		type.name = elem.name;
		type.is_array = true;
		type.is_nullable = elem.is_nullable;
		type.is_array_heap = true;
		type.type_args = undefined;
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
