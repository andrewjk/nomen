import type { LanguageRegistration } from "shiki";

// The VS Code extension's TextMate grammar is the single source of truth.
import grammar from "../../extension/syntaxes/nomen.tmLanguage.json" with { type: "json" };

// Shiki takes the language id from `name`, not the bundler's map key. The
// grammar's `name` is the display name ("Nomen"); register the lowercase id.
// `Object.assign` (rather than a spread) keeps the bundler from flagging the
// overridden `name` as a duplicate object key.
export default [Object.assign({}, grammar, { name: "nomen" })] as unknown as LanguageRegistration[];
