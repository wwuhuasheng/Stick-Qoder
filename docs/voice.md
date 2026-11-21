# 本地中文语音

macOS 26 及以上可使用 Apple Speech。安装 Xcode 命令行工具后，在仓库根目录编译语音程序，并安装简体中文模型。[Apple Speech](https://developer.apple.com/documentation/speech/speechtranscriber)

```sh
swiftc -parse-as-library -O speech/StickSpeech.swift -o speech/StickSpeech
./speech/StickSpeech --prepare
```

连接向导会自动选用编译后的语音程序。手动启动时，在桥接命令末尾加 `--speech ./speech/StickSpeech`。

也可以用 [whisper.cpp](https://github.com/ggml-org/whisper.cpp)。在手动启动命令末尾加 `--whisper /path/to/whisper-cli --whisper-model /path/to/ggml-base-q5_1.bin`。

录音、预览和确认的按键操作见[按键与提醒](usage.md)。
