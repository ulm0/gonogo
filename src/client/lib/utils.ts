/** shadcn's `cn`: joins class names, a later Tailwind class wins over an earlier one of the same kind. */
import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export const cn = (...inputs: ClassValue[]): string => twMerge(clsx(inputs));
