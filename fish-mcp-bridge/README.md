# ST-iPhonie → Fish Audio MCP Bridge

**实验版 0.1.1（网络限制移除版）：代码已实现、本地模拟集成已测试；真实 Fish 账号端到端未验证。**

本适配器把 ST-iPhonie「自己的接口」的 HTTP 配音请求转为 Fish 官方 MCP 调用。不是将网页额度充值进 Developer API，也不是抓 Cookie 或模拟 Fish 私有网页接口。

```text
ST-iPhonie / 自己的接口
          ↓ HTTP + 桥接密钥
本机/自有服务器上的 Node 适配器
          ↓ OAuth + MCP Streamable HTTP
https://api.fish.audio/mcp
          ↓ 语音生成结果
适配器校验/获取音频 → 酒馆播放
```

Fish 官方说明：MCP 使用 OAuth，授权时选择团队，调用消耗套餐 package credits 而不是 developer API credits。最终扣费与赠送 Plus 的资格以你所选团队后台为准。[官方文档](https://docs.fish.audio/overview/mcp)

## 0.1.1：删除网络硬拦截

这版默认直接使用你配置的 HTTP(S) 地址，没有“允许 HTTP”开关：

- 音频下载支持 HTTP / HTTPS、任意有效端口、回环/局域网/IPv6 地址与自定义域名；不再做公网 IP/DNS 分类白名单，也不强改协议。
- 结果中的 HTTP 音频链接可以从结构化字段、显式路径和文本中读出；下载保留签名查询字符串，正常跟随重定向。
- 可用 `FISH_MCP_ENDPOINT` 指向你控制的 HTTP(S) MCP 地址；OAuth 地址不再硬编码限定 Fish 域名。实际登录仍需要服务端正确支持 OAuth/PKCE。
- 不再限制请求 Host、网页 Origin 或管理端的来源 IP。旧 `BRIDGE_ALLOWED_HOSTS` / `BRIDGE_ALLOWED_ORIGINS` 环境变量不再参与校验。CORS 响应按请求来源返回。
- `BRIDGE_HOST` 可填任意有效监听地址；仍默认监听 `127.0.0.1`。管理/TTS API 仍要求桥接密钥，OAuth 回调仍核验 state/PKCE，切换 MCP 服务不会沿用旧服务令牌。
- 保留真实 HTTP 错误、超时、数据大小及音频内容识别，不把 HTML 错误页当音频，也没有关闭系统 HTTPS 证书验证。

### 同时修补原版 ST-iPhonie

```powershell
node .\integration\relax-network.mjs "你的 ST-iPhonie 扩展目录"
```

针对已经读取过的上游 0.7.80 代码，修改以下四个文件：

| 文件 | 改动 |
|---|---|
| `core/novelai.js` | 删除 Fish/NovelAI HTTP 中转在 HTTPS 页面下的提前拦截；更正 HTTPS-only 提示 |
| `core/image-engines.js` | 删除 GPT HTTP 中转的同类提前拦截 |
| `core/music.js` | 不再把用户填写的 HTTP 音乐链接自动改成 HTTPS |
| `core/cloud-queue.js` | 两类云端队列客户端不再限定 HTTPS |

脚本会先检查全部目标，再修改文件，原文件备份为 `*.before-network-unlock.bak`。可重复运行，保留 CRLF，不重置密钥、角色、聊天记录或服务配置。它不是完整上游源代码副本，也没有自动提交远端仓库。上游后续更新覆盖这些文件后可能需要重跑。

这是删除应用层限制，不是关闭浏览器自身的 Mixed Content/CORS。浏览器仍可能阻止 HTTPS 页面直接请求 HTTP 服务；必要时使用你已有的酒馆服务端代理或匹配的部署协议。

## 本次交付状态

- 已编写独立适配器、浏览器控制台、ST-iPhonie 预设安装器、Fork 发布助手和自动化测试。
- Fork 中的功能分支为 `feature/fish-mcp-integration`，`main` 保持不变；实际 GitHub 提交与推送以分支提交记录为准。
- 未获得你的 Fish OAuth 授权；本轮未生成真实 Fish 音频、未验证账号扣费。旧版网络诊断归档在 `evidence/archive-v0.1.0/`，不作为本轮线上测试。
- 测试内的 `generate_speech`、`get_generation`、`search_voices` 是**测试夹具**，不是声称已查明的 Fish 线上工具名。运行时读取真实 tools/list；不能唯一匹配就停下，允许手动映射。

## 1. 直接运行，不必先 Fork

要求 Node.js **22 或更新**。没有第三方 npm 依赖，不需要 `npm install`。

Windows 解压后双击 `start.cmd`，或在解压文件夹打开 PowerShell：

```powershell
node .\src\main.mjs
```

macOS / Linux：

```bash
node src/main.mjs
```

终端会显示一个控制台链接，形如 `http://127.0.0.1:3789/#key=...`。**打开完整链接，不要分享其中的桥接密钥。**

在控制台中完成（手机/反代访问见下方 BRIDGE_PUBLIC_URL）：

1. 点击「登录 Fish 官方账号」，在官方页面授权并选择赠送 Plus 所在的团队。
2. 返回后点击「读取 MCP 工具与参数」。这一步只读取工具，不生成音频。
3. 音色先填 `default`、语言填 `zh`、模型留空，点击「生成试听」。**这一步会提交生成并使用网页套餐积分。**

保存授权成功与生成成功是两回事；只有收到并识别为音频的返回才算配音成功。若 Fish 的注册策略、权限、Schema 与本实现不兼容，界面会报具体阶段，不会显示假成功。

> MCP 桥接不需要再运行 Codex 或 Claude，也不需要额外大语言模型做工具选择。但适配器本身必须在你自己的电脑或服务器上持续运行；它不是托管服务，ChatGPT 不替你维持这个进程。

## 2. 接入现有 ST-iPhonie

### 最少改动：直接填「自己的接口」

在小手机「引擎 → 语音 → 自己的接口」设置：

| 字段 | 值 |
|---|---|
| 接口地址 | `http://127.0.0.1:3789/v1/audio/speech` |
| 请求方式 | `POST` |
| 密钥 | 本机控制台中的**桥接密钥**，不是 Fish API Key |
| 回答是什么 | 音频本身 |
| 音色列表地址 | `http://127.0.0.1:3789/voices` |
| 列表路径 | `voices` |

请求体：

```json
{
  "model": "fish-mcp",
  "input": "{{text}}",
  "voice": "{{voice}}",
  "language": "{{lang}}",
  "emotion": "{{emotion}}"
}
```

然后新增一个名为「Fish 默认音色」、音色值为 `default` 的音色，把角色引擎切换为「自己的接口」并选择它。也可把音色值改为自己的 Fish 音色 ID。`default` 是本桥接器的约定，会被省略，让服务端按语言选择音色。

`fish-mcp` 也是本桥接器标记，不是虚构的 Fish 模型名称；它不被当作模型参数发给服务端。指定真实模型时填服务端支持的名称。**中文音色名、中文模型 ID 原样保留**，不会做 ASCII 过滤，但服务端自身仍可能限定可用 ID。

`integration/st-iphonie-settings.json` 仅是这些字段的参考，不是整个插件备份，不能拿它覆盖酒馆设置。

### 添加一键格式入口（可选）

```powershell
node .\integration\install-template.mjs "E:\SillyTavern\public\scripts\extensions\third-party\ST-iPhonie"
```

换成你实际的扩展文件夹。该脚本只给 `core/custom-voice.js` 的 `CUSTOM_TEMPLATES` 加一个 `Fish MCP（网页套餐积分）` 入口；会在原文件旁保留 `.before-fish-mcp.bak`。重复执行不会重复添加，遇到上游结构变化会拒绝盲改。它不改原来的 Fish 引擎、不覆盖密钥与聊天记录。

安装后刷新酒馆，到「自己的接口 → 一键格式」选 Fish MCP。原插件的普通更新可能覆盖此本地改动，届时可再次执行安装器，或使用自己的 Fork。

## 3. Fork 与发布

附带本机辅助发布脚本，优先使用 GitHub 功能分支。脚本需在你自己的电脑运行，使用已登录的 GitHub CLI `gh` 与 `git`；不会要求把 GitHub Token 发给 ChatGPT。

先检查/登录：

```powershell
gh auth status
# 只有尚未登录时才运行：
# gh auth login
```

执行只读预览：

```powershell
node .\scripts\fork-publish.mjs
```

确认要实际创建/修改你的 Fork 后运行：

```powershell
node .\scripts\fork-publish.mjs --publish
```

发布脚本会核对当前账户是 **Zis30axs**，创建或复用其 `hey8v0/ST-iPhonie` Fork，核对父仓库，再克隆到新的 `ST-iPhonie-fish-mcp-fork` 文件夹。随后添加适配器目录和模板入口，运行本地测试，通过后提交并推送到 **Fork 的 `feature/fish-mcp-integration` 分支**。不会修改上游，不会自动向上游发 PR，不会 force-push。已有目标目录或已有适配器实现时会停止，避免覆盖。

可另选本地克隆目录：

```powershell
node .\scripts\fork-publish.mjs --publish --destination=E:\ST-iPhonie-fish-mcp-fork
```

只有脚本最后明确打印 `Published to ...` 才表示推送完成；脚本失败不等于 Fork 完全没有创建，要看它停在哪一步。

## 4. 手机、局域网与自有服务器

手机上的 `127.0.0.1` 是手机，不是电脑。默认只监听本机；要让手机访问电脑，可在 PowerShell 中：

```powershell
$env:BRIDGE_HOST = "0.0.0.0"
$env:BRIDGE_PUBLIC_URL = "http://192.168.1.10:3789"
node .\src\main.mjs
```

把 IP 换成电脑实际 IP。酒馆接口地址改为 `http://电脑IP:3789/v1/audio/speech`。来源/Host 不再需要白名单；管理端也允许带正确密钥的局域网访问。`BRIDGE_PUBLIC_URL` 用于控制台提示及 OAuth 回调；反向代理部署时填浏览器实际访问到的外部地址。OAuth 服务端是否接受这个回调仍由服务端决定，也可用 `FISH_OAUTH_REDIRECT_URI` 单独指定。

自有 MCP 反代示例：

```powershell
$env:FISH_MCP_ENDPOINT = "http://192.168.1.10:9000/mcp"
```

只向你信任的 MCP/授权服务发送登录数据。HTTP 是明文传输，桥接密钥、授权数据或文本可能被所在网络上的攻击者读取；不要把服务无保护地暴露到公网。默认官方地址仍为 HTTPS。

本轮测试验证了同一运行环境内的真实 HTTP 局域网接口访问；并未在你的手机、Docker 或 VPS 上部署。浏览器混合内容或第三方 CORS 限制不能通过删 JavaScript 校验自动解决。ST-iPhonie「自己的接口」已有酒馆服务端代理回退路径，是否可用取决于你的酒馆设置与部署。

## 5. 真实 Schema 变化时如何调整

控制台会展示真实 `tools/list`。自动检测只支持可明确识别的语音生成/查询工具。高级配置中：

```json
{
  "speech": {
    "tool": "从真实列表复制语音工具名",
    "fields": {
      "text": "实际文本字段路径",
      "voice": "实际音色字段路径"
    },
    "extra": {},
    "resultPath": "",
    "pollTool": "",
    "pollIdField": "",
    "pollIdPath": "",
    "pollExtra": {},
    "pollResultPath": ""
  },
  "voiceTool": "",
  "voiceFields": {},
  "voiceExtra": {},
  "voiceResultPath": "",
  "voices": []
}
```

这是说明模板，**不要原样保存这些中文占位符**。默认配置的 `tool`、`fields` 都是空的，表示先自动识别。

字段路径支持点分隔嵌套，如 `request.text`。`extra` 用来填写服务端要求而无法自动识别的固定字段。可映射 text、voice、language、model、emotion、format、speed。未识别到独立情绪字段时，把情绪写成 Fish 文档支持的方括号标签。

`resultPath` 相对于 `structuredContent` 或 text 块中的 JSON；例如真实结果是 `{"asset":{"url":"https://..."}}`，就填 `asset.url`。异步任务可配置只读查询工具与 ID 字段。已经拿到的任务/结果会保留在当前进程内，调整查询映射不会重新提交相同的合成参数。

内置 Schema 检查覆盖常见类型、必填项、枚举、数值/长度限制与本地 `$ref`；它不是完整 JSON Schema 验证器，不执行远端正则，不下载远端 Schema。未知复杂约束由服务端验证，不声称支持所有 MCP 功能。原生 MCP Tasks/elicitation/sampling 不在本版实现范围，异步生成通过普通查询工具处理。

## 6. 额度、重试与缓存

生成请求遇到网络错误、429、5xx 或工具错误时，不自动重发。只有明确的 HTTP 401 拒绝会尝试刷新 OAuth 后重试一次。无法保证超时请求没有在远端生成/计费，因此不要盲目连续点生成。

相同工具及参数的并发请求共享同一次生成。成功音频有最多 64 MiB / 100 项、30 分钟的内存缓存；ST-iPhonie 自己的缓存独立存在。没有持久化的跨重启去重保证。已知未完成任务保留在内存；**重启进程会丢失任务记录，再点生成可能重新扣费**。

桥接器保留服务端实际返回的音频格式，不提供转码或实时分块播放。收到完整音频后才返回给酒馆。默认不指定 `response_format`，避免把 WAV 假标为 MP3。

## 7. 密钥和安全边界

授权数据默认保存在用户主目录 `.st-iphonie-fish-mcp/state.json`，不在代码目录中。内含 OAuth 令牌与桥接密钥，**不要上传或粘贴给别人**。POSIX 下文件权限设为 0600，新建数据目录为 0700；Windows 请保护好当前用户目录访问权限。令牌不是加密保险库，也未经过专业安全审计。

桥接密钥与 Fish OAuth 令牌分离，音频下载不自动附带二者。授权令牌只发给当前配置的 MCP/授权端点，切换 MCP 地址需重新登录。下载端已移除协议强制升级、端口和内网地址白名单；来源/Host/IP 不再设硬拦截。默认本机监听，保留鉴权、请求大小、超时与音频识别。

测试目录的 `localhost-test.key` / `.crt` 是公开的本地测试证书，不是用户或线上服务的密钥，不能用于正式部署。

`.env.example` 不会自动加载。需要环境文件时复制为 `.env`，再用 `node --env-file=.env src/main.mjs`。源码 `.gitignore` 排除了常见敏感文件；Fork 发布脚本只复制固定代码路径，但这不替代你发布前自己的检查。

## 8. 验证与诊断

```powershell
npm test
npm run doctor
```

`npm test` 完全本地，使用本地 HTTP/HTTPS 服务、假的授权服务、假的 MCP 工具和合成测试波形，不访问 Fish、不生成真实配音。`doctor` 尝试读取真实 OAuth 元数据；已授权时读取工具列表，不提交生成，不输出令牌。

本轮 55 项本地测试通过，包括真实本地 HTTP/HTTPS 下载、局域网访问与模拟 OAuth/MCP。没有真实 Fish 授权/配音/扣费验证。报告及原始输出见 `TEST-REPORT.md` 和 `evidence/test-results.txt`。旧版诊断仅作历史归档。

## 参考

- Fish MCP： https://docs.fish.audio/overview/mcp
- MCP OAuth： https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization
- 上游项目： https://github.com/hey8v0/ST-iPhonie
- 检查过的模板入口：`core/custom-voice.js`，读取时 blob SHA `e4865beaaf995e2cfc6e78ba81f5bce3e555bf01`。

这是为本次需求编写的独立实验实现，不是 Fish Audio 官方客户端，也不是 ST-iPhonie 上游发布的正式功能。
