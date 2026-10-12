// Menus and popovers (Radix): keyboard navigation, Esc closes only the
// menu, focus returns to the trigger. Non-modal, so an item may open a
// dialog or a confirmation without fighting the menu's focus lock.
import { Ellipsis, type LucideIcon } from "lucide-react";
import { DropdownMenu as M, Popover as P } from "radix-ui";
import { useState, type ReactNode } from "react";
import { cn } from "../cn";
import { Button } from "./button";

const surface =
  "glass z-50 min-w-48 overflow-hidden rounded-lg bg-popover p-1 text-foreground shadow-pop data-[state=closed]:pointer-events-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.97]";

/** A dropdown menu on any trigger element. */
export function Menu({
  trigger,
  children,
  align = "end",
  label,
  open,
  onOpenChange,
  className,
}: {
  trigger: ReactNode;
  children: ReactNode;
  align?: "start" | "end";
  label?: string;
  open?: boolean;
  onOpenChange?: (o: boolean) => void;
  className?: string;
}) {
  return (
    <M.Root modal={false} open={open} onOpenChange={onOpenChange}>
      <M.Trigger asChild>{trigger}</M.Trigger>
      <M.Portal>
        <M.Content
          data-slot="menu-content"
          align={align}
          sideOffset={4}
          aria-label={label}
          className={cn(surface, className)}
          // A clickable row around the menu must not see its clicks.
          onClick={(e) => e.stopPropagation()}
        >
          {children}
        </M.Content>
      </M.Portal>
    </M.Root>
  );
}

export function MenuItem({
  icon: Icon,
  children,
  onClick,
  danger,
  disabled,
}: {
  icon?: LucideIcon;
  children: ReactNode;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <M.Item
      disabled={disabled}
      onSelect={() => onClick?.()}
      className={cn(
        "flex h-8 cursor-default items-center gap-2 rounded-[7px] px-2.5 text-body outline-none select-none data-[disabled]:opacity-45 data-[highlighted]:bg-primary data-[highlighted]:text-primary-foreground pointer-coarse:h-11",
        danger && "text-destructive data-[highlighted]:bg-destructive data-[highlighted]:text-white",
      )}
    >
      {Icon && <Icon className="size-4 shrink-0" aria-hidden="true" />}
      {children}
    </M.Item>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <M.Label className="px-2.5 pt-1.5 pb-1 text-caption font-semibold text-faint">{children}</M.Label>;
}

export function MenuSeparator() {
  return <M.Separator className="my-1 h-px bg-separator" />;
}

/** A "⋯" button with a menu of row actions. `close` is kept for old call sites. */
export function RowMenu({ label, children }: { label: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <span
      role="presentation"
      className="inline-flex"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <Menu
        open={open}
        onOpenChange={setOpen}
        label={label}
        trigger={<Button variant="ghost" size="icon-sm" icon={Ellipsis} aria-label={label} />}
      >
        {children(() => setOpen(false))}
      </Menu>
    </span>
  );
}

/** A popover panel (filters, column chooser) anchored to its trigger. */
export function Popover({
  trigger,
  children,
  align = "end",
  className,
  open,
  onOpenChange,
  label,
}: {
  trigger: ReactNode;
  children: ReactNode;
  align?: "start" | "end" | "center";
  className?: string;
  open?: boolean;
  onOpenChange?: (o: boolean) => void;
  label?: string;
}) {
  return (
    <P.Root open={open} onOpenChange={onOpenChange}>
      <P.Trigger asChild>{trigger}</P.Trigger>
      <P.Portal>
        <P.Content
          data-slot="popover-content"
          align={align}
          sideOffset={6}
          collisionPadding={12}
          aria-label={label}
          className={cn(surface, "max-w-[calc(100vw-24px)] p-1.5", className)}
        >
          {children}
        </P.Content>
      </P.Portal>
    </P.Root>
  );
}
