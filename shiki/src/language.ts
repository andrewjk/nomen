import type { LanguageRegistration } from "shiki";

// The VS Code extension's TextMate grammar is the single source of truth.
import grammar from "../../extension/syntaxes/nomen.tmLanguage.json";

// Shiki takes the language id from `name`, not the bundler's map key. The
// grammar's `name` is the display name ("Nomen"); register the lowercase id.
export default [{ ...grammar, name: "nomen" }] as unknown as LanguageRegistration[];
