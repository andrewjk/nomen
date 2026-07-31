# Nomen

This is the Visual Studio Code language server for [Nomen](https://github.com/andrewjk/nomen).

Nomen is a statically-typed, memory managed language.

The language server provides the following features for `.nm` files:

- Syntax highlighting
- Type checking, as you type or on save
- Hover information for variables, parameters, fields, functions and types
- Go to definition and find all references, across your modules and the standard library
- Auto-completion for struct, class, trait and enum members
- Run and Audit code lenses on `func main`

Nomen code looks something like this:

```nomen
import System

pub func main = () {
    Console.write_line("Hello, World!")
}
```
