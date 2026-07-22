# SRL 酒馆互传安装说明

页面扩展也可以直接在 SillyTavern 的“安装扩展”中粘贴以下地址：

`https://github.com/jixiangruyi117/SillyTavern-SRL-Bridge`

## 先选你需要的模式

- 只在同一个浏览器里使用：只安装“酒馆页面扩展”即可。
- 手机、不同浏览器或未来 APK 互传：酒馆页面扩展和设备码服务端插件都要安装。

## 一、安装酒馆页面扩展

1. 关闭 SillyTavern。
2. 解压 `srl-bridge-extension`。
3. 将里面的 `srl-bridge` 整个文件夹复制到：
   `SillyTavern/data/default-user/extensions/srl-bridge`
4. 启动 SillyTavern，在扩展设置里找到“酒馆资源库互传”。

如果使用的不是 `default-user`，请把路径中的用户名替换成当前酒馆用户目录。

## 二、安装设备码服务端插件

服务端插件具有和 SillyTavern 服务端相同的本机权限，只应安装来自项目官方发布页的版本。

1. 关闭 SillyTavern。
2. 解压 `srl-bridge-server-plugin`。
3. 将里面的 `srl-bridge` 整个文件夹复制到：
   `SillyTavern/plugins/srl-bridge`
4. 用文本编辑器打开 `SillyTavern/config.yaml`。
5. 找到 `enableServerPlugins: false`，改成 `enableServerPlugins: true`。
6. 重新启动 SillyTavern。启动日志出现 `[SRL Bridge] Short-lived device relay loaded` 即安装成功。

服务端插件不能由浏览器页面扩展自动安装，这是为了避免第三方前端扩展越权写入 SillyTavern 服务端目录。更新时请从 GitHub 最新 Release 重新下载并覆盖这两个文件。

## 三、跨浏览器连接

1. 在酒馆扩展设置中填写 SRL 地址，点击“生成跨浏览器设备码”。
2. 在手机或另一浏览器打开 SRL，进入“功能 → 酒馆互传”。
3. 填写酒馆地址和八位设备码。
4. 核对两边六位确认码，再允许连接。

设备码两分钟内有效，连接最长三十分钟；服务重启后立即失效。中继不会把资源文件保存到酒馆服务器磁盘。

## 常见问题

- 手机不能使用 `127.0.0.1`，应填写电脑的局域网地址，例如 `http://192.168.1.10:8000`。
- 公网部署必须使用 HTTPS，并保留 SillyTavern 自身的登录或访问控制。
- 只部署 SRL 到 Netlify 不会自动安装酒馆插件；插件必须安装到运行 SillyTavern 的设备或服务器。
