import os, zipfile, io, glob
desk = "D:\\桌面"
hits = [f for f in os.listdir(desk) if f.lower().endswith(".zip")]
print("zips:", hits)
