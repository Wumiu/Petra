#!/usr/bin/env python3
"""生成 src-tauri/src/lib.rs 里 SmtpConfig::load() 用的密文字节数组。

背景：反馈邮件的 SMTP 服务器/账号/授权码/收件邮箱以"XOR + 位置偏移"的内嵌密文形式
存在于 Rust 源码里（见 xdecrypt）。授权码会过期或被邮箱服务商重置，一旦失效，
发送会返回 535 Authentication failed，这时候需要重新生成密文并替换四个数组。

用法：
    python scripts/enc-smtp.py                 # 交互式输入（授权码不回显，推荐）
    python scripts/enc-smtp.py --server smtp.163.com --username me@163.com \
        --auth-code XXXXXXXXXXXXXXXX --to you@163.com

注意：
  * "授权码"不是邮箱登录密码。163 邮箱：设置 → POP3/SMTP/IMAP → 开启 SMTP 服务 → 新增授权密码。
  * 生成后把输出的四个数组粘回 SmtpConfig::load() 对应位置，然后重新编译。
  * 授权码属于敏感信息，别贴到公开的地方（含聊天记录）。
"""

import argparse
import getpass
import sys

KEY = b"p3t_smtp_aozora_2026"


def xdecrypt(cipher):
    return bytes(b ^ KEY[i % len(KEY)] ^ (i & 0xFF) for i, b in enumerate(cipher))


def xencrypt(plain: str):
    data = plain.encode("utf-8")
    return [b ^ KEY[i % len(KEY)] ^ (i & 0xFF) for i, b in enumerate(data)]


def read_current_from_lib(path="src-tauri/src/lib.rs"):
    """从 src-tauri/src/lib.rs 的 SmtpConfig::load() 里读出四个密文字节数组。"""
    import re
    try:
        with open(path, encoding="utf-8") as fh:
            src = fh.read()
    except OSError:
        return None
    block = re.search(r"impl SmtpConfig \{(.*?)\n\}", src, re.S)
    if not block:
        return None
    out = {}
    for key in ("smtp_server", "username", "auth_code", "to_email"):
        m = re.search(key + r": xdecrypt\(&\[([^\]]*)\]\)", block.group(1))
        if m:
            out[key] = [int(x) for x in re.findall(r"-?\d+", m.group(1))]
    return out or None


def fmt(arr):
    lines = []
    for i in range(0, len(arr), 12):
        lines.append("                " + ", ".join(str(x) for x in arr[i:i + 12]) + ",")
    return "\n".join(lines)


def ask(label, current=None):
    hint = ""
    if current:
        try:
            cur = xdecrypt(current).decode("utf-8", "replace")
            masked = cur[:3] + "*" * max(0, len(cur) - 6) + cur[-3:] if len(cur) > 6 else "*" * len(cur)
            hint = " [当前: %s]" % masked
        except Exception:
            pass
    val = input("%s%s: " % (label, hint)).strip()
    return val


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--server")
    ap.add_argument("--username")
    ap.add_argument("--auth-code")
    ap.add_argument("--to")
    ap.add_argument("--show-current", action="store_true", help="只解密显示当前配置（授权码只显示长度）")
    args = ap.parse_args()

    # 从 lib.rs 直接读出当前配置，避免脚本里手抄一份导致失同步
    cur = read_current_from_lib() or {}

    if args.show_current:
        if not cur:
            print("没能从 src-tauri/src/lib.rs 解析出当前配置（路径不对？）", file=sys.stderr)
            sys.exit(1)
        for k in ("smtp_server", "username", "auth_code", "to_email"):
            if k not in cur:
                continue
            text = xdecrypt(cur[k]).decode("utf-8", "replace")
            print("%-12s: %s" % (k, "(长度 %d，不外显)" % len(text) if k == "auth_code" else text))
        return

    server = args.server or ask("SMTP 服务器", cur.get("smtp_server"))
    username = args.username or ask("登录账号", cur.get("username"))
    if args.auth_code:
        auth_code = args.auth_code
    else:
        auth_code = getpass.getpass("授权码（不回显）: ").strip()
    to_email = args.to or ask("收件邮箱", cur.get("to_email"))

    if not (server and username and auth_code and to_email):
        print("四项都不能为空", file=sys.stderr)
        sys.exit(1)

    print("")
    print("把下面四段粘回 src-tauri/src/lib.rs 的 SmtpConfig::load()：")
    print("")
    for name, value in (
        ("smtp_server", server),
        ("username", username),
        ("auth_code", auth_code),
        ("to_email", to_email),
    ):
        arr = xencrypt(value)
        print("            %s: xdecrypt(&[" % name)
        print(fmt(arr))
        print("            ]),")
    print("")
    print("（检查一下：解密回来是否等于你刚输入的值）")
    for name, value in (("smtp_server", server), ("username", username), ("to_email", to_email)):
        assert xdecrypt(xencrypt(value)).decode("utf-8") == value, name
    print("自检通过。")


if __name__ == "__main__":
    main()
