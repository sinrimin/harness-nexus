/** Skill hub page. */
const en = {
  title: 'Skill hub',
  tabHub: 'Skill hub',
  subtitle: 'Browse a marketplace or search across GitHub, well-known, and direct URLs.',
  // Filters.
  marketplacePlaceholder: 'Marketplace',
  allCategories: 'All categories',
  searchPlaceholder: 'Search across sources…',
  searchAriaLabel: 'Search skills',
  // Results table.
  category: 'Category',
  source: 'Source',
  trust: 'Trust',
  timedOut: 'Some sources timed out ({sources}); showing partial results.',
  emptySearch: 'No skills match the search.',
  emptyFilters: 'No plugins match the current filters.',
  saveAsSkill: 'Save as skill',
  archiveTooltip: 'Archive sources cannot be saved as plugin-source skills',
  // Trust badge labels.
  trusted: 'trusted',
  community: 'community',
  // Save-as-skill dialog.
  dialogTitle: 'Save as skill resource',
  dialogDescLead: 'Stores this entry as a plugin-source skill. Reference it from a profile via',
  dialogDescTail: '.',
  warnLead: 'Community source, no pin.',
  warnBody:
    'Without a SHA/version pin, this reference floats with upstream — a supply-chain drift risk. Pin a SHA where possible.',
  key: 'Key',
  targets: 'Targets',
  adminOnly: ' (admin only)',
  homepage: 'homepage',
  saveSkill: 'Save skill',
  // Toasts.
  savedToast: 'Saved as skill resource',
  saveFailedToast: 'Failed to save skill',
  loadMarketplacesFailed: 'Failed to load marketplaces',
  loadSkillsFailed: 'Failed to load skills',
};

const zh: typeof en = {
  title: '技能中心',
  tabHub: '技能中心',
  subtitle: '浏览市场，或跨 GitHub、well-known 与直接 URL 搜索。',
  marketplacePlaceholder: '市场',
  allCategories: '全部分类',
  searchPlaceholder: '跨来源搜索…',
  searchAriaLabel: '搜索技能',
  category: '分类',
  source: '来源',
  trust: '信任',
  timedOut: '以下来源超时（{sources}）；仅显示部分结果。',
  emptySearch: '没有符合搜索条件的技能。',
  emptyFilters: '当前筛选条件下没有插件。',
  saveAsSkill: '保存为技能',
  archiveTooltip: '归档来源无法保存为插件来源的技能',
  trusted: '可信',
  community: '社区',
  dialogTitle: '保存为技能资源',
  dialogDescLead: '将此条目保存为插件来源的技能，可在配置集中通过',
  dialogDescTail: ' 引用它。',
  warnLead: '社区来源，未锁定版本。',
  warnBody:
    '缺少 SHA 或版本锁定时，此引用将随上游浮动——存在供应链漂移风险。请尽可能使用 SHA 锁定。',
  key: '键名',
  targets: '目标',
  adminOnly: '（仅管理员）',
  homepage: '主页',
  saveSkill: '保存技能',
  savedToast: '已保存为技能资源',
  saveFailedToast: '保存技能失败',
  loadMarketplacesFailed: '加载市场失败',
  loadSkillsFailed: '加载技能失败',
};

export const skillHubStrings = { en, zh };
