// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merge Tailwind classes with conflict resolution (shadcn standard helper). */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
