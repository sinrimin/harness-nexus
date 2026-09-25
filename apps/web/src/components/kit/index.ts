/**
 * kit — the product's own devices (04-contract.md §2).
 *
 * `ui/` stays the untouched Radix/shadcn wrappers; everything that encodes a
 * *decision about this product* (protocol material on a designed surface,
 * status with two channels, panels with a nameplate, states as rows) lives
 * here. Each primitive replaced at least two existing hand-rolled copies
 * before it was allowed in.
 *
 * Not here on purpose: nothing today — the toolbar landed with the URL
 * contract it was waiting for (`FilterBar`/`TableSearch`, 07-p3-list-pages.md).
 */
export { LabelText, DataText } from './text';
export { Panel, PanelHeader, PanelBody } from './panel';
export { Well, CopyButton } from './well';
export { Lamp } from './lamp';
export { Readout } from './readout';
export { Field } from './field';
export { DataTable, TableStateRow, tableState } from './table';
export { FilterBar, TableSearch, FilterSelect, SortSelect } from './filter-bar';
export { EmptyState } from './empty-state';
export { Skeleton } from './skeleton';
export { Note } from './note';
export { CommandLine } from './command-line';
export { ConfirmDialog } from './confirm-dialog';
export { PageIntro } from './page-intro';
export { Chip } from './chip';
export { Region } from './region';
