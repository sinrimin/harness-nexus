// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

/** #97 — the delegated-decision audit dialogs (session entry + providers entry). */
const en = {
  title: 'Delegated decisions',
  openHint: 'Delegated decision records',
  viewAll: 'View delegated records',
  verdictAllow: 'Allowed',
  verdictDeny: 'Denied',
  verdictEscalate: 'Escalated',
  byFloor: 'rule layer',
  byModel: 'decision model',
  humanLabel: 'you',
  hrAllow: 'allowed',
  hrReject: 'rejected',
  hrTimeout: 'timed out',
  hrCancel: 'cancelled',
  severity: 'severity',
  intent: 'intent',
  showArgs: 'Arguments',
  hideArgs: 'Hide arguments',
  emptyFull: 'No delegated decisions yet.',
  emptySession: 'No delegated decisions in this session yet.',
  loadMore: 'Load more',
  allOutcomes: 'All verdicts',
  errorLoad: 'Failed to load the decision records.',
};

const zh: typeof en = {
  title: '委托审批记录',
  openHint: '委托审批记录',
  viewAll: '查看委托审批记录',
  verdictAllow: '放行',
  verdictDeny: '拒绝',
  verdictEscalate: '转人工',
  byFloor: '规则层',
  byModel: '决策模型',
  humanLabel: '人答',
  hrAllow: '放行',
  hrReject: '拒绝',
  hrTimeout: '超时',
  hrCancel: '取消',
  severity: '严重度',
  intent: '意图',
  showArgs: '调用参数',
  hideArgs: '收起参数',
  emptyFull: '暂无委托审批记录。',
  emptySession: '本会话暂无代审记录。',
  loadMore: '加载更多',
  allOutcomes: '全部结果',
  errorLoad: '委托审批记录加载失败。',
};

export const decisionsStrings = { en, zh };
