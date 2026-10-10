(() => {
  // iwb-cutout-extension/src/shared/config.js
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

  // iwb-cutout-extension/src/popup.js
  document.addEventListener("DOMContentLoaded", () => {
    const apiUrlEl = document.getElementById("apiUrl");
    const cropEl = document.getElementById("crop");
    const autoConnectEl = document.getElementById("autoConnect");
    const autoWhiteBgEl = document.getElementById("autoWhiteBg");
    const bgSizeEl = document.getElementById("bgSize");
    const bgRatioEl = document.getElementById("bgRatio");
    const bgModeEl = document.getElementById("bgMode");
    const compressWidthEl = document.getElementById("compressWidth");
    const compressQualityEl = document.getElementById("compressQuality");
    const modeNewNodeEl = document.getElementById("modeNewNode");
    const modeReplaceEl = document.getElementById("modeReplace");
    const statusDot = document.getElementById("statusDot");
    const statusText = document.getElementById("statusText");
    const saveBtn = document.getElementById("saveBtn");
    const testBtn = document.getElementById("testBtn");
    const probeBtn = document.getElementById("probeBtn");
    const probeResult = document.getElementById("probeResult");
    const verText = document.getElementById("verText");
    verText.textContent = "v" + chrome.runtime.getManifest().version;
    function fillForm(config) {
      apiUrlEl.value = config.apiUrl;
      cropEl.checked = config.crop;
      autoConnectEl.checked = config.autoConnect;
      autoWhiteBgEl.checked = config.autoWhiteBg;
      bgSizeEl.value = config.bgSize;
      bgRatioEl.value = Math.round(config.bgRatio * 100);
      bgModeEl.value = config.bgMode;
      compressWidthEl.value = config.compressWidth;
      compressQualityEl.value = config.compressQuality;
      if (config.replaceMode) modeReplaceEl.checked = true;
      else modeNewNodeEl.checked = true;
    }
    chrome.runtime.sendMessage({ type: "GET_CONFIG" }, (resp) => {
      const config = resp && resp.success && resp.config || mergeConfig(DEFAULT_CONFIG);
      fillForm(config);
      checkApiStatus(config.apiUrl);
    });
    function checkApiStatus(url) {
      statusDot.className = "status-dot status-checking";
      statusText.textContent = "\u68C0\u6D4B\u4E2D...";
      chrome.runtime.sendMessage({ type: "PING_API", apiUrl: url }, (resp) => {
        if (resp && resp.success) {
          statusDot.className = "status-dot status-online";
          statusText.textContent = "\u9C9C\u827A\u62A0\u56FE\u670D\u52A1\u5DF2\u8FDE\u63A5";
        } else {
          statusDot.className = "status-dot status-offline";
          statusText.textContent = "\u672A\u68C0\u6D4B\u5230\u9C9C\u827A\u62A0\u56FE\uFF0C\u8BF7\u786E\u4FDD\u8F6F\u4EF6\u5DF2\u542F\u52A8";
        }
      });
    }
    function save() {
      const candidate = {
        apiUrl: apiUrlEl.value.trim(),
        crop: cropEl.checked,
        autoConnect: autoConnectEl.checked,
        replaceMode: modeReplaceEl.checked,
        autoWhiteBg: autoWhiteBgEl.checked,
        bgSize: parseFloat(bgSizeEl.value),
        bgRatio: parseFloat(bgRatioEl.value) / 100,
        // 表单是百分比，存储是 0~1
        bgMode: bgModeEl.value,
        compressWidth: parseFloat(compressWidthEl.value),
        compressQuality: parseFloat(compressQualityEl.value)
      };
      const config = mergeConfig(candidate);
      chrome.runtime.sendMessage({ type: "SAVE_CONFIG", config }, (resp) => {
        if (resp && resp.success) {
          fillForm(resp.config || config);
          saveBtn.textContent = "\u5DF2\u4FDD\u5B58";
          setTimeout(() => {
            saveBtn.textContent = "\u4FDD\u5B58";
          }, 1500);
          checkApiStatus(config.apiUrl);
        }
      });
    }
    saveBtn.addEventListener("click", save);
    testBtn.addEventListener("click", () => {
      checkApiStatus(apiUrlEl.value.trim() || DEFAULT_CONFIG.apiUrl);
    });
    const LEVEL_MARK = { ok: "\u2713", info: "\xB7", warn: "!", error: "\u2715" };
    function renderProbe(results, error) {
      probeResult.hidden = false;
      if (error) {
        probeResult.innerHTML = `<div class="probe-item error"><span class="mk">\u2715</span><span>${escapeHtml(error)}</span></div>`;
        return;
      }
      probeResult.innerHTML = results.map((r) => `<div class="probe-item ${r.ok ? r.level : "error"}"><span class="mk">${LEVEL_MARK[r.level] || "\xB7"}</span><span>${escapeHtml(r.name)}\uFF1A<span class="dt">${escapeHtml(r.detail)}</span></span></div>`).join("");
    }
    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
    }
    probeBtn.addEventListener("click", () => {
      probeResult.hidden = false;
      probeResult.innerHTML = '<div class="probe-item info"><span class="mk">\xB7</span><span>\u68C0\u67E5\u4E2D...</span></div>';
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs && tabs[0];
        if (!tab || tab.id == null) {
          renderProbe(null, "\u627E\u4E0D\u5230\u5F53\u524D\u6807\u7B7E\u9875");
          return;
        }
        chrome.tabs.sendMessage(tab.id, { type: "RUN_PROBE" }, (resp) => {
          if (chrome.runtime.lastError) {
            renderProbe(null, `\u65E0\u6CD5\u81EA\u68C0\uFF1A${chrome.runtime.lastError.message}\uFF08\u8BF7\u5728\u5DE5\u4F5C\u53F0\u9875\u9762\u4E0A\u6253\u5F00\u672C\u5F39\u7A97\uFF09`);
            return;
          }
          if (!resp || !resp.success) {
            renderProbe(null, resp && resp.error || "\u9875\u9762\u672A\u54CD\u5E94\u81EA\u68C0");
            return;
          }
          renderProbe(resp.results);
        });
      });
    });
  });
})();
