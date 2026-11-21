# Stick-Qoder

用 M5StickS3 查看 Mac 上的 Qoder CN CLI 任务，按键暂停和继续，并用板载麦克风提交补充指令。开发板和 Mac 通过同一个可信局域网通信。Mac 需要保持唤醒并运行桥接程序。

## 准备

- M5StickS3、USB 数据线，以及与 Mac 互通的 2.4 GHz Wi-Fi。
- Arduino CLI、ESP32 Arduino 核心 3.3.x、M5Unified 0.3.0 和 M5GFX 0.3.0。已在 ESP32 核心 3.3.10-cn 上验证。
- Mac 上安装 Node.js 20 或更新版本和 Qoder CLI CN。桥接使用一个 Qoder CLI 会话。已有 IDE 聊天由 IDE 继续管理。 [Qoder CLI CN 安装](https://docs.qoder.cn/cli/installation) · [Qoder CN ACP](https://docs.qoder.cn/cli/acp)

使用 iPhone 个人热点时，打开「允许其他人加入」和「最大兼容性」。首次连接期间，在 iPhone 上停留在个人热点设置页。Wi-Fi 名称区分大小写。 [Apple 个人热点兼容性说明](https://support.apple.com/guide/security/wi-fi-security-with-apple-devices-secfd166f620/web)

## 编译和烧录

在仓库根目录运行以下命令。将串口换成 `arduino-cli board list` 列出的设备地址。如需保留原固件，请先备份整片 Flash。长按侧面 RESET 约 2 秒，内部绿灯闪烁时松开，板子会进入下载模式。 [M5Stack 烧录文档](https://docs.m5stack.com/en/arduino/m5sticks3/program)

```sh
FQBN='esp32:esp32:esp32s3:FlashSize=8M,PartitionScheme=default_8MB,PSRAM=opi,CDCOnBoot=cdc'
arduino-cli compile --fqbn "$FQBN" --build-path build firmware/StickQoder
arduino-cli board list
arduino-cli upload --fqbn "$FQBN" --port /dev/cu.usbmodem1101 --input-dir build firmware/StickQoder
```

烧录后如仍在下载模式，短按 RESET 启动固件。首次启动时屏幕显示 `PAIR VIA USB`。

## 配对和运行

保持 USB 连接，双击 `连接开发板.command`。它会引导输入 Wi-Fi、完成 Qoder CLI 登录，然后启动桥接。Wi-Fi 密码输入时不回显。桥接运行时再次打开这个命令，只更新开发板的 Wi-Fi 配对。配对完成且板子显示 `IDLE` 后，USB 可拔掉。使用时保留 Mac 上的桥接窗口。

也可以手动配对和启动。把示例 IP 与串口替换成现场值，Mac 的 Wi-Fi IP 通常可用 `ipconfig getifaddr en0` 查询。若官方 CLI 的命令名为 `qoderclicn`，用它替换登录命令，并给桥接添加 `--cli qoderclicn`。

```sh
node pair.mjs --serial /dev/cu.usbmodem1101 --ssid '你的 2.4 GHz Wi-Fi' \
  --url http://192.168.1.20:8765
qodercn login
node bridge.mjs --cwd '/你的项目目录' --host 192.168.1.20 --connect-on-start
```

Wi-Fi 密码存入板内。Mac 端的 `pairing.json` 存随机配对密钥。网络或 Mac IP 变更后重新配对。桥接使用局域网 HTTP，请在可信的网络中使用。Mac 防火墙如询问是否允许 Node 入站，允许后开发板才能连接。

## 使用

- 在 Mac 桥接终端输入任务。板上约每秒更新状态，完整输出在终端查看。Qoder 请求工具权限时，按终端提示选择。
- 任务运行中短按 **A** 请求暂停。看到 `PAUSED` 后再按 **A**，在同一个 Qoder 会话中继续。暂停会中断当前回合，已完成的文件修改会保留。
- 开启语音后按住 **B**，看到 `RECORDING` 再说话，松开后由 Mac 本地转写。短按 **A** 提交草稿、**B** 丢弃。若 Qoder 正在运行，先按 **A** 暂停，再按 **A** 发送。
- 完成响短音，错误或断线响长音。震动提醒需要外接带驱动的震动模块。确认模块及供电适配后，在固件里设置 `VibratorPin` 并重新烧录。 [StickS3 硬件规格](https://docs.m5stack.com/en/core/StickS3)

给手动启动命令加 `--demo` 可以先用模拟任务测试。输入任意文字启动模拟任务，输入 `/network` 模拟服务网络错误。

## 启用本地中文语音

macOS 26 及以上可用 Apple Speech。安装 Xcode 命令行工具后编译随附源码，并安装简体中文语音模型。连接向导会自动使用编译后的语音工具。手动启动时，在桥接命令后加 `--speech ./speech/StickSpeech`。 [Apple Speech](https://developer.apple.com/documentation/speech/speechtranscriber)

```sh
swiftc -parse-as-library -O speech/StickSpeech.swift -o speech/StickSpeech
./speech/StickSpeech --prepare
```

也可以使用 [whisper.cpp](https://github.com/ggml-org/whisper.cpp)，在手动启动命令末尾加 `--whisper /path/to/whisper-cli --whisper-model /path/to/ggml-base-q5_1.bin`。

## 连接诊断

```sh
node pair.mjs --serial /dev/cu.usbmodem1101 --network
node pair.mjs --serial /dev/cu.usbmodem1101 --scan
```

`wifi=3` 表示开发板已连上 Wi-Fi，`http=200 linked=1` 表示 Mac 桥接已响应。
