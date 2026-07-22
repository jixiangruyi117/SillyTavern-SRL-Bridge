# SRL 酒馆互传扩展

适配 SillyTavern 1.18.x 的本地桥接扩展。第一版支持角色卡、世界书和当前 API 类型预设与 SRL 双向传输。

## 安装

把本目录复制到当前酒馆用户的 `extensions/srl-bridge`，重新加载 SillyTavern，然后在“扩展”设置中找到“酒馆资源库互传”。开发机当前安装位置为：

`D:\SillyTavern\SillyTavern\data\default-user\extensions\srl-bridge`

填入 SRL 地址，点击“打开并配对”，核对两端六位数字后才会建立本次连接。关闭桥接窗口或刷新酒馆后，授权立即失效。

手机端同样可以传输，但手机必须能同时访问酒馆和 SRL。不要在手机上填写 `127.0.0.1`：本地开发应在电脑运行 `pnpm dev:lan`，再填写电脑局域网 IP；已部署时直接填写 SRL 的 HTTPS 地址。扩展设置采用酒馆原生折叠面板，窄屏按插件容器宽度自动重排。

## 通信与安全

- SillyTavern 1.18.0 使用 `Cross-Origin-Opener-Policy: same-origin`，扩展因此先打开同源 `bridge.html`，再在其中嵌入 SRL 并转交 `MessageChannel`。中继只接受配置中的精确 SRL 来源。
- 不读取或写入酒馆数据目录，角色卡、世界书、预设均调用 SillyTavern 当前页面公开上下文或官方接口。
- 文件按 256 KiB 分块，接收端校验声明大小与 SHA-256；第一版单文件上限为 256 MB。
- 同名资源可选择保留副本、跳过或覆盖；覆盖前由 SRL 再次确认。

## 当前边界

- 正则、快速回复、主题与酒馆助手脚本尚未接入。
- 这是用户主动触发的单次互传，不是后台实时同步。
- SRL 页面必须允许被扩展中继页嵌入；项目自带的 Netlify 配置没有禁止嵌入。
- 不应把 SillyTavern 服务端口直接暴露到公网。

## 验证

```bash
npm run check
```

真实联调脚本为 `tests/bridge.e2e.mjs`，凭证仅从运行时环境变量读取，不写入仓库。
