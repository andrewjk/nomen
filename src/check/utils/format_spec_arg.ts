import add_error from "../../add_error.ts";
import { get_built_in_type } from "../../built_in_types.ts";
import AccessFunctionCallNode from "../../nodes/AccessFunctionCallNode.ts";
import AccessNode from "../../nodes/AccessNode.ts";
import type BaseNode from "../../nodes/BaseNode.ts";
import CastNode from "../../nodes/CastNode.ts";
import Type from "../../nodes/Type.ts";
import ValueNode from "../../nodes/ValueNode.ts";
import type FormatSpec from "../../types/FormatSpec.ts";
import type CheckStatus from "../CheckStatus.ts";
import type_from_value_node from "./type_from_value_node.ts";

/**
 * Compile-time-checked format specs (`\{expr:spec}` — SPEC, String
 * Interpolation). The parse layer splits the spec text off the interpolation
 * argument and attaches it to the call (`FunctionCallNode.format_specs`);
 * this module validates the spec against the argument's TYPE — the
 * compile-time half of the feature — and lowers the argument into a call of
 * the matching System `Format` function, so the interpolation helper keeps
 * receiving an ordinary owned string.
 *
 *   \{f:.2} / \{f:08.2} / \{f:<10.3}  → Format.float_fixed(v, "<directive>")
 *       The checker builds the full printf directive (it knows the spec is
 *       constant), so the raw body is one snprintf with no flag logic.
 *   \{i:03} / \{i:x} / \{u:08X} / \{i:b} → Format.int_base / Format.uint_base
 *       Signed arguments widen to int64, unsigned to uint64 (both accepted
 *       families under the implicit-int coercion ranking), then the library's
 *       digit loop renders base/width/zero/alignment.
 *   \{s:>8} / anything with only width/align → Format.pad(rendered, width)
 *       The argument keeps its `.to_string()` wrap; pad aligns the text.
 *
 * Type mismatches are REJECTED here (precision on a non-float, base on a
 * non-integer, zero-padding on a non-numeric) with the spec text in the
 * message — an invalid `\{expr:spec}` never reaches codegen.
 */

/** Lower one spec'd interpolation argument. Returns the replacement node, or
 *  undefined when the spec was rejected (error already reported) or the
 *  argument shape is unexpected (keep the plain wrap). */
export default function check_format_spec_arg(
	param: BaseNode,
	spec: FormatSpec,
	status: CheckStatus,
): BaseNode | undefined {
	// The parse layer wraps every argument in `.to_string()` unless the source
	// already spelled the conversion — both shapes arrive here as an access
	// call named `to_string` whose target is the user's expression.
	const wrap =
		param.node_type === "access" &&
		(param as AccessNode).access.node_type === "access_func" &&
		((param as AccessNode).access as AccessFunctionCallNode).name === "to_string"
			? param
			: undefined;
	const target = wrap ? (param as AccessNode).target : param;
	const t = type_from_value_node(target, status);
	// A container TYPE carries its ELEMENT's name (`Array(1, 2, 3)` is
	// `Type{ name: "int", is_array: true }`), so the built-in lookup alone
	// would mistake an int array for an int. Only a bare scalar target is a
	// numeric argument (mirrors interp_arg_rewrite).
	const scalar = !t.is_array && !t.is_view && !t.is_ref && !t.is_pointer;
	const info = scalar ? get_built_in_type(t.name) : undefined;
	const kind = info?.kind;
	const is_float = kind === "float";
	const is_int = kind === "int";

	if (spec.precision !== undefined && !is_float) {
		add_error(
			status,
			`format spec ':${spec.text}': precision requires a float, but the value is ${t.name || "value"}`,
			spec.start,
		);
		return undefined;
	}
	if (spec.base && !is_int) {
		add_error(
			status,
			`format spec ':${spec.text}': base requires an integer, but the value is ${t.name || "value"}`,
			spec.start,
		);
		return undefined;
	}
	if (spec.zero && !is_float && !is_int) {
		add_error(
			status,
			`format spec ':${spec.text}': zero-padding requires an integer or float, but the value is ${t.name || "value"}`,
			spec.start,
		);
		return undefined;
	}

	// Width sign encodes alignment: negative = left-align (the library pads
	// with spaces on the right), positive = right-align, 0 = no padding.
	const signed_width = (spec.align === "left" ? -1 : 1) * (spec.width ?? 0);

	if (is_float && spec.precision !== undefined) {
		let directive = "%";
		if (spec.zero && signed_width > 0) directive += "0";
		if (spec.align === "left") directive += "-";
		if (signed_width !== 0) directive += String(signed_width);
		directive += `.${spec.precision}f`;
		return format_call(spec.start, "float_fixed", [
			new CastNode(target.start, target, new Type("float")),
			new ValueNode(target.start, `"${directive}"`, new Type("string", true)),
		]);
	}
	if (is_int && (spec.base || spec.zero)) {
		const base =
			spec.base === "x" || spec.base === "X"
				? 16
				: spec.base === "b"
					? 2
					: spec.base === "o"
						? 8
						: 10;
		const fname = info?.signed ? "int_base" : "uint_base";
		return format_call(spec.start, fname, [
			new CastNode(target.start, target, new Type(info?.signed ? "int64" : "uint64")),
			new ValueNode(target.start, String(base), new Type("int", true)),
			new ValueNode(target.start, spec.base === "X" ? "true" : "false", new Type("bool", true)),
			new ValueNode(target.start, String(signed_width), new Type("int", true)),
			new ValueNode(target.start, spec.zero ? "true" : "false", new Type("bool", true)),
		]);
	}
	// Width/alignment only (or a numeric with neither base nor zero-pad):
	// render through the existing `.to_string()` wrap, then align the text.
	return format_call(spec.start, "pad", [
		wrap ?? param,
		new ValueNode(target.start, String(signed_width), new Type("int", true)),
	]);
}

function format_call(start: number, fname: string, params: BaseNode[]): AccessNode {
	return new AccessNode(
		start,
		new ValueNode(start, "Format"),
		new AccessFunctionCallNode(start, fname, undefined, params),
	);
}
