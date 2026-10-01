import * as React from "react";

import { cn } from "../../lib/utils";

const Label = React.forwardRef<HTMLLabelElement, React.LabelHTMLAttributes<HTMLLabelElement>>(
  ({ className, ...props }, ref) => (
    // Generic wrapper: every caller passes htmlFor (or wraps its control).
    // eslint-disable-next-line jsx-a11y/label-has-associated-control
    <label ref={ref} className={cn("text-sm font-medium leading-none text-foreground", className)} {...props} />
  ),
);
Label.displayName = "Label";

export { Label };
