import os, zipfile, io
base = "D:\\桌面"
for d in os.listdir(base):
    p = os.path.join(base, d)
    if os.path.isdir(p) and p.lower().endswith(".zip"):
        for f in os.listdir(p):
            if f.lower().endswith(".zip"):
                path = os.path.join(p, f)
                print("zip:", path, os.path.getsize(path))
                z = zipfile.ZipFile(path)
                names = [n for n in z.namelist() if n.endswith("src-tauri/src/lib.rs")]
                print("lib.rs:", names)
                data = z.read(names[0]).decode("utf-8", "replace")
                i = data.find("async fn tts_synthesize")
                out = data[max(0, i-300):i+2600]
                io.open("tmp-old-tts.txt", "w", encoding="utf-8").write(out)
                print(out)
