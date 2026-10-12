import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// The font-size tokens (text-body …, index.css) are registered as font
// sizes, else tailwind-merge takes them for text colours and drops e.g.
// text-primary-foreground next to text-body.
const merge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["caption", "footnote", "body", "callout", "headline", "title3", "title2", "title1"] }],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return merge(clsx(inputs));
}
