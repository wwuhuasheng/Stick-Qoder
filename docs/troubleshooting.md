# 测试与排查

## 模拟任务

给[手动启动命令](setup.md#配对与启动)加 `--demo`，即可测试显示、按键和提醒。输入任意文字启动模拟任务，输入 `/network` 模拟服务网络错误。

## USB 诊断

将串口替换成 `arduino-cli board list` 显示的设备地址。

```sh
node pair.mjs --serial /dev/cu.usbmodem1101 --network
node pair.mjs --serial /dev/cu.usbmodem1101 --scan
```

- `wifi=3` 表示开发板已连上 Wi-Fi。`http=200 linked=1` 表示 Mac 桥接已响应。
- 扫描结果中的 `matches=0` 表示本次扫描没有找到已配对的网络。核对 Wi-Fi 名称的大小写、空格及 2.4 GHz 可用性。
- 已连上 Wi-Fi 但桥接不响应时，检查 Mac IP 是否变化、桥接终端是否还在运行，以及防火墙是否允许 Node 入站。

## iPhone 热点

打开「允许其他人加入」和「最大兼容性」。首次连接期间，在 iPhone 上停留在个人热点设置页。Wi-Fi 名称区分大小写。如果板子仍扫不到热点，可以关闭再打开「允许其他人加入」，然后重试扫描。[Apple 个人热点兼容性说明](https://support.apple.com/guide/security/wi-fi-security-with-apple-devices-secfd166f620/web)
