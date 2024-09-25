export default function trim_test_build(source: string): string {
  return (
    source
      // Replace includes
      .replace(/^\#include.+$/gm, "")
      // Replace commented lines
      .replace(/^\/\/.+$/gm, "")
      // Replace empty lines
      .replace(/\n{2,}/gm, "\n")
      .trim()
  );
}
