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
};

export const settingsStrings = { en, zh };
