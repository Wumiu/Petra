import base64, io, json, os, socket, struct, sys
class WS:
    def __init__(self, url):
        host = url.split('/')[2]; h, p = host.split(':'); path = '/' + '/'.join(url.split('/')[3:])
        self.s = socket.create_connection((h, int(p)), timeout=180)
        key = base64.b64encode(os.urandom(16)).decode()
        self.s.sendall((f"GET {path} HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                        f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        buf = b""
        while b"\r\n\r\n" not in buf: buf += self.s.recv(4096)
        self.buf = buf.split(b"\r\n\r\n", 1)[1]
    def send(self, obj):
        data = json.dumps(obj).encode(); hdr = bytearray([0x81]); n = len(data)
        if n < 126: hdr.append(0x80 | n)
        elif n < 65536: hdr.append(0x80 | 126); hdr += struct.pack(">H", n)
        else: hdr.append(0x80 | 127); hdr += struct.pack(">Q", n)
        mask = os.urandom(4); hdr += mask
        self.s.sendall(bytes(hdr) + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))
    def _read(self, n):
        while len(self.buf) < n:
            c = self.s.recv(1 << 16)
            if not c: raise EOFError
            self.buf += c
        out, self.buf = self.buf[:n], self.buf[n:]; return out
    def recv(self):
        b1, b2 = self._read(2); n = b2 & 0x7F
        if n == 126: n = struct.unpack(">H", self._read(2))[0]
        elif n == 127: n = struct.unpack(">Q", self._read(8))[0]
        return json.loads(self._read(n).decode())
expr = sys.argv[2]
if expr.startswith("@"): expr = io.open(expr[1:], encoding="utf-8").read()
ws = WS(sys.argv[1]); ws.send({"id": 1, "method": "Runtime.enable"})
ws.send({"id": 2, "method": "Runtime.evaluate", "params": {"expression": expr, "awaitPromise": True, "returnByValue": True}})
while True:
    m = ws.recv()
    if m.get("id") == 2:
        sys.stdout.reconfigure(encoding="utf-8")
        r = m.get("result", {}); v = r.get("result", {})
        print(json.dumps(v.get("value") if "value" in v else r.get("exceptionDetails"), ensure_ascii=False)); break
