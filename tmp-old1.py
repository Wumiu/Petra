import os, zipfile, io
desk = "D:\\桌面"
name = [f for f in os.listdir(desk) if f.lower().endswith(".zip")][0]
path = os.path.join(desk, name)
z = zipfile.ZipFile(path)
names = [n for n in z.namelist() if n.endswith("src-tauri/src/lib.rs")]
print("found:", names)
data = z.read(names[0]).decode("utf-8", "replace")
i = data.find("async fn tts_synthesize")
out = data[max(0, i-200):i+3000]
io.open("tmp-old-tts.txt", "w", encoding="utf-8").write(out)
print(out)
