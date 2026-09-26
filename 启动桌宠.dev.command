#!/bin/bash
# Petra dev 启动器（macOS 版，对应 Windows 的「启动桌宠.dev*.bat」）
#
# 用法：Finder 里双击本文件；或在终端里执行  ./启动桌宠.dev.command
# 说明：.bat 是 Windows 批处理，macOS 上没有 cmd.exe，所以这里用 .command（macOS 等价物，
#       双击时由「终端」执行）。chcp/title/pause 这些 Windows 专有命令在 mac 上没有对应物，
#       需要用到的效果分别由 LANG、终端标题、最后的 read 代替。

cd "$(dirname "$0")" || exit 1

echo "[*] 正在启动 Petra……（首次编译要几分钟，属正常）"
echo

# Node 检查
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "[!] 没找到 node/npm。请先安装 Node.js 20+（https://nodejs.org 或 brew install node）"
  read -r -p "按回车关闭……" _
  exit 1
fi

# Rust 工具链：rustup 装在 ~/.cargo/bin，但双击运行的 bash 是非交互 shell，
# 不会读 ~/.zshrc / ~/.bash_profile，所以这里必须主动补 PATH —— 否则即使装了 Rust
# 也会报 "failed to run 'cargo metadata' ... No such file or directory"。
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
export PATH="$HOME/.cargo/bin:$PATH"

if ! command -v cargo >/dev/null 2>&1; then
  echo "[!] 没找到 cargo：mac 上还没装 Rust 工具链（这是 ./启动桌宠.dev.command 最常见的失败原因）"
  echo
  echo "    安装（约 1 分钟，装完重开终端或再双击本文件即可）："
  echo "      curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y"
  echo
  echo "    装完验证：cargo --version"
  read -r -p "按回车关闭……" _
  exit 1
fi

# 首次运行自动装依赖（对应 Windows 版直接 npm run tauri dev 前的 npm ci）
if [ ! -d node_modules ]; then
  echo "[*] 首次运行：正在安装前端依赖（npm ci）……"
  if ! npm ci; then
    echo
    echo "[!] npm ci 失败，请把上面的报错发给开发者"
    read -r -p "按回车关闭……" _
    exit 1
  fi
  echo
fi

# Xcode 命令行工具检查（macOS 编译 Rust 依赖需要 clang/链接器）
if ! xcode-select -p >/dev/null 2>&1; then
  echo "[!] 缺少 Xcode 命令行工具，请先执行：xcode-select --install"
  read -r -p "按回车关闭……" _
  exit 1
fi

# 真正的开发启动（与 Windows 版一致；npm run dev 里会先同步 vendor 内核再起 Vite）
npm run tauri dev
status=$?

echo
if [ $status -ne 0 ]; then
  echo "[!] 退出码 $status —— 把上面的报错整段发给开发者"
else
  echo "[*] 已退出"
fi
# 等价于 Windows 版的 pause，防止双击时窗口一闪而过
read -r -p "按回车关闭……" _
exit $status
