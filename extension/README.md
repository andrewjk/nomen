# Nomen

This is the Visual Studio Code extension for [Nomen](https://github.com/andrewjk/nomen).

Nomen is a statically-typed, memory managed language.

It requires the Nomen CLI (`npm i -g nomen-lang`): language features come from the CLI's
language server, `nomen lsp`, which other editors can use too (see
[docs/EDITORS.md](https://github.com/andrewjk/nomen/blob/main/docs/EDITORS.md)).

It provides the following features for `.nm` files:

- Syntax highlighting
- Type checking, as you type or on save
- Hover information for variables, parameters, fields, functions and types
- Go to definition and find all references, across your modules and the standard library
- Auto-completion for struct, class, trait and enum members
- Formatting, and quick fixes for field-effect warnings
- Run and Audit code lenses on `func main`

Nomen code looks something like this:

```nomen
import System

pub func main = () {
    Console.write_line("Hello, World!")
}
```
