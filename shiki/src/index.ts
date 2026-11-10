import { createBundledHighlighter, createSingletonShorthands } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

/**
 * A Shiki highlighter for Nomen (`source.nm`), using the VS Code extension's
 * TextMate grammar.
 *
 * The JavaScript regex engine is used instead of the Oniguruma WASM build, so
 * this works in Workers and without a binary asset. `c` is registered because
 * the Nomen grammar embeds C for triple-backtick raw blocks.
 */
export const createHighlighter = createBundledHighlighter({
	langs: {
		nomen: () => import("./language.ts"),
		c: () => import("@shikijs/langs/c"),
	},
	themes: {
		"dark-plus": () => import("@shikijs/themes/dark-plus"),
		"light-plus": () => import("@shikijs/themes/light-plus"),
	},
	engine: () => createJavaScriptRegexEngine(),
});

const shorthands = createSingletonShorthands(createHighlighter);

export const codeToHtml = shorthands.codeToHtml;
export const codeToHast = shorthands.codeToHast;
export const codeToTokens = shorthands.codeToTokens;
export const codeToTokensBase = shorthands.codeToTokensBase;
export const getSingletonHighlighter = shorthands.getSingletonHighlighter;
