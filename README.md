# SRL 酒馆互传扩展

适配 SillyTavern 1.18.x 的桥接扩展。支持角色卡、世界书、当前 API 类型预设、快速回复组、酒馆主题，以及全局、角色卡、预设三种作用域正则与 SRL 双向传输。

## 安装

把本目录复制到当前酒馆用户的 `extensions/srl-bridge`，重新加载 SillyTavern，然后在“扩展”设置中找到“酒馆资源库互传”。开发机当前安装位置为：

`D:\SillyTavern\SillyTavern\data\default-user\extensions\srl-bridge`

同一浏览器可点击“打开并配对”。跨浏览器或未来 APK 可点击“生成跨浏览器设备码”，再到 SRL 的酒馆互传页填写当前酒馆地址与八位设备码。设备码两分钟内有效，连接最长保留三十分钟，服务重启后立即失效。

跨浏览器功能还需将 `server-plugin` 安装到 SillyTavern 的 `plugins/srl-bridge`，在 `config.yaml` 启用 `enableServerPlugins: true` 后重启酒馆。中继仅在当前酒馆会话内转发数据块，不把资源写入酒馆服务器磁盘；公网部署时仍必须使用 HTTPS。

手机端同样可以传输，但手机必须能同时访问酒馆和 SRL。不要在手机上填写 `127.0.0.1`：本地开发应在电脑运行 `pnpm dev:lan`，再填写电脑局域网 IP；已部署时直接填写 SRL 的 HTTPS 地址。扩展设置采用酒馆原生折叠面板，窄屏按插件容器宽度自动重排。

## 发布给用户

运行 `powershell -ExecutionPolicy Bypass -File scripts/package-release.ps1` 会在 `release` 生成三种包：

- `srl-bridge-extension-v0.3.0.zip`：仅酒馆页面扩展，同浏览器互传使用。
- `srl-bridge-server-plugin-v0.3.0.zip`：仅设备码服务端插件。
- `srl-bridge-complete-v0.3.0.zip`：完整包，包含两者和中文安装说明，推荐普通用户下载。

SRL 网站的“功能 → 酒馆互传”页已内置这三个下载入口；部署 `dist` 后会一起发布。也可以把相同文件上传到项目的 GitHub Releases。服务端插件不能由 Netlify 代替，必须由用户安装到实际运行 SillyTavern 的电脑或服务器。

## 通信与安全

- SillyTavern 1.18.0 使用 `Cross-Origin-Opener-Policy: same-origin`，扩展因此先打开同源 `bridge.html`，再在其中嵌入 SRL 并转交 `MessageChannel`。中继只接受配置中的精确 SRL 来源。
- 不读取或写入酒馆数据目录，资源通过 SillyTavern 当前页面公开上下文或官方接口处理。
- 文件按 256 KiB 分块并逐块确认，接收端校验声明大小与 SHA-256；单文件上限为 256 MB。
- 设备码中继采用短期随机令牌、酒馆用户隔离、加入限速和 2 MiB 内存队列上限，不保存传输文件。
- 同名资源可选择保留副本、跳过或覆盖；覆盖前由 SRL 再次确认。

## 当前边界

- 酒馆助手脚本尚未接入；快速回复已接入，角色卡与预设正则会按所属对象传输。
- 跨设备访问仍要求设备能访问同一个 SillyTavern 地址；公网使用必须配置 HTTPS 和访问控制，不应裸露酒馆端口。
- 这是用户主动触发的单次互传，不是后台实时同步。
- SRL 页面必须允许被扩展中继页嵌入；项目自带的 Netlify 配置没有禁止嵌入。
- 不应把 SillyTavern 服务端口直接暴露到公网。

## 验证

```bash
npm run check
```

真实联调脚本为 `tests/bridge.e2e.mjs`，凭证仅从运行时环境变量读取，不写入仓库。
