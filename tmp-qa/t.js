(async () => {
  const invoke = window.__TAURI_INTERNALS__.invoke;
  const key = await invoke("get_tts_key");
  const out = {};
  for (const spk of ["S_rD64E0Hg2", "ICL_6abcc9329794e2d2"]) {
    try {
      const a = await invoke("tts_synthesize", { apiKey: key, speaker: spk, text: "你好，今天天气不错" });
      out[spk] = "ok:" + a.length;
    } catch (e) { out[spk] = String(e).slice(0, 160); }
  }
  return out;
})()
