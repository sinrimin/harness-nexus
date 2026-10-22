// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

const en = {
  title: 'API tools',
  subtitle:
    'Declarative HTTP APIs as assistant tools — LLM-authored JSON bundles, uploaded and probe-verified here.',
  uploadButton: 'Upload bundle',
  uploadTitle: 'Upload an API tool bundle',
  replaceTitle: 'Replace the bundle',
  bundleLabel: 'Bundle JSON',
  bundleHint:
    'The authoring surface — paste the JSON document; validation errors come back verbatim.',
  listTitle: 'API tool services',
  colBaseUrl: 'Base URL',
  colTools: 'Tools',
  empty: 'No API tool services yet',
  emptyHint: 'Upload a JSON bundle (authored by you or an LLM) to turn an HTTP API into tools.',
  probeAction: 'Probe',
  downloadAction: 'Download',
  replaceAction: 'Replace',
  deleteTitle: 'Delete API tool service',
  deleteBody:
    'The bundle is removed; references (assistant configs) keep their ids but resolve to nothing.',
  deleteFailed: 'Delete failed: {error}',
  saved: 'Saved',
  saveFailed: 'Save failed: {error}',
  jsonInvalid: 'Not valid JSON',
  probeTitle: 'Probe — {name}',
  probeTool: 'Tool',
  probeArgs: 'Arguments (JSON)',
  probeArgsHint: 'Sample arguments for the selected tool.',
  probeRun: 'Run probe',
  probeRunning: 'Running…',
  probeArgsInvalid: 'Arguments must be valid JSON',
  allowlistTitle: 'Outbound allowlist',
  allowlistHint:
    'Default-deny: API tools may only reach allowlisted hosts. “internal” entries may resolve to private addresses (intranet APIs); metadata ranges stay blocked.',
  allowlistEmpty: 'Empty — all outbound API tool traffic is denied.',
  allowlistInternal: 'internal',
  allowlistAdd: 'Add',
  allowlistSaved: 'Allowlist saved',
  servicesLabel: 'API tool services',
  servicesHint:
    'The assistant may call the selected services’ tools (the api-tools group gates them).',
};

const zh: typeof en = {
  title: 'API 工具',
  subtitle: '以声明式 JSON 把 HTTP API 接成助手工具——在此上传并试跑验证。',
  uploadButton: '上传配置',
  uploadTitle: '上传 API 工具配置',
  replaceTitle: '替换配置',
  bundleLabel: '配置 JSON',
  bundleHint: '编写界面就是这份 JSON——校验错误会原样返回，便于迭代。',
  listTitle: 'API 工具服务',
  colBaseUrl: 'Base URL',
  colTools: '工具',
  empty: '还没有 API 工具服务',
  emptyHint: '上传一份 JSON 配置（人工或 LLM 编写），把 HTTP API 变成工具。',
  probeAction: '试跑',
  downloadAction: '下载',
  replaceAction: '替换',
  deleteTitle: '删除 API 工具服务',
  deleteBody: '配置将被移除；引用它的助手配置保留 id 但不再解析到任何服务。',
  deleteFailed: '删除失败：{error}',
  saved: '已保存',
  saveFailed: '保存失败：{error}',
  jsonInvalid: '不是有效的 JSON',
  probeTitle: '试跑 — {name}',
  probeTool: '工具',
  probeArgs: '参数（JSON）',
  probeArgsHint: '所选工具的样例参数。',
  probeRun: '执行试跑',
  probeRunning: '执行中…',
  probeArgsInvalid: '参数必须是有效的 JSON',
  allowlistTitle: '出站允许清单',
  allowlistHint:
    '默认拒绝：API 工具只能访问清单内的主机。勾选 internal 的条目可解析到内网地址；元数据网段始终封禁。',
  allowlistEmpty: '为空——所有 API 工具出站流量都被拒绝。',
  allowlistInternal: '内网',
  allowlistAdd: '添加',
  allowlistSaved: '允许清单已保存',
  servicesLabel: 'API 工具服务',
  servicesHint: '助手可调用所选服务的工具（由 api-tools 组门控）。',
};

export const apiToolsStrings = { en, zh };
