#!/bin/bash
# Petra Linux 启动器（AppImage 用）
#
# 为什么需要它：AppImage 双击"没反应"通常是三种原因之一，而且双击时看不到任何报错：
#   ① 缺 libfuse2（AppImage 默认要挂载运行）→ 本脚本会用"免挂载解包运行"自动重试
#   ② 缺 WebKitGTK / GTK3 等系统库 → 本脚本会先自检并给出对应的 apt 安装命令
#   ③ 只是没执行权限或没在终端里跑 → 本脚本会 chmod +x 并把输出留在终端
#
# 用法（推荐在终端里跑，才能看到报错）：
#   cd 到本脚本所在目录
#   bash 启动Petra-linux.sh                 # 自动找同目录下的 *.AppImage
#   bash 启动Petra-linux.sh 路径/xxx.AppImage   # 或手动指定

set -u
cd "$(dirname "$0")" || exit 1

# 全程留痕：无论走到哪一步（包括"没找到 AppImage"直接退出），输出都同时写进 petra-run.log，
# 这样"起不来又找不到报错"的情况不会再发生。
LOG="$(pwd)/petra-run.log"
exec > >(tee "$LOG") 2>&1
echo "=== Petra 启动诊断 ==="
echo "时间   : $(date '+%F %T')"
echo "脚本   : $0"
echo "工作目录: $(pwd)"
echo "目录内容:"
ls -lah . 2>/dev/null | sed 's/^/    /'
echo

APP="${1:-}"
if [ -n "$APP" ]; then shift; fi
if [ -z "$APP" ]; then
  APP="$(ls -1 ./*.AppImage 2>/dev/null | head -n 1)"
fi

echo "=== Petra 启动诊断 ==="
echo "发行版 : $(grep PRETTY_NAME /etc/os-release 2>/dev/null | cut -d= -f2- | tr -d '\"')"
echo "会话   : ${XDG_SESSION_TYPE:-未知} / ${XDG_CURRENT_DESKTOP:-未知}"
echo "架构   : $(uname -m)"
echo

if [ -z "$APP" ] || [ ! -f "$APP" ]; then
  echo "[!] 没找到 .AppImage（脚本没有启动任何程序，所以不会有应用报错）"
  echo "    你下载的压缩包里，AppImage 通常在 src-tauri/target/release/bundle/appimage/ 下面，"
  echo "    把它和本脚本放到同一目录，或者： bash 启动Petra-linux.sh 路径/xxx.AppImage"
  echo
  echo "    先用这条命令找一下它藏在哪："
  echo "      find ~ -name '*.AppImage' 2>/dev/null"
  if ls -1 ./*.deb >/dev/null 2>&1; then
    echo "    （注意：这个目录里有 .deb，但 .deb 只有 Debian/Ubuntu 系能装，Arch 系用不了）"
  fi
  echo
  echo "[i] 本次诊断已写入：$LOG"
  read -r -p "按回车退出……" _ || true
  exit 1
fi
chmod +x "$APP" 2>/dev/null

# 依赖自检：把"没反应"翻译成**当前发行版**上可执行的修复命令
# （包名各发行版不同：Arch 是 webkit2gtk-4.1 / fuse2，Fedora 是 webkit2gtk4.1 / fuse）
need_webkit=0 need_gtk=0 need_fuse=0 need_xdg=0 need_notify=0
command -v xdg-open    >/dev/null 2>&1 || need_xdg=1
command -v notify-send >/dev/null 2>&1 || need_notify=1
if command -v ldconfig >/dev/null 2>&1; then
  ldconfig -p 2>/dev/null | grep -q 'libwebkit2gtk-4' || need_webkit=1
  ldconfig -p 2>/dev/null | grep -q 'libgtk-3'        || need_gtk=1
  ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2'  || need_fuse=1
fi

pkg_names() {
  # $1 = apt | pacman | dnf
  local out=""
  [ "$need_webkit" -eq 1 ] && case "$1" in
    apt)    out="$out libwebkit2gtk-4.1-0" ;;
    pacman) out="$out webkit2gtk-4.1" ;;
    dnf)    out="$out webkit2gtk4.1" ;;
  esac
  [ "$need_gtk" -eq 1 ] && case "$1" in
    apt)    out="$out libgtk-3-0" ;;
    pacman) out="$out gtk3" ;;
    dnf)    out="$out gtk3" ;;
  esac
  [ "$need_fuse" -eq 1 ] && case "$1" in
    apt)    out="$out libfuse2" ;;
    pacman) out="$out fuse2" ;;
    dnf)    out="$out fuse" ;;
  esac
  [ "$need_xdg" -eq 1 ] && out="$out xdg-utils"
  [ "$need_notify" -eq 1 ] && case "$1" in
    apt)    out="$out libnotify-bin" ;;
    pacman) out="$out libnotify" ;;
    dnf)    out="$out libnotify" ;;
  esac
  echo "$out"
}

if [ "$need_webkit$need_gtk$need_fuse$need_xdg$need_notify" != "00000" ]; then
  echo "[!] 缺少一些系统库/工具（不一定是致命原因，先看下面的提示）"
  if command -v pacman >/dev/null 2>&1; then
    echo "    Arch/Manjaro 系： sudo pacman -S --needed$(pkg_names pacman)"
  elif command -v apt >/dev/null 2>&1; then
    echo "    Debian/Ubuntu 系： sudo apt install -y$(pkg_names apt)"
  elif command -v dnf >/dev/null 2>&1; then
    echo "    Fedora 系： sudo dnf install -y$(pkg_names dnf)"
  else
    echo "    没识别出包管理器，需要装： WebKitGTK 4.1 / GTK3 / libfuse2 / xdg-utils / libnotify"
  fi
  echo "    （缺 libfuse2 的话，下面会自动改走"免挂载解包"模式，通常仍能跑起来）"
  echo
fi

echo "[*] 启动：$APP"
echo "    （日志会同时写到 petra-run.log；详细日志已开启）"
echo
PETRA_VERBOSE_LOG=1 "$APP" "$@" 2>&1 | tee petra-run.log
status=${PIPESTATUS[0]:-$?}

if [ "$status" -ne 0 ]; then
  echo
  echo "[!] 直接启动失败（退出码 $status）——改用「免 FUSE 解包运行」再试一次……"
  APPIMAGE_EXTRACT_AND_RUN=1 PETRA_VERBOSE_LOG=1 "$APP" "$@" 2>&1 | tee -a petra-run.log
  status=${PIPESTATUS[0]:-$?}
fi

echo
if [ "$status" -ne 0 ]; then
  echo "[!] 仍然失败（退出码 $status）。把这两样发我即可："
  echo "    1) petra-run.log（本目录）"
  echo "    2) 上面整段终端输出"
  echo "    日志目录：${XDG_DATA_HOME:-$HOME/.local/share}/com.wumiu.petra/logs/"
else
  echo "[*] 已正常退出。"
fi
read -r -p "按回车关闭……" _ || true
exit "$status"
