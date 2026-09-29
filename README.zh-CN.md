<p align="center">
  <img src="docs/assets/logo.svg" alt="Harness Nexus" width="380">
</p>

<p align="center">
  <em>自托管的编码代理管理平台：MCP、技能、模型配置一次配好，分发到自己的机器，
  还能在浏览器里直接和 agent 对话。</em>
</p>

<p align="center">
  <a href="README.md">English</a> | 简体中文
  &nbsp;·&nbsp;
  <a href="https://github.com/sinrimin/harness-nexus/actions/workflows/ci.yml"><img src="https://github.com/sinrimin/harness-nexus/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  &nbsp;·&nbsp;
  <a href="https://www.npmjs.com/package/@harness-nexus/cli"><img src="https://img.shields.io/npm/v/@harness-nexus/cli" alt="npm @harness-nexus/cli"></a>
  &nbsp;·&nbsp;
  <a href="https://github.com/sinrimin/harness-nexus/stargazers"><img src="https://img.shields.io/github/stars/sinrimin/harness-nexus?logo=github" alt="GitHub stars"></a>
</p>

在 Claude Code、Codex、DeepSeek、OpenCode、pi、Hermes 这些编码代理之间，同一个
MCP server 和 API key 往往每个工具配一遍，换台机器再来一遍；技能和 hooks 散落
各处，也没有一个地方能看清每台机器上到底装了什么。Harness Nexus 补上这个位置：
一个你自己部署的服务端和 Web 界面，加上每台机器上一个轻量客户端 `hnx` 负责本地
执行。

## 在线演示

公开实例跑在 **<https://demo.harness-nexus.com>**——随手注册一个账号就能逛。
那是个一次性环境：数据只存内存、每天清空，请使用一次性凭据，账号随时可能
消失。它运行的准确代码[完全可查](https://github.com/sinrimin/harness-nexus-demo)。

## 它能做什么

- MCP server 只登记一次，凭据加密保存；工具统一从一个端点提供给 agent 使用，
  机器上也可以走本地 stdio shim 接入。
- 把技能、hooks、子代理、规则和 MCP server 打包成 Profile（配置集），一次作业
  部署到目标机器。Claude Code 通过它原生的 plugin marketplace 安装，Codex、
  DeepSeek、Hermes 用 `hnx install`。
- 用 `hnx enroll` 接入机器后，能看到机器上装了什么，一键导回平台作为资源，
  后续更新以作业形式下发。
- 连 agent 本身也一起管（Claude Code、Codex、DeepSeek、OpenCode、pi）：远程
  安装、升级、锁定版本，推送默认的供应商和模型配置，不 SSH 也能查看各 agent
  的配置文件，机密内容已脱敏。
- 在浏览器里和任意 agent 对话：流式输出、工具调用卡片、权限确认，可以传图片
  和文件。对话数据留在你自己的机器上，平台不保存。

## 当前状态

Alpha，仍在快速迭代。上面这些工作流今天就能用，但会有毛边。CLI 已发布到 npm
（[@harness-nexus/cli](https://www.npmjs.com/package/@harness-nexus/cli)，0.x
alpha），Docker 镜像随下一个发布 tag 上线。功能和 API 还会调整，暂时别把找不
回来的数据放进来。开发在 [issues 和
milestones](https://github.com/sinrimin/harness-nexus/milestones) 里推进，功能
说明和设计文档都在 [Wiki](https://github.com/sinrimin/harness-nexus/wiki)。

## 快速开始

### Docker

```bash
cp .env.example .env     # 填 JWT_SECRET（随机字符串，≥16 字符）
docker compose pull && docker compose up -d
open http://127.0.0.1:15922
```

Web 端口默认只绑定 127.0.0.1。要对外开放，先在前面试一层 TLS（Caddy、nginx
都行）：API 的 token 走请求头传输，务必上 HTTPS。如果打算把 profile 通过
Claude Code 的 plugin marketplace 部署，还要在 `.env` 里设置 `PUBLIC_BASE_URL`
为你的公开 https 域名——marketplace 地址由它拼接，默认值
`http://localhost:8080` 只在所有东西都跑在同一台机器上时才可用。也可以从源码
构建，运行 `docker compose up --build -d` 即可；镜像构建走国内源（apt 用
TUNA，npm 用 npmmirror），不需要代理，想换回官方源就把 Dockerfile 里的镜像源
配置删掉。

### 从源码运行（开发）

```bash
pnpm install
export JWT_SECRET="$(openssl rand -base64 48)"   # 必需
export STORAGE_DRIVER=memory                     # 可选：不落数据库文件
pnpm dev:server        # API 在 :8080
pnpm dev:web           # 界面在 :5173
```

第一个注册的用户自动成为管理员。界面默认跟随浏览器语言，可以在页头切换
英文/简体中文。

### 接入一台机器

在要管理的机器上执行（和管理端同一台主机也行）：

```bash
npm install -g @harness-nexus/cli    # 需要 Node.js ≥ 20
hnx daemon --server https://your-instance --token <machine-token> --machine-id <machine-id>
```

先在 Web 界面的「机器 → 注册」创建机器，拿到一次性 token。daemon 会保持
连接、提供本地 MCP shim、执行部署作业、承载聊天进程。远程聊天默认关闭，按
机器开启（它会在那台机器上执行工具，仅所有者可用）。

### 客户端盒子（一条命令）

不动你机器上的任何东西就能连上任意实例：客户端镜像把 `hnx` CLI 和官方
MCP Inspector 装进一个即用即弃的容器。

```bash
docker run -it --rm -p 6274:6274 -p 6275:6275 \
  -e HNX_SERVER=https://your-instance \
  -e HNX_TOKEN=hnpat_… \
  sinrimin/harness-nexus-client
```

token 先在 Web 界面创建（访问令牌 → 新建）。盒子会校验 token、打印配置集
聚合出的工具列表，然后在 `http://localhost:6274` 起 Inspector 界面——已经
指向该服务器的 `/mcp` 出口，无需手填；`HNX_PROFILE` 选择配置集（默认
`default`）。带参数运行则完全跳过盒子流程，直接用 CLI：
`docker run -it --rm sinrimin/harness-nexus-client hnx …`。

## 安全

- 凭据以 AES-256-GCM 加密存储，界面只显示掩码，不回显完整内容。
- 各类 token（个人访问令牌、机器注册）只在创建时完整显示一次。
- 机器 token 只能用于 realtime 通道，不能调用 REST API。
- 聊天记录不离开你的机器；机器清单上传前会先脱敏 env 和 header 值。
- 请把实例和它的 `JWT_SECRET` 当作所连接一切的 root 凭据来保管。

## 文档

- [Wiki](https://github.com/sinrimin/harness-nexus/wiki)：功能说明、设计文档、
  调研笔记和历史路线图
- [`docs/architecture.md`](docs/architecture.md) 与
  [`docs/adr/`](docs/adr)：架构契约与决策记录
- [CONTRIBUTING.md](CONTRIBUTING.md)：开发流程

## 许可证

[MIT](LICENSE)
