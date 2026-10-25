import os, zipfile, re
base = "D:\\桌面"
path = None
for d in os.listdir(base):
    p = os.path.join(base, d)
    if os.path.isdir(p) and p.lower().endswith(".zip"):
        for f in os.listdir(p):
            if f.lower().endswith(".zip"):
                path = os.path.join(p, f)
z = zipfile.ZipFile(path)
cands = [n for n in z.namelist() if n.endswith("src/tts/TTSPlayer.ts")]
print("TTSPlayer:", cands)
if cands:
    data = z.read(cands[0]).decode("utf-8", "replace")
    for line in data.splitlines():
        if any(k in line for k in ["invoke(", "speaker", "apiKey", "tts_synthesize", "language"]):
            s = re.sub(r'[^\x20-\x7e]', '', line).rstrip()
            if s.strip(): print(s)
