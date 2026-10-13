import { clsx } from 'clsx';
import type { ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// Joins class names, letting a later Tailwind class override an earlier one.
export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));
