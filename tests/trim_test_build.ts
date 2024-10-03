export default function trim_test_build(source: string, remove_typedefs = false): string {
  source = source
    // Replace includes
    .replace(/^\#include.+$/gm, "")
    // Replace malloc_count declaration
    .replace(/^int malloc_count;$/gm, "")
    // Replace commented lines
    .replace(/^\/\/.+$/gm, "")
    // Replace empty lines
    .replace(/\n{2,}/gm, "\n")
    .trim();

  return source;
}
