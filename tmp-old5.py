import os, zipfile, io, re
base = "D:\\桌面"
path = None
for d in os.listdir(base):
    p = os.path.join(base, d)
    if os.path.isdir(p) and p.lower().endswith(".zip"):
        for f in os.listdir(p):
            if f.lower().endswith(".zip"):
                path = os.path.join(p, f)
z = zipfile.ZipFile(path)
name = [n for n in z.namelist() if n.endswith("src-tauri/src/lib.rs")][0]
data = z.read(name).decode("utf-8", "replace")
i = data.find("async fn tts_synthesize")
seg = data[max(0, i-1500):i+3000]
# 只打印 ASCII 结构行（去掉中文，避免控制台乱码）
for line in seg.splitlines():
    s = re.sub(r'[^\x20-\x7e]', '', line).rstrip()
    if s.strip():
        print(s)
