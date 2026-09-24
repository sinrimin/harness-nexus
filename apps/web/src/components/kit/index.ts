/**
 * kit — the product's own devices (04-contract.md §2).
 *
 * `ui/` stays the untouched Radix/shadcn wrappers; everything that encodes a
 * *decision about this product* (protocol material on a designed surface,
 * status with two channels, panels with a nameplate, states as rows) lives
 * here. Each primitive replaced at least two existing hand-rolled copies
 * before it was allowed in.
 *
 * Not here on purpose: `TableToolbar`/search (P3 wires filters to the URL, and
 * a slot nobody uses is a slot that lies about the design).
 */
export { LabelText, DataText } from './text';
export { Panel, PanelHeader, PanelBody } from './panel';
export { Well, CopyButton, type WellVariant } from './well';
export { Lamp, type LampSize } from './lamp';
export { Readout } from './readout';
export { Field } from './field';
export { DataTable, TableStateRow, tableState, type TableState } from './table';
export { EmptyState } from './empty-state';
export { Skeleton, SkeletonRows, useDelayedVisible } from './skeleton';
export { Note, errorParts, type NoteTone } from './note';
export { CommandLine, commandPlaceholders, markPlaceholders } from './command-line';
export { ConfirmDialog } from './confirm-dialog';
export { PageHeader, Breadcrumb, type CrumbItem } from './page-header';
export { Chip } from './chip';
export { Region } from './region';
