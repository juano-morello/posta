import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// T6.2.1 — the standard shadcn/ui `cn()` helper: clsx composes conditional
// class strings, twMerge then resolves Tailwind class conflicts (e.g. a
// later `p-4` correctly wins over an earlier `p-2` instead of both
// surviving in the className string). Every shadcn-derived primitive in
// components/ui/** builds its className through this, never string
// concatenation, so variant/override composition stays predictable.
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
