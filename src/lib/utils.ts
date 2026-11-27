/**
 * Joins class names, the way shadcn's `cn` does without pulling in Tailwind's
 * merge step: this project styles with plain CSS, so there is nothing to merge.
 */
export function cn(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}