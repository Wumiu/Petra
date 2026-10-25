import os, zipfile, io
for desk in [r"D:\桌面", os.path.join(os.path.expanduser("~"), "Desktop")]:
    if os.path.isdir(desk):
        print("dir:", desk, [f for f in os.listdir(desk)][:15])
