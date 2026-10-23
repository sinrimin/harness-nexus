// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

/** Admin system settings page. */
const en = {
  title: 'System settings',
  subtitle: 'Instance-wide configuration.',
  registration: 'Registration',
  registrationDesc:
    'When enabled, anyone can create an account. When disabled, only admins can add users.',
  allowPublicRegistration: 'Allow public registration',
  currentState: 'Current state:',
  open: 'Open',
  closed: 'Closed',
  registrationOpened: 'Registration opened',
  registrationClosed: 'Registration closed',
  retention: 'Image retention',
  retentionDesc:
    'How many days an assistant chat image is kept. Applies to newly sent images only — already stored ones keep the retention that was in effect when they arrived.',
  retentionDays: 'Retention (days)',
  retentionCurrent: 'Current: {count} day(s)',
  retentionInvalid: 'Retention must be a whole number of days between 1 and 3650',
  retentionSaved: 'Retention set to {count} day(s)',
  outboundTitle: 'API tool outbound',
  outboundModeLabel: 'Default action',
  outboundModeAllow: 'Allow by default (lists are blacklists)',
  outboundModeDeny: 'Deny by default (lists are whitelists)',
  outboundHintAllow:
    'Any host may be dialed EXCEPT entries in the lists below (blacklists). Cloud-metadata ranges stay blocked in every mode.',
  outboundHintDeny:
    'No host may be dialed EXCEPT entries in the lists below (whitelists). Cloud-metadata ranges stay blocked in every mode.',
  outboundExternal: 'External list',
  outboundInternal: 'Internal list',
  outboundRuleHint:
    'Entries: hostname, *.domain wildcard, IP, or CIDR range (e.g. 10.0.0.0/8). The internal list applies to targets resolving to private/loopback addresses, the external list to public ones.',
  outboundEmpty: 'empty',
  outboundAdd: 'Add',
  outboundRemove: 'Remove {rule}',
  outboundSaved: 'Outbound policy saved',
};

const zh: typeof en = {
  title: '系统设置',
  subtitle: '实例级配置。',
  registration: '注册',
  registrationDesc: '开启后，任何人都可以创建账户；关闭后，只有管理员能添加用户。',
  allowPublicRegistration: '允许公开注册',
  currentState: '当前状态：',
  open: '开放',
  closed: '关闭',
  registrationOpened: '已开放注册',
  registrationClosed: '已关闭注册',
  retention: '图片保留',
  retentionDesc: '助理会话图片的保留天数。只对新发送的图片生效——已存储的图片沿用其入库时的保留期。',
  retentionDays: '保留天数',
  retentionCurrent: '当前：{count} 天',
  retentionInvalid: '保留天数必须是 1–3650 之间的整数',
  retentionSaved: '保留天数已设为 {count} 天',
  outboundTitle: 'API 工具出站访问',
  outboundModeLabel: '默认动作',
  outboundModeAllow: '默认允许（名单为黑名单）',
  outboundModeDeny: '默认拒绝（名单为白名单）',
  outboundHintAllow:
    '除下列名单中的条目（黑名单）外，任意主机均可访问。云元数据网段在任何模式下都封禁。',
  outboundHintDeny:
    '仅下列名单中的条目（白名单）可访问，其余一律拒绝。云元数据网段在任何模式下都封禁。',
  outboundExternal: '外网名单',
  outboundInternal: '内网名单',
  outboundRuleHint:
    '条目支持域名、*.domain 通配符、IP 与 CIDR 网段（如 10.0.0.0/8）。内网名单适用于解析到私网/回环地址的目标，外网名单适用于公网地址。',
  outboundEmpty: '为空',
  outboundAdd: '添加',
  outboundRemove: '移除 {rule}',
  outboundSaved: '出站策略已保存',
};

export const settingsStrings = { en, zh };
