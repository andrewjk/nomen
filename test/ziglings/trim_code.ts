export default function trim_code(source: string) {
  return (
    source
      .substring(source.indexOf("// Func main"), source.indexOf("void **_get_trait_func"))
      // Replace includes
      .replace(/^#include.+$/gm, "")
      // Replace malloc_count stuff
      .replace(/^int malloc_count;$/gm, "")
      .replace(/^malloc_count--;$/gm, "")
      .replace(/^printf\("\\n\\nMalloc balance: %d\\n", malloc_count\);$/gm, "")
      // Replace commented lines
      .replace(/^\/\/.+$/gm, "")
      // Replace empty lines
      .replace(/\n{2,}/gm, "\n")
      .trim()
  );
}
