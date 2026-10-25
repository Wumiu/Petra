import os, zipfile, io
desk = os.path.join(os.path.expanduser("~"), "Desktop")
if not os.path.isdir(desk):
    desk = "D:\\桌面"
cands = [f for f in os.listdir(desk) if f.endswith(".zip") and "源码" in f]
print("候选:", cands)
path = os.path.join(desk, cands[0])
z = zipfile.ZipFile(path)
names = [n for n in z.namelist() if n.endswith("src-tauri/src/lib.rs")]
print("found:", names)
data = z.read(names[0]).decode("utf-8", "replace")
i = data.find("async fn tts_synthesize")
out = data[max(0, i-400):i+3200]
io.open("tmp-old-tts.txt", "w", encoding="utf-8").write(out)
print(out[:3000])
