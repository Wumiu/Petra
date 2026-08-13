# -*- coding: utf-8 -*-
"""
SMTP 反馈配置加密脚本（更新邮箱/授权码后重新生成密文）：
1. 修改下方 SECRETS 里的值
2. python scripts/enc-smtp.py
3. 把输出的密文数组贴回 src-tauri/src/lib.rs 的 SmtpConfig::load()
注意：KEY 与 lib.rs 中 SMTP_KEY 保持一致。
"""
KEY = b"p3t_smtp_aozora_2026"

SECRETS = {
    "smtp_server": "smtp.163.com",
    "username": "wumiu381@163.com",
    "auth_code": "JGmpuMZbDgPws6Mz",
    "to_email": "1832633006@qq.com",
}

def enc(s: str):
    b = s.encode("utf-8")
    return [ch ^ KEY[i % len(KEY)] ^ (i & 0xFF) for i, ch in enumerate(b)]

if __name__ == "__main__":
    for k, v in SECRETS.items():
        arr = enc(v)
        # 校验可逆
        dec = bytes(x ^ KEY[i % len(KEY)] ^ (i & 0xFF) for i, x in enumerate(arr))
        assert dec.decode() == v, k
        print(f"{k}: &[{', '.join(str(x) for x in arr)}]")
    print(f"KEY = {KEY.decode()!r}  （与 lib.rs 的 SMTP_KEY 一致）")
    print("OK")
