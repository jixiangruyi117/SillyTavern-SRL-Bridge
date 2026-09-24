# SRL 酒馆资源库互传

这是 [SillyTavern](https://github.com/SillyTavern/SillyTavern) 与 SRL 酒馆资源库之间的第三方互传扩展，不是 SillyTavern 官方组件。

本 README 由 AI 辅助整理，并已尽量依据当前源码、测试和 SillyTavern 验证记录核对。若发现表述不准确、内容遗漏或容易产生误解，请通过 [GitHub Issues](https://github.com/jixiangruyi117/SillyTavern-SRL-Bridge/issues) 告知维护者，以便按照实际实现修正。

聊天归档需要配套 SRL 资源库更新到支持接收和阅读酒馆聊天归档的版本。其余资源互传功能按下文所列方式使用。
## 可以互传哪些资源

| 资源 | 说明 |
| --- | --- |
| 角色卡 | 传输角色卡 JSON 与 PNG 图片。 |
| 世界书 | 传输酒馆世界书。 |
| 当前 API 类型预设 | 传输预设及其酒馆数据。 |
| 正则 | 全局、角色卡、预设三个作用域分别传输，不混写作用域。 |
| 快速回复 | 传输快速回复组。 |
| 主题 | 传输酒馆主题。 |
| 用户人设 | 传输人设数据及对应头像。 |
| 酒馆助手脚本 | 支持全局、角色卡、预设作用域，保留脚本/文件夹结构；导入后默认停用，需在酒馆助手中手动启用。 |
| 已保存的单角色聊天（本地候选） | 按需读取单角色 JSONL，随附实际所属角色卡 PNG，以及全局和当前所选预设中的 Markdown 显示正则快照与启用状态。群聊和聊天目录扫描不支持。 |

导入普通资源时可按资源类型选择副本、跳过或覆盖；覆盖前会要求确认。聊天归档按聊天原件和角色绑定去重，不会改动酒馆内已有聊天。

## 连接和传输方式

实时互传和加密暂存是两种传输方式；同浏览器配对、设备码、本机 APK 连接是建立实时连接的路径。

| 方式 | 适合场景和设备 | 操作 |
| --- | --- | --- |
| 同一浏览器实时配对 | 电脑或手机上，SRL 与 SillyTavern 使用同一个浏览器配置文件。 | 在酒馆扩展填写 SRL 地址并点“打开并配对”；核对双方六位确认码，然后在 SRL 选择资源和传输方向。 |
| HTTPS 设备码实时连接 | 不同浏览器、电脑与手机、iOS、TauriTavern；也适合无法同浏览器打开两端的场景。 | 在酒馆扩展生成设备码；在能访问同一 SRL HTTPS 服务的另一端打开“功能 → 酒馆互传”，输入设备码并核对确认码，再选择资源和方向。TauriTavern 使用此方式，不需要 SillyTavern Node 服务端插件。 |
| Android APK 跨设备连接 | 自行构建的 Android APK 连接另一台设备上的 SillyTavern。 | 与 HTTPS 设备码实时连接相同；APK 和酒馆都要能访问已部署的 HTTPS SRL 中继。 |
| Android APK 本机直连 | APK 与普通 SillyTavern 酒馆都运行在同一台 Android 设备，酒馆地址为 `http://127.0.0.1:8000`。 | 在 APK 点“发现并连接本机酒馆”；切回酒馆扩展点“允许本机 APK 连接”，之后按页面提示继续。此方式需要酒馆端服务端插件。 |
| 加密暂存 | 两端不能同时在线，或希望先发送、稍后在另一台设备领取；适合手机、iOS、TauriTavern 等浏览器。 | 在发送端打开“加密暂存”，选择“发给资源库”，读取并勾选资源，点“暂存所选资源”；复制 `SRL1` 口令后可切换设备。在接收端选择“从资源库领取”，输入口令并点“领取并校验”，检查清单后确认导入。双方需填写同一个已部署的 HTTPS SRL 地址。 |

### 实时互传的操作

1. 在酒馆扩展设置中展开“SRL 酒馆互传”，填写 SRL 地址。
2. 同一浏览器点“打开并配对”；跨浏览器或设备点“生成跨浏览器设备码”，再到 SRL 的“功能 → 酒馆互传”加入。
3. 核对六位确认码。连接成功后，在 SRL 选择从酒馆取回或发送到酒馆、选择资源并处理同名冲突。

普通 SillyTavern 的 HTTPS 设备码中继不可用时，可回退到酒馆服务端插件。TauriTavern 不支持该插件回退；请使用可用的 HTTPS SRL 中继。

### 加密暂存的操作

1. 两端都填写同一个已部署的 HTTPS SRL 地址。
2. 发送端在酒馆扩展中打开“加密暂存”，选择“发给资源库”，读取资源并勾选要发送的项目。
3. 点发送并等待暂存完成，复制 `SRL1` 口令。暂存完成后可以关闭发送端或切换设备。
4. 接收端打开同一功能，选择“从资源库领取”，输入口令并点“领取并校验”，检查清单。
5. 确认导入并选择冲突处理方式。

暂存内容由客户端分块加密，解密密钥不发送给中继。每次最多 100 项、总计 16 MiB，口令 30 分钟后过期；超过限额时改用实时互传。中继只暂存加密内容，部署者仍应保护口令，拿到完整口令的人可以领取对应暂存。

### 聊天归档候选的操作

配套资源库需要支持接收和阅读酒馆聊天归档。实时连接时，在 SRL 互传页读取聊天记录；分开操作时，在酒馆扩展的加密暂存面板选择“发给资源库”，读取聊天并勾选后发送。每条聊天单独归档，列表显示角色并支持搜索。

归档包含原始 JSONL、实际所属角色卡 PNG，以及全局和当前所选预设的 Markdown 显示正则快照及开关状态；不包含完整预设或账号配置。聊天和角色 PNG 没有单独的 64/16 MiB 限额，合成的归档按通用单文件 256 MiB 上限传输。加密暂存仍是每次合计 16 MiB，因此较大的聊天请使用实时互传。读取过程不会保存、删除、切换或回写酒馆聊天。0.3.36-chat.4 新增显式回传：资源库默认只传 JSONL，可选配套正则，发送前确认接收头像文件；酒馆按新记录导入，不切换当前聊天。配套正则追加为停用的角色规则副本，原规则保留。加密暂存领取也会再次确认目标。真实 SillyTavern、TauriTavern 和实体手机的完整互传仍待验收。

## 安装页面扩展

在 SillyTavern 中打开“扩展 → 安装扩展 → 输入 Git 仓库 URL”，粘贴：

```text
https://github.com/jixiangruyi117/SillyTavern-SRL-Bridge.git
```

确认第三方扩展安全提示，等待安装完成并刷新酒馆。Git 安装只安装页面扩展；同一浏览器实时配对不需要服务端插件。

如果出现“扩展程序安装失败”：

1. 打开“扩展 → 管理扩展”，搜索 `SRL 酒馆互传`。如果已经存在，说明前面安装已经完成；不要重复安装，刷新酒馆即可。
2. 如果同时看到两份 SRL 扩展，保留带 Git 更新按钮的一份，删除旧的手动安装副本后刷新。
3. 安装时确认 GitHub 在当前网络可访问，并且只粘贴上面的 `.git` 地址。
4. 如果 SillyTavern 服务端返回 `Directory already exists`，表示安装目录已存在；先在扩展管理中更新或删除旧版本，不要连续点击安装。

## 手机或不同浏览器：推荐 HTTPS 设备码

设备码由 SRL 的 HTTPS 服务端内存中继承载。正常使用只需安装页面扩展，并把扩展中的 SRL 地址填写为已部署的 HTTPS 资源库地址；手机不需要访问 SillyTavern 的本机 HTTP 地址，也不需要打开中继窗口。

1. 在酒馆扩展中点击“生成跨浏览器设备码”。
2. 在另一浏览器或手机打开 SRL，进入“功能 → 酒馆互传”并输入设备码。
3. 核对六位确认码，然后选择资源和传输方向。

TauriTavern（含 iOS）使用 HTTPS 设备码，不调用 SillyTavern Node 服务端插件。普通 SillyTavern 在中继不可用时可以使用下方的服务端插件兼容回退。

## 服务端插件

HTTPS 设备码中继正常工作时，普通 SillyTavern 的跨设备连接也无需服务端插件。插件用于普通 SillyTavern 的兼容回退，以及同一 Android 设备上 APK 与 `127.0.0.1:8000` 酒馆的本机直连。TauriTavern 不运行该插件。

从[最新 Release](https://github.com/jixiangruyi117/SillyTavern-SRL-Bridge/releases/latest)下载 `srl-bridge-server-plugin-v*.zip`，或下载包含扩展和插件的 `srl-bridge-complete-v*.zip`。关闭 SillyTavern，解压后将 `srl-bridge` 文件夹放到 `SillyTavern/plugins/srl-bridge`，确认最终文件为 `plugins/srl-bridge/index.mjs`；在 `config.yaml` 中启用 `enableServerPlugins: true`，然后重启 SillyTavern。

确认日志中出现 `[SRL Bridge] Short-lived device relay loaded` 即加载成功。服务端插件下载直达：[打开最新 Release](https://github.com/jixiangruyi117/SillyTavern-SRL-Bridge/releases/latest)。

### Windows 一键安装服务端插件

酒馆助手和其他页面扩展运行在浏览器中，没有权限写入 `SillyTavern/plugins` 或修改 `config.yaml`，不能代装服务端插件。Windows 用户可以先下载并检查安装脚本，再在脚本所在目录打开 PowerShell（不是 CMD）运行。脚本会搜索当前目录、桌面、文档、下载目录和常见磁盘位置中的 SillyTavern；发现多个安装时会让你选择。

```powershell
powershell -ExecutionPolicy Bypass -File .\install-server-plugin.ps1
```

仓库中的脚本路径是 [`scripts/install-server-plugin.ps1`](scripts/install-server-plugin.ps1)，也可以[直接下载脚本](https://raw.githubusercontent.com/jixiangruyi117/SillyTavern-SRL-Bridge/main/scripts/install-server-plugin.ps1)。它直接下载 `index.mjs` 和 `relay.js`，Raw GitHub 失败时使用 jsDelivr；写入前检查文件标识和 Node 语法，也支持用 `-PackagePath "本地服务端包.zip"` 安装离线包。更新失败时会恢复旧插件；成功后默认清理临时备份。脚本不会启动或关闭酒馆，安装后需要完全重启 SillyTavern。

自动识别失败时，可以显式指定自己的安装路径：

```powershell
powershell -ExecutionPolicy Bypass -File .\install-server-plugin.ps1 -SillyTavernPath "E:\你自己的目录\SillyTavern"
```

熟悉 PowerShell 并确认信任仓库后，也可以下载后直接运行脚本：

```powershell
$code = Invoke-RestMethod "https://raw.githubusercontent.com/jixiangruyi117/SillyTavern-SRL-Bridge/main/scripts/install-server-plugin.ps1"
& ([scriptblock]::Create($code))
```

### Android / Termux、Linux 与 macOS

只有在 Termux 内实际运行 SillyTavern 时，才需要在 Android 上安装服务端插件。通过 iPhone/iPad 浏览器访问其他设备上的酒馆时，应在运行酒馆的电脑或服务器安装；TauriTavern 不运行 Node 服务端插件。

Termux 可先安装 curl，再运行自动识别安装脚本：

```bash
pkg install curl -y
bash <(curl -fsSL https://raw.githubusercontent.com/jixiangruyi117/SillyTavern-SRL-Bridge/main/scripts/install-server-plugin.sh)
```

脚本会优先识别常见的 `~/SillyTavern`，多份安装时会让你选择；下载并校验新插件后再替换旧版，失败时恢复旧插件。Linux 和 macOS 同样可用。也可以下载脚本后手动指定路径：

```bash
bash install-server-plugin.sh --path "/你自己的路径/SillyTavern"
```

不希望直接运行联网脚本时，请先下载并检查内容，或手动安装 ZIP。服务端插件拥有与 SillyTavern 服务端相同的本机权限。

## 限制与安全

- 页面扩展适配 SillyTavern 1.18.x；实时传输单文件上限 256 MiB，采用分块传输与 SHA-256 校验。
- HTTPS 设备码要求酒馆和 SRL 都能访问同一已部署 `/api/bridge` 服务。纯静态站点没有中继接口。
- 设备码短时有效；配对仍要求用户核对确认码。互传不会后台自动同步，也不会自动删除对端资源。
- 上传、领取及导入需要应用保持打开。暂存可让两端分开操作，但不保证应用被系统结束后的字节级续传。
- 脚本导入后保持停用。主题列表或部分第三方扩展面板可能需要重新打开或刷新。
- 聊天归档候选不支持群聊、遍历聊天目录或把聊天写回酒馆。

## 开发

```bash
npm install
npm run check
```

生成发布包：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/package-release.ps1
```

## 许可证

本项目采用 **PolyForm Noncommercial License 1.0.0**，SPDX 标识为 `PolyForm-Noncommercial-1.0.0`。本许可授权非商业用途下的使用、复制、修改和分发；商业使用、收费分发、商业整合以及带有预期商业应用的使用不在授权范围内。该协议属于源码可用的非商业软件许可，不是 OSI 批准的开源许可证。完整条款见根目录 [LICENSE](LICENSE)。第三方依赖及 SillyTavern 本体仍分别遵循各自的许可证。

## 更新记录

- **0.3.36-chat.4（未发布候选）**：聊天归档不再设 64 MiB 聊天或 16 MiB 角色卡专用上限，整个归档沿用 256 MiB 单文件限制；加密暂存仍限每批 16 MiB。
- **0.3.36-chat.2 / .1（未发布候选）**：新增单角色聊天归档，随附角色卡 PNG 和显示正则快照；支持搜索、重复接收去重，不写回酒馆聊天。
- **0.3.35**：增加加密暂存和稍后领取，补齐用户人设互传；保留实时设备码连接与 Android 本机 APK 直连。
