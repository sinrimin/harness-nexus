/**
 * Copy owned by the kit primitives (panel/table/well/confirm…). Page copy lives
 * in its page's namespace; these strings are rendered *inside* a primitive, so
 * a page cannot supply them without re-implementing the primitive.
 */
const en = {
  retry: 'Retry',
  loadFailed: 'Could not load this list',
  filteredEmpty: 'No rows match the current filter',
  clearFilters: 'Clear filters',
  // Two-step confirmation (irreversible actions only).
  typeToConfirm: 'Type {name} to confirm',
  irreversible: 'This cannot be undone.',
  // CommandLine: the angle-bracket tokens the reader must replace.
  substitute: 'Replace these with your values:',
  // Empty state fallback when a page passes no title.
  emptyTitle: 'Nothing here yet',
};

const zh: typeof en = {
  retry: '重试',
  loadFailed: '列表加载失败',
  filteredEmpty: '没有符合当前筛选的行',
  clearFilters: '清除筛选',
  typeToConfirm: '输入 {name} 以确认',
  irreversible: '此操作不可撤销。',
  substitute: '请替换为你的取值：',
  emptyTitle: '这里还是空的',
};

export const kitStrings = { en, zh };
