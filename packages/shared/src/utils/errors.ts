// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

/** Small shared helpers usable by every package (no node-only APIs here). */

/** Typed error with an HTTP-ish status code for the server to map. */
export class AppError extends Error {
  constructor(
    message: string,
    readonly statusCode: number = 500,
    readonly code: string = 'INTERNAL',
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const isAppError = (e: unknown): e is AppError => e instanceof AppError;
