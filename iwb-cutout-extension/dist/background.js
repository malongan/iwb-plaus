(() => {
  // iwb-cutout-extension/src/shared/config.js
  var CONFIG_KEY = "iwb_cutout_config";
  var DEFAULT_CONFIG = Object.freeze({
    apiUrl: "http://localhost:30092",
    crop: true,
    // 抠图后裁掉多余透明像素
    autoConnect: true,
    // 新节点模式下自动连线
    replaceMode: false,
    // false=创建新节点，true=替换原图
    autoWhiteBg: false,
    // 抠图后直接生成白底大图
    bgSize: 800,
    // 白底画布边长
    bgRatio: 0.85,
    // 内容占画布比例 0~1
    bgMode: "white",
    // white=白底 / transparent=透明底
    compressWidth: 1024,
    // 压缩目标宽度
    compressQuality: 80
    // 压缩质量 10~100
  });
  var clamp = (n, min, max) => Math.min(max, Math.max(min, n));
  function num(v, fallback, min, max) {
    const n = typeof v === "number" ? v : parseFloat(v);
    if (!Number.isFinite(n)) return fallback;
    return clamp(n, min, max);
  }
  function normalizeApiUrl(v) {
    const raw = String(v == null ? "" : v).trim();
    if (!raw) return DEFAULT_CONFIG.apiUrl;
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
    const candidate = hasScheme ? raw : `http://${raw}`;
    try {
      const u = new URL(candidate);
      if (u.protocol !== "http:" && u.protocol !== "https:") return DEFAULT_CONFIG.apiUrl;
      if (!u.hostname) return DEFAULT_CONFIG.apiUrl;
      return u.origin;
    } catch {
      return DEFAULT_CONFIG.apiUrl;
    }
  }
  function mergeConfig(raw) {
    const r = raw && typeof raw === "object" ? raw : {};
    const d = DEFAULT_CONFIG;
    return {
      apiUrl: normalizeApiUrl(r.apiUrl != null ? r.apiUrl : d.apiUrl),
      crop: r.crop != null ? !!r.crop : d.crop,
      autoConnect: r.autoConnect != null ? !!r.autoConnect : d.autoConnect,
      replaceMode: r.replaceMode != null ? !!r.replaceMode : d.replaceMode,
      autoWhiteBg: r.autoWhiteBg != null ? !!r.autoWhiteBg : d.autoWhiteBg,
      bgSize: Math.round(num(r.bgSize != null ? r.bgSize : d.bgSize, d.bgSize, 64, 4096)),
      // 旧实现允许输入 500 存成 5.0，这里 clamp 到 0.1~1
      bgRatio: num(r.bgRatio != null ? r.bgRatio : d.bgRatio, d.bgRatio, 0.1, 1),
      bgMode: r.bgMode === "transparent" ? "transparent" : "white",
      compressWidth: Math.round(num(r.compressWidth != null ? r.compressWidth : d.compressWidth, d.compressWidth, 64, 8192)),
      compressQuality: Math.round(num(r.compressQuality != null ? r.compressQuality : d.compressQuality, d.compressQuality, 10, 100))
    };
  }
  function readStoredConfig(stored) {
    return mergeConfig(stored && typeof stored === "object" ? stored : {});
  }

  // iwb-cutout-extension/src/shared/bytes.js
  function splitDataUrl(dataUrl) {
    const s = String(dataUrl || "");
    const m = /^data:([^;,]+)?(;base64)?,/i.exec(s);
    if (!m) return { mime: null, base64: s };
    return { mime: m[1] || null, base64: s.slice(m[0].length) };
  }
  function base64ToBytes(input) {
    const { base64 } = splitDataUrl(input);
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  function bytesToBase64(bytes) {
    let binary = "";
    const chunk = 32768;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }
  function bytesToDataUrl(bytes, mime = "image/png") {
    return `data:${mime};base64,${bytesToBase64(bytes)}`;
  }
  function bufferToDataUrl(buffer, mime = "image/png") {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    return bytesToDataUrl(bytes, mime);
  }

  // iwb-cutout-extension/src/background.js
  async function getConfig() {
    const result = await chrome.storage.local.get(CONFIG_KEY);
    return readStoredConfig(result[CONFIG_KEY]);
  }
  function cutoutUrl(config) {
    const apiUrl = String(config.apiUrl || "http://localhost:30092").replace(/\/$/, "");
    return `${apiUrl}/rmbg?crop=${config.crop ? "true" : "false"}`;
  }
  async function postCutout(body, config) {
    const resp = await fetch(cutoutUrl(config), {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`\u9C9C\u827A\u62A0\u56FE API \u8FD4\u56DE\u9519\u8BEF ${resp.status}: ${errText}`);
    }
    return bufferToDataUrl(await resp.arrayBuffer(), "image/png");
  }
  async function callCutoutAPI(imageBase64, config) {
    return postCutout(base64ToBytes(imageBase64), config);
  }
  async function callCutoutAPIByUrl(imageUrl, config) {
    let imgResp;
    try {
      imgResp = await fetch(imageUrl, { mode: "cors" });
    } catch {
      throw new Error("\u56FE\u7247\u8DE8\u57DF\u65E0\u6CD5\u4E0B\u8F7D\uFF08\u6269\u5C55\u53EA\u88AB\u6388\u6743\u8BFB\u53D6\u5DE5\u4F5C\u53F0\u81EA\u8EAB\u4E0E localhost \u7684\u56FE\u7247\uFF09\uFF0C\u8BF7\u5148\u4E0B\u8F7D\u56FE\u7247\u540E\u91CD\u65B0\u4E0A\u4F20");
    }
    if (!imgResp.ok) throw new Error(`\u65E0\u6CD5\u4E0B\u8F7D\u56FE\u7247: ${imgResp.status}`);
    return postCutout(await imgResp.arrayBuffer(), config);
  }
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "CUTOUT_IMAGE") {
      getConfig().then((config) => {
        if (msg.imageUrl && !msg.imageBase64) {
          return callCutoutAPIByUrl(msg.imageUrl, config);
        }
        return callCutoutAPI(msg.imageBase64, config);
      }).then((resultBase64) => {
        sendResponse({ success: true, resultBase64 });
      }).catch((err) => {
        sendResponse({ success: false, error: err.message });
      });
      return true;
    }
    if (msg.type === "GET_CONFIG") {
      getConfig().then((config) => {
        sendResponse({ success: true, config });
      });
      return true;
    }
    if (msg.type === "PING_API") {
      getConfig().then((config) => {
        const apiUrl = String(msg.apiUrl || config.apiUrl).replace(/\/$/, "");
        return fetch(`${apiUrl}/rmbg`, { method: "HEAD" });
      }).then((resp) => {
        sendResponse({ success: true, status: resp.status });
      }).catch((err) => {
        sendResponse({ success: false, error: err.message });
      });
      return true;
    }
    if (msg.type === "SAVE_CONFIG") {
      const config = mergeConfig(msg.config);
      chrome.storage.local.set({ [CONFIG_KEY]: config }).then(() => {
        sendResponse({ success: true, config });
      });
      return true;
    }
  });
})();
