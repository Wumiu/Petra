(async () => {
  const invoke = window.__TAURI_INTERNALS__.invoke;
  const key = await invoke("get_tts_key");
  const res = {};
  for (var i = 0; i < 2; i++) {
    var spk = i === 0 ? "S_rD64E0Hg2" : "ICL_6abcc9329794e2d2";
    try {
      var a = await invoke("tts_synthesize", { apiKey: key, speaker: spk, text: "\u4f60\u597d\u4e0a\u6d77" });
      res[spk] = "ok:" + a.length;
    } catch (e) {
      res[spk] = String(e).slice(0, 160);
    }
  }
  return res;
})()
