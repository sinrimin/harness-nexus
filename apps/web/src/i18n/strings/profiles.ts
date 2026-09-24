/** Profiles page. */
const en = {
  // Two-stage delete: badge shown next to a soft-deleted entry target.
  deletedEntry: 'deleted',
  title: 'Profiles',
  subtitle: 'Bundles of MCP servers and resources that agent tools install or connect through.',
  // Install-in-Claude-Code card.
  installTitle: 'Install in Claude Code',
  installDescBefore: 'Every',
  installDescAfter:
    'profile below is served as a native Claude Code plugin. Create a marketplace token once, then on your machine:',
  // The ` — ` / `——` join before the link is part of the string so each
  // language controls its own dash spacing.
  installNoteBefore: 'The add command is shown once when you create the token — ',
  manageTokens: 'manage tokens',
  installNoteAfter: '. Install, update, and uninstall are then handled by Claude Code itself.',
  // Profiles table.
  cardDesc: 'Personal profiles are yours; global ones are shared by an admin.',
  searchPlaceholder: 'Search name, description or target',
  allTargets: 'Any target',
  emptyHint: 'Create one here, or add MCP servers and resources to an existing profile.',
  target: 'Target',
  entries: 'Entries',
  noProfiles: 'No profiles yet.',
  // Action name = dialog title = confirm button (03-interaction.md §9).
  deleteAction: 'Delete profile',
  deleteConsequence:
    'The profile stops resolving at its install URL; the resources it referenced are untouched.',
  deleted: 'Profile deleted',
  loadFailed: 'Failed to load profiles',
  // Create form.
  addTitle: 'Add profile',
  addDesc: 'Choose which MCP servers this profile exposes to agent tools.',
  namePlaceholder: 'e.g. Frontend daily',
  optional: 'optional',
  // Appended to `common.scopeGlobal` on the disabled select item.
  adminSuffix: ' (admin)',
  serversLegend: 'MCP servers in this profile',
  loadingServers: 'Loading servers…',
  noServers: 'No MCP servers visible to you yet. Add one first.',
  creating: 'Creating…',
  createProfile: 'Create profile',
  created: 'Profile created',
  // Edit dialog (#6) — the version field is the marketplace publish switch.
  editTitle: 'Edit profile',
  editDesc:
    'Rename, re-describe, or re-pick the profile entries — or bump its version: Claude Code compares versions, so a bump is what publishes an update to marketplace installs.',
  versionLabel: 'Version',
  versionHint:
    'Auto-numbered; bumps when the entries change (that bump publishes marketplace updates).',
  updated: 'Profile saved',
  // Entry-kind fieldset legends (lookup: KIND_LEGEND in Profiles.tsx).
  kindSkills: 'skills',
  kindRules: 'rules',
  kindCommands: 'commands',
  kindSubAgents: 'sub-agents',
  kindHooks: 'hooks',
  visibleCount: '({count} visible)',
  noneInResources: 'None — manage them in Resources.',
};

const zh: typeof en = {
  deletedEntry: '已删除',
  title: '配置集',
  subtitle: '供 Agent 工具安装或连接的 MCP 服务器与资源集合。',
  installTitle: '在 Claude Code 中安装',
  installDescBefore: '下方的每个',
  installDescAfter:
    '配置集都以原生 Claude Code 插件的形式提供。创建一次市场令牌，然后在你的机器上执行：',
  installNoteBefore: '添加命令只会在你创建令牌时显示一次——',
  manageTokens: '管理令牌',
  installNoteAfter: '。安装、更新与卸载随后均由 Claude Code 自行处理。',
  cardDesc: '个人配置集归你所有；全局配置集由管理员共享。',
  searchPlaceholder: '搜索名称、描述或目标',
  allTargets: '全部目标',
  emptyHint: '在此新建，或向已有配置集中添加 MCP 服务与资源。',
  target: '目标',
  entries: '条目',
  noProfiles: '还没有配置集。',
  deleteAction: '删除配置集',
  deleteConsequence: '该配置集在其安装 URL 上不再可解析；它引用的资源不受影响。',
  deleted: '已删除配置集',
  loadFailed: '加载配置集失败',
  addTitle: '添加配置集',
  addDesc: '选择此配置集向 Agent 工具暴露哪些 MCP 服务器。',
  namePlaceholder: '例如：前端日常',
  optional: '可选',
  adminSuffix: '（管理员）',
  serversLegend: '此配置集中的 MCP 服务器',
  loadingServers: '正在加载服务器…',
  noServers: '你还没有可见的 MCP 服务器。请先添加一个。',
  creating: '创建中…',
  createProfile: '创建配置集',
  created: '已创建配置集',
  editTitle: '编辑配置集',
  editDesc:
    '重命名、修改描述或增删条目，也可升级版本号——Claude Code 按版本号比较，升级版本号即向市场安装发布更新。',
  versionLabel: '版本',
  versionHint: '自动编号；条目变化时自动发番（发番即发布市场更新）。',
  updated: '配置集已保存',
  kindSkills: '技能',
  kindRules: '规则',
  kindCommands: '命令',
  kindSubAgents: '子代理',
  kindHooks: '钩子',
  visibleCount: '（{count} 可见）',
  noneInResources: '暂无——请到资源页管理。',
};

export const profilesStrings = { en, zh };
