import { TableCell, TableRow } from "./ui/table";

/** Polite loading indicator (screen readers hear it once). */
export function Loading({ label }: { label: string }) {
  return (
    <p role="status" aria-live="polite" className="py-6 text-center text-sm text-muted-foreground">
      {label}
    </p>
  );
}

/** An error the user must notice (announced immediately). */
export function ErrorText({ children }: { children: React.ReactNode }) {
  if (children == null || children === "") return null;
  return (
    <p role="alert" className="text-sm text-destructive">
      {children}
    </p>
  );
}

/** A full-width table row for empty and loading states. */
export function TableNote({ colSpan, children }: { colSpan: number; children: React.ReactNode }) {
  return (
    <TableRow>
      <TableCell colSpan={colSpan} className="py-6 text-center text-muted-foreground">
        {children}
      </TableCell>
    </TableRow>
  );
}
