import os, shutil, zipfile, io
desk = "D:\\桌面"
name = [f for f in os.listdir(desk) if f.lower().endswith(".zip")][0]
src = os.path.join(desk, name)
print("size:", os.path.getsize(src))
try:
    shutil.copy(src, "tmp-old.zip")
    print("copied ok")
except Exception as e:
    print("copy failed:", e)
