/**
 * External scanner for tree-sitter-nomen.
 *
 * Handles the tokens a context-free lexer cannot:
 *   - STRING_CONTENT / STRING_CONTINUATION / STRING_END_OF_LINE: the body of
 *     a "…" string. A line break inside a string continues the string when
 *     the next line's first non-blank character is `"` (the multi-line
 *     form), and otherwise ends the string at the line break (the last line
 *     of a multi-line string has no closing quote).
 *   - RAW_BODY: the text of a `#raw { … }` block, up to the brace that
 *     closes it. Braces inside C/asm strings and comments do not count —
 *     the same scan as `scan_raw_body_end` in the compiler's
 *     src/raw_block.ts.
 *   - TYPE_ARGS_START: a `<` that opens type arguments (`List<int>()`),
 *     rather than the less-than operator. It must touch the preceding token
 *     and be closed by a matching `>` later on the same line, with only
 *     type-ish characters in between.
 *   - BLOCK_COMMENT: `/* … *\/`, which nests.
 */

#include "tree_sitter/parser.h"

#include <stdbool.h>
#include <stdint.h>

enum TokenType {
	STRING_CONTENT,
	STRING_CONTINUATION,
	STRING_END_OF_LINE,
	RAW_BODY,
	TYPE_ARGS_START,
	BLOCK_COMMENT,
	ERROR_SENTINEL,
};

void *tree_sitter_nomen_external_scanner_create(void) { return NULL; }

void tree_sitter_nomen_external_scanner_destroy(void *payload) { (void)payload; }

unsigned tree_sitter_nomen_external_scanner_serialize(void *payload, char *buffer) {
	(void)payload;
	(void)buffer;
	return 0;
}

void tree_sitter_nomen_external_scanner_deserialize(void *payload, const char *buffer,
                                                    unsigned length) {
	(void)payload;
	(void)buffer;
	(void)length;
}

static inline void advance(TSLexer *lexer) { lexer->advance(lexer, false); }

static inline void skip(TSLexer *lexer) { lexer->advance(lexer, true); }

static inline bool is_blank(int32_t c) { return c == ' ' || c == '\t' || c == '\r'; }

static inline bool is_space(int32_t c) {
	return c == ' ' || c == '\t' || c == '\r' || c == '\n' || c == '\f' || c == '\v';
}

static inline bool is_word(int32_t c) {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
	       c == '_';
}

// ---------------------------------------------------------------------------
// Strings
// ---------------------------------------------------------------------------

static bool scan_string(TSLexer *lexer, const bool *valid_symbols) {
	int32_t c = lexer->lookahead;

	if (c == '\n' || lexer->eof(lexer)) {
		// End of a line inside a string: a continuation when the next line
		// starts with `"`, otherwise the (unterminated) end of the string.
		lexer->mark_end(lexer);
		if (lexer->eof(lexer)) {
			if (valid_symbols[STRING_END_OF_LINE]) {
				lexer->result_symbol = STRING_END_OF_LINE;
				return true;
			}
			return false;
		}
		advance(lexer);
		while (is_blank(lexer->lookahead)) advance(lexer);
		if (lexer->lookahead == '"' && valid_symbols[STRING_CONTINUATION]) {
			advance(lexer);
			lexer->mark_end(lexer);
			lexer->result_symbol = STRING_CONTINUATION;
			return true;
		}
		if (valid_symbols[STRING_END_OF_LINE]) {
			lexer->result_symbol = STRING_END_OF_LINE;
			return true;
		}
		return false;
	}

	if (!valid_symbols[STRING_CONTENT]) return false;

	bool has_content = false;
	while (!lexer->eof(lexer)) {
		c = lexer->lookahead;
		if (c == '"' || c == '\\' || c == '\n') break;
		advance(lexer);
		has_content = true;
	}
	if (!has_content) return false;
	lexer->mark_end(lexer);
	lexer->result_symbol = STRING_CONTENT;
	return true;
}

// ---------------------------------------------------------------------------
// Raw bodies
// ---------------------------------------------------------------------------

static bool scan_raw_body(TSLexer *lexer) {
	unsigned depth = 1;
	bool has_content = false;
	lexer->mark_end(lexer);
	while (!lexer->eof(lexer)) {
		int32_t c = lexer->lookahead;
		if (c == '"' || c == '\'') {
			int32_t quote = c;
			advance(lexer);
			while (!lexer->eof(lexer)) {
				int32_t d = lexer->lookahead;
				if (d == '\\') {
					advance(lexer);
					if (!lexer->eof(lexer)) advance(lexer);
					continue;
				}
				if (d == quote) {
					advance(lexer);
					break;
				}
				if (d == '\n') break;
				advance(lexer);
			}
			has_content = true;
			lexer->mark_end(lexer);
			continue;
		}
		if (c == '/') {
			advance(lexer);
			if (lexer->lookahead == '/') {
				while (!lexer->eof(lexer) && lexer->lookahead != '\n') advance(lexer);
			} else if (lexer->lookahead == '*') {
				advance(lexer);
				while (!lexer->eof(lexer)) {
					if (lexer->lookahead == '*') {
						advance(lexer);
						if (lexer->lookahead == '/') {
							advance(lexer);
							break;
						}
						continue;
					}
					advance(lexer);
				}
			}
			has_content = true;
			lexer->mark_end(lexer);
			continue;
		}
		if (c == '{') {
			depth++;
		} else if (c == '}') {
			depth--;
			if (depth == 0) break;
		}
		advance(lexer);
		has_content = true;
		lexer->mark_end(lexer);
	}
	if (!has_content) return false;
	lexer->result_symbol = RAW_BODY;
	return true;
}

// ---------------------------------------------------------------------------
// Type arguments
// ---------------------------------------------------------------------------

static bool scan_type_args_start(TSLexer *lexer) {
	// Called with the `<` as lookahead and no whitespace before it.
	advance(lexer);
	lexer->mark_end(lexer);
	// `<<` / `<=` are operators.
	if (lexer->lookahead == '<' || lexer->lookahead == '=') return false;
	unsigned depth = 1;
	while (!lexer->eof(lexer)) {
		int32_t c = lexer->lookahead;
		if (c == '>') {
			depth--;
			if (depth == 0) {
				lexer->result_symbol = TYPE_ARGS_START;
				return true;
			}
		} else if (c == '<') {
			depth++;
		} else if (!(is_word(c) || c == ' ' || c == '\t' || c == ',' || c == '.' || c == ':' ||
		             c == '?' || c == '[' || c == ']' || c == '#' || c == '{' || c == '}' ||
		             c == '(' || c == ')' || c == '+')) {
			// Anything else (operators, quotes, line ends) means this was a
			// comparison, not a type-argument list.
			return false;
		}
		advance(lexer);
	}
	return false;
}

// ---------------------------------------------------------------------------
// Block comments
// ---------------------------------------------------------------------------

static bool scan_block_comment(TSLexer *lexer) {
	while (is_space(lexer->lookahead)) skip(lexer);
	if (lexer->lookahead != '/') return false;
	advance(lexer);
	if (lexer->lookahead != '*') return false;
	advance(lexer);
	unsigned depth = 1;
	while (!lexer->eof(lexer)) {
		int32_t c = lexer->lookahead;
		if (c == '/') {
			advance(lexer);
			if (lexer->lookahead == '*') {
				advance(lexer);
				depth++;
			}
			continue;
		}
		if (c == '*') {
			advance(lexer);
			if (lexer->lookahead == '/') {
				advance(lexer);
				depth--;
				if (depth == 0) break;
			}
			continue;
		}
		advance(lexer);
	}
	lexer->mark_end(lexer);
	lexer->result_symbol = BLOCK_COMMENT;
	return true;
}

bool tree_sitter_nomen_external_scanner_scan(void *payload, TSLexer *lexer,
                                             const bool *valid_symbols) {
	(void)payload;

	// During error recovery every symbol is marked valid; let the internal
	// lexer take over rather than guessing.
	if (valid_symbols[ERROR_SENTINEL]) return false;

	if (valid_symbols[RAW_BODY]) return scan_raw_body(lexer);

	if (valid_symbols[STRING_CONTENT] || valid_symbols[STRING_CONTINUATION] ||
	    valid_symbols[STRING_END_OF_LINE]) {
		return scan_string(lexer, valid_symbols);
	}

	if (valid_symbols[TYPE_ARGS_START] && lexer->lookahead == '<') {
		if (scan_type_args_start(lexer)) return true;
		return false;
	}

	if (valid_symbols[BLOCK_COMMENT]) return scan_block_comment(lexer);

	return false;
}
