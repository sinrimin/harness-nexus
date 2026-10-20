// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

/**
 * @harness-nexus/core — pure domain layer.
 *
 * Re-exports all entities and repository ports. This package must stay free of
 * runtime I/O and framework imports so it can be consumed by every other
 * package (server, sdk-ts, cli) without dragging in dependencies.
 */
export * from './domain/index.js';
export * from './ports/index.js';
