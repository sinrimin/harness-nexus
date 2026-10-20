// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

/** Registration page. */
const en = {
  createAccount: 'Create account',
  subtitle: 'Register a new Harness Nexus account',
  closed: 'Registration is closed on this instance. Ask an admin for an account.',
  username: 'Username',
  password: 'Password',
  minChars: 'Minimum 8 characters.',
  emailOptional: 'Email (optional)',
  register: 'Register',
  creating: 'Creating…',
  haveAccount: 'Already have an account?',
  signInLink: 'Sign in',
  failed: 'Registration failed: {message}',
};

const zh: typeof en = {
  createAccount: '创建账户',
  subtitle: '注册一个新的 Harness Nexus 账户',
  closed: '该实例已关闭公开注册，请联系管理员创建账户。',
  username: '用户名',
  password: '密码',
  minChars: '至少 8 个字符。',
  emailOptional: '邮箱（可选）',
  register: '注册',
  creating: '创建中…',
  haveAccount: '已经有账户了？',
  signInLink: '去登录',
  failed: '注册失败：{message}',
};

export const registerStrings = { en, zh };
