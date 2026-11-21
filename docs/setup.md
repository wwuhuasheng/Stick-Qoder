# 安装与配对

## 准备

- M5StickS3、USB 数据线，以及与 Mac 互通的 2.4 GHz Wi-Fi。
- Arduino CLI、ESP32 Arduino 核心 3.3.x、M5Unified 0.3.0 和 M5GFX 0.3.0。已在 ESP32 核心 3.3.10-cn 上验证。
- Mac 上安装 Node.js 20 或更新版本和 Qoder CLI CN。桥接使用自己的 Qoder CLI 会话。已有 IDE 聊天由 IDE 继续管理。[Qoder CLI CN 安装](https://docs.qoder.cn/cli/installation) · [Qoder CN ACP](https://docs.qoder.cn/cli/acp)

## 编译与烧录

如需保留原固件，请先备份整片 Flash。长按侧面 RESET 约 2 秒，内部绿灯闪烁时松开，板子会进入下载模式。[M5Stack 烧录文档](https://docs.m5stack.com/en/arduino/m5sticks3/program)

在仓库根目录运行以下命令。把串口换成 `arduino-cli board list` 列出的设备地址。

```sh
FQBN='esp32:esp32:esp32s3:FlashSize=8M,PartitionScheme=default_8MB,PSRAM=opi,CDCOnBoot=cdc'
arduino-cli compile --fqbn "$FQBN" --build-path build firmware/StickQoder
arduino-cli board list
arduino-cli upload --fqbn "$FQBN" --port /dev/cu.usbmodem1101 --input-dir build firmware/StickQoder
```

烧录后如仍在下载模式，短按 RESET 启动固件。首次启动时屏幕显示 `PAIR VIA USB`。

## 配对与启动

保持 USB 连接，双击仓库中的 `连接开发板.command`。向导会引导输入 Wi-Fi、登录 Qoder CN CLI 并启动桥接。密码输入时不会回显。桥接运行时再次打开向导，可更新开发板的 Wi-Fi 配对。

板子显示 `IDLE` 后可以拔掉 USB。使用时让 Mac 保持唤醒，并保留桥接终端窗口。使用 iPhone 热点时，见[热点连接说明](troubleshooting.md#iphone-热点)。

也可以手动配对和启动。把示例 IP 与串口替换为实际值。Mac 的 Wi-Fi IP 通常可用 `ipconfig getifaddr en0` 查询。

```sh
node pair.mjs --serial /dev/cu.usbmodem1101 --ssid '你的 2.4 GHz Wi-Fi' \
  --url http://192.168.1.20:8765
qodercn login
node bridge.mjs --cwd '/你的项目目录' --host 192.168.1.20 --connect-on-start
```

如果 CLI 命令名是 `qoderclicn`，用它登录，并给桥接添加 `--cli qoderclicn`。Mac 上的 `pairing.json` 存放配对密钥，Wi-Fi 密码存入板内。网络或 Mac IP 变更后需要重新配对。桥接使用局域网 HTTP，请在可信网络中使用。

接下来可以查看[按键与提醒](usage.md)或[启用本地语音](voice.md)。
