import { clsx, type ClassValue } from "clsx";

/** Tailwind-friendly class merger (no twMerge to keep the bundle small; avoid conflicting utilities). */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
