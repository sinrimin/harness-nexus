// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

/** Login page. */
const en = {
  welcomeBack: 'Welcome back',
  signInSubtitle: 'Sign in to your Harness Nexus account',
  username: 'Username',
  password: 'Password',
  signIn: 'Sign in',
  signingIn: 'Signing in…',
  noAccount: 'No account?',
  registerLink: 'Register',
  failed: 'Login failed: {message}',
};

const zh: typeof en = {
  welcomeBack: '欢迎回来',
  signInSubtitle: '登录你的 Harness Nexus 账户',
  username: '用户名',
  password: '密码',
  signIn: '登录',
  signingIn: '登录中…',
  noAccount: '还没有账户？',
  registerLink: '注册',
  failed: '登录失败：{message}',
};

export const loginStrings = { en, zh };
