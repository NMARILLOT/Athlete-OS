import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "outline";
type Size = "sm" | "md" | "lg" | "xl";

const VARIANT: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg hover:bg-accent-strong active:scale-[0.98]",
  secondary: "bg-bg-muted text-fg hover:bg-border active:scale-[0.98]",
  outline: "border border-border-strong text-fg hover:bg-bg-muted active:scale-[0.98]",
  ghost: "text-fg-muted hover:bg-bg-muted hover:text-fg",
  danger: "bg-danger/15 text-danger hover:bg-danger/25",
};
const SIZE: Record<Size, string> = {
  sm: "h-9 px-3 text-sm rounded-lg",
  md: "h-12 px-4 text-base rounded-xl",
  lg: "h-14 px-5 text-lg rounded-2xl",
  xl: "h-16 px-6 text-xl rounded-2xl",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  full?: boolean;
}

/** Large touch targets by default (≥ 48 px), one-hand friendly (spec §85). */
export function Button({
  variant = "primary",
  size = "md",
  full,
  className,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex items-center justify-center gap-2 font-semibold tracking-tight transition-[background-color,transform] duration-150 select-none disabled:cursor-not-allowed disabled:opacity-50",
        VARIANT[variant],
        SIZE[size],
        full && "w-full",
        className,
      )}
      {...props}
    />
  );
}
