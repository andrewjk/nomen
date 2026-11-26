/**
 * @file Tree-sitter grammar for the Nomen programming language
 * @license ISC
 *
 * Nomen has no statement terminators: statements are separated by newlines,
 * but no rule in the language ever needs a newline to disambiguate (an
 * expression never continues with `{`, and `if`/`match`/`switch`/`try` are
 * never the left operand of an operator). The grammar therefore treats
 * newlines as ordinary whitespace.
 *
 * The external scanner (src/scanner.c) handles the lexically awkward parts:
 *  - nested block comments,
 *  - `#raw { … }` bodies (brace-delimited; braces inside C/asm strings and
 *    comments do not count — mirrors src/raw_block.ts in the compiler),
 *  - string content and multi-line continuation strings (a line ending
 *    inside a string continues when the next line starts with `"`, and
 *    otherwise ends the string),
 *  - the `<` that opens type arguments in expression position
 *    (`List<int>()`), told apart from the less-than operator by spacing and
 *    a same-line lookahead for the matching `>`.
 */

/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

const PREC = {
	lambda: -1,
	swap: 1,
	coalesce: 2,
	or: 3,
	and: 4,
	equality: 5,
	relational: 6,
	bit_or: 7,
	bit_xor: 8,
	bit_and: 9,
	shift: 10,
	range: 11,
	additive: 12,
	multiplicative: 13,
	unary: 14,
	cast: 15,
	postfix: 16,
};

/**
 * @param {RuleOrLiteral} rule
 * @param {RuleOrLiteral} [sep]
 */
function sepBy1(rule, sep = ",") {
	return seq(rule, repeat(seq(sep, rule)));
}

/** Comma-separated list allowing a trailing comma.
 *
 * @param {RuleOrLiteral} rule
 */
function commaSep(rule) {
	return optional(seq(sepBy1(rule), optional(",")));
}

/** Non-empty comma-separated list allowing a trailing comma.
 *
 * @param {RuleOrLiteral} rule
 */
function commaSep1(rule) {
	return seq(sepBy1(rule), optional(","));
}

module.exports = grammar({
	name: "nomen",

	word: ($) => $.identifier,

	externals: ($) => [
		$._string_content,
		$.string_continuation,
		$._string_end_of_line,
		$.raw_body,
		$._type_args_start,
		$.block_comment,
		$._call_paren,
		$._index_bracket,
		$._binary_minus,
		$._same_line,
		$._error_sentinel,
	],

	extras: ($) => [/\s/, $.line_comment, $.block_comment],

	supertypes: ($) => [$._statement, $._expression, $._type],

	inline: ($) => [$._name, $._decl_name, $._branch],

	conflicts: ($) => [
		// `(x)` — a parenthesized expression or a lambda's parameter list,
		// decided at `=>`.
		[$._expression, $.lambda_parameter],
		// `[a, b]` after `var` — a destructuring pattern or a tuple type,
		// decided by what follows the `]`.
		[$.destructuring_element, $._type_identifier],
		// `var view x …` — `view` the binding kind or the type prefix.
		[$.declaration_kind],
		// `#hook = (…)` — a lifecycle hook or an assignment of a lambda.
		[$._expression, $.hook_declaration],
		// type-only vs named parameter
	],

	rules: {
		source_file: ($) => repeat($._statement),

		// ------------------------------------------------------------------
		// Statements and declarations
		// ------------------------------------------------------------------

		_statement: ($) =>
			choice(
				$.import_declaration,
				$.function_declaration,
				$.hook_declaration,
				$.struct_declaration,
				$.extend_declaration,
				$.trait_declaration,
				$.enum_declaration,
				$.enum_case,
				$.variable_declaration,
				$.return_statement,
				$.break_statement,
				$.continue_statement,
				$.let_statement,
				$.while_statement,
				$.for_statement,
				$.async_block,
				$.unsafe_block,
				$.block,
				$.pragma_if,
				$.pragma_switch,
				$.pragma_for,
				$.pragma_error,
				$.raw_block,
				$.assignment_statement,
				$.expression_statement,
			),

		block: ($) => seq("{", repeat($._statement), "}"),

		import_declaration: ($) => seq("import", field("path", $.import_path)),

		import_path: ($) => sepBy1($.identifier, "::"),

		attribute_list: ($) => repeat1(seq($.attribute, optional(","))),

		attribute: ($) =>
			seq(
				"@",
				field("name", alias(token.immediate(/[A-Za-z_][A-Za-z0-9_]*/), $.identifier)),
				optional(field("arguments", $.argument_list)),
			),

		modifier: (_) => choice("pub", "internal", "private", "inline", "unsafe", "foreign", "checked"),

		// --- functions ---

		function_declaration: ($) =>
			prec.right(
				seq(
					optional(field("attributes", $.attribute_list)),
					repeat($.modifier),
					"func",
					field("name", $._func_name),
					optional(field("type_parameters", $.type_parameters)),
					"=",
					field("parameters", $.parameter_list),
					optional(field("body", choice($.block, $.expression_body))),
				),
			),

		expression_body: ($) => seq("=>", $._expression),

		_func_name: ($) => choice($.identifier, $.hash_identifier, $.template_name),

		// `#handle = () { }`, `#spawn = () { … }` — lifecycle hooks declared
		// without `func`.
		hook_declaration: ($) =>
			prec.right(
				seq(
					repeat($.modifier),
					field("name", $.hash_identifier),
					"=",
					field("parameters", $.parameter_list),
					optional(field("body", $.block)),
				),
			),

		parameter_list: ($) =>
			seq(
				"(",
				optional(
					choice(
						seq(sepBy1($._parameter), optional(",")),
						seq(optional(seq(sepBy1($._parameter), ",")), $.return_parameter, optional(",")),
					),
				),
				")",
			),

		_parameter: ($) =>
			choice($.self_parameter, $.parameter, $.variadic_parameter, $.type_parameter_declaration),

		self_parameter: ($) =>
			seq(
				optional(choice("ref", "mv")),
				"self",
				optional(field("effects", $.field_set)),
				optional($.constraint),
			),

		parameter: ($) =>
			seq(
				optional(field("attributes", $.attribute_list)),
				optional(field("type", $._type)),
				field("name", $._decl_name),
				optional(field("effects", $.field_set)),
				optional($.constraint),
				optional(seq("=", field("default", $._expression))),
			),

		variadic_parameter: ($) => seq("...", field("type", $._type), field("name", $._decl_name)),

		// `type T` (or `T: type`) — a comptime type parameter.
		type_parameter_declaration: ($) =>
			choice(
				seq("type", field("name", $.identifier)),
				seq(field("name", $.identifier), ":", "type"),
			),

		// `out T`, `mv out T`, `out T ! E1, E2`, `out ! E`, `out int: out >= n`
		return_parameter: ($) =>
			seq(
				optional("mv"),
				"out",
				optional(field("type", $._type)),
				optional(seq("!", field("errors", $.error_types))),
				optional($.constraint),
			),

		error_types: ($) => prec.right(sepBy1($._type)),

		// `{ stats, cache }` — declared field effects on a `ref` parameter.
		field_set: ($) => seq("{", commaSep($.identifier), "}"),

		constraint: ($) => seq(":", field("condition", $._expression)),

		type_parameters: ($) => seq($._type_args_start, commaSep1($.type_parameter), ">"),

		type_parameter: ($) =>
			seq(
				field("name", alias($.identifier, $.type_identifier)),
				optional(seq(":", sepBy1($._type, "+"))),
			),

		// --- types ---

		struct_declaration: ($) =>
			seq(
				optional(field("attributes", $.attribute_list)),
				repeat($.modifier),
				optional("mv"),
				choice("struct", "class"),
				field("name", $._type_name),
				optional(field("type_parameters", $.type_parameters)),
				optional(field("traits", $.trait_list)),
				field("body", $.block),
			),

		trait_list: ($) => seq(":", sepBy1($._type)),

		extend_declaration: ($) =>
			seq(
				"extend",
				optional(choice("struct", "enum", "trait", "bitset", "error")),
				field("name", $._type_name),
				optional(field("type_parameters", $.type_parameters)),
				optional(field("traits", $.trait_list)),
				field("body", $.block),
			),

		trait_declaration: ($) =>
			seq(
				optional(field("attributes", $.attribute_list)),
				repeat($.modifier),
				"trait",
				field("name", $._type_name),
				optional(field("type_parameters", $.type_parameters)),
				optional(field("traits", $.trait_list)),
				field("body", $.block),
			),

		enum_declaration: ($) =>
			seq(
				optional(field("attributes", $.attribute_list)),
				repeat($.modifier),
				optional("mv"),
				choice("enum", "error", "bitset"),
				field("name", $._type_name),
				optional(field("type_parameters", $.type_parameters)),
				optional(field("traits", $.trait_list)),
				field("body", $.block),
			),

		_type_name: ($) => choice(alias($.identifier, $.type_identifier), $.template_name),

		enum_case: ($) =>
			prec.right(
				seq(
					optional(field("attributes", $.attribute_list)),
					"case",
					field("name", $._name),
					optional(seq("(", commaSep($.case_parameter), ")")),
					optional(seq("=", field("value", $._expression))),
				),
			),

		case_parameter: ($) => seq(field("type", $._type), optional(field("name", $._decl_name))),

		// --- variables ---

		variable_declaration: ($) =>
			seq(
				optional(field("attributes", $.attribute_list)),
				repeat($.modifier),
				field("kind", $.declaration_kind),
				choice(
					seq(
						field("type", $._type),
						field("name", $._decl_name),
						optional($.constraint),
						optional(seq("=", field("value", $._expression))),
					),
					seq(
						field("name", $._decl_name),
						optional($.constraint),
						"=",
						field("value", $._expression),
					),
					seq(field("pattern", $.destructuring_pattern), "=", field("value", $._expression)),
				),
			),

		declaration_kind: (_) =>
			choice(
				"var",
				"const",
				// At statement start these are declarations, not the `mv x` /
				// `ref x` prefix expressions (which only appear as operands).
				prec(PREC.postfix + 1, "mv"),
				"view",
				prec(PREC.postfix + 1, "ref"),
				"readonly",
				prec.dynamic(1, seq(choice("var", "const"), "view")),
				seq("readonly", choice("var", "mv")),
			),

		destructuring_pattern: ($) => seq("[", commaSep1($.destructuring_element), "]"),

		destructuring_element: ($) =>
			choice(
				seq(optional("mv"), field("name", $.identifier)),
				seq(field("field", $.identifier), "=", optional("mv"), field("name", $.identifier)),
			),

		// --- simple statements ---

		// The value must start on the `return` line: a bare `return` followed by
		// a statement on the next line stays bare.
		return_statement: ($) => prec.right(seq("return", optional(seq($._same_line, $._expression)))),

		break_statement: (_) => "break",

		continue_statement: (_) => "continue",

		let_statement: ($) => seq("let", $._expression),

		assignment_statement: ($) =>
			seq(
				field("left", $._expression),
				field("operator", choice("=", "+=", "-=", "*=", "/=", "%=")),
				field("right", $._expression),
			),

		expression_statement: ($) => $._expression,

		_update: ($) => choice($.assignment_statement, $._expression),

		while_statement: ($) =>
			seq(
				"while",
				field("condition", $._expression),
				optional(seq(";", field("update", $._update))),
				field("body", $.block),
			),

		for_statement: ($) =>
			seq(
				"for",
				optional(choice("ref", "mv", "var")),
				field("binding", choice($.identifier, $.destructuring_pattern)),
				"of",
				field("iterable", $._expression),
				optional(seq(";", field("update", $._update))),
				field("body", $.block),
			),

		// `async { … }`, `async(timeout: 500) { … }`, `async pool { … }`,
		// `async pool = Nursery(mode: race) { … }`
		async_block: ($) =>
			seq(
				"async",
				optional(
					choice(
						field("options", $.argument_list),
						seq(field("name", $.identifier), optional(seq("=", field("value", $._expression)))),
					),
				),
				field("body", $.block),
			),

		unsafe_block: ($) => seq("unsafe", field("body", $.block)),

		// ------------------------------------------------------------------
		// Compile-time pragmas
		// ------------------------------------------------------------------

		pragma_if: ($) =>
			seq(
				"#if",
				field("condition", $._expression),
				field("consequence", $.block),
				optional(seq("else", field("alternative", $.block))),
			),

		pragma_switch: ($) =>
			seq(
				"#switch",
				"{",
				repeat($.pragma_case),
				"}",
				optional(seq("else", field("alternative", $.block))),
			),

		pragma_case: ($) => seq("case", field("condition", $._expression), $._branch),

		pragma_for: ($) =>
			seq(
				"#for",
				field("binding", $.identifier),
				"of",
				field("iterable", $._expression),
				field("body", $.block),
			),

		pragma_error: ($) => seq("#error", field("message", $.string)),

		// `#raw { … }`, `#raw("c") { … }`, `#raw("c", "file") { … }`
		raw_block: ($) =>
			seq(
				"#raw",
				optional(
					seq(
						"(",
						choice(
							// `#raw("file")` — file scope, the target's default dialect
							field("scope", alias($._raw_file, $.string)),
							// `#raw("c")`, `#raw("c", "file")`
							seq(
								field("dialect", alias($._raw_argument, $.string)),
								optional(seq(",", field("scope", alias($._raw_file, $.string)))),
							),
						),
						optional(","),
						")",
					),
				),
				"{",
				optional(field("body", $.raw_body)),
				"}",
			),

		_raw_argument: (_) => token(seq('"', /[^"\n]*/, '"')),

		_raw_file: (_) => '"file"',

		// ------------------------------------------------------------------
		// Names
		// ------------------------------------------------------------------

		_name: ($) => choice($.identifier, $.template_name),

		_decl_name: ($) => choice($.identifier, $.template_name),

		// `#init`, `#destroy`, `#op_add`, `#self`, `#i`, `#embed_file`
		hash_identifier: (_) => token(/#[A-Za-z_][A-Za-z0-9_]*/),

		// A name built from literal text and `#{…}` splices:
		// `get_#{field.name}`, `#{field.name}_count`, `S_#{w.name}`.
		template_name: ($) =>
			prec.right(
				seq(
					choice(
						seq(alias($.identifier, $.template_text), alias($._immediate_splice, $.splice)),
						$.splice,
					),
					repeat(
						choice(
							alias(token.immediate(/[A-Za-z0-9_]+/), $.template_text),
							alias($._immediate_splice, $.splice),
						),
					),
				),
			),

		splice: ($) => seq("#{", $._expression, "}"),

		_immediate_splice: ($) => seq(token.immediate("#{"), $._expression, "}"),

		// ------------------------------------------------------------------
		// Types
		// ------------------------------------------------------------------

		_type: ($) =>
			choice(
				$._type_identifier,
				$.qualified_type,
				$.scoped_type,
				$.generic_type,
				$.nullable_type,
				$.array_type,
				$.reference_type,
				$.view_type,
				$.move_type,
				$.pointer_type,
				$.tuple_type,
				$.anonymous_enum_type,
				$.function_type,
				$.hash_identifier,
				$.template_name,
			),

		_type_identifier: ($) => alias($.identifier, $.type_identifier),

		qualified_type: ($) => prec.right(seq($.identifier, repeat1(seq("::", $.identifier)))),

		// `Res.ok` — a case-typed enum value
		scoped_type: ($) =>
			prec(1, seq(field("enum", $._type_identifier), ".", field("case", $.identifier))),

		generic_type: ($) =>
			prec(
				1,
				seq(
					field("name", choice($._type_identifier, $.qualified_type)),
					field("arguments", $.type_arguments),
				),
			),

		type_arguments: ($) => seq($._type_args_start, commaSep1($._type), ">"),

		nullable_type: ($) => prec(2, seq($._type, "?")),

		array_type: ($) =>
			prec(2, seq(field("element", $._type), "[", optional(field("length", $._expression)), "]")),

		reference_type: ($) => prec.right(seq("ref", $._type)),

		view_type: ($) => prec.right(seq("view", $._type)),

		move_type: ($) => prec.right(seq("mv", $._type)),

		pointer_type: ($) => prec.right(seq("ptr", $._type)),

		tuple_type: ($) => seq("[", commaSep1($._type), "]"),

		anonymous_enum_type: ($) => seq("[", commaSep1($.enum_variant), "]"),

		enum_variant: ($) =>
			seq(".", field("name", $.identifier), optional(seq("(", commaSep($._type), ")"))),

		function_type: ($) =>
			prec.right(
				seq(
					"func",
					optional("?"),
					"(",
					optional(
						choice(
							seq(sepBy1($._type), optional(",")),
							seq(optional(seq(sepBy1($._type), ",")), $.return_parameter, optional(",")),
						),
					),
					")",
				),
			),

		// ------------------------------------------------------------------
		// Expressions
		// ------------------------------------------------------------------

		_expression: ($) =>
			choice(
				$.identifier,
				$.hash_identifier,
				$.self,
				$.number,
				$.string,
				$.char,
				$.boolean,
				$.null,
				$.qualified_identifier,
				$.generic_name,
				$.enum_shorthand,
				$.array_literal,
				$.struct_literal,
				$.parenthesized_expression,
				$.call_expression,
				$.member_expression,
				$.index_expression,
				$.propagate_expression,
				$.unary_expression,
				$.binary_expression,
				$.cast_expression,
				$.range_expression,
				$.lambda_expression,
				$.function_literal,
				$.if_expression,
				$.match_expression,
				$.switch_expression,
				$.try_expression,
				$.panic_expression,
			),

		// `panic("…")` / `todo("…")`
		panic_expression: ($) =>
			seq(field("keyword", choice("panic", "todo")), field("arguments", $.argument_list)),

		self: (_) => "self",

		boolean: (_) => choice("true", "false"),

		null: (_) => "null",

		number: (_) =>
			token(
				choice(
					/0[xX][0-9a-fA-F_]+/,
					/0[oO][0-7_]+/,
					/0[bB][01_]+/,
					/\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d+)?/,
				),
			),

		char: (_) => token(seq("'", choice(/[^'\\\n]/, /\\x[0-9a-fA-F]+/, /\\./), "'")),

		string: ($) =>
			seq(
				'"',
				repeat(
					choice(
						alias($._string_content, $.string_content),
						$.escape_sequence,
						$.interpolation,
						$.string_continuation,
					),
				),
				choice('"', $._string_end_of_line),
			),

		escape_sequence: (_) => token.immediate(seq("\\", choice(/x[0-9a-fA-F]+/, /[^{\n]/))),

		interpolation: ($) =>
			seq(token.immediate("\\{"), field("expression", $._expression), optional($.format_spec), "}"),

		// `:.2`, `:>8`, `:08X`, `:#,##0.00;(#,##0.00)` — the text after the
		// expression's top-level `:` up to the closing brace.
		format_spec: (_) => token(seq(":", /[^}:\n]/, /[^}\n]*/)),

		qualified_identifier: ($) => prec.right(seq($.identifier, repeat1(seq("::", $.identifier)))),

		generic_name: ($) =>
			prec(
				PREC.postfix,
				seq(
					field("name", choice($.identifier, $.qualified_identifier)),
					field("arguments", $.type_arguments),
				),
			),

		// `.north`, `.rect(10, 20)` (as a call), `.LoadError(e)`
		enum_shorthand: ($) => prec(PREC.postfix, seq(".", field("name", $.identifier))),

		array_literal: ($) => seq("[", commaSep($._expression), "]"),

		// `[ name = "bob", age = 5 ]`, `[ .. LayoutParams(), grow = 2 ]`
		struct_literal: ($) =>
			seq(
				"[",
				choice(
					seq($.spread_element, optional(seq(",", commaSep($.field_initializer)))),
					commaSep1($.field_initializer),
				),
				"]",
			),

		spread_element: ($) => seq("..", $._expression),

		field_initializer: ($) => seq(field("name", $.identifier), "=", field("value", $._expression)),

		parenthesized_expression: ($) => seq("(", $._expression, ")"),

		call_expression: ($) =>
			prec(
				PREC.postfix,
				seq(
					field("function", $._expression),
					field("arguments", alias($._call_arguments, $.argument_list)),
				),
			),

		// A call's `(` (and an index's `[`) must be on the callee's line; on
		// the next line it starts a new statement.
		_call_arguments: ($) => seq(alias($._call_paren, "("), commaSep($._argument), ")"),

		argument_list: ($) => seq("(", commaSep($._argument), ")"),

		_argument: ($) => choice($._expression, $.named_argument),

		named_argument: ($) => seq(field("name", $.identifier), ":", field("value", $._expression)),

		member_expression: ($) =>
			prec(
				PREC.postfix,
				seq(
					field("object", $._expression),
					choice(".", "?."),
					field("property", alias($.identifier, $.field_identifier)),
				),
			),

		index_expression: ($) =>
			prec(
				PREC.postfix,
				seq(
					field("object", $._expression),
					alias($._index_bracket, "["),
					field("index", $._expression),
					"]",
				),
			),

		// `load(path)!` — propagate the error side
		propagate_expression: ($) => prec(PREC.postfix, seq($._expression, "!")),

		unary_expression: ($) =>
			prec(
				PREC.unary,
				seq(field("operator", choice("-", "!", "~", "mv", "ref")), field("operand", $._expression)),
			),

		binary_expression: ($) => {
			/** @type {[number, RuleOrLiteral][]} */
			const table = [
				[PREC.swap, "swap"],
				[PREC.coalesce, choice("??", "!!")],
				[PREC.or, "||"],
				[PREC.and, "&&"],
				[PREC.equality, choice("==", "!=")],
				[PREC.relational, choice("<", "<=", ">", ">=")],
				[PREC.bit_or, "|"],
				[PREC.bit_xor, "^"],
				[PREC.bit_and, "&"],
				[PREC.shift, choice("<<", ">>")],
				// Binary `-` must be on the left operand's line; at the start of
				// a line it is a unary minus beginning a new statement.
				[PREC.additive, choice("+", alias($._binary_minus, "-"))],
				[PREC.multiplicative, choice("*", "/", "%")],
			];
			return choice(
				...table.map(([precedence, operator]) =>
					prec.left(
						precedence,
						seq(
							field("left", $._expression),
							field("operator", operator),
							field("right", $._expression),
						),
					),
				),
			);
		},

		cast_expression: ($) =>
			prec.left(PREC.cast, seq(field("value", $._expression), "as", field("type", $._type))),

		range_expression: ($) =>
			prec.left(PREC.range, seq(field("start", $._expression), "..", field("end", $._expression))),

		// `(a, b, out int) => a + b`, `(x) => x * 2`, `() => 3`
		lambda_expression: ($) =>
			prec.right(
				PREC.lambda,
				seq(field("parameters", $.lambda_parameters), "=>", field("body", $._expression)),
			),

		lambda_parameters: ($) =>
			seq(
				"(",
				optional(
					choice(
						seq(sepBy1($.lambda_parameter), optional(",")),
						seq(optional(seq(sepBy1($.lambda_parameter), ",")), $.return_parameter, optional(",")),
					),
				),
				")",
			),

		lambda_parameter: ($) => field("name", $.identifier),

		// `func (x, out int) { return x * 4 }`
		function_literal: ($) =>
			seq("func", field("parameters", $.parameter_list), field("body", $.block)),

		if_expression: ($) =>
			prec.right(
				seq(
					"if",
					field("condition", $._expression),
					field("consequence", $._branch),
					optional(seq("else", field("alternative", $._branch))),
				),
			),

		_branch: ($) => choice($.block, $.arrow_branch),

		arrow_branch: ($) =>
			prec.right(
				seq(
					"->",
					choice(
						$._expression,
						$.return_statement,
						$.break_statement,
						$.continue_statement,
						$.assignment_statement,
					),
				),
			),

		match_expression: ($) =>
			seq("match", field("value", $._expression), field("body", $.match_body)),

		match_body: ($) => seq("{", repeat($.match_arm), "}"),

		match_arm: ($) => seq("case", field("pattern", sepBy1($._expression)), $._branch),

		switch_expression: ($) =>
			seq("switch", optional(field("value", $._expression)), field("body", $.match_body)),

		try_expression: ($) =>
			prec.right(
				seq("try", field("value", $._expression), "catch", field("handlers", $.match_body)),
			),

		// ------------------------------------------------------------------
		// Lexical
		// ------------------------------------------------------------------

		identifier: (_) => /[A-Za-z_][A-Za-z0-9_]*/,

		line_comment: (_) => token(seq("//", /[^\n]*/)),
	},
});
