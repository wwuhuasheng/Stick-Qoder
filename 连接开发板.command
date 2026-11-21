#!/bin/zsh
set -eu
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
stick_project="${0:A:h}"
stick_workspace_runtime="${stick_project:h:h}/work"
if [[ "${stick_project:h:t}" == outputs && -x "$stick_workspace_runtime/qodercn/qoderclicn" ]]; then
  stick_work="$stick_workspace_runtime"
else
  stick_work="$stick_project/.stick-qoder"
fi
umask 077
mkdir -p "$stick_work"
stick_cli="${STICK_QODER_CLI:-}"
if [[ -z "$stick_cli" ]]; then
  if [[ -x "$stick_work/qodercn/qoderclicn" ]]; then
    stick_cli="$stick_work/qodercn/qoderclicn"
  else
    stick_cli="$(command -v qodercn || command -v qoderclicn || true)"
  fi
fi
stick_pair="$stick_work/pairing.json"
stick_progress="$stick_work/setup-progress.txt"

stage() {
  printf '%s\n' "$1" > "$stick_progress"
}

printf '\nStickS3 × Qoder CN\n\n'
if ! command -v node >/dev/null || [[ -z "$stick_cli" ]] || ! command -v "$stick_cli" >/dev/null; then
  printf '%s\n' '请先安装 Node.js 20 或更新版本，以及 Qoder CLI CN。' \
    'https://docs.qoder.cn/cli/installation'
  read -r 'stick_ack?按回车退出。'
  exit 1
fi
stage "checking-usb"
stick_ports=(/dev/cu.usbmodem*(N))
if (( ${#stick_ports} != 1 )); then
  stage "usb-unavailable"
  printf '%s\n' '请让 StickS3 保持 USB 连接，并确认只有这一块 USB 开发板。'
  read -r 'stick_ack?按回车退出。'
  exit 1
fi
stick_serial="${stick_ports[1]}"
node "$stick_project/pair.mjs" --serial "$stick_serial" --probe

if [[ -f "$stick_work/active-setup.env" ]]; then
  stick_previous_ip="$(sed -n '1p' "$stick_work/active-setup.env")"
  stick_previous_dir="$(sed -n '2p' "$stick_work/active-setup.env")"
else
  stick_previous_ip=""
  stick_previous_dir=""
fi
stick_ip="$(ipconfig getifaddr en0 2>/dev/null || true)"
if [[ -z "$stick_ip" ]]; then
  printf '%s\n' 'Mac 需要先连接 Wi-Fi。'
  stage "wifi-unavailable"
  read -r 'stick_ack?按回车退出。'
  exit 1
fi
printf 'Mac 的 Wi-Fi IP 是 %s。\n' "$stick_ip"

stick_bridge_active=n
if node -e 'const fs=require("fs"); const {token}=JSON.parse(fs.readFileSync(process.argv[2],"utf8")); fetch("http://"+process.argv[1]+":8765/status",{headers:{Authorization:"Bearer "+token},signal:AbortSignal.timeout(1250)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1));' "$stick_ip" "$stick_pair"; then
  stick_bridge_active=y
fi
if [[ "$stick_bridge_active" == y ]]; then
  printf '%s\n' 'Qoder 桥接正在运行。这个窗口只更新开发板的 Wi-Fi，原会话会保留。'
  stick_repair=n
elif [[ "$stick_previous_ip" == "$stick_ip" ]]; then
  read -r 'stick_repair?沿用上一次的开发板配对？[Y/n] '
else
  stick_repair=n
fi
if [[ "${stick_repair:l}" == n ]]; then
  stick_ssid="$(networksetup -getairportnetwork en0 2>/dev/null | sed -n 's/^Current Wi-Fi Network: //p' || true)"
  stage "waiting-for-wifi"
  if [[ -n "$stick_ssid" ]]; then
    read -r "stick_input?输入与 Mac 同网的 2.4 GHz Wi-Fi 名称（回车用 $stick_ssid）: "
    stick_ssid="${stick_input:-$stick_ssid}"
  else
    read -r 'stick_ssid?输入与 Mac 同网的 2.4 GHz Wi-Fi 名称: '
  fi
  node "$stick_project/pair.mjs" --serial "$stick_serial" --ssid "$stick_ssid" \
    --url "http://$stick_ip:8765" --pair "$stick_pair"
  umask 077
  printf '%s\n%s\n' "$stick_ip" "$stick_previous_dir" > "$stick_work/active-setup.env"
fi

if [[ "$stick_bridge_active" == y ]]; then
  stage "wifi-updated"
  printf '%s\n' '新设置已写入。等板子连上后，原桥接窗口会显示 Connected。'
  exit 0
fi

if ! "$stick_cli" status -o json | node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); process.exit(s.logged_in ? 0 : 1)'; then
  stage "waiting-for-qoder-login"
  printf '\n现在打开 Qoder 官方登录页。请用你平时的 Qoder CN 账号完成授权。\n'
  "$stick_cli" login
fi
if ! "$stick_cli" status -o json | node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); process.exit(s.logged_in ? 0 : 1)'; then
  printf '%s\n' 'Qoder 尚未登录。授权完成后重新打开这个窗口。'
  read -r 'stick_ack?按回车退出。'
  exit 1
fi

stage "waiting-for-project"
stick_default_dir="${stick_previous_dir:-$stick_project}"
printf '\n要用开发板控制哪个项目？回车用默认项目，也可以拖一个项目文件夹进来。\n'
read -rt 15 'stick_cwd?项目文件夹（15 秒后用默认目录）: ' || stick_cwd=""
stick_cwd="${stick_cwd:-$stick_default_dir}"
if [[ ! -d "$stick_cwd" ]]; then
  stick_candidate=(${(z)stick_cwd})
  if (( ${#stick_candidate} == 1 )); then
    stick_cwd="${(Q)stick_candidate[1]}"
  fi
fi
if [[ ! -d "$stick_cwd" ]]; then
  printf '找不到该文件夹。将使用 %s。\n' "$stick_default_dir"
  stick_cwd="$stick_default_dir"
fi
umask 077
printf '%s\n%s\n' "$stick_ip" "$stick_cwd" > "$stick_work/active-setup.env"
stage "starting-bridge"
stick_speech="$stick_project/speech/StickSpeech"
stick_voice=()
if [[ -x "$stick_speech" ]]; then
  stick_voice=(--speech "$stick_speech")
else
  printf '\n已启用任务控制。启用语音所需的编译命令见 README。\n'
fi
printf '\n桥接启动后保持窗口打开。你可以在这里输入第一条任务。\n'
node "$stick_project/bridge.mjs" --cli "$stick_cli" --cwd "$stick_cwd" \
  --host "$stick_ip" --pair "$stick_pair" "${stick_voice[@]}" \
  --connect-on-start --connection-status "$stick_work/live-connection.json"
stage "bridge-stopped"
