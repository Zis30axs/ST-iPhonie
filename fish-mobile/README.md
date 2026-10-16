# Fish MCP · iPhone 直连实验 v0.1.1

入口：TauriTavern 的扩展设置 → ST-iPhonie → **Fish iPhone 直连实验**。

这个入口不运行 Node、不连接自建桥接器，不需要电脑常驻或修改 IPA。它在扩展前端发出标准 OAuth/MCP HTTP 请求。**实现完成不等于真实 Fish 授权已经通过**：服务端回调注册策略、WebView CORS、Safari 失败跳转后的地址复制行为仍待真机验证。

## 手机测试

1. 更新 `feature/fish-mcp-integration` 分支并完整重启 TauriTavern，打开上面的入口。
2. 点击“生成登录链接”；复制到 Safari 或点击“在浏览器打开”。在 Fish 官方页面登录并选择有 Plus 的团队。
3. 授权后复制包含 `code` 和 `state` 的完整回调 URL，回到实验入口粘贴，点击“交换令牌”。默认回调是 `http://127.0.0.1:3789/oauth/callback`，**手机上没有监听服务器**；这是手动接收流程，不是让你启动 localhost 服务。若地址栏没有 code/state，或 Fish 拒绝该 redirect_uri，就尚未完成此步。
4. 点击“读取工具”，选择真实的语音合成工具；音色先用 `default`、语言 `zh`、模型留空，点击“生成试听”。仅此按钮会调用所选工具，可能消耗套餐积分。工具名和参数来自真实 tools/list，不硬编码假工具名。

播放器能实际解码/播放才说明音频链路通过；Plus 积分扣费要在所选团队后台核对。异步任务若尚无音频链接会明确停下，不自动重新生成。

## 保留与改变

- `mobile-entry.js` 包装原有生命周期，原 `index.js` 不改写；新增入口挂到原 ST-iPhonie 扩展设置里。
- 原来的 Node MCP 桥接器与原角色配音预设全部保留。**本轮只是手机直连验证入口，尚未自动接管角色配音。**不要把此实验入口和原本填写 `127.0.0.1:3789` 的 Node TTS 预设混用。
- 前端允许显式配置 HTTP(S)、自定义端口和自己的 MCP 服务；不做域名白名单、HTTPS-only 拦截、中文模型 ID 过滤、猜测式服务端枚举验证。
- OAuth 的 state、S256 PKCE、issuer/resource、回调匹配仍保留；不使用其他客户端身份或 Cookie。
- 网络请求直接尝试，按实际阶段报告错误。不声称删除 JavaScript 校验能解除 WebView CORS。没有 `no-cors` 假成功或失败后偷换代理重发。
- OAuth challenge/verifier/state 在跳 Safari 前写入本机网站存储，关闭窗口或重建 WebView 后仍可读取；默认有效期十分钟。
- 回调提交即标记已尝试；网络中断后不会自动重放授权码。令牌过期时尝试刷新，已返回成功的刷新令牌保存到本机。
- 相同已成功试听在当前客户端实例内复用音频。结果未知的生成标记保留到本机存储，避免 App 刷新后自动重复扣费。手动清除前先核对 Fish 历史记录。

## 数据与网络边界

登录数据位于这个 App/origin 的 localStorage，键为 `st-iphonie.fish-mobile.v1`。不写入原插件配置或常规设置备份，不提供令牌导出；但**这不是 Keychain/加密保险库**，同源扩展代码和完整 App 数据备份可能接触到它。仅使用可信扩展。清除本机授权不等于向 Fish 撤销授权。

音频 URL 直接交给 `<audio>`；不向音频 CDN 附加 OAuth Bearer。若 WebView 无法获取或解码，界面显示播放失败。复制诊断只包含阶段、状态和工具名，不包含回调、令牌、登录链接、试听文字。

默认 Fish 端点使用 HTTPS。高级参数只有在你信任对应服务时才修改；HTTP 是明文。修改连接参数会丢弃之前保存的授权，避免把旧令牌发送到新服务。

## 验证

在开发环境运行：

```sh
node --test fish-mobile/test/client.test.mjs
```

本轮 **24 项客户端测试通过**，覆盖真实 Web Crypto S256、回调匹配/重放、模拟 WebView 重建、令牌刷新、HTTP 自定义端口、MCP JSON/SSE 与分页、中文参数、结果未知不重试，以及一个真实本地 HTTP 测试服务的 PKCE/form/resource 校验。

另有 **11 项离线 Chromium 移动视口 UI 检查通过**。这些 UI 检查 mock 了 fetch、存储和 digest，只验证界面交互和合成测试 WAV 解码，不证明 Safari 或 Fish 线上兼容。浏览器直接访问本地 HTTP 测试页被运行环境管理员策略阻止，未更改该策略。容器无法解析外网 GitHub/Fish 域名，GitHub 发布使用连接器；线上 Fish 元数据也未能通过网页工具读取。

没有使用用户账号授权，没有生成真实 Fish 语音，没有验证 Plus 扣费。

## 依据

- Fish 官方 MCP（OAuth、套餐积分、默认音色与音频链接）：https://docs.fish.audio/overview/mcp
- MCP 2025-06-18 OAuth/PKCE 与 resource 规范：https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization
- TauriTavern 宿主契约（移动端外部浏览器）：https://github.com/Darkatse/TauriTavern/blob/main/docs/FrontendHostContract.md

这是此 Fork 的实验实现，不是 Fish Audio 或 TauriTavern 官方功能；不更改上游许可证状态。

## 0.1.1：Safari 显示 client_id and redirect_uri are required

「生成登录链接」会先校验完整 OAuth 授权 URL，确认 client_id、redirect_uri、state、PKCE 必要参数均存在且不重复。现在也可以点「校验链接参数」。点击复制或浏览器打开之前都会校验，切回 App 后可恢复有效期内的完整 URL。

如果校验通过，但 Safari 仍提示缺少这两个参数，建议用「复制登录链接」，把整个 URL 粘贴 Safari 地址栏；如果仍失败，可能是授权端点的重定向链丢失参数，或 Fish 对动态客户端的注册要求。请只提供页面错误文字或「复制脱敏诊断」，不要发原始授权链接、回调 URL、Token。

本次只是客户端前置诊断和链接恢复改进，尚未证明 Fish iOS OAuth 真机登录成功。