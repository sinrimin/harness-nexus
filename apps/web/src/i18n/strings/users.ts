/** Admin users page. */
const en = {
  title: 'Users',
  subtitle: 'Manage accounts and roles.',
  countLabel: 'users',
  username: 'Username',
  role: 'Role',
  created: 'Created',
  loadFailed: 'Failed to load users',
  noUsers: 'No users yet.',
  emptyHint: 'Add one here — the registration switch does not apply to admins.',
  // List toolbar (07-p3-list-pages.md §4).
  searchPlaceholder: 'Search username',
  allRoles: 'Any role',
  allStatuses: 'Any status',
  statusActive: 'active',
  statusDisabled: 'disabled',
  sortUsername: 'Username (A–Z)',
  sortCreated: 'Newest first',
  nowRole: '{username} is now {role}',
  deleted: 'Deleted {username}',
  // Action name = dialog title = confirm button (03-interaction.md §9).
  deleteAction: 'Delete user',
  deleteConsequence:
    'The account is removed and its tokens stop being accepted. Machines and sessions it owns are deleted with it.',
  makeAdmin: 'Make admin',
  makeUser: 'Make user',
  // Create form.
  addUser: 'Add user',
  addUserDesc: 'Bypasses the registration switch — admins can always add users.',
  password: 'Password',
  createdOk: 'Created {username}',
};

const zh: typeof en = {
  title: '用户',
  subtitle: '管理账户与角色。',
  countLabel: '用户',
  username: '用户名',
  role: '角色',
  created: '创建时间',
  loadFailed: '加载用户失败',
  noUsers: '还没有用户。',
  emptyHint: '在此添加——注册开关不限制管理员。',
  searchPlaceholder: '搜索用户名',
  allRoles: '全部角色',
  allStatuses: '全部状态',
  statusActive: '启用',
  statusDisabled: '已禁用',
  sortUsername: '用户名（A–Z）',
  sortCreated: '最新创建在前',
  nowRole: '{username} 已变更为 {role}',
  deleted: '已删除 {username}',
  deleteAction: '删除用户',
  deleteConsequence: '该账户会被移除，其令牌立即失效。它拥有的机器与会话一并删除。',
  makeAdmin: '设为管理员',
  makeUser: '设为用户',
  addUser: '添加用户',
  addUserDesc: '此入口不受注册开关限制——管理员随时可以添加用户。',
  password: '密码',
  createdOk: '已创建 {username}',
};

export const usersStrings = { en, zh };
