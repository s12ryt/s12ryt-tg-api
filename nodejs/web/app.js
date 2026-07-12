/**
 * S12RYT Web 配置面板 — Vanilla JS SPA
 *
 * 零依賴、無構建工具。全部功能在一個文件中。
 *
 * 架構：
 *   - API: 封裝 fetch 調用
 *   - Router: hash-based 路由
 *   - Pages: 每個路由對應一個 render 函數
 *   - Utils: toast, modal, format 等工具函數
 */

(function () {
  "use strict";

  // =========================================================================
  // State
  // =========================================================================

  const state = {
    sessionToken: null,
    user: null, // { tgUserId, isAdmin, username, isActive, userType }
    models: [],
    authConfig: null, // { authMode: "telegram"|"password", needsSetup: boolean }
  };

  let systemUsageTimer = null;

  // =========================================================================
  // API Layer
  // =========================================================================

  const API = {
    async call(method, path, body) {
      const opts = {
        method,
        headers: {
          "Content-Type": "application/json",
        },
      };
      if (state.sessionToken) {
        opts.headers["Authorization"] = `Bearer ${state.sessionToken}`;
      }
      if (body !== undefined) {
        opts.body = JSON.stringify(body);
      }

      // 超時 + 網路錯誤處理
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      opts.signal = controller.signal;

      let resp;
      try {
        resp = await fetch(path, opts);
      } catch (netErr) {
        clearTimeout(timer);
        if (netErr.name === "AbortError") {
          throw new Error("請求逾時，請稍後再試");
        }
        throw new Error("網路連線失敗，請檢查網路狀態");
      }
      clearTimeout(timer);

      const data = await resp.json().catch(() => ({}));

      if (!resp.ok) {
        const msg = data.error || `HTTP ${resp.status}`;
        if (resp.status === 401) {
          handleSessionExpired("登入已過期，請重新登入");
          return new Promise(() => {}); // 停止執行，不觸發 caller 的 catch
        }
        if (resp.status === 404) {
          throw new Error(`請求的資源不存在 (${path})，可能是版本過舊或端點已變更`);
        }
        throw new Error(msg);
      }
      return data;
    },

    get: (p) => API.call("GET", p),
    post: (p, b) => API.call("POST", p, b),
    put: (p, b) => API.call("PUT", p, b),
    del: (p, b) => API.call("DELETE", p, b),
  };

  // =========================================================================
  // Utils
  // =========================================================================

  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return document.querySelectorAll(sel); }

  function esc(str) {
    if (str === null || str === undefined) return "";
    return String(str)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }

  function fmtNum(n, decimals = 0) {
    if (n === null || n === undefined) return "0";
    return Number(n).toLocaleString("en-US", { maximumFractionDigits: decimals });
  }

  function fmtCost(n) {
    if (!n || n === 0) return "$0.00";
    return `$${Number(n).toFixed(4)}`;
  }

  function fmtDate(str) {
    if (!str) return "--";
    try {
      const d = new Date(str.includes("T") ? str : str.replace(" ", "T") + "Z");
      return d.toLocaleString("zh-TW", { hour12: false });
    } catch {
      return str;
    }
  }

  function fmtPercent(value) {
    return value === null || value === undefined ? "取樣中" : `${fmtNum(value, 2)}%`;
  }

  function fmtDuration(seconds) {
    const total = Number(seconds || 0);
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = Math.floor(total % 60);
    if (days > 0) return `${days}天 ${hours}小時 ${minutes}分`;
    if (hours > 0) return `${hours}小時 ${minutes}分`;
    if (minutes > 0) return `${minutes}分 ${secs}秒`;
    return `${secs}秒`;
  }

  function clampPercent(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return 0;
    return Math.max(0, Math.min(100, Number(value)));
  }

  function usageLevelClass(value) {
    if (value === null || value === undefined) return "";
    if (value >= 90) return "danger";
    if (value >= 75) return "warning";
    return "good";
  }

  function copy(text) {
    navigator.clipboard.writeText(text).then(
      () => toast("已複製到剪貼簿", "success"),
      () => toast("複製失敗", "error")
    );
  }


  // --- SVG Icons (Lucide-style, size controlled by CSS) ---
  function svg(p) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>';
  }
  const ic = {
    zap: svg('<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>'),
    link: svg('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
    chart: svg('<path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>'),
    code: svg('<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>'),
    calendar: svg('<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>'),
    ban: svg('<circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>'),
    plug: svg('<path d="M22 12h-5l-3 9L9 3l-3 9H2"/>'),
    users: svg('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
    settings: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
    flask: svg('<path d="M9 2v6l-5 9a3 3 0 0 0 2.6 4.5h10.8A3 3 0 0 0 20 17l-5-9V2"/><path d="M7 2h10"/><path d="M7.7 14h8.6"/>'),
    clipboard: svg('<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/>'),
    eye: svg('<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'),
    refresh: svg('<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>'),
    download: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'),
    alert: svg('<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'),
    key: svg('<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>'),
    trending: svg('<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>'),
    check: svg('<polyline points="20 6 9 17 4 12"/>'),
    x: svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
    target: svg('<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>'),
    search: svg('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
    dollar: svg('<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>'),
    lock: svg('<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'),
    inbox: svg('<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>'),
    sparkles: svg('<path d="M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2z"/>'),
  };

  // --- Toast ---
  function toast(msg, type = "info") {
    const el = document.createElement("div");
    el.className = `toast toast-${type}`;
    el.textContent = msg;
    $("#toast-container").appendChild(el);
    setTimeout(() => {
      el.style.opacity = "0";
      el.style.transform = "translateX(120%)";
      setTimeout(() => el.remove(), 300);
    }, 3000);
  }

  // --- Modal ---
  function showModal(title, bodyHTML, actions = []) {
    $("#modal-title").innerHTML = title;
    $("#modal-body").innerHTML = bodyHTML;

    // 清除舊 actions
    const existing = $("#modal-body .modal-actions");
    if (existing) existing.remove();

    if (actions.length > 0) {
      const wrap = document.createElement("div");
      wrap.className = "modal-actions";
      for (const a of actions) {
        const btn = document.createElement("button");
        btn.className = `btn ${a.class || "btn-primary"}`;
        btn.textContent = a.label;
        btn.onclick = () => {
          if (a.onClick) a.onClick($("#modal-body"));
          if (a.close !== false) closeModal();
        };
        wrap.appendChild(btn);
      }
      $("#modal-body").appendChild(wrap);
    }

    $("#modal-overlay").classList.remove("hidden");
  }

  function closeModal() {
    $("#modal-overlay").classList.add("hidden");
  }

  // --- Confirm ---
  function confirm(msg, onYes) {
    showModal("確認", `<p>${esc(msg)}</p>`, [
      { label: "取消", class: "btn-ghost" },
      { label: "確認", class: "btn-danger", onClick: () => onYes() },
    ]);
  }

  // --- Model Picker (nested overlay for selecting from fetched models) ---
  function showModelPicker(models, onConfirm, opts) {
    var preSelected = opts && opts.preSelected ? opts.preSelected : null;
    var confirmLabel = opts && opts.confirmLabel ? opts.confirmLabel : "確認添加";
    var existing = $("#model-picker-overlay");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "model-picker-overlay";
    overlay.className = "modal-overlay";
    overlay.style.zIndex = "60";

    overlay.innerHTML =
      '<div class="modal" style="max-width:600px;">' +
      '  <div class="modal-header">' +
      '    <h3>選擇模型（共 ' + models.length + ' 個）</h3>' +
      '    <button class="modal-close" id="mp-close" aria-label="關閉">&times;</button>' +
      "  </div>" +
      '  <div class="modal-body">' +
      '    <input type="text" id="mp-search" placeholder="搜尋模型..." autocomplete="off" style="width:100%;margin-bottom:12px;">' +
      '    <div style="display:flex;gap:8px;margin-bottom:12px;align-items:center;">' +
      '      <button class="btn btn-ghost btn-sm" id="mp-select-all">全選</button>' +
      '      <button class="btn btn-ghost btn-sm" id="mp-deselect-all">全不選</button>' +
      '      <span style="margin-left:auto;color:var(--text-tertiary);font-size:13px;" id="mp-count">已選 0 個</span>' +
      "    </div>" +
      '    <div id="mp-list" style="max-height:350px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;">' +
      models
        .map(function (m) {
          var isChecked = preSelected ? (preSelected.indexOf(m) !== -1) : true;
          return (
            '<label class="mp-item" style="display:flex;align-items:center;gap:8px;padding:6px 10px;cursor:pointer;">' +
            '<input type="checkbox" class="mp-checkbox" value="' + esc(String(m)) + '"' + (isChecked ? " checked" : "") + '>' +
            '<span style="font-family:var(--mono);font-size:13px;word-break:break-all;">' + esc(String(m)) + "</span>" +
            "</label>"
          );
        })
        .join("") +
      "    </div>" +
      '    <div class="modal-actions">' +
      '      <button class="btn btn-ghost" id="mp-cancel">取消</button>' +
      '      <button class="btn btn-primary" id="mp-confirm">' + confirmLabel + '</button>' +
      "    </div>" +
      "  </div>" +
      "</div>";

    document.body.appendChild(overlay);

    function updateCount() {
      var checked = overlay.querySelectorAll(".mp-checkbox:checked").length;
      $("#mp-count").textContent = "已選 " + checked + " 個";
      var btn = $("#mp-confirm");
      btn.textContent = checked > 0 ? confirmLabel + " (" + checked + ")" : confirmLabel;
      btn.disabled = checked === 0;
    }

    function close() { overlay.remove(); }

    // Search filter (real-time)
    $("#mp-search").oninput = function (e) {
      var q = e.target.value.toLowerCase();
      overlay.querySelectorAll(".mp-item").forEach(function (item) {
        var text = item.querySelector("span").textContent.toLowerCase();
        item.style.display = text.indexOf(q) !== -1 ? "flex" : "none";
      });
    };

    // Select all (visible only)
    $("#mp-select-all").onclick = function () {
      overlay.querySelectorAll(".mp-item").forEach(function (item) {
        if (item.style.display !== "none") {
          item.querySelector(".mp-checkbox").checked = true;
        }
      });
      updateCount();
    };

    // Deselect all (visible only)
    $("#mp-deselect-all").onclick = function () {
      overlay.querySelectorAll(".mp-item").forEach(function (item) {
        if (item.style.display !== "none") {
          item.querySelector(".mp-checkbox").checked = false;
        }
      });
      updateCount();
    };

    // Per-item change
    overlay.querySelectorAll(".mp-checkbox").forEach(function (cb) {
      cb.onchange = updateCount;
    });

    // Confirm
    $("#mp-confirm").onclick = function () {
      var selected = Array.from(overlay.querySelectorAll(".mp-checkbox:checked")).map(function (cb) {
        return cb.value;
      });
      if (selected.length === 0) return;
      close();
      onConfirm(selected);
    };

    // Cancel / close
    $("#mp-cancel").onclick = close;
    $("#mp-close").onclick = close;
    overlay.onclick = function (e) { if (e.target === overlay) close(); };

    updateCount();
    setTimeout(function () { $("#mp-search") && $("#mp-search").focus(); }, 50);
  }

  // =========================================================================
  // Login Flow
  // =========================================================================

  function showLogin(msg = "請稍候") {
    $("#app").classList.add("hidden");
    $("#login-screen").classList.remove("hidden");
    $("#login-loading").classList.remove("hidden");
    $("#login-password").classList.add("hidden");
    $("#login-setup").classList.add("hidden");
    $("#login-msg").textContent = msg;
  }

  function showLoginPassword(msg = "") {
    $("#app").classList.add("hidden");
    $("#login-screen").classList.remove("hidden");
    $("#login-loading").classList.add("hidden");
    $("#login-password").classList.remove("hidden");
    $("#login-setup").classList.add("hidden");
    $("#login-password-msg").textContent = msg;
    const u = $("#login-username");
    if (u && !u.value) setTimeout(() => u.focus(), 50);
  }

  function showLoginSetup(msg = "") {
    $("#app").classList.add("hidden");
    $("#login-screen").classList.remove("hidden");
    $("#login-loading").classList.add("hidden");
    $("#login-password").classList.add("hidden");
    $("#login-setup").classList.remove("hidden");
    $("#setup-msg").textContent = msg;
    const u = $("#setup-username");
    if (u && !u.value) setTimeout(() => u.focus(), 50);
  }

  function handleSessionExpired(msg) {
    state.sessionToken = null;
    state.user = null;
    localStorage.removeItem("web_session");
    // 有自定義登入路徑時，跳轉過去（確保 URL 正確 + cookie 已被後端清除）
    if (state.authConfig && state.authConfig.loginPath) {
      window.location.href = state.authConfig.loginPath;
      return;
    }
    if (state.authConfig && state.authConfig.authMode === "password") {
      if (state.authConfig.needsSetup) {
        showLoginSetup(msg);
      } else {
        showLoginPassword(msg);
      }
    } else {
      showLogin(msg);
    }
  }

  function showApp() {
    $("#login-screen").classList.add("hidden");
    $("#app").classList.remove("hidden");
  }

  async function tryLogin() {
    // 先取得認證模式配置
    try {
      state.authConfig = await API.get("/web/api/auth/config");
    } catch {
      // 無法取得配置，回退到 telegram 模式
      state.authConfig = { authMode: "telegram", needsSetup: false };
    }

    // 從 localStorage 取已有 session
    const saved = localStorage.getItem("web_session");
    if (saved) {
      state.sessionToken = saved;
      try {
        const me = await API.get("/web/api/auth/me");
        onLoginSuccess(me);
        return;
      } catch {
        localStorage.removeItem("web_session");
        state.sessionToken = null;
      }
    }

    // 從 URL 取 token（telegram 模式 OTP）
    const params = new URLSearchParams(location.search);
    const token = params.get("token");

    // telegram 模式
    if (state.authConfig.authMode === "telegram") {
      if (token) {
        try {
          const result = await API.post("/web/api/auth/login", { token });
          state.sessionToken = result.sessionToken;
          localStorage.setItem("web_session", result.sessionToken);
          const me = await API.get("/web/api/auth/me");
          onLoginSuccess(me);
          history.replaceState(null, "", location.pathname);
          return;
        } catch (err) {
          showLogin(err.message || "登入連結已過期，請重新從 Bot 取得");
          return;
        }
      }
      showLogin("請從 Telegram Bot 使用 /web 指令取得登入連結");
      return;
    }

    // password 模式
    if (state.authConfig.authMode === "password") {
      // 首次設定，顯示引導頁面
      if (state.authConfig.needsSetup) {
        showLoginSetup("首次使用，請建立管理員帳號");
        return;
      }
      // 顯示帳密登入表單
      showLoginPassword();
      return;
    }

    // 未知模式，回退
    showLogin("無法識別認證模式，請檢查設定");
  }

  function onLoginSuccess(me) {
    // 成功到達 panelPath，清除 redirect 標記
    if (me.panelPath && window.location.pathname === me.panelPath) {
      sessionStorage.removeItem("tried_panel_redirect");
    }
    // 如果有 panelPath 且當前不在 panelPath 上，嘗試 redirect
    if (me.panelPath && window.location.pathname !== me.panelPath) {
      // 防止無限 redirect 迴圈（cookie 無效但 session 有效時最多嘗試一次）
      if (!sessionStorage.getItem("tried_panel_redirect")) {
        sessionStorage.setItem("tried_panel_redirect", "1");
        window.location.href = me.panelPath;
        return;
      }
      // redirect 回來了（cookie 無效），清除標記，在當前頁面顯示應用
      sessionStorage.removeItem("tried_panel_redirect");
    }
    state.user = me;
    // 更新 UI
    $("#user-name").textContent = me.username || `ID: ${me.tgUserId}`;
    const roleEl = $("#user-role");
    if (me.isAdmin) {
      roleEl.textContent = "管理員";
      roleEl.classList.add("admin");
      $("#admin-nav").classList.remove("hidden");
    } else {
      roleEl.textContent = "用戶";
      roleEl.classList.remove("admin");
    }

    // password 模式才顯示帳號設定相關導航
    if (state.authConfig && state.authConfig.authMode === "password") {
      const navAccount = $("#nav-account");
      if (navAccount) navAccount.classList.remove("hidden");
      if (me.isAdmin) {
        const navWebUsers = $("#nav-web-users");
        if (navWebUsers) navWebUsers.classList.remove("hidden");
      }
    }

    showApp();

    // 初始化路由
    if (!location.hash) location.hash = "#/dashboard";
    handleRoute();
  }

  // =========================================================================
  // Router
  // =========================================================================

  const routes = {
    "/dashboard": pageDashboard,
    "/keys": pageKeys,
    "/usage": pageUsage,
    "/coding": pageCoding,
    "/limits": pageLimits,
    "/restrictions": pageRestrictions,
    "/account": pageAccount,
    "/providers": pageProviders,
    "/users": pageUsers,
    "/web-users": pageWebUsers,
    "/groups": pageGroups,
    "/all-usage": pageAllUsage,
    "/api-test": pageApiTest,
    "/model-catch": pageModelCatch,
    "/model-mapping": pageModelMapping,
    "/api-logs": pageApiLogs,
    "/system-usage": pageSystemUsage,
    "/plugins": pagePlugins,
    "/system": pageSystem,
  };

  window.addEventListener("hashchange", handleRoute);

  function setMobileNav(open) {
    const sidebar = $("#sidebar");
    const overlay = $("#mobile-nav-overlay");
    const toggle = $("#mobile-nav-toggle");
    if (!sidebar || !overlay || !toggle) return;

    sidebar.classList.toggle("open", open);
    overlay.classList.toggle("open", open);
    overlay.setAttribute("aria-hidden", open ? "false" : "true");
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    document.body.classList.toggle("nav-open", open);
  }

  function closeMobileNav() {
    setMobileNav(false);
  }

  function toggleMobileNav() {
    const sidebar = $("#sidebar");
    setMobileNav(sidebar ? !sidebar.classList.contains("open") : false);
  }

  function stopSystemUsagePolling() {
    if (systemUsageTimer) {
      clearInterval(systemUsageTimer);
      systemUsageTimer = null;
    }
  }

  function handleRoute() {
    const hash = location.hash.slice(1) || "/dashboard";
    if (hash === "/settings") {
      location.hash = "#/system";
      return;
    }
    const route = routes[hash];

    // 更新導覽列
    $$(".nav-item").forEach((el) => el.classList.remove("active"));
    const navEl = $(`.nav-item[data-route="${hash.slice(1)}"]`);
    if (navEl) navEl.classList.add("active");

    // 行動端：導航後自動收合側欄
    closeMobileNav();
    stopSystemUsagePolling();

    if (route) {
      route();
    } else {
      $("#main-content").innerHTML = `<div class="empty-state"><div class="icon"><svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg></div><div class="title">找不到頁面</div></div>`;
    }
  }

  // 頁面切換時設定標題
  function setPage(title, desc = "") {
    $("#main-content").innerHTML = `
      <div class="page-header">
        <h2>${esc(title)}</h2>
        ${desc ? `<p>${esc(desc)}</p>` : ""}
      </div>
      <div id="page-body"></div>
    `;
    return $("#page-body");
  }

  function loading(msg = "載入中...") {
    return `<div class="loading"><div class="spinner"></div><p>${esc(msg)}</p></div>`;
  }

  function errorState(msg, title = "載入失敗") {
    return `<div class="empty-state"><div class="icon">${ic.alert}</div><div class="title">${esc(title)}</div><p>${esc(msg)}</p></div>`;
  }

  function skeleton(rows = 4) {
    let html = '<div class="card" style="padding:16px;">';
    for (let i = 0; i < rows; i++) {
      html += `<div class="skeleton skeleton-line${i % 3 === 2 ? ' short' : ''}"></div>`;
    }
    html += '</div>';
    return html;
  }

  // =========================================================================
  // Pages — Dashboard
  // =========================================================================

  async function pageDashboard() {
    const body = setPage("總覽", "快速查看您的帳號狀態");
    body.innerHTML = loading();

    try {
      const [limitsData, keysData] = await Promise.all([
        API.get("/web/api/limits"),
        API.get("/web/api/keys"),
      ]);

      const l = limitsData.limits || {};
      const daily = limitsData.daily || {};
      const monthly = limitsData.monthly || {};
      const keys = keysData.keys || [];

      body.innerHTML = `
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-label">API Keys</div>
            <div class="stat-value">${keys.length}</div>
            <div class="stat-sub">個金鑰</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">今日 Token</div>
            <div class="stat-value">${fmtNum((daily.total_input_tokens || 0) + (daily.total_output_tokens || 0))}</div>
            <div class="stat-sub">輸入 ${fmtNum(daily.total_input_tokens || 0)} / 輸出 ${fmtNum(daily.total_output_tokens || 0)}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">今日花費</div>
            <div class="stat-value">${fmtCost(daily.total_cost || 0)}</div>
            <div class="stat-sub">USD</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">本月 Token</div>
            <div class="stat-value">${fmtNum((monthly.total_input_tokens || 0) + (monthly.total_output_tokens || 0))}</div>
            <div class="stat-sub">輸入 ${fmtNum(monthly.total_input_tokens || 0)} / 輸出 ${fmtNum(monthly.total_output_tokens || 0)}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">本月花費</div>
            <div class="stat-value">${fmtCost(monthly.total_cost || 0)}</div>
            <div class="stat-sub">USD</div>
          </div>
        </div>

        <div class="card">
          <div class="card-title">${ic.zap} 有效限制</div>
          <div class="table-wrap table-wrap-compact">
            <table>
              <tbody>
                <tr><td>RPM（每分鐘請求）</td><td><strong>${l.rpm || "無限制"}</strong></td></tr>
                <tr><td>TPM（每分鐘 Token）</td><td><strong>${fmtNum(l.tpm || 0)}</strong></td></tr>
                <tr><td>並發連接</td><td><strong>${l.concurrency || "無限制"}</strong></td></tr>
                <tr><td>每日 Token 上限</td><td><strong>${l.daily_token ? fmtNum(l.daily_token) : "無限制"}</strong></td></tr>
                <tr><td>每月 Token 上限</td><td><strong>${l.monthly_token ? fmtNum(l.monthly_token) : "無限制"}</strong></td></tr>
                <tr><td>每日花費上限</td><td><strong>${l.daily_cost ? fmtCost(l.daily_cost) : "無限制"}</strong></td></tr>
                <tr><td>每月花費上限</td><td><strong>${l.monthly_cost ? fmtCost(l.monthly_cost) : "無限制"}</strong></td></tr>
                <tr><td>使用期限</td><td><strong>${l.expires_at ? fmtDate(l.expires_at) : "永久"}</strong></td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="card">
          <div class="card-title">${ic.link} 快速操作</div>
          <div class="action-row">
            <a href="#/keys" class="btn btn-primary">管理 API Keys</a>
            <a href="#/coding" class="btn btn-ghost">Coding 設定</a>
            <a href="#/usage" class="btn btn-ghost">查看用量</a>
            <a href="#/limits" class="btn btn-ghost">限制詳情</a>
          </div>
        </div>
      `;
    } catch (err) {
      body.innerHTML = errorState(err.message);
    }
  }

  // =========================================================================
  // Pages — API Keys
  // =========================================================================

  async function pageKeys() {
    const body = setPage("API Keys", "管理您的 API 金鑰");
    body.innerHTML = loading();

    try {
      const data = await API.get("/web/api/keys");
      const keys = data.keys || [];

      body.innerHTML = `
        <div class="action-row action-row-spaced">
          <button class="btn btn-primary" id="btn-add-key">${ic.key} 新增 API Key</button>
        </div>
        ${keys.length === 0
          ? `<div class="empty-state"><div class="icon">${ic.key}</div><div class="title">尚無 API Key</div><p>點擊上方按鈕新增</p></div>`
          : `<div class="card"><div class="table-wrap"><table>
              <thead><tr><th>ID</th><th>Key</th><th>狀態</th><th>建立時間</th><th>操作</th></tr></thead>
              <tbody>
                ${keys.map((k) => `
                  <tr>
                    <td>${k.id}</td>
                    <td><code>${esc(k.keyPreview || k.key)}</code></td>
                    <td>${Number(k.is_active) === 1 ? '<span class="badge badge-success">啟用</span>' : '<span class="badge badge-danger">停用</span>'}</td>
                    <td>${fmtDate(k.created_at)}</td>
                    <td style="display:flex;gap:4px;">
                      <button class="btn-icon" onclick="window._viewKey(${k.id})" title="查看完整 Key" aria-label="查看完整 Key">${ic.eye}</button>
                      <button class="btn-icon" onclick="window._copyKey(${k.id})" title="複製完整 Key" aria-label="複製完整 Key">${ic.clipboard}</button>
                      <button class="btn-icon danger" onclick="window._delKey(${k.id})" title="刪除" aria-label="刪除 API Key">${ic.x}</button>
                    </td>
                  </tr>
                `).join("")}
              </tbody>
            </table></div></div>`
        }
      `;

      $("#btn-add-key").onclick = addKey;

      window._viewKey = async (id) => {
        try {
          const data = await API.get(`/web/api/keys/${id}`);
          const fullKey = data.key.key;
          showModal(
            "查看 API Key",
            `
              <p style="margin-bottom:12px;color:var(--text-secondary);">完整 API Key：</p>
              <div class="key-display">
                <span>${esc(fullKey)}</span>
                <button class="copy-btn" id="modal-copy-key" title="複製" aria-label="複製完整 Key">${ic.clipboard}</button>
              </div>
              <p style="margin-top:8px;color:var(--text-muted);font-size:12px;">建立時間：${fmtDate(data.key.created_at)}</p>
            `,
            [{ label: "關閉", class: "btn-primary" }]
          );
          const copyBtn = $("#modal-copy-key");
          if (copyBtn) copyBtn.onclick = () => copy(fullKey);
        } catch (err) {
          toast(err.message, "error");
        }
      };

      window._copyKey = async (id) => {
        try {
          const data = await API.get(`/web/api/keys/${id}`);
          copy(data.key.key);
        } catch (err) {
          toast(err.message, "error");
        }
      };

      window._delKey = (id) => {
        confirm("確定要刪除這個 API Key？刪除後無法恢復。", async () => {
          try {
            await API.del(`/web/api/keys/${id}`);
            toast("已刪除", "success");
            pageKeys();
          } catch (err) {
            toast(err.message, "error");
          }
        });
      };
    } catch (err) {
      body.innerHTML = errorState(err.message);
    }
  }

  async function addKey() {
    try {
      const result = await API.post("/web/api/keys");
      showModal(
        "API Key 已建立",
        `
          <p style="margin-bottom:12px;color:var(--text-secondary);">請立即複製保存，此 Key 只會顯示一次：</p>
          <div class="key-display">
            <span>${esc(result.key)}</span>
            <button class="copy-btn" id="btn-copy-new-key" title="複製 API Key" aria-label="複製 API Key">${ic.clipboard}</button>
          </div>
        `,
        [{ label: "關閉", class: "btn-primary" }]
      );
      const copyNewKeyBtn = $("#btn-copy-new-key");
      if (copyNewKeyBtn) {
        copyNewKeyBtn.onclick = () => {
          copy(result.key);
          copyNewKeyBtn.innerHTML = ic.check;
        };
      }
      pageKeys();
    } catch (err) {
      toast(err.message, "error");
    }
  }

  // =========================================================================
  // Pages — Usage
  // =========================================================================

  async function pageUsage() {
    const body = setPage("用量統計", "查看各 API Key 的 Token 用量與花費");
    body.innerHTML = loading();

    try {
      const data = await API.get("/web/api/usage");
      const records = data.records || [];
      const summary = data.summary || {};

      // 按 model 統計
      const byModel = {};
      for (const r of records) {
        const m = r.model || "unknown";
        if (!byModel[m]) byModel[m] = { input: 0, output: 0, cost: 0, count: 0 };
        byModel[m].input += Number(r.input_tokens) || 0;
        byModel[m].output += Number(r.output_tokens) || 0;
        byModel[m].cost += (Number(r.input_cost) || 0) + (Number(r.output_cost) || 0);
        byModel[m].count++;
      }

      const modelRows = Object.entries(byModel)
        .sort((a, b) => b[1].cost - a[1].cost)
        .map(([m, s]) => `
          <tr>
            <td><code>${esc(m)}</code></td>
            <td>${fmtNum(s.input)}</td>
            <td>${fmtNum(s.output)}</td>
            <td>${fmtNum(s.input + s.output)}</td>
            <td>${fmtCost(s.cost)}</td>
            <td>${s.count}</td>
          </tr>
        `).join("");

      body.innerHTML = `
        <div class="card">
          <div class="card-title">${ic.chart} 按模型統計（最近 ${records.length} 筆）</div>
          ${records.length === 0
            ? `<div class="empty-state"><div class="icon">${ic.trending}</div><div class="title">暫無用量記錄</div></div>`
            : `<div class="table-wrap"><table>
                <thead><tr><th>模型</th><th>輸入 Token</th><th>輸出 Token</th><th>總 Token</th><th>花費</th><th>次數</th></tr></thead>
                <tbody>${modelRows}</tbody>
              </table></div>`
          }
        </div>
      `;
    } catch (err) {
      body.innerHTML = errorState(err.message);
    }
  }

  // =========================================================================
  // Pages — Coding Mode
  // =========================================================================

  async function pageCoding() {
    const body = setPage("Coding 模式", "設定 fallback 模型鏈，API 報錯時自動重試");
    body.innerHTML = loading();

    try {
      const data = await API.get("/web/api/coding");
      const cfg = data.config;
      const models = await API.get("/web/api/models");
      const allModels = models.models || [];

      body.innerHTML = `
        <div class="card">
          <div class="card-title">${ic.code} Coding 模式設定</div>
          <div class="form-group">
            <label class="toggle-wrap">
              <span class="toggle-switch">
                <input type="checkbox" id="coding-active" ${cfg && Number(cfg.is_active) === 1 ? "checked" : ""}>
                <span class="toggle-slider"></span>
              </span>
              <span>啟用 Coding 模式</span>
            </label>
            <div class="hint">啟用後，API 報錯時會按 fallback 模型鏈自動重試</div>
          </div>
          <div class="form-group">
            <label>Fallback 模型鏈</label>
            <textarea id="coding-models" placeholder="model-a,model-b,model-c">${esc(cfg?.fallback_models || "")}</textarea>
            <div class="hint">逗號分隔的模型名稱，按順序嘗試。留空表示使用全部可用模型。</div>
          </div>
          <div class="form-group">
            <label>最大重試次數</label>
            <input type="number" id="coding-retries" value="${cfg?.max_retries ?? 3}" min="1" max="10">
          </div>
          ${allModels.length > 0 ? (() => {
            const fallbackSet = new Set((cfg?.fallback_models || "").split(",").map((s) => s.trim()).filter(Boolean));
            return `
              <div style="margin-bottom:16px;">
                <strong style="font-size:13px;color:var(--text-secondary);">可用模型（點擊加入 / 移除）：</strong>
                <div id="coding-chips" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;max-height:200px;overflow-y:auto;">
                  ${allModels.map((m) => `<button type="button" class="btn-icon${fallbackSet.has(m) ? " selected" : ""}" data-model="${esc(m)}">${esc(m)}</button>`).join("")}
                </div>
              </div>
            `;
          })() : ""}
          <button class="btn btn-primary" id="btn-save-coding">儲存設定</button>
        </div>
      `;

      $("#btn-save-coding").onclick = async () => {
        try {
          await API.put("/web/api/coding", {
            isActive: $("#coding-active").checked,
            fallbackModels: $("#coding-models").value.trim(),
            maxRetries: parseInt($("#coding-retries").value, 10) || 3,
          });
          toast("設定已儲存", "success");
        } catch (err) {
          toast(err.message, "error");
        }
      };

      // 模型 chips：點擊 toggle 加入/移除
      const codingChips = document.querySelector("#coding-chips");
      if (codingChips) {
        codingChips.querySelectorAll(".btn-icon").forEach(btn => {
          btn.onclick = () => {
            const model = btn.dataset.model;
            const ta = $("#coding-models");
            const current = ta.value.split(",").map((s) => s.trim()).filter(Boolean);
            const idx = current.indexOf(model);
            if (idx >= 0) {
              current.splice(idx, 1);
              btn.classList.remove("selected");
            } else {
              current.push(model);
              btn.classList.add("selected");
            }
            ta.value = current.join(",");
          };
        });
      }
    } catch (err) {
      body.innerHTML = errorState(err.message);
    }
  }

  // =========================================================================
  // Pages — Limits
  // =========================================================================

  async function pageLimits() {
    const body = setPage("我的限制", "查看您的有效限制和用量");
    body.innerHTML = loading();

    try {
      const data = await API.get("/web/api/limits");
      const l = data.limits || {};
      const daily = data.daily || {};
      const monthly = data.monthly || {};

      function limitRow(label, used, limit, fmt = fmtNum) {
        const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
        const barColor = pct >= 90 ? "var(--danger)" : pct >= 70 ? "var(--warning)" : "var(--success)";
        return `
          <tr>
            <td style="width:200px;">${label}</td>
            <td><strong>${fmt(used)}</strong></td>
            <td>${limit > 0 ? fmt(limit) : "無限制"}</td>
            <td style="width:200px;">
              ${limit > 0 ? `
                <div style="background:var(--bg-primary);border-radius:4px;height:8px;overflow:hidden;">
                  <div style="width:${pct}%;height:100%;background:${barColor};transition:width 0.3s;"></div>
                </div>
                <span style="font-size:11px;color:var(--text-muted);">${pct.toFixed(1)}%</span>
              ` : '<span class="badge badge-success">無限制</span>'}
            </td>
          </tr>
        `;
      }

      body.innerHTML = `
        <div class="card">
          <div class="card-title">${ic.zap} 有效限制</div>
          <table>
            <tbody>
              <tr><td style="width:200px;">RPM</td><td><strong>${l.rpm || "無限制"}</strong></td><td colspan="2"></td></tr>
              <tr><td>TPM</td><td><strong>${fmtNum(l.tpm || 0)}</strong></td><td colspan="2"></td></tr>
              <tr><td>並發</td><td><strong>${l.concurrency || "無限制"}</strong></td><td colspan="2"></td></tr>
              <tr><td>使用期限</td><td colspan="3"><strong>${l.expires_at ? fmtDate(l.expires_at) : "永久"}</strong></td></tr>
            </tbody>
          </table>
        </div>

        <div class="card">
          <div class="card-title">${ic.calendar} 今日用量</div>
          <table>
            <thead><tr><th>項目</th><th>已用</th><th>上限</th><th>進度</th></tr></thead>
            <tbody>
              ${limitRow("Token", (Number(daily.total_input_tokens)||0)+(Number(daily.total_output_tokens)||0), l.daily_token)}
              ${limitRow("花費 (USD)", Number(daily.total_cost)||0, l.daily_cost, fmtCost)}
            </tbody>
          </table>
        </div>

        <div class="card">
          <div class="card-title">${ic.calendar} 本月用量</div>
          <table>
            <thead><tr><th>項目</th><th>已用</th><th>上限</th><th>進度</th></tr></thead>
            <tbody>
              ${limitRow("Token", (Number(monthly.total_input_tokens)||0)+(Number(monthly.total_output_tokens)||0), l.monthly_token)}
              ${limitRow("花費 (USD)", Number(monthly.total_cost)||0, l.monthly_cost, fmtCost)}
            </tbody>
          </table>
        </div>
      `;
    } catch (err) {
      body.innerHTML = errorState(err.message);
    }
  }

  // =========================================================================
  // Pages — Model Restrictions
  // =========================================================================

  async function pageRestrictions() {
    const body = setPage("模型限制", "查看您的模型存取限制");
    body.innerHTML = loading();

    try {
      const data = await API.get("/web/api/restrictions");
      const restrictions = data.restrictions || [];

      body.innerHTML = `
        <div class="card">
          <div class="card-title">${ic.ban} 模型存取限制</div>
          ${restrictions.length === 0
            ? `<div class="empty-state"><div class="icon">${ic.check}</div><div class="title">無特殊限制</div><p>${state.user?.isAdmin ? "管理員可存取所有模型" : "使用預設規則"}</p></div>`
            : restrictions.map((r) => {
                const models = (r.models || "").split(",").filter(Boolean);
                return `
                  <div style="margin-bottom:16px;padding-bottom:16px;border-bottom:1px solid var(--border);">
                    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
                      <span class="badge ${r.mode === "whitelist" ? "badge-success" : "badge-danger"}">${r.mode === "whitelist" ? "白名單" : "黑名單"}</span>
                      <span style="font-size:13px;color:var(--text-secondary);">
                        ${r.api_key_id ? `Key #${r.api_key_id}` : "用戶級別"}
                      </span>
                    </div>
                    <div style="display:flex;flex-wrap:wrap;gap:4px;">
                      ${models.map((m) => `<code style="background:var(--bg-primary);padding:2px 8px;border-radius:4px;font-size:12px;">${esc(m)}</code>`).join("")}
                    </div>
                  </div>
                `;
              }).join("")
          }
        </div>
      `;
    } catch (err) {
      body.innerHTML = errorState(err.message);
    }
  }

  // =========================================================================
  // Pages — Providers (Admin)
  // =========================================================================

  async function pageProviders() {
    if (!state.user?.isAdmin) { location.hash = "#/dashboard"; return; }
    const body = setPage("供應商管理", "管理 AI API 供應商");
    body.innerHTML = loading();

    try {
      const data = await API.get("/web/api/admin/providers");
      const providers = data.providers || [];

      body.innerHTML = `
        <div style="margin-bottom:16px;">
          <button class="btn btn-primary" id="btn-add-provider">＋ 新增供應商</button>
        </div>
        ${providers.length === 0
          ? `<div class="empty-state"><div class="icon">${ic.plug}</div><div class="title">尚無供應商</div></div>`
          : providers.map((p) => `
            <div class="card">
              <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:12px;">
                <div>
                  <h3 style="font-size:18px;">${esc(p.name)} ${Number(p.enabled) === 1 ? '<span class="badge badge-success">啟用</span>' : '<span class="badge badge-danger">停用</span>'}</h3>
                  <div style="font-size:13px;color:var(--text-secondary);margin-top:4px;">
                    <span class="badge badge-info">${esc(p.api_type)}</span>
                    <code style="margin-left:8px;">${esc(p.base_url)}</code>
                  </div>
                </div>
                <div style="display:flex;gap:6px;flex-wrap:wrap;">
                  <button class="btn-icon" onclick="window._editProvider(${p.id})">編輯</button>
                  <button class="btn-icon" onclick="window._providerPrices(${p.id},'${esc(p.name)}')">定價</button>
                  <button class="btn-icon" onclick="window._testModel(${p.id})">${ic.flask} 測試</button>
                  <button class="btn-icon danger" onclick="window._delProvider(${p.id},'${esc(p.name)}')">刪除</button>
                </div>
              </div>
              <div style="font-size:13px;">
                <strong>Keys:</strong> ${(p.api_keys || []).length} 個 &nbsp;|&nbsp;
                <strong>模型:</strong> ${(p.models_list || []).length} 個 &nbsp;|&nbsp;
                <strong>User-Agent:</strong> ${p.user_agent ? "自訂" : "繼承"}
              </div>
              ${p.models ? `<details style="margin-top:8px;"><summary style="cursor:pointer;color:var(--text-secondary);font-size:13px;">查看模型列表</summary><div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:8px;">${(p.models_list||[]).map(m=>`<code style="background:var(--bg-primary);padding:2px 6px;border-radius:4px;font-size:11px;">${esc(m)}</code>`).join("")}</div></details>` : ""}
            </div>
          `).join("")
        }
      `;

      $("#btn-add-provider").onclick = () => showProviderForm();
      window._editProvider = (id) => {
        const p = providers.find((x) => x.id === id);
        if (p) showProviderForm(p);
      };
      window._delProvider = (id, name) => {
        confirm(`確定要刪除供應商「${name}」？此操作不可逆。`, async () => {
          try {
            await API.del("/web/api/admin/providers", { ids: [id] });
            toast("已刪除", "success");
            pageProviders();
          } catch (err) {
            toast(err.message, "error");
          }
        });
      };
      window._providerPrices = (id, name) => showProviderPrices(id, name);
      window._testModel = (id) => {
        const p = providers.find((x) => x.id === id);
        if (p) showModelTest(p);
      };
    } catch (err) {
      body.innerHTML = errorState(err.message);
    }
  }

  function showModelTest(p) {
    const models = p.models_list || [];
    const apiType = p.api_type;

    const bodyHTML = `
      <div style="margin-bottom:16px;">
        <label style="display:block;font-size:13px;color:var(--text-secondary);margin-bottom:6px;">選擇模型</label>
        ${models.length > 0
          ? `<select id="mt-model" class="form-input" style="width:100%;">${models.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join("")}</select>`
          : `<input id="mt-model-input" class="form-input" style="width:100%;" placeholder="輸入模型名稱" value="">`
        }
      </div>
      <div style="margin-bottom:16px;">
        <label style="display:block;font-size:13px;color:var(--text-secondary);margin-bottom:6px;">測試訊息</label>
        <textarea id="mt-message" class="form-input" style="width:100%;min-height:60px;resize:vertical;" placeholder="輸入測試訊息">Hello!</textarea>
      </div>
      <div style="margin-bottom:12px;display:flex;gap:8px;align-items:center;">
        <span class="badge badge-info">${esc(apiType)}</span>
        <span style="font-size:12px;color:var(--text-muted);">將使用第一個 API Key 發送請求</span>
      </div>
      <div id="mt-result" style="min-height:40px;"></div>
    `;

    showModal(`${ic.flask} 測試模型 — ${esc(p.name)}`, bodyHTML, [
      {
        label: "發送測試",
        class: "btn-primary",
        close: false,
        onClick: async (modalBody) => {
          const selectEl = modalBody.querySelector("#mt-model");
          const inputEl = modalBody.querySelector("#mt-model-input");
          let model = selectEl ? selectEl.value : (inputEl ? inputEl.value.trim() : "");
          const message = modalBody.querySelector("#mt-message").value.trim() || "Hello!";

          if (!model) {
            toast("請選擇或輸入模型名稱", "error");
            return;
          }

          const resultDiv = modalBody.querySelector("#mt-result");
          resultDiv.innerHTML = loading("正在發送測試請求...");

          try {
            const data = await API.post(`/web/api/admin/providers/${p.id}/test-model`, { model, message });

            if (data.success) {
              resultDiv.innerHTML = `
                <div class="test-result test-success">
                  <div class="test-result-header">
                    <span>${ic.check} 測試成功</span>
                    <span class="test-latency">${data.latencyMs}ms</span>
                  </div>
                  <div class="test-result-body">${esc(data.content || "(空回應)")}</div>
                </div>
              `;
            } else {
              resultDiv.innerHTML = `
                <div class="test-result test-error">
                  <div class="test-result-header">
                    <span>${ic.alert} 測試失敗${data.status ? " (HTTP " + data.status + ")" : ""}</span>
                    <span class="test-latency">${data.latencyMs}ms</span>
                  </div>
                  <div class="test-result-body">${esc(data.error || "未知錯誤")}</div>
                  ${data.url ? `<div class="test-result-meta">${ic.link} ${esc(data.url)}</div>` : ""}
                </div>
              `;
            }
          } catch (err) {
            resultDiv.innerHTML = `
              <div class="test-result test-error">
                <div class="test-result-header">
                  <span>${ic.alert} 請求失敗</span>
                </div>
                <div class="test-result-body">${esc(err.message)}</div>
              </div>
            `;
          }
        },
      },
      { label: "關閉", class: "btn-secondary", close: true },
    ]);
  }

  function showProviderForm(p = null) {
    const isEdit = !!p;
    const keys = p ? (p.api_keys || []) : [];

    // 建立一列模型行（含名稱、輸入價、輸出價、刪除鈕）
    function addModelRow(name = "", iprice = "", oprice = "") {
      const container = $("#pf-models-container");
      if (!container) return;
      const row = document.createElement("div");
      row.className = "model-row";
      row.innerHTML =
        '<input class="pf-model-name" type="text" placeholder="模型名稱" value="' + esc(String(name)) + '">' +
        '<input class="pf-model-iprice" type="number" step="0.01" placeholder="輸入 $" value="' + (iprice != null && iprice !== "" ? iprice : "") + '">' +
        '<input class="pf-model-oprice" type="number" step="0.01" placeholder="輸出 $" value="' + (oprice != null && oprice !== "" ? oprice : "") + '">' +
        '<button type="button" class="btn-model-del" title="刪除">✕</button>';
      row.querySelector(".btn-model-del").onclick = () => row.remove();
      container.appendChild(row);
    }

    // 建立一列 API Key 輸入行（含刪除鈕）
    function addKeyRow(value = "") {
      const container = $("#pf-keys-container");
      if (!container) return;
      const row = document.createElement("div");
      row.className = "key-row";
      row.innerHTML =
        '<input class="pf-key-input" type="text" placeholder="sk-xxx" value="' + esc(String(value)) + '">' +
        '<button type="button" class="btn-model-del" title="刪除">✕</button>';
      row.querySelector(".btn-model-del").onclick = () => row.remove();
      container.appendChild(row);
    }

    showModal(
      isEdit ? "編輯供應商" : "新增供應商",
      `
        <div class="form-group">
          <label>名稱</label>
          <input type="text" id="pf-name" value="${p ? esc(p.name) : ""}">
        </div>
        <div class="form-group">
          <label>API 類型</label>
          <select id="pf-type">
            <option value="openai_chat" ${p?.api_type === "openai_chat" ? "selected" : ""}>openai_chat (Chat Completions)</option>
            <option value="openai_response" ${p?.api_type === "openai_response" ? "selected" : ""}>openai_response (Responses API)</option>
            <option value="anthropic" ${p?.api_type === "anthropic" ? "selected" : ""}>anthropic</option>
            <option value="google" ${p?.api_type === "google" ? "selected" : ""}>google</option>
          </select>
        </div>
        <div class="form-group">
          <label>Base URL</label>
          <input type="url" id="pf-url" value="${p ? esc(p.base_url) : ""}" placeholder="https://api.openai.com/v1">
        </div>
        <div class="form-group">
          <label>User-Agent（可選）</label>
          <input type="text" id="pf-user-agent" value="${p ? esc(p.user_agent || "") : ""}" placeholder="留空使用全域預設">
        </div>
        <div class="form-group">
          <label>API Keys</label>
          <div id="pf-keys-container"></div>
          <button type="button" class="btn btn-ghost btn-sm" id="btn-pf-add-key" style="margin-top:4px;">+ 新增 Key</button>
        </div>
        <div class="form-group">
          <label>Key 調度策略</label>
          <select id="pf-key-strategy">
            <option value="failover" ${p?.key_strategy === "round_robin" || p?.key_strategy === "random" ? "" : "selected"}>故障轉移（用到報錯才換下一個 Key）</option>
            <option value="round_robin" ${p?.key_strategy === "round_robin" ? "selected" : ""}>輪詢（用完 Key1 換 Key2，依序循環）</option>
            <option value="random" ${p?.key_strategy === "random" ? "selected" : ""}>隨機（完全隨機選取）</option>
          </select>
        </div>
        <div class="form-group">
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;">
            <button class="btn btn-ghost btn-sm" id="btn-pf-fetch-models">${ic.clipboard} 抓取模型</button>
            <button class="btn btn-ghost btn-sm" id="btn-pf-fetch-pricing">${ic.dollar} 抓取定價</button>
          </div>
          <div id="pf-detect-result" style="font-size:12px;color:var(--text-secondary);"></div>
        </div>
        <div class="form-group">
          <label>模型與定價（USD / 1M tokens）</label>
          <div id="pf-models-container"></div>
          <button type="button" class="btn btn-ghost btn-sm" id="btn-pf-add-model" style="margin-top:4px;">+ 新增模型</button>
        </div>
        ${isEdit ? `
          <div class="form-group">
            <label class="toggle-wrap">
              <span class="toggle-switch">
                <input type="checkbox" id="pf-enabled" ${Number(p.enabled) === 1 ? "checked" : ""}>
                <span class="toggle-slider"></span>
              </span>
              <span>啟用</span>
            </label>
          </div>
        ` : ""}
      `,
      [
        { label: "取消", class: "btn-ghost" },
        {
          label: isEdit ? "更新" : "新增",
          class: "btn-primary",
          onClick: async (modalBody) => {
            // 收集每列模型 + 定價
            const rows = modalBody.querySelectorAll(".model-row");
            const modelPrices = [];
            const modelNames = [];
            rows.forEach((row) => {
              const mName = row.querySelector(".pf-model-name").value.trim();
              if (!mName) return;
              const ipVal = row.querySelector(".pf-model-iprice").value;
              const opVal = row.querySelector(".pf-model-oprice").value;
              modelPrices.push({
                model: mName,
                input_price: ipVal !== "" ? Number(ipVal) : null,
                output_price: opVal !== "" ? Number(opVal) : null,
              });
              modelNames.push(mName);
            });

            // 收集所有 API Keys（每列一個）
            const keyInputs = modalBody.querySelectorAll(".key-row .pf-key-input");
            const keysCollected = [];
            keyInputs.forEach((input) => {
              const v = input.value.trim();
              if (v) keysCollected.push(v);
            });

            const payload = {
              name: modalBody.querySelector("#pf-name").value.trim(),
              api_type: modalBody.querySelector("#pf-type").value,
              base_url: modalBody.querySelector("#pf-url").value.trim(),
              user_agent: modalBody.querySelector("#pf-user-agent").value.trim(),
              api_key: keysCollected.join(","),
              key_strategy: modalBody.querySelector("#pf-key-strategy").value,
              models: modelNames.join(","),
              model_prices: modelPrices,
            };
            if (isEdit) {
              const cb = modalBody.querySelector("#pf-enabled");
              if (cb) payload.enabled = cb.checked;
            }
            if (!payload.name || !payload.api_type || !payload.base_url) {
              toast("名稱、類型、URL 為必填", "error");
              return;
            }
            try {
              if (isEdit) {
                await API.put(`/web/api/admin/providers/${p.id}`, payload);
              } else {
                await API.post("/web/api/admin/providers", payload);
              }
              toast(isEdit ? "已更新" : "已新增", "success");
              pageProviders();
            } catch (err) {
              toast(err.message, "error");
            }
          },
        },
      ]
    );

    // 預填模型列（編輯模式）或新增一行空列（新增模式）
    if (isEdit && p) {
      if (p.model_prices && p.model_prices.length > 0) {
        p.model_prices.forEach((mp) => addModelRow(mp.model, mp.input_price, mp.output_price));
      } else if (p.models_list && p.models_list.length > 0) {
        p.models_list.forEach((m) => addModelRow(m));
      } else {
        addModelRow();
      }
    } else {
      addModelRow();
    }

    // 預填 API Key 列（編輯模式）或新增一行空列（新增模式）
    if (isEdit && keys.length > 0) {
      keys.forEach((k) => addKeyRow(k));
    } else {
      addKeyRow();
    }

    // 綁定「+ 新增 Key」按鈕
    const addKeyBtn = $("#btn-pf-add-key");
    if (addKeyBtn) {
      addKeyBtn.onclick = () => addKeyRow();
    }

    // 綁定「+ 新增模型」按鈕
    const addBtn = $("#btn-pf-add-model");
    if (addBtn) {
      addBtn.onclick = () => addModelRow();
    }

    // 綁定獨立按鈕
    const resultDiv = $("#pf-detect-result");

    // 抓取模型
    const btnModels = $("#btn-pf-fetch-models");
    if (btnModels) {
      btnModels.onclick = async () => {
        const baseUrl = $("#pf-url").value.trim();
        const keyInputs = document.querySelectorAll(".key-row .pf-key-input");
        let apiKey = "";
        for (const input of keyInputs) {
          const v = input.value.trim();
          if (v) { apiKey = v; break; }
        }
        const apiType = $("#pf-type").value;
        if (!baseUrl) { toast("請先填入 Base URL", "error"); return; }
        if (!apiKey) { toast("抓取模型需要 API Key", "error"); return; }
        btnModels.disabled = true;
        btnModels.innerHTML = ic.clipboard + " 抓取中...";
        resultDiv.innerHTML = `<span style="color:var(--text-tertiary);">正在抓取模型列表...</span>`;
        try {
          const data = await API.post("/web/api/admin/provider-models", { baseUrl, apiKey, apiType });
          if (data.models && data.models.length > 0) {
            resultDiv.innerHTML = `${ic.clipboard} 抓取到 <strong>${data.models.length}</strong> 個模型，請選擇要添加的`;
            showModelPicker(data.models, (selected) => {
              const container = $("#pf-models-container");
              if (container) container.innerHTML = "";
              selected.forEach((modelId) => addModelRow(modelId));
              resultDiv.innerHTML = `${ic.clipboard} 已填入 <strong>${selected.length}</strong> 個模型`;
              toast(`已填入 ${selected.length} 個模型`, "success");
            });
          } else {
            resultDiv.innerHTML = '<span style="color:var(--text-tertiary);">未抓取到任何模型</span>';
            toast("未抓取到模型", "info");
          }
        } catch (err) {
          resultDiv.innerHTML = `<span style="color:var(--accent-red);">抓取失敗: ${esc(err.message)}</span>`;
          toast(err.message, "error");
        } finally {
          btnModels.disabled = false;
          btnModels.innerHTML = ic.clipboard + " 抓取模型";
        }
      };
    }

    // 3️⃣ 抓取定價
    const btnPricing = $("#btn-pf-fetch-pricing");
    if (btnPricing) {
      btnPricing.onclick = async () => {
        const container = $("#pf-models-container");
        const rows = container ? container.querySelectorAll(".model-row") : [];
        const modelNames = [];
        rows.forEach((row) => {
          const name = row.querySelector(".pf-model-name").value.trim();
          if (name) modelNames.push(name);
        });
        if (modelNames.length === 0) { toast("請先填入模型名稱", "error"); return; }
        btnPricing.disabled = true;
        btnPricing.innerHTML = ic.dollar + " 查詢中...";
        resultDiv.innerHTML = `<span style="color:var(--text-tertiary);">正在從 models.dev 查詢定價...</span>`;
        try {
          const data = await API.post("/web/api/admin/provider-pricing", { models: modelNames });
          let filled = 0;
          rows.forEach((row) => {
            const name = row.querySelector(".pf-model-name").value.trim();
            if (name && data.pricing[name]) {
              const ip = row.querySelector(".pf-model-iprice");
              const op = row.querySelector(".pf-model-oprice");
              const p = data.pricing[name];
              if (ip && p.input != null) ip.value = p.input;
              if (op && p.output != null) op.value = p.output;
              filled++;
            }
          });
          resultDiv.innerHTML = `${ic.dollar} 已填入 <strong>${filled}</strong> / ${modelNames.length} 個模型定價`;
          toast(`已填入 ${filled} 個模型定價`, "success");
        } catch (err) {
          resultDiv.innerHTML = `<span style="color:var(--accent-red);">定價查詢失敗: ${esc(err.message)}</span>`;
          toast(err.message, "error");
        } finally {
          btnPricing.disabled = false;
          btnPricing.innerHTML = ic.dollar + " 抓取定價";
        }
      };
    }
  }

  async function showProviderPrices(providerId, name) {
    try {
      const data = await API.get(`/web/api/admin/provider-prices/${providerId}`);
      const prices = data.prices || [];

      showModal(
        `${name} — 模型定價`,
        `
          <p style="margin-bottom:12px;color:var(--text-secondary);font-size:13px;">
            價格單位：USD / 1M tokens。修改後點擊「儲存」批量更新。
          </p>
          <div class="table-wrap">
            <table>
              <thead><tr><th>模型</th><th>輸入價</th><th>輸出價</th></tr></thead>
              <tbody id="prices-tbody">
                ${prices.map((p) => `
                  <tr data-model="${esc(p.model)}">
                    <td><code>${esc(p.model)}</code></td>
                    <td><input type="number" class="price-input" data-field="input_price" value="${p.input_price ?? ""}" step="0.01" style="width:100px;"></td>
                    <td><input type="number" class="price-input" data-field="output_price" value="${p.output_price ?? ""}" step="0.01" style="width:100px;"></td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        `,
        [
          { label: "關閉", class: "btn-ghost" },
          {
            label: "儲存",
            class: "btn-primary",
            onClick: async (modalBody) => {
              const rows = modalBody.querySelectorAll("#prices-tbody tr");
              const entries = [];
              rows.forEach((row) => {
                const model = row.dataset.model;
                const inputs = row.querySelectorAll(".price-input");
                const inputPrice = inputs[0].value === "" ? null : parseFloat(inputs[0].value);
                const outputPrice = inputs[1].value === "" ? null : parseFloat(inputs[1].value);
                entries.push({ model, input_price: inputPrice, output_price: outputPrice });
              });
              try {
                await API.put(`/web/api/admin/provider-prices/${providerId}`, { entries });
                toast("定價已更新", "success");
              } catch (err) {
                toast(err.message, "error");
              }
            },
          },
        ]
      );
    } catch (err) {
      toast(err.message, "error");
    }
  }

  // =========================================================================
  // Pages — Users (Admin)
  // =========================================================================

  async function pageUsers() {
    if (!state.user?.isAdmin) { location.hash = "#/dashboard"; return; }
    const body = setPage("用戶管理", "管理系統用戶");
    body.innerHTML = loading();

    try {
      const [usersData, groupsData] = await Promise.all([
        API.get("/web/api/admin/users"),
        API.get("/web/api/admin/groups"),
      ]);
      const users = usersData.users || [];
      const groups = groupsData.groups || [];

      body.innerHTML = `
        <div style="margin-bottom:16px;">
          <button class="btn btn-primary" id="btn-add-user">＋ 新增用戶</button>
        </div>
        <div class="card">
          <div class="table-wrap">
            <table>
              <thead><tr><th>ID</th><th>TG ID</th><th>用戶名</th><th>狀態</th><th>建立時間</th><th>操作</th></tr></thead>
              <tbody>
                ${users.map((u) => `
                  <tr>
                    <td>${u.id}</td>
                    <td>${u.tg_user_id}</td>
                    <td>${esc(u.username || "--")}${u.is_admin ? ' <span class="badge badge-info">管理員</span>' : ""}</td>
                    <td>${Number(u.is_active) === 1 ? '<span class="badge badge-success">啟用</span>' : '<span class="badge badge-danger">停用</span>'}</td>
                    <td>${fmtDate(u.created_at)}</td>
                    <td style="display:flex;gap:4px;">
                      <button class="btn-icon" onclick="window._userDetail(${u.id})">詳情</button>
                      ${u.is_admin ? "" : `<button class="btn-icon" onclick="window._toggleUser(${u.id},${u.is_active})">${Number(u.is_active) === 1 ? "停用" : "啟用"}</button><button class="btn-icon danger" onclick="window._delUser(${u.id})">刪除</button>`}
                    </td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        </div>
      `;

      $("#btn-add-user").onclick = () => {
        showModal("新增用戶", `
          <div class="form-group"><label>Telegram User ID</label><input type="number" id="uf-tgid"></div>
          <div class="form-group"><label>用戶名（可選）</label><input type="text" id="uf-username"></div>
        `, [
          { label: "取消", class: "btn-ghost" },
          {
            label: "新增", class: "btn-primary",
            onClick: async (mb) => {
              try {
                await API.post("/web/api/admin/users", {
                  tgUserId: parseInt(mb.querySelector("#uf-tgid").value, 10),
                  username: mb.querySelector("#uf-username").value || null,
                });
                toast("已新增", "success");
                pageUsers();
              } catch (err) { toast(err.message, "error"); }
            },
          },
        ]);
      };

      window._userDetail = (id) => userDetail(id, groups);
      window._toggleUser = async (id, current) => {
        try {
          await API.put(`/web/api/admin/users/${id}/status`, { isActive: Number(current) !== 1 });
          toast("已更新", "success");
          pageUsers();
        } catch (err) { toast(err.message, "error"); }
      };
      window._delUser = (id) => {
        confirm(`確定要刪除用戶 #${id}？`, async () => {
          try {
            await API.del(`/web/api/admin/users/${id}`);
            toast("已刪除", "success");
            pageUsers();
          } catch (err) { toast(err.message, "error"); }
        });
      };
    } catch (err) {
      body.innerHTML = errorState(err.message);
    }
  }

  async function userDetail(id, groups) {
    try {
      const [limitsData, keysData, restrictionsData] = await Promise.all([
        API.get(`/web/api/admin/users/${id}/limits`),
        API.get(`/web/api/admin/users/${id}/keys`),
        API.get(`/web/api/admin/users/${id}/restrictions`),
      ]);

      const user = limitsData.user || {};
      const limits = limitsData.effectiveLimits || {};
      const keys = keysData.keys || [];
      const restrictions = restrictionsData.restrictions || [];

      showModal(
        `用戶詳情 #${id}`,
        `
          <div style="margin-bottom:16px;">
            <table>
              <tbody>
                <tr>
                  <td>TG ID</td>
                  <td>
                    <strong>${user.tg_user_id}</strong>
                    ${user.is_admin ? "" : `<button class="btn-icon btn-sm" id="btn-edit-tgid" style="margin-left:8px;">編輯</button>`}
                  </td>
                </tr>
                <tr><td>用戶名</td><td>${esc(user.username || "--")}</td></tr>
                <tr><td>狀態</td><td>${Number(user.is_active) === 1 ? '<span class="badge badge-success">啟用</span>' : '<span class="badge badge-danger">停用</span>'}</td></tr>
                <tr><td>分組</td><td>${user.group_id || "預設"}</td></tr>
                <tr><td>期限</td><td>${user.expires_at ? fmtDate(user.expires_at) : "永久"}</td></tr>
              </tbody>
            </table>
          </div>

          <h4 style="margin-bottom:8px;">API Keys (${keys.length})</h4>
          ${keys.length === 0 ? '<p style="color:var(--text-muted);">無</p>' : `
            <div class="table-wrap" style="margin-bottom:16px;">
              <table>
                <thead><tr><th>ID</th><th>Key</th><th>操作</th></tr></thead>
                <tbody>
                  ${keys.map(k => `<tr><td>${k.id}</td><td><code>...${esc(k.key.slice(-12))}</code></td><td style="display:flex;gap:4px;"><button class="btn-icon btn-sm" data-keylimits="${k.id}" data-keypreview="${esc(k.key.slice(-12))}">限制</button><button class="btn-icon btn-sm danger" data-delkey="${k.id}">刪除</button></td></tr>`).join("")}
                </tbody>
              </table>
            </div>
          `}

          <h4 style="margin-bottom:8px;display:flex;align-items:center;gap:8px;">
            模型限制
            <button class="btn-icon btn-sm" id="btn-add-restriction">+ 新增</button>
          </h4>
          ${restrictions.length === 0 ? '<p style="color:var(--text-muted);">無</p>' : restrictions.map(r => `
            <div style="margin-bottom:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
              <span class="badge ${r.mode === "whitelist" ? "badge-success" : "badge-danger"}">${r.mode === "whitelist" ? "白名單" : "黑名單"}</span>
              ${r.api_key_id ? `<span class="badge badge-muted">Key #${r.api_key_id}</span>` : '<span class="badge badge-info">用戶級</span>'}
              <code style="font-size:12px;flex:1;word-break:break-all;">${esc(r.models)}</code>
              <button class="btn-icon btn-sm danger" data-delrest="${r.api_key_id || ''}">刪除</button>
            </div>
          `).join("")}

          ${user.is_admin ? `
            <h4 style="margin:16px 0 8px;">用戶級限制</h4>
            <p style="color:var(--text-muted);">管理員不受用戶級限制，僅可設定 API Key 級別限制。</p>
          ` : `
            <h4 style="margin:16px 0 8px;">設定分組 & 覆蓋</h4>
            <div class="form-group">
              <label>用戶分組</label>
              <select id="ud-group">
                ${groups.map(g => `<option value="${g.id}" ${user.group_id === g.id ? "selected" : ""}>${esc(g.name)}${g.is_default == 1 ? "（預設）" : ""}</option>`).join("")}
              </select>
            </div>
            <div class="form-group">
              <label>期限（YYYY-MM-DD 或留空=永久）</label>
              <input type="text" id="ud-expires" value="${user.expires_at ? user.expires_at.split(" ")[0] : ""}">
            </div>
          `}
        `,
        user.is_admin ? [
          { label: "關閉", class: "btn-ghost" },
        ] : [
          { label: "關閉", class: "btn-ghost" },
          {
            label: "儲存", class: "btn-primary",
            onClick: async (mb) => {
              try {
                await API.put(`/web/api/admin/users/${id}/limits`, {
                  groupId: parseInt(mb.querySelector("#ud-group").value, 10),
                  overrides: {
                    expires_at: mb.querySelector("#ud-expires").value || null,
                  },
                });
                toast("已更新", "success");
              } catch (err) { toast(err.message, "error"); }
            },
          },
        ]
      );

      // --- 編輯 TG ID ---
      const btnEditTg = $("#btn-edit-tgid");
      if (btnEditTg) {
        btnEditTg.onclick = () => {
          showModal("編輯 TG ID", `
            <div class="form-group">
              <label>新的 TG User ID</label>
              <input type="number" id="et-newid" value="${user.tg_user_id}">
            </div>
            <p style="color:var(--text-muted);font-size:13px;">注意：修改 TG ID 後，該用戶需用新的 Telegram 帳號操作。</p>
          `, [
            { label: "取消", class: "btn-ghost" },
            {
              label: "儲存", class: "btn-primary", close: false,
              onClick: async (mb2) => {
                const newId = parseInt(mb2.querySelector("#et-newid").value, 10);
                if (isNaN(newId)) { toast("請輸入有效的數字", "error"); return; }
                try {
                  await API.put(`/web/api/admin/users/${id}/tg-id`, { newTgId: newId });
                  toast("TG ID 已更新", "success");
                  userDetail(id, groups);
                } catch (err) { toast(err.message, "error"); }
              },
            },
          ]);
        };
      }

      // --- 新增模型限制 ---
      const btnAddRest = $("#btn-add-restriction");
      if (btnAddRest) {
        btnAddRest.onclick = () => showRestrictionForm(id, keys, groups, userDetail);
      }

      // --- 綁定 Key 操作按鈕 ---
      const modalBody = $("#modal-body");
      modalBody.querySelectorAll("[data-keylimits]").forEach(btn => {
        btn.onclick = async () => {
          const keyId = parseInt(btn.dataset.keylimits, 10);
          const preview = btn.dataset.keypreview || "";
          try {
            const data = await API.get(`/web/api/admin/keys/${keyId}/limits`);
            showKeyLimitsModal(id, keyId, preview, data.key || {}, groups, userDetail);
          } catch (err) { toast(err.message, "error"); }
        };
      });
      modalBody.querySelectorAll("[data-delkey]").forEach(btn => {
        btn.onclick = () => {
          const kid = parseInt(btn.dataset.delkey, 10);
          confirm("確定刪除這個 Key？", async () => {
            try {
              await API.del(`/web/api/admin/users/${id}/keys/${kid}`);
              toast("已刪除", "success");
              userDetail(id, groups);
            } catch (err) { toast(err.message, "error"); }
          });
        };
      });

      // --- 綁定限制刪除按鈕 ---
      modalBody.querySelectorAll("[data-delrest]").forEach(btn => {
        btn.onclick = () => {
          const apiKeyId = btn.dataset.delrest;
          confirm("確定刪除此模型限制？", async () => {
            try {
              await API.put(`/web/api/admin/users/${id}/restrictions`, {
                action: "delete",
                apiKeyId: apiKeyId ? parseInt(apiKeyId, 10) : null,
              });
              toast("已刪除", "success");
              userDetail(id, groups);
            } catch (err) { toast(err.message, "error"); }
          });
        };
      });
    } catch (err) {
      toast(err.message, "error");
    }
  }

  // --- 模型限制表單 ---
  async function showRestrictionForm(userId, keys, groups, callback) {
    const scopeOptions = [
      '<option value="">用戶級（所有 Key）</option>',
      ...keys.map(k => `<option value="${k.id}">Key #${k.id} (...${esc(k.key.slice(-12))})</option>`),
    ].join("");

    let allModels = [];
    try {
      const resp = await API.get("/web/api/models");
      allModels = resp.models || [];
    } catch (_) { /* 可用模型可選，不阻塞 */ }

    showModal("新增模型限制", `
      <div class="form-group">
        <label>套用範圍</label>
        <select id="rf-scope">${scopeOptions}</select>
      </div>
      <div class="form-group">
        <label>模式</label>
        <select id="rf-mode">
          <option value="whitelist">白名單（僅允許列出的模型）</option>
          <option value="blacklist">黑名單（禁止列出的模型）</option>
        </select>
      </div>
      <div class="form-group">
        <label>模型列表（逗號分隔，可點選下方模型）</label>
        <textarea id="rf-models" rows="3" placeholder="gpt-4o,claude-sonnet-4,..."></textarea>
      </div>
      ${allModels.length > 0 ? `
        <div style="margin-bottom:16px;">
          <strong style="font-size:13px;color:var(--text-secondary);">可用模型（點擊加入 / 移除）：</strong>
          <div id="rf-chips" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;max-height:200px;overflow-y:auto;">
            ${allModels.map((m) => `<button type="button" class="btn-icon" data-model="${esc(m)}">${esc(m)}</button>`).join("")}
          </div>
        </div>
      ` : ""}
      <p style="color:var(--text-muted);font-size:13px;">同一範圍只能有一條規則，新的會覆蓋舊的。</p>
    `, [
      { label: "取消", class: "btn-ghost" },
      {
        label: "設定", class: "btn-primary", close: false,
        onClick: async (mb) => {
          const scopeVal = mb.querySelector("#rf-scope").value;
          const mode = mb.querySelector("#rf-mode").value;
          const models = mb.querySelector("#rf-models").value.trim();
          if (!models) { toast("請輸入至少一個模型", "error"); return; }
          try {
            await API.put(`/web/api/admin/users/${userId}/restrictions`, {
              apiKeyId: scopeVal ? parseInt(scopeVal, 10) : null,
              mode,
              models,
            });
            toast("已設定", "success");
            callback(userId, groups);
          } catch (err) { toast(err.message, "error"); }
        },
      },
    ]);

    // 綁定模型 chips：點擊 toggle 加入/移除
    const chipsContainer = document.querySelector("#rf-chips");
    if (chipsContainer) {
      chipsContainer.querySelectorAll(".btn-icon").forEach(btn => {
        btn.onclick = () => {
          const model = btn.dataset.model;
          const ta = document.querySelector("#rf-models");
          const current = ta.value.split(",").map(s => s.trim()).filter(Boolean);
          const idx = current.indexOf(model);
          if (idx >= 0) {
            current.splice(idx, 1);
            btn.classList.remove("selected");
          } else {
            current.push(model);
            btn.classList.add("selected");
          }
          ta.value = current.join(",");
        };
      });
    }
  }

  // --- API Key 限制覆蓋表單 ---
  function showKeyLimitsModal(userId, keyId, keyPreview, keyData, groups, callback) {
    const fields = [
      ["rpm_override", "RPM"],
      ["tpm_override", "TPM"],
      ["concurrency_override", "並發"],
      ["daily_token_override", "每日 Token"],
      ["monthly_token_override", "每月 Token"],
      ["daily_cost_override", "每日花費 ($)"],
      ["monthly_cost_override", "每月花費 ($)"],
    ];

    showModal(
      `Key 限制覆蓋 — ...${esc(keyPreview)}`,
      `
        <p style="color:var(--text-muted);font-size:13px;margin-bottom:12px;">留空 = 繼承用戶/分組設定，填入數值 = 覆蓋。</p>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
          ${fields.map(([key, label]) => `
            <div class="form-group" style="margin-bottom:0;">
              <label>${label}</label>
              <input type="number" step="any" id="kl-${key}" value="${keyData[key] != null ? keyData[key] : ""}" placeholder="繼承">
            </div>
          `).join("")}
        </div>
        <div class="form-group">
          <label>期限（YYYY-MM-DD 或留空=繼承）</label>
          <input type="text" id="kl-expires" value="${keyData.expires_at ? String(keyData.expires_at).split(" ")[0] : ""}" placeholder="繼承">
        </div>
      `,
      [
        { label: "取消", class: "btn-ghost" },
        {
          label: "儲存", class: "btn-primary", close: false,
          onClick: async (mb) => {
            const overrides = {};
            for (const [key] of fields) {
              const val = mb.querySelector(`#kl-${key}`).value.trim();
              if (val !== "") {
                overrides[key] = key.includes("cost") ? parseFloat(val) : parseInt(val, 10);
              } else {
                overrides[key] = null;
              }
            }
            const expVal = mb.querySelector("#kl-expires").value.trim();
            overrides.expires_at = expVal || null;

            try {
              await API.put(`/web/api/admin/keys/${keyId}/limits`, { overrides });
              toast("Key 限制已更新", "success");
              callback(userId, groups);
            } catch (err) { toast(err.message, "error"); }
          },
        },
      ]
    );
  }

  // =========================================================================
  // Pages — Groups (Admin)
  // =========================================================================

  async function pageGroups() {
    if (!state.user?.isAdmin) { location.hash = "#/dashboard"; return; }
    const body = setPage("用戶分組", "管理用戶分組和限制模板");
    body.innerHTML = loading();

    try {
      const data = await API.get("/web/api/admin/groups");
      const groups = data.groups || [];

      body.innerHTML = `
        <div style="margin-bottom:16px;">
          <button class="btn btn-primary" id="btn-add-group">＋ 新增分組</button>
        </div>
        <div class="card">
          <div class="table-wrap">
            <table>
              <thead>
                <tr><th>ID</th><th>名稱</th><th>顯示名</th><th>每分鐘請求</th><th>每分鐘Token</th><th>並發</th><th>日Token</th><th>月Token</th><th>日費</th><th>月費</th><th>模型限制</th><th>操作</th></tr>
              </thead>
              <tbody>
                ${groups.map((g) => `
                  <tr>
                    <td>${g.id}</td>
                    <td>${esc(g.name)}${g.is_default == 1 ? ' <span class="badge badge-info">預設</span>' : ""}</td>
                    <td>${esc(g.display_name || "--")}</td>
                    <td>${g.rpm_limit || "∞"}</td>
                    <td>${fmtNum(g.tpm_limit || 0)}</td>
                    <td>${g.concurrency_limit || "∞"}</td>
                    <td>${g.daily_token_limit ? fmtNum(g.daily_token_limit) : "∞"}</td>
                    <td>${g.monthly_token_limit ? fmtNum(g.monthly_token_limit) : "∞"}</td>
                    <td>${g.daily_cost_limit ? fmtCost(g.daily_cost_limit) : "∞"}</td>
                    <td>${g.monthly_cost_limit ? fmtCost(g.monthly_cost_limit) : "∞"}</td>
                    <td>${(() => {
                      const models = (g.allowed_models || "").split(",").map((m) => m.trim()).filter(Boolean);
                      if (models.length === 0) return '<span style="color:var(--text-tertiary);">全部</span>';
                      return esc(models.slice(0, 3).join(", ")) + (models.length > 3 ? ` <span class="badge">+${models.length - 3}</span>` : "");
                    })()}</td>
                    <td style="display:flex;gap:4px;">
                      <button class="btn-icon" onclick="window._editGroup(${g.id})">編輯</button>
                      ${g.is_default != 1 ? `<button class="btn-icon" onclick="window._setDefaultGroup(${g.id})">設為預設</button>` : ""}
                      ${g.is_default != 1 ? `<button class="btn-icon danger" onclick="window._delGroup(${g.id})">刪除</button>` : ""}
                    </td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        </div>
      `;

      $("#btn-add-group").onclick = () => showGroupForm();
      window._editGroup = (id) => {
        const g = groups.find((x) => x.id === id);
        if (g) showGroupForm(g);
      };
      window._delGroup = (id) => {
        confirm("確定刪除此分組？組內用戶將被移至預設分組。", async () => {
          try {
            await API.del(`/web/api/admin/groups/${id}`);
            toast("已刪除", "success");
            pageGroups();
          } catch (err) { toast(err.message, "error"); }
        });
      };
      window._setDefaultGroup = (id) => {
        confirm("確定將此分組設為預設？新用戶將自動加入此分組。", async () => {
          try {
            await API.put(`/web/api/admin/groups/${id}/default`);
            toast("已設為預設", "success");
            pageGroups();
          } catch (err) { toast(err.message, "error"); }
        });
      };
    } catch (err) {
      body.innerHTML = errorState(err.message);
    }
  }

  function showGroupForm(g = null) {
    const isEdit = !!g;
    const fields = [
      ["name", "名稱（英文）"], ["display_name", "顯示名"],
      ["rpm_limit", "每分鐘請求數（0=不限）"], ["tpm_limit", "每分鐘Token數（0=不限）"],
      ["concurrency_limit", "並發"],
      ["daily_token_limit", "每日 Token"], ["monthly_token_limit", "每月 Token"],
      ["daily_cost_limit", "每日花費"], ["monthly_cost_limit", "每月花費"],
    ];

    showModal(
      isEdit ? "編輯分組" : "新增分組",
      fields.map(([key, label]) => `
        <div class="form-group">
          <label>${label}</label>
          <input type="${key === "name" || key === "display_name" ? "text" : "number"}" id="gf-${key}" value="${g ? (g[key] ?? "") : ""}" ${key === "name" && isEdit ? "readonly" : ""}>
        </div>
      `).join("") + `
        <div class="form-group">
          <label>允許的模型（逗號分隔，留空 = 允許全部）</label>
          <textarea id="gf-allowed_models" rows="3" placeholder="gpt-4o,claude-3.5-sonnet">${g ? esc(g.allowed_models || "") : ""}</textarea>
          <button type="button" class="btn btn-ghost btn-sm" id="gf-pick-models" style="margin-top:4px;">${ic.clipboard} 從列表選擇</button>
        </div>
      `,
      [
        { label: "取消", class: "btn-ghost" },
        {
          label: isEdit ? "更新" : "新增", class: "btn-primary",
          onClick: async (mb) => {
            const payload = {};
            fields.forEach(([key]) => {
              const val = mb.querySelector(`#gf-${key}`).value;
              if (val !== "") {
                payload[key] = key === "name" || key === "display_name" ? val : parseFloat(val);
              }
            });
            payload.allowed_models = mb.querySelector("#gf-allowed_models").value.trim();
            if (!payload.name) { toast("名稱為必填", "error"); return; }
            try {
              if (isEdit) {
                await API.put(`/web/api/admin/groups/${g.id}`, payload);
              } else {
                await API.post("/web/api/admin/groups", payload);
              }
              toast(isEdit ? "已更新" : "已新增", "success");
              pageGroups();
            } catch (err) { toast(err.message, "error"); }
          },
        },
      ]
    );

    // 綁定「從列表選擇」按鈕
    const btnPickModels = $("#gf-pick-models");
    if (btnPickModels) {
      btnPickModels.onclick = async () => {
        try {
          const data = await API.get("/web/api/models");
          const allModels = data.models || [];
          const ta = $("#gf-allowed_models");
          const current = ta.value.split(",").map((m) => m.trim()).filter(Boolean);
          showModelPicker(allModels, (selected) => {
            ta.value = selected.join(", ");
          }, { preSelected: current, confirmLabel: "確認選擇" });
        } catch (err) {
          toast(err.message, "error");
        }
      };
    }
  }
  // =========================================================================
  // Pages — All Usage (Admin)
  // =========================================================================

  async function pageAllUsage() {
    if (!state.user?.isAdmin) { location.hash = "#/dashboard"; return; }
    const body = setPage("全域用量", "全部用戶的 Token 用量與花費總覽");
    body.innerHTML = loading();

    try {
      const data = await API.get("/web/api/admin/usage");
      const total = data.total || {};

      body.innerHTML = `
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-label">總請求數</div>
            <div class="stat-value">${fmtNum(total.total_requests || 0)}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">總輸入 Token</div>
            <div class="stat-value">${fmtNum(total.total_input_tokens || 0)}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">總輸出 Token</div>
            <div class="stat-value">${fmtNum(total.total_output_tokens || 0)}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">總花費</div>
            <div class="stat-value">${fmtCost(total.total_cost || 0)}</div>
          </div>
        </div>

        ${total.by_provider && Object.keys(total.by_provider).length > 0 ? `
          <div class="card">
            <div class="card-title">${ic.plug} 按供應商統計</div>
            <div class="table-wrap">
              <table>
                <thead><tr><th>供應商</th><th>請求</th><th>輸入 Token</th><th>輸出 Token</th><th>花費</th></tr></thead>
                <tbody>
                  ${Object.entries(total.by_provider).map(([name, s]) => `
                    <tr>
                      <td><strong>${esc(name)}</strong></td>
                      <td>${fmtNum(s.requests || 0)}</td>
                      <td>${fmtNum(s.input_tokens || 0)}</td>
                      <td>${fmtNum(s.output_tokens || 0)}</td>
                      <td>${fmtCost(s.cost || 0)}</td>
                    </tr>
                  `).join("")}
                </tbody>
              </table>
            </div>
          </div>
        ` : ""}

        ${total.by_user && Object.keys(total.by_user).length > 0 ? `
          <div class="card">
            <div class="card-title">${ic.users} 按用戶統計</div>
            <div class="table-wrap">
              <table>
                <thead><tr><th>用戶</th><th>請求</th><th>輸入 Token</th><th>輸出 Token</th><th>花費</th></tr></thead>
                <tbody>
                  ${Object.entries(total.by_user).map(([name, s]) => `
                    <tr>
                      <td>${esc(name)}</td>
                      <td>${fmtNum(s.requests || 0)}</td>
                      <td>${fmtNum(s.input_tokens || 0)}</td>
                      <td>${fmtNum(s.output_tokens || 0)}</td>
                      <td>${fmtCost(s.cost || 0)}</td>
                    </tr>
                  `).join("")}
                </tbody>
              </table>
            </div>
          </div>
        ` : ""}
      `;
    } catch (err) {
      body.innerHTML = errorState(err.message);
    }
  }

  // =========================================================================
  // Pages — API Test (Admin)
  // =========================================================================

  async function pageApiTest() {
    if (!state.user?.isAdmin) { location.hash = "#/dashboard"; return; }
    const body = setPage("API 協議測試", "用真實模型測試 API 端點支援的所有協議");
    body.innerHTML = `
      <div class="card">
        <div class="card-title">${ic.flask} API 協議測試</div>
        <div class="hint" style="margin-bottom:12px;">輸入 Base URL 和 API Key，先抓取模型列表（或手動輸入），再對 4 種協議逐一發送真實請求。</div>
        <div class="form-group">
          <label>Base URL</label>
          <input type="url" id="at-url" placeholder="https://api.openai.com/v1">
        </div>
        <div class="form-group">
          <label>API Key</label>
          <input type="text" id="at-key" placeholder="sk-xxx">
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px;">
          <button class="btn btn-primary" id="btn-fetch-models">${ic.search} 抓取模型</button>
          <span id="at-model-count" class="hint"></span>
        </div>
        <div class="form-group" id="at-model-group">
          <label>測試模型</label>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
            <select id="at-model" style="flex:1;min-width:200px;">
              <option value="">（請先抓取模型，或直接在手動輸入框輸入）</option>
            </select>
            <input type="text" id="at-model-manual" placeholder="或手動輸入模型名稱" style="flex:1;min-width:200px;">
          </div>
        </div>
        <div class="form-group">
          <label>測試訊息</label>
          <input type="text" id="at-message" value="Hello!" placeholder="測試訊息">
        </div>
        <button class="btn btn-primary" id="btn-protocol-test">${ic.zap} 測試全部協議</button>
      </div>
      <div id="at-result" style="margin-top:16px;"></div>
    `;

    let fetchedModels = [];

    // Step 1: Fetch models
    $("#btn-fetch-models").onclick = async () => {
      const baseUrl = $("#at-url").value.trim();
      const apiKey = $("#at-key").value.trim();
      if (!baseUrl) { toast("請輸入 Base URL", "error"); return; }
      if (!apiKey) { toast("請輸入 API Key", "error"); return; }

      const btn = $("#btn-fetch-models");
      btn.disabled = true;
      btn.innerHTML = `${ic.refresh} 抓取中...`;
      $("#at-model-count").textContent = "";

      try {
        const data = await API.post("/web/api/admin/model-catch", {
          baseUrl, apiKey, apiType: "openai_chat",
        });
        fetchedModels = data.models || [];
        if (fetchedModels.length === 0) {
          toast("未抓取到模型，請手動輸入", "error");
          $("#at-model-group").style.display = "";
          $("#at-model").innerHTML = '<option value="">（無可用模型，請手動輸入）</option>';
        } else {
          $("#at-model-group").style.display = "";
          const sel = $("#at-model");
          sel.innerHTML = fetchedModels.map((m) => {
            const name = typeof m === "string" ? m : (m.id || m.name || JSON.stringify(m));
            return `<option value="${esc(name)}">${esc(name)}</option>`;
          }).join("");
          $("#at-model-count").innerHTML = `${ic.clipboard} 抓到 <strong>${fetchedModels.length}</strong> 個模型`;
        }
        $("#btn-protocol-test").disabled = false;
      } catch (err) {
        toast(err.message, "error");
        // Still allow manual input
        $("#at-model-group").style.display = "";
        $("#at-model").innerHTML = '<option value="">（抓取失敗，請手動輸入）</option>';
        $("#btn-protocol-test").disabled = false;
      } finally {
        btn.disabled = false;
        btn.innerHTML = `${ic.search} 抓取模型`;
      }
    };

    // Step 2: Test all protocols
    $("#btn-protocol-test").onclick = async () => {
      const baseUrl = $("#at-url").value.trim();
      const apiKey = $("#at-key").value.trim();
      const model = $("#at-model-manual").value.trim() || $("#at-model").value.trim();
      const message = $("#at-message").value.trim() || "Hello!";

      if (!baseUrl) { toast("請輸入 Base URL", "error"); return; }
      if (!apiKey) { toast("請輸入 API Key", "error"); return; }
      if (!model) { toast("請選擇或輸入模型", "error"); return; }

      const btn = $("#btn-protocol-test");
      const resultDiv = $("#at-result");
      btn.disabled = true;
      btn.innerHTML = `${ic.refresh} 測試中...`;
      resultDiv.innerHTML = loading("正在對 4 種協議發送測試請求...");

      try {
        const data = await API.post("/web/api/admin/protocol-test", {
          baseUrl, apiKey, model, message,
        });
        const results = data.results || [];

        let html = `<div class="card"><div class="card-title">${ic.chart} 測試結果 — ${esc(model)}</div>`;
        html += '<div class="proto-grid">';
        for (const r of results) {
          const isSuccess = r.success;
          const badge = isSuccess
            ? `<span class="badge badge-success">${ic.check} 成功</span>`
            : `<span class="badge badge-danger">${ic.x} 失敗</span>`;
          const latency = r.latencyMs != null ? `<span class="proto-latency">${r.latencyMs}ms</span>` : "";
          html += `
            <div class="proto-card ${isSuccess ? "proto-success" : "proto-fail"}">
              <div class="proto-header">
                <div class="proto-name">${esc(r.protocol)}</div>
                <div class="proto-status">${badge} ${latency}</div>
              </div>
              <div class="proto-body">${esc(isSuccess ? (r.content || "(無回應內容)") : (r.error || "未知錯誤"))}</div>
            </div>
          `;
        }
        html += "</div>";

        if (data.recommended) {
          html += `<div class="proto-recommend">${ic.target} <strong>推薦協議：${esc(data.recommended)}</strong>（最快成功回應）</div>`;
        } else {
          html += `<div class="empty-state" style="padding:16px;"><div class="icon">${ic.alert}</div><div class="title">所有協議測試失敗</div><p>請檢查 URL、API Key、模型名稱是否正確</p></div>`;
        }
        html += "</div>";
        resultDiv.innerHTML = html;
      } catch (err) {
        resultDiv.innerHTML = `<div class="empty-state"><div class="icon">${ic.alert}</div><div class="title">測試失敗</div><p>${esc(err.message)}</p></div>`;
      } finally {
        btn.disabled = false;
        btn.innerHTML = `${ic.zap} 測試全部協議`;
      }
    };
  }

  // =========================================================================
  // Pages — Model Catch (Admin)
  // =========================================================================

  async function pageModelCatch() {
    if (!state.user?.isAdmin) { location.hash = "#/dashboard"; return; }
    const body = setPage("模型抓取", "抓取任意 API 的可用模型列表");
    body.innerHTML = `
      <div class="card">
        <div class="card-title">${ic.clipboard} 模型抓取</div>
        <div class="form-group">
          <label>Base URL</label>
          <input type="url" id="mc-url" placeholder="https://api.openai.com/v1">
        </div>
        <div class="form-group">
          <label>API Key（可選）</label>
          <input type="text" id="mc-key" placeholder="sk-xxx">
        </div>
        <div class="form-group">
          <label>API 類型（可選，預設 openai_chat）</label>
          <select id="mc-type">
            <option value="openai_chat">openai_chat (Chat Completions)</option>
            <option value="openai_response">openai_response (Responses API)</option>
            <option value="anthropic">anthropic</option>
            <option value="google">google</option>
          </select>
        </div>
        <button class="btn btn-primary" id="btn-model-catch">抓取模型</button>
      </div>
      <div id="mc-result" style="margin-top:16px;"></div>
    `;

    $("#btn-model-catch").onclick = async () => {
      const baseUrl = $("#mc-url").value.trim();
      const apiKey = $("#mc-key").value.trim();
      const apiType = $("#mc-type").value;
      if (!baseUrl) { toast("請輸入 Base URL", "error"); return; }

      const btn = $("#btn-model-catch");
      const resultDiv = $("#mc-result");
      btn.disabled = true;
      btn.textContent = "抓取中...";
      resultDiv.innerHTML = loading();

      try {
        const data = await API.post("/web/api/admin/model-catch", {
          baseUrl, apiKey: apiKey || undefined, apiType,
        });
        const models = data.models || [];
        const needsAuth = data.needsAuth;

        let html = '<div class="card"><div class="card-title">抓取結果</div>';
        if (needsAuth) {
          html += `<div class="empty-state"><div class="icon">${ic.lock}</div><div class="title">需要認證</div><p>此 API 需要提供有效的 API Key 才能取得模型列表</p></div>`;
        } else if (models.length === 0) {
          html += `<div class="empty-state"><div class="icon">${ic.inbox}</div><div class="title">未找到模型</div></div>`;
        } else {
          const modelList = models.map(m => m.id).join(",");
          html += `<p style="margin-bottom:12px;color:var(--text-secondary);">共 ${models.length} 個模型</p>`;
          html += `<button class="btn btn-ghost" id="btn-copy-models" style="margin-bottom:12px;">${ic.clipboard} 複製全部模型名稱</button>`;
          html += '<div style="display:flex;flex-wrap:wrap;gap:6px;">';
          for (const m of models) {
            html += `<span class="badge badge-muted" style="font-size:11px;">${esc(m.id)}</span>`;
          }
          html += "</div>";
          html += `<textarea id="mc-models-text" style="display:none;">${esc(modelList)}</textarea>`;
        }
        html += "</div>";
        resultDiv.innerHTML = html;

        const copyBtn = $("#btn-copy-models");
        if (copyBtn) {
          copyBtn.onclick = () => {
            const text = $("#mc-models-text").value;
            copy(text);
          };
        }
      } catch (err) {
        resultDiv.innerHTML = `<div class="empty-state"><div class="icon">${ic.alert}</div><div class="title">抓取失敗</div><p>${esc(err.message)}</p></div>`;
      } finally {
        btn.disabled = false;
        btn.textContent = "抓取模型";
      }
    };
  }

  // =========================================================================
  // Pages — Model Mapping (Admin)
  // =========================================================================

  async function pageModelMapping() {
    if (!state.user?.isAdmin) { location.hash = "#/dashboard"; return; }
    const body = setPage("模型映射", "管理每個供應商模型的顯示名稱");
    body.innerHTML = loading();

    try {
      const [provData, mapData] = await Promise.all([
        API.get("/web/api/admin/providers"),
        API.get("/web/api/admin/model-mappings"),
      ]);

      const providers = provData.providers || [];
      const mappings = mapData.mappings || [];
      const mapByKey = new Map();
      for (const m of mappings) {
        mapByKey.set(`${m.provider_id}:${m.original_model}`, m.display_name);
      }

      if (providers.length === 0) {
        body.innerHTML = `<div class="empty-state"><div class="icon">${ic.plug}</div><div class="title">尚無供應商</div><p>請先新增供應商</p></div>`;
        return;
      }

      let rows = "";
      for (const p of providers) {
        const models = p.models_list || [];
        for (const model of models) {
          const key = `${p.id}:${model}`;
          const current = mapByKey.get(key) || "";
          rows += `
            <tr>
              <td class="mono" style="white-space:nowrap;">${esc(p.name)}/${esc(model)}</td>
              <td><input type="text" class="table-input" data-pid="${p.id}" data-model="${esc(model)}" value="${esc(current)}" placeholder="${esc(model)}"></td>
            </tr>`;
        }
      }

      if (!rows) {
        body.innerHTML = `<div class="empty-state"><div class="icon">${ic.inbox}</div><div class="title">無模型</div><p>供應商尚未設定任何模型</p></div>`;
        return;
      }

      body.innerHTML = `
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
            <div style="color:var(--text-secondary);font-size:13px;">
              設定自訂顯示名稱後，使用者將看到新名稱，但實際調用仍使用原始模型名。
              <br>留空 = 使用原始名稱（不映射）。
            </div>
            <button class="btn btn-primary" id="btn-save-mapping">${ic.check} 保存</button>
          </div>
          <table class="table">
            <thead>
              <tr><th>供應商 / 模型名稱</th><th>顯示名稱</th></tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;

      $("#btn-save-mapping").onclick = async () => {
        const inputs = document.querySelectorAll(".table-input");
        const payload = [];
        for (const inp of inputs) {
          const display = inp.value.trim();
          const original = inp.dataset.model;
          if (display && display !== original) {
            payload.push({
              provider_id: Number(inp.dataset.pid),
              original_model: original,
              display_name: display,
            });
          }
        }

        const btn = $("#btn-save-mapping");
        btn.disabled = true;
        btn.textContent = "保存中...";

        try {
          await API.put("/web/api/admin/model-mappings", { mappings: payload });
          toast("模型映射已保存", "success");
        } catch (err) {
          toast("保存失敗：" + err.message, "error");
        } finally {
          btn.disabled = false;
          btn.innerHTML = `${ic.check} 保存`;
        }
      };
    } catch (err) {
      body.innerHTML = errorState(err.message);
    }
  }

  // =========================================================================
  // Pages — API Logs (Admin)
  // =========================================================================

  async function pageApiLogs() {
    if (!state.user?.isAdmin) { location.hash = "#/dashboard"; return; }
    const body = setPage("API 日誌", "近期 50 條 API 調用記錄");
    body.innerHTML = loading();

    try {
      const data = await API.get("/web/api/admin/api-logs");
      const logs = data.logs || [];

      if (logs.length === 0) {
        body.innerHTML = `<div class="empty-state"><div class="icon">${ic.inbox}</div><div class="title">暫無日誌</div><p>當有 API 請求時，會自動記錄於此</p></div>`;
        return;
      }

      let rows = "";
      const shortLogText = (value, max = 42) => {
        const text = String(value || "");
        return text.length > max ? `${text.slice(0, Math.max(0, max - 3))}...` : text;
      };
      for (const log of logs) {
        const statusClass = log.responseStatus >= 400 ? "badge-danger" : "badge-success";
        const tokens = (log.inputTokens || 0) + (log.outputTokens || 0);
        rows += `
          <tr>
            <td class="mono" style="white-space:nowrap;font-size:12px;">${esc(log.timestamp.replace("T", " ").slice(0, 19))}</td>
            <td><span class="badge badge-muted" style="font-size:11px;">${esc(log.path)}</span></td>
            <td class="mono">${esc(log.model)}</td>
            <td>${esc(log.providerName)}</td>
            <td>
              <div class="mono">TG ${esc(log.username || "unknown")}</div>
              <div style="font-size:11px;color:var(--text-secondary);">User ${esc(log.userId || "-")} / Key ${esc(log.apiKeyId || "-")}</div>
              <div style="font-size:11px;color:var(--text-secondary);">IP ${esc(log.ip || "-")}</div>
              <div style="font-size:11px;color:var(--text-secondary);" title="${esc(log.userAgent || "")}">UA ${esc(shortLogText(log.userAgent || "-", 42))}</div>
            </td>
            <td style="text-align:right;">${tokens > 0 ? tokens : "-"}</td>
            <td style="text-align:right;">${log.latencyMs}ms</td>
            <td><span class="badge ${statusClass}">${log.responseStatus}</span></td>
            <td><button class="btn-icon" data-log-id="${log.id}" title="查看詳情">${ic.eye}</button></td>
          </tr>`;
      }

      body.innerHTML = `
        <div class="card">
          <div style="margin-bottom:12px;">
            <button class="btn btn-ghost" id="btn-refresh-logs">${ic.refresh} 刷新</button>
            <span style="margin-left:8px;color:var(--text-secondary);font-size:13px;">共 ${logs.length} 條（最多保存 50 條）</span>
          </div>
          <div style="overflow-x:auto;">
            <table class="table">
              <thead>
                <tr>
                  <th>時間</th><th>路徑</th><th>模型</th><th>供應商</th>
                  <th>來源</th><th style="text-align:right;">Tokens</th>
                  <th style="text-align:right;">延遲</th><th>狀態</th><th></th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>`;

      $("#btn-refresh-logs").onclick = () => pageApiLogs();

      // Bind detail view buttons
      document.querySelectorAll("[data-log-id]").forEach((btn) => {
        btn.onclick = () => {
          const id = Number(btn.dataset.logId);
          const log = logs.find((l) => l.id === id);
          if (!log) return;

          const bodyJson = JSON.stringify(log.body, null, 2);
          const errorHtml = log.error ? `<div style="margin-top:12px;padding:10px;background:var(--bg-danger);border-radius:6px;color:var(--text-danger);font-size:13px;">${ic.alert} ${esc(log.error)}</div>` : "";
          const usageHtml = (log.inputTokens || log.outputTokens) ? `
            <div style="display:flex;gap:16px;margin-top:12px;font-size:13px;">
              <span>輸入 Tokens: <strong>${log.inputTokens || 0}</strong></span>
              <span>輸出 Tokens: <strong>${log.outputTokens || 0}</strong></span>
            </div>` : "";

          showModal(
            `API 請求詳情 #${log.id}`,
            `<div style="margin-bottom:12px;font-size:13px;color:var(--text-secondary);">
              <div>時間: ${esc(log.timestamp)}</div>
              <div>路徑: <span class="mono">${esc(log.path)}</span></div>
              <div>模型: <span class="mono">${esc(log.model)}</span> → <span class="mono">${esc(log.actualModel)}</span></div>
              <div>供應商: ${esc(log.providerName)}</div>
              <div>用戶: <span class="mono">${esc(log.username)}</span></div>
              <div>User ID: <span class="mono">${esc(log.userId || "-")}</span> | API Key ID: <span class="mono">${esc(log.apiKeyId || "-")}</span></div>
              <div>IP: <span class="mono">${esc(log.ip || "-")}</span></div>
              <div>User-Agent: <span class="mono">${esc(log.userAgent || "-")}</span></div>
              <div>狀態: ${log.responseStatus} | 延遲: ${log.latencyMs}ms</div>
            </div>
            ${usageHtml}
            ${errorHtml}
            <div style="margin-top:12px;">
              <div style="font-weight:600;margin-bottom:6px;">請求體:</div>
              <div style="display:flex;gap:8px;align-items:flex-start;">
                <pre style="flex:1;background:var(--bg-tertiary);border-radius:6px;padding:12px;font-size:12px;overflow-x:auto;max-height:400px;white-space:pre-wrap;word-break:break-all;">${esc(bodyJson)}</pre>
                <button class="copy-btn" id="btn-copy-log-body" title="複製">${ic.clipboard}</button>
              </div>
            </div>`,
            [{ label: "關閉", class: "btn-ghost", onclick: closeModal }],
          );

          const copyBtn = $("#btn-copy-log-body");
          if (copyBtn) {
            copyBtn.onclick = () => copy(bodyJson);
          }
        };
      });
    } catch (err) {
      body.innerHTML = errorState(err.message);
    }
  }

  // =========================================================================
  // Pages — System Usage (Admin)
  // =========================================================================

  function renderUsageMeter(value) {
    const width = clampPercent(value);
    const level = usageLevelClass(value);
    return `<div class="usage-meter" aria-hidden="true"><div class="usage-meter-fill ${level}" style="width:${width}%;"></div></div>`;
  }

  function renderUsageCard(title, icon, value, subText, percent) {
    return `
      <div class="usage-card">
        <div class="usage-card-header">
          <div class="usage-card-title">${icon} ${esc(title)}</div>
        </div>
        <div class="usage-card-value">${esc(value)}</div>
        <div class="usage-card-sub">${esc(subText)}</div>
        ${renderUsageMeter(percent)}
      </div>`;
  }

  function renderUsageDetail(label, value, isText = false) {
    return `
      <div class="usage-detail">
        <div class="usage-detail-label">${esc(label)}</div>
        <div class="usage-detail-value${isText ? " text" : ""}">${esc(value)}</div>
      </div>`;
  }

  function renderSystemUsage(usage) {
    const sys = usage.system || {};
    const proc = usage.process || {};
    const sysMem = sys.memory || {};
    const procMem = proc.memory || {};
    const versions = proc.versions || {};
    const loadAverage = Array.isArray(sys.loadAverage) ? sys.loadAverage.map((v) => fmtNum(v, 2)).join(" / ") : "--";
    const heapPercent = procMem.heapUsedPercent;

    const cards = [
      renderUsageCard("系統 CPU", ic.chart, fmtPercent(sys.cpuPercent), `${fmtNum(sys.cpuCount)} 核心 · Load ${loadAverage}`, sys.cpuPercent),
      renderUsageCard("系統記憶體", ic.zap, fmtPercent(sysMem.usedPercent), `${fmtNum(sysMem.usedGb, 2)} / ${fmtNum(sysMem.totalGb, 2)} GB`, sysMem.usedPercent),
      renderUsageCard("程式 CPU", ic.trending, fmtPercent(proc.cpuPercent), `PID ${fmtNum(proc.pid)} · 已運行 ${fmtDuration(proc.uptimeSec)}`, proc.cpuPercent),
      renderUsageCard("程式 Heap", ic.code, fmtPercent(heapPercent), `${fmtNum(procMem.heapUsedMb, 2)} / ${fmtNum(procMem.heapTotalMb, 2)} MB`, heapPercent),
    ].join("");

    const details = [
      renderUsageDetail("主機名稱", sys.hostname || "--", true),
      renderUsageDetail("平台 / 架構", `${sys.platform || "--"} / ${sys.arch || "--"}`, true),
      renderUsageDetail("CPU 核心", fmtNum(sys.cpuCount)),
      renderUsageDetail("Load Average", loadAverage),
      renderUsageDetail("系統運行時間", fmtDuration(sys.uptimeSec)),
      renderUsageDetail("程式 PID", fmtNum(proc.pid)),
      renderUsageDetail("程式運行時間", fmtDuration(proc.uptimeSec)),
      renderUsageDetail("Node / V8", `${versions.node || "--"} / ${versions.v8 || "--"}`, true),
      renderUsageDetail("RSS", `${fmtNum(procMem.rssMb, 2)} MB`),
      renderUsageDetail("Heap Total", `${fmtNum(procMem.heapTotalMb, 2)} MB`),
      renderUsageDetail("External", `${fmtNum(procMem.externalMb, 2)} MB`),
      renderUsageDetail("Array Buffers", `${fmtNum(procMem.arrayBuffersMb, 2)} MB`),
    ].join("");

    return `
      <div class="usage-grid">${cards}</div>
      <div class="card">
        <div class="card-title">${ic.settings} 詳細資訊</div>
        <div class="usage-detail-grid">${details}</div>
      </div>`;
  }

  async function pageSystemUsage() {
    if (!state.user?.isAdmin) { location.hash = "#/dashboard"; return; }
    const body = setPage("系統佔用", "即時查看主機與目前 Node.js 程式資源佔用");
    stopSystemUsagePolling();

    body.innerHTML = `
      <div class="usage-toolbar">
        <button class="btn btn-ghost" id="btn-refresh-system-usage">${ic.refresh} 刷新</button>
        <span class="usage-updated" id="system-usage-updated">等待取樣</span>
      </div>
      <div id="system-usage-content">${loading("載入系統佔用...")}</div>`;

    let inFlight = false;
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      const btn = $("#btn-refresh-system-usage");
      const updated = $("#system-usage-updated");
      const content = $("#system-usage-content");
      if (btn) btn.disabled = true;
      try {
        const data = await API.get("/web/api/admin/system-usage");
        if (!content) return;
        content.innerHTML = renderSystemUsage(data.usage || {});
        if (updated) updated.textContent = `最後更新：${fmtDate(data.usage?.timestamp)}`;
      } catch (err) {
        if (content) content.innerHTML = errorState(err.message);
        if (updated) updated.textContent = "更新失敗";
      } finally {
        if (btn) btn.disabled = false;
        inFlight = false;
      }
    };

    const refreshBtn = $("#btn-refresh-system-usage");
    if (refreshBtn) refreshBtn.onclick = refresh;
    await refresh();
    systemUsageTimer = setInterval(refresh, 1000);
  }

  // =========================================================================
  // Pages — Plugin Management (Admin)
  // =========================================================================

  function pluginKindLabel(kind) {
    if (kind === "github") return "GitHub";
    if (kind === "upload") return "檔案匯入";
    if (kind === "env") return "環境變數";
    return kind || "未知";
  }

  function renderPluginStatusList(plugins) {
    const loaded = Array.isArray(plugins.loaded) ? plugins.loaded : [];
    const installed = Array.isArray(plugins.installed) ? plugins.installed : [];
    const installedById = new Map(installed.map((item) => [item.id, item]));
    const ids = new Set([...loaded.map((item) => item.id), ...installed.map((item) => item.id)]);

    if (ids.size === 0) {
      return `
        <div class="plugin-empty">
          ${ic.plug}
          <div>
            <strong>尚未安裝插件</strong>
            <p>可以從本機 .js/.mjs 檔案匯入，或貼上 GitHub raw/blob/repo 連結線上安裝。</p>
          </div>
        </div>`;
    }

    const items = [...ids].sort().map((id) => {
      const loadedItem = loaded.find((item) => item.id === id) || {};
      const installedItem = installedById.get(id) || {};
      const name = loadedItem.name || installedItem.name || id;
      const version = loadedItem.version || installedItem.version || "--";
      const description = loadedItem.description || installedItem.description || "未提供描述";
      const source = installedItem.url || installedItem.source || loadedItem.source || "--";
      const installedAt = installedItem.installedAt ? fmtDate(installedItem.installedAt) : "--";
      const isLoaded = loaded.some((item) => item.id === id);

      return `
        <div class="plugin-item">
          <div class="plugin-item-main">
            <div class="plugin-item-title">
              <span>${esc(name)}</span>
              <span class="badge ${isLoaded ? "badge-success" : "badge-warning"}">${isLoaded ? "已載入" : "待重啟載入"}</span>
            </div>
            <div class="plugin-item-desc">${esc(description)}</div>
            <div class="plugin-meta">
              <span>ID: <code>${esc(id)}</code></span>
              <span>版本: <code>${esc(version)}</code></span>
              <span>來源: ${esc(pluginKindLabel(installedItem.kind || (loadedItem.source ? "env" : "")))}</span>
              <span>安裝時間: ${esc(installedAt)}</span>
            </div>
          </div>
          <div class="plugin-path" title="${esc(source)}">${esc(source)}</div>
        </div>`;
    }).join("");

    return `<div class="plugin-list">${items}</div>`;
  }

  async function pagePlugins() {
    if (!state.user?.isAdmin) { location.hash = "#/dashboard"; return; }
    const body = setPage("插件管理", "透過 Web 匯入 Node.js 插件；Bot 不提供插件配置入口");

    body.innerHTML = `
      <div class="usage-toolbar">
        <button class="btn btn-ghost" id="btn-refresh-plugins">${ic.refresh} 刷新列表</button>
        <span class="usage-updated">插件會安裝到 Node.js 執行環境，請只匯入信任來源。</span>
      </div>
      <div class="form-hint" style="margin-bottom:16px;">註：安裝第三方插件說明你信任第三方插件與本項目無關。</div>

      <div class="plugin-install-grid">
        <div class="card plugin-card">
          <div class="card-title">${ic.download} 匯入本機插件檔案</div>
          <div class="form-group">
            <label for="plugin-file">插件入口檔</label>
            <input type="file" id="plugin-file" accept=".js,.mjs">
            <div class="form-hint">支援 .js / .mjs，大小上限 10MB。檔案內容會由伺服器端驗證後載入。</div>
          </div>
          <button class="btn btn-primary" id="btn-install-plugin-file">${ic.plug} 安裝檔案</button>
        </div>

        <div class="card plugin-card">
          <div class="card-title">${ic.link} 從 GitHub 安裝</div>
          <div class="form-group">
            <label for="plugin-github-url">GitHub 連結</label>
            <input type="url" id="plugin-github-url" placeholder="https://github.com/owner/repo 或 blob/raw .js">
            <div class="form-hint">支援 GitHub repo、tree、blob 與 raw 連結；repo 會讀取 plugin.json 的 main 欄位。</div>
          </div>
          <button class="btn btn-primary" id="btn-install-plugin-github">${ic.download} 線上安裝</button>
        </div>
      </div>

      <div class="card">
        <div class="card-title">${ic.plug} 已安裝插件</div>
        <div id="plugin-list-content">${loading("載入插件列表...")}</div>
      </div>`;

    const listContent = $("#plugin-list-content");
    const refreshBtn = $("#btn-refresh-plugins");
    const fileBtn = $("#btn-install-plugin-file");
    const githubBtn = $("#btn-install-plugin-github");

    const refresh = async () => {
      if (refreshBtn) refreshBtn.disabled = true;
      try {
        const data = await API.get("/web/api/admin/plugins");
        if (listContent) listContent.innerHTML = renderPluginStatusList(data.plugins || {});
      } catch (err) {
        if (listContent) listContent.innerHTML = errorState(err.message);
      } finally {
        if (refreshBtn) refreshBtn.disabled = false;
      }
    };

    const installFromFile = async () => {
      const input = $("#plugin-file");
      const file = input?.files?.[0];
      if (!file) { toast("請先選擇插件檔案", "warning"); return; }
      if (!/\.m?js$/i.test(file.name)) { toast("只支援 .js 或 .mjs 插件檔", "error"); return; }
      if (file.size > 10 * 1024 * 1024) { toast("插件檔案超過 10MB 上限", "error"); return; }

      fileBtn.disabled = true;
      try {
        const content = await file.text();
        const data = await API.post("/web/api/admin/plugins/upload", { filename: file.name, content });
        toast(`插件已安裝：${data.plugin?.name || data.plugin?.id || file.name}`, "success");
        input.value = "";
        await refresh();
      } catch (err) {
        toast(err.message, "error");
      } finally {
        fileBtn.disabled = false;
      }
    };

    const installFromGitHub = async () => {
      const input = $("#plugin-github-url");
      const url = input?.value?.trim();
      if (!url) { toast("請輸入 GitHub 連結", "warning"); return; }

      githubBtn.disabled = true;
      try {
        const data = await API.post("/web/api/admin/plugins/github", { url });
        toast(`插件已安裝：${data.plugin?.name || data.plugin?.id || url}`, "success");
        input.value = "";
        await refresh();
      } catch (err) {
        toast(err.message, "error");
      } finally {
        githubBtn.disabled = false;
      }
    };

    if (refreshBtn) refreshBtn.onclick = refresh;
    if (fileBtn) fileBtn.onclick = installFromFile;
    if (githubBtn) githubBtn.onclick = installFromGitHub;
    await refresh();
  }

  // =========================================================================
  // Pages — System Management (Admin)
  // =========================================================================

  async function pageSystem() {
    if (!state.user?.isAdmin) { location.hash = "#/dashboard"; return; }
    const body = setPage("系統管理", "系統設定、版本更新與重啟");
    body.innerHTML = loading();

    try {
      const [data, settingsData] = await Promise.all([
        API.get("/web/api/admin/version"),
        API.get("/web/api/admin/settings"),
      ]);
      const ver = data.version || {};
      const clean = data.workingDirClean;
      const settings = settingsData.settings || {};

      let html = `
        <div class="card">
          <div class="card-title">${ic.link} 系統設定</div>
          <div class="form-group">
            <label>API URL</label>
            <input type="url" id="sys-api-url" value="${esc(settings.api_url || "")}" placeholder="http://localhost:8000">
            ${settings.api_url_source && settings.api_url_source !== "configured" ? `
            <div style="margin-top:6px;font-size:12px;opacity:0.85;line-height:1.6;">
              ${settings.api_url_source === "tunnel" ? `⚠️ 目前使用 Cloudflare 快速隧道：<code>${esc(settings.effective_api_url)}</code>（重啟後 URL 會變更，留空儲存可恢復自動）` : ""}
              ${settings.api_url_source === "tunnel-pending" ? `⏳ Cloudflare 隧道連線中，暫時使用預設：<code>${esc(settings.effective_api_url)}</code>` : ""}
              ${settings.api_url_source === "default" ? `ℹ️ 未設定自訂 URL，目前使用預設：<code>${esc(settings.effective_api_url)}</code>` : ""}
            </div>` : ""}
          </div>
          <div class="form-group">
            <label>全域 Provider User-Agent</label>
            <input type="text" id="sys-provider-ua" value="${esc(settings.provider_default_user_agent || "")}" placeholder="留空使用 runtime 預設">
          </div>
                    ${settings.is_cloud_db ? `
          <div class="form-group">
            <label>?脩垢?豢?摨恍?瑞?</label>
            <div style="display:flex;align-items:center;gap:8px;">
              <input type="checkbox" id="sys-keepalive-enabled" ${settings.keepalive_enabled ? "checked" : ""}>
              <span>?摰?敹歲嚗神??+ ?芷?⊥?蝢拇???脫迫?脩垢 DB 隡?嚗?/span>
            </div>
            <input type="number" id="sys-keepalive-interval" value="${settings.keepalive_interval || 5}" min="1" max="1440" style="margin-top:8px;width:120px;">
            <span style="margin-top:4px;display:block;font-size:12px;opacity:0.7;">敹歲??嚗????身 5嚗?撠?1嚗?/span>
          </div>
          ` : ""}
<button class="btn btn-primary" id="btn-save-settings">儲存設定</button>
        </div>

        <div class="card" style="margin-top:16px;">
          <div class="card-title">${ic.refresh} 當前版本</div>
          <table class="table" style="margin-bottom:12px;">
            <tr><td style="width:120px;">Commit</td><td><code>${esc(ver.hash || "N/A")}</code></td></tr>
            <tr><td>Tag</td><td>${ver.tag ? `<span class="badge badge-success">${esc(ver.tag)}</span>` : '<span class="badge badge-muted">無</span>'}</td></tr>
            <tr><td>日期</td><td>${esc(ver.date || "N/A")}</td></tr>
            <tr><td>訊息</td><td style="font-size:12px;">${esc(ver.message || "N/A")}</td></tr>
            <tr><td>工作目錄</td><td>${clean ? '<span class="badge badge-success">乾淨</span>' : '<span class="badge badge-warning">有未提交變更</span>'}</td></tr>
          </table>
        </div>

        <div class="card" style="margin-top:16px;">
          <div class="card-title">${ic.download} 檢查更新</div>
          <button class="btn btn-primary" id="btn-check-update" style="margin-bottom:12px;">檢查 GitHub Release 更新</button>
          <div id="sys-update-result"></div>
        </div>

        <div class="card" style="margin-top:16px;">
          <div class="card-title">${ic.refresh} 版本回滾</div>
          <div class="hint" style="margin-bottom:12px;">Blue-Green 更新會自動保留舊版本備份，可用於回滾到上一個版本。</div>
          <div class="form-group">
            <button class="btn btn-secondary" id="btn-load-backups">載入備份列表</button>
            <div id="sys-backup-list" style="margin-top:12px;"></div>
          </div>
        </div>

        ${state.authConfig?.loginPath ? `
        <div class="card" style="margin-top:16px;">
          <div class="card-title">${ic.lock} 安全路徑</div>
          <div class="form-group">
            <div class="hint" style="margin-bottom:8px;">當前 Web 面板透過隨機 UUID 路徑保護。重新生成後舊連結立即失效，需重新登入。</div>
            <button class="btn btn-secondary" id="btn-regenerate-panel-path">重新生成面板路徑</button>
          </div>
        </div>
        ` : ""}
        <div class="card" style="margin-top:16px;">
          <div class="card-title">${ic.alert} 危險操作</div>
          <div class="form-group">
            <button class="btn btn-danger" id="btn-restart">重啟進程</button>
            <div class="hint">重啟後 Web 和 Bot 服務會短暫中斷（約 5 秒）</div>
          </div>
        </div>
      `;
      body.innerHTML = html;

      const saveSettingsBtn = $("#btn-save-settings");
      if (saveSettingsBtn) {
        saveSettingsBtn.onclick = async () => {
          saveSettingsBtn.disabled = true;
          saveSettingsBtn.textContent = "儲存中...";
          try {
            await API.put("/web/api/admin/settings", {
              api_url: $("#sys-api-url").value.trim(),
              provider_default_user_agent: $("#sys-provider-ua").value.trim(),
              keepalive_enabled: $("#sys-keepalive-enabled") ? $("#sys-keepalive-enabled").checked : undefined,
              keepalive_interval: $("#sys-keepalive-interval") ? Number($("#sys-keepalive-interval").value) : undefined,
            });
            toast("設定已儲存", "success");
          } catch (err) {
            toast(err.message, "error");
          } finally {
            saveSettingsBtn.disabled = false;
            saveSettingsBtn.textContent = "儲存設定";
          }
        };
      }

      // 檢查更新
      $("#btn-check-update").onclick = async () => {
        const btn = $("#btn-check-update");
        const resultDiv = $("#sys-update-result");
        btn.disabled = true;
        btn.textContent = "檢查中...";
        resultDiv.innerHTML = loading();

        try {
          const checkData = await API.get("/web/api/admin/check-update");
          let updateHtml = "";
          if (checkData.hasUpdate) {
            const release = checkData.latestRelease;
            // 偵測 Release 是否提供預編譯包（prebuilt asset）
            const hasPrebuilt = Array.isArray(release?.assets) && release.assets.some(a => {
              const name = a.name || "";
              const url = a.browser_download_url || a.url || "";
              return name === "s12ryt-tg-api-dist.tar.gz"
                || /s12ryt-tg-api-dist.*\.tar\.gz$/i.test(name)
                || /s12ryt-tg-api-dist.*\.tar\.gz$/i.test(url);
            });
            // 更新方式標籤（純文字，不用 emoji）
            const methodLabel = (m) => {
              if (m === "prebuilt") return "預編譯包（零編譯快速更新）";
              if (m === "blue-green") return "Blue-Green 原子交換";
              if (m === "tarball") return "tarball 下載";
              if (m === "git") return "git pull";
              return m;
            };
            updateHtml = `
              <div style="padding:12px;background:var(--bg-accent);border-radius:8px;margin-bottom:12px;">
                <p>${ic.sparkles} <strong>有新版本可用！</strong></p>
                <p style="margin-top:6px;">最新版本: <strong>${esc(release?.tag || "N/A")}</strong></p>
                <p style="font-size:12px;color:var(--text-secondary);">${esc(release?.name || "")}</p>
                ${checkData.commitsBehind > 0 ? `<p style="font-size:12px;color:var(--text-secondary);">落後 ${checkData.commitsBehind} 個 commit</p>` : ""}
              </div>
              <div class="hint" style="margin-bottom:8px;">選擇更新方式：</div>
              <div style="display:flex;gap:8px;flex-wrap:wrap;">
                ${hasPrebuilt ? `<button class="btn btn-primary" id="btn-update-prebuilt">${ic.download} 預編譯包（快速，零編譯）</button>` : ""}
                <button class="btn ${hasPrebuilt ? "btn-secondary" : "btn-primary"}" id="btn-update-bluegreen">${ic.refresh} Blue-Green（源碼編譯）</button>
              </div>
            `;
            resultDiv.innerHTML = updateHtml;

            const runUpdate = (method) => {
              confirm(`確定要使用${method === "prebuilt" ? "預編譯包" : "Blue-Green"}方式更新並重啟嗎？更新期間服務會短暫中斷。`, async () => {
                // 停用所有更新按鈕，避免重複點擊；被點的按鈕顯示進度
                const targetBtn = method === "prebuilt" ? $("#btn-update-prebuilt") : $("#btn-update-bluegreen");
                resultDiv.querySelectorAll("button[id^='btn-update-']").forEach(b => { b.disabled = true; });
                if (targetBtn) targetBtn.textContent = "更新中...";
                try {
                  const updateData = await API.post("/web/api/admin/update", { method, restart: true });
                  resultDiv.innerHTML = `
                    <div style="padding:12px;background:var(--bg-accent);border-radius:8px;">
                      <p>${updateData.success ? ic.check : ic.alert} ${esc(updateData.message)}</p>
                      ${updateData.method ? `<p style="font-size:12px;">更新方式: ${esc(methodLabel(updateData.method))}</p>` : ""}
                      <p style="font-size:12px;color:var(--text-secondary);">如果頁面沒有自動重連，請稍後手動刷新。</p>
                    </div>
                  `;
                  toast(updateData.message, updateData.success ? "success" : "warning");
                } catch (err) {
                  toast(err.message, "error");
                  resultDiv.innerHTML = `<p style="color:var(--accent-red);">更新失敗: ${esc(err.message)}</p>`;
                }
              });
            };
            const prebuiltBtn = $("#btn-update-prebuilt");
            if (prebuiltBtn) prebuiltBtn.onclick = () => runUpdate("prebuilt");
            $("#btn-update-bluegreen").onclick = () => runUpdate("blue-green");
          } else {
            resultDiv.innerHTML = `<div style="padding:12px;background:var(--bg-accent);border-radius:8px;"><p>${ic.check} 已是最新版本</p></div>`;
            toast("已是最新版本", "success");
          }
        } catch (err) {
          resultDiv.innerHTML = `<p style="color:var(--accent-red);">檢查失敗: ${esc(err.message)}</p>`;
          toast(err.message, "error");
        } finally {
          btn.disabled = false;
          btn.textContent = "檢查 GitHub Release 更新";
        }
      };

      // 重啟
            // 安全路徑：重新生成 panel UUID
      const regenBtn = $("#btn-regenerate-panel-path");
      if (regenBtn) {
        regenBtn.onclick = async () => {
          if (!confirm("確定要重新生成面板路徑嗎？目前的所有連結將立即失效，您需要重新登入。")) return;
          regenBtn.disabled = true;
          regenBtn.textContent = "生成中...";
          try {
            const result = await API.post("/web/api/admin/regenerate-panel-path");
            state.sessionToken = null;
            state.user = null;
            localStorage.removeItem("web_session");
            toast("面板路徑已更新，正在跳轉到登入頁...", "success");
            setTimeout(() => { window.location.href = result.loginPath; }, 1500);
          } catch (err) {
            toast(err.message, "error");
          } finally {
            regenBtn.disabled = false;
            regenBtn.textContent = "重新生成面板路徑";
          }
        };
      }

      $("#btn-restart").onclick = () => {
        confirm("確定要重啟進程嗎？所有服務會短暫中斷。", async () => {
          try {
            await API.post("/web/api/admin/restart", { delay: 1000 });
            toast("重啟指令已發送，請稍後刷新頁面", "success");
            setTimeout(() => location.reload(), 3000);
          } catch (err) {
            toast(err.message, "error");
          }
        });
      };

      // 版本回滾
      $("#btn-load-backups").onclick = async () => {
        const btn = $("#btn-load-backups");
        const listDiv = $("#sys-backup-list");
        btn.disabled = true;
        btn.textContent = "載入中...";
        listDiv.innerHTML = loading();
        try {
          const data = await API.get("/web/api/admin/backups");
          const backups = data.backups || [];
          if (backups.length === 0) {
            listDiv.innerHTML = `<p style="color:var(--text-secondary);">沒有可用的備份版本。執行過 Blue-Green 更新後才會產生備份。</p>`;
          } else {
            listDiv.innerHTML = backups.map((b, i) => `
              <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;background:var(--bg-accent);border-radius:8px;margin-bottom:8px;">
                <div>
                  <strong>${i === 0 ? "最新備份" : `備份 #${i + 1}`}</strong>
                  <span style="font-size:12px;color:var(--text-secondary);margin-left:8px;">${esc(new Date(b.timestamp).toLocaleString())}</span>
                </div>
                ${i === 0 ? `<button class="btn btn-danger" id="btn-do-rollback" style="padding:4px 12px;font-size:13px;">回滾到此版本</button>` : ""}
              </div>
            `).join("");
            const rollbackBtn = $("#btn-do-rollback");
            if (rollbackBtn) {
              rollbackBtn.onclick = () => {
                confirm("確定要回滾到上一個版本嗎？當前版本會被保存為新備份，服務會短暫中斷。", async () => {
                  rollbackBtn.disabled = true;
                  rollbackBtn.textContent = "回滾中...";
                  try {
                    await API.post("/web/api/admin/rollback", {});
                    listDiv.innerHTML = `<div style="padding:12px;background:var(--bg-accent);border-radius:8px;"><p>${ic.check} 回滾指令已執行，正在重啟...</p><p style="font-size:12px;color:var(--text-secondary);">如果頁面沒有自動重連，請稍後手動刷新。</p></div>`;
                    toast("回滾中，請稍候刷新頁面", "success");
                    setTimeout(() => location.reload(), 5000);
                  } catch (err) {
                    toast(err.message, "error");
                    rollbackBtn.disabled = false;
                    rollbackBtn.textContent = "回滾到此版本";
                  }
                });
              };
            }
          }
        } catch (err) {
          listDiv.innerHTML = `<p style="color:var(--accent-red);">載入失敗: ${esc(err.message)}</p>`;
          toast(err.message, "error");
        } finally {
          btn.disabled = false;
          btn.textContent = "載入備份列表";
        }
      };
    } catch (err) {
      body.innerHTML = errorState(err.message);
    }
  }

  // =========================================================================
  // Pages — Account (password mode: change password)
  // =========================================================================

  async function pageAccount() {
    const body = setPage("個人設定", "管理您的帳號");
    body.innerHTML = `
      <div class="card" style="max-width:480px;">
        <h3 style="margin-bottom:16px;">修改密碼</h3>
        <div style="position:relative;margin-bottom:12px;">
          <input type="password" id="acc-current-pwd" placeholder="目前密碼" style="width:100%;padding:12px 44px 12px 12px;box-sizing:border-box;" autocomplete="current-password">
          <button type="button" class="pwd-toggle" data-target="acc-current-pwd" aria-label="顯示密碼" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;color:var(--text-secondary);padding:4px;display:flex;align-items:center;">${ic.eye}</button>
        </div>
        <div style="position:relative;margin-bottom:12px;">
          <input type="password" id="acc-new-pwd" placeholder="新密碼（至少 8 字元）" style="width:100%;padding:12px 44px 12px 12px;box-sizing:border-box;" autocomplete="new-password">
          <button type="button" class="pwd-toggle" data-target="acc-new-pwd" aria-label="顯示密碼" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;color:var(--text-secondary);padding:4px;display:flex;align-items:center;">${ic.eye}</button>
        </div>
        <div style="position:relative;margin-bottom:16px;">
          <input type="password" id="acc-confirm-pwd" placeholder="確認新密碼" style="width:100%;padding:12px 44px 12px 12px;box-sizing:border-box;" autocomplete="new-password">
          <button type="button" class="pwd-toggle" data-target="acc-confirm-pwd" aria-label="顯示密碼" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;color:var(--text-secondary);padding:4px;display:flex;align-items:center;">${ic.eye}</button>
        </div>
        <button class="btn btn-primary" id="btn-save-password" style="width:100%;">更新密碼</button>
        <p id="acc-msg" style="margin-top:8px;font-size:13px;min-height:18px;"></p>
      </div>
    `;

    const btn = $("#btn-save-password");
    const msgEl = $("#acc-msg");
    btn.onclick = async () => {
      const current = $("#acc-current-pwd").value;
      const newPwd = $("#acc-new-pwd").value;
      const confirmPwd = $("#acc-confirm-pwd").value;
      msgEl.textContent = "";

      if (!current || !newPwd || !confirmPwd) {
        msgEl.textContent = "請填寫所有欄位";
        msgEl.style.color = "var(--accent-red)";
        return;
      }
      if (newPwd !== confirmPwd) {
        msgEl.textContent = "兩次輸入的新密碼不一致";
        msgEl.style.color = "var(--accent-red)";
        return;
      }
      if (newPwd.length < 8) {
        msgEl.textContent = "新密碼至少需要 8 字元";
        msgEl.style.color = "var(--accent-red)";
        return;
      }

      btn.disabled = true;
      btn.textContent = "更新中...";
      try {
        await API.put("/web/api/auth/password", { currentPassword: current, newPassword: newPwd });
        toast("密碼已更新", "success");
        $("#acc-current-pwd").value = "";
        $("#acc-new-pwd").value = "";
        $("#acc-confirm-pwd").value = "";
        msgEl.textContent = "密碼已更新，其他設備的登入狀態已失效";
        msgEl.style.color = "var(--success)";
      } catch (err) {
        msgEl.textContent = err.message || "更新失敗";
        msgEl.style.color = "var(--accent-red)";
      } finally {
        btn.disabled = false;
        btn.textContent = "更新密碼";
      }
    };
  }

  // =========================================================================
  // Pages — Web Users (admin, password mode)
  // =========================================================================

  async function pageWebUsers() {
    const body = setPage("Web 帳號", "管理帳密模式的用戶");
    body.innerHTML = loading();

    try {
      const data = await API.get("/web/api/admin/web-users");
      const users = data.users || [];
      body.innerHTML = `
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:8px;">
            <h3>Web 用戶列表（${users.length}）</h3>
            <button class="btn btn-primary" id="btn-add-web-user">新增用戶</button>
          </div>
          <div style="overflow-x:auto;">
            <table style="width:100%;border-collapse:collapse;font-size:14px;">
              <thead>
                <tr style="border-bottom:2px solid var(--border);">
                  <th style="text-align:left;padding:8px 12px;">ID</th>
                  <th style="text-align:left;padding:8px 12px;">使用者名稱</th>
                  <th style="text-align:left;padding:8px 12px;">角色</th>
                  <th style="text-align:left;padding:8px 12px;">狀態</th>
                  <th style="text-align:left;padding:8px 12px;">建立時間</th>
                  <th style="text-align:left;padding:8px 12px;">操作</th>
                </tr>
              </thead>
              <tbody>
                ${users.length === 0 ? `<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--text-secondary);">無用戶</td></tr>` : users.map(function (u) {
                  var uid = Number(u.id);
                  var isAdmin = Number(u.is_admin) === 1;
                  var isActive = Number(u.is_active) === 1;
                  return '<tr style="border-bottom:1px solid var(--border);">' +
                    '<td style="padding:8px 12px;">' + esc(u.id) + '</td>' +
                    '<td style="padding:8px 12px;font-family:var(--mono);">' + esc(u.username) + '</td>' +
                    '<td style="padding:8px 12px;">' + (isAdmin ? '<span style="color:var(--accent);">管理員</span>' : '一般') + '</td>' +
                    '<td style="padding:8px 12px;">' + (isActive ? '<span style="color:var(--success);">啟用</span>' : '<span style="color:var(--accent-red);">停用</span>') + '</td>' +
                    '<td style="padding:8px 12px;">' + fmtDate(u.created_at) + '</td>' +
                    '<td style="padding:8px 12px;white-space:nowrap;">' +
                      '<button class="btn btn-ghost btn-sm" data-action="toggle" data-uid="' + uid + '" data-active="' + (isActive ? "1" : "0") + '">' + (isActive ? "停用" : "啟用") + '</button> ' +
                      '<button class="btn btn-ghost btn-sm" data-action="reset" data-uid="' + uid + '" data-username="' + esc(u.username) + '">重設密碼</button> ' +
                      '<button class="btn btn-danger btn-sm" data-action="delete" data-uid="' + uid + '" data-username="' + esc(u.username) + '">刪除</button>' +
                    '</td>' +
                  '</tr>';
                }).join("")}
              </tbody>
            </table>
          </div>
        </div>
      `;

      // 事件委託：data-action 按鈕
      body.querySelectorAll("[data-action]").forEach(function (btn) {
        btn.onclick = function () {
          var action = btn.dataset.action;
          var uid = parseInt(btn.dataset.uid, 10);
          if (isNaN(uid)) return;
          if (action === "toggle") {
            window._toggleWebUser(uid, btn.dataset.active === "1");
          } else if (action === "reset") {
            window._resetWebUserPwd(uid, btn.dataset.username || "");
          } else if (action === "delete") {
            window._deleteWebUser(uid, btn.dataset.username || "");
          }
        };
      });

      $("#btn-add-web-user").onclick = function () {
        showModal("新增 Web 用戶", `
          <div style="margin-bottom:12px;">
            <label style="display:block;margin-bottom:4px;font-size:13px;">使用者名稱（3-64 字元，英數字、底線、連字號）</label>
            <input type="text" id="wu-username" style="width:100%;padding:8px 12px;box-sizing:border-box;" autocomplete="off">
          </div>
          <div style="margin-bottom:12px;">
            <label style="display:block;margin-bottom:4px;font-size:13px;">密碼（至少 8 字元）</label>
            <input type="password" id="wu-password" style="width:100%;padding:8px 12px;box-sizing:border-box;" autocomplete="new-password">
          </div>
          <div style="margin-bottom:12px;">
            <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;">
              <input type="checkbox" id="wu-is-admin"> 設為管理員
            </label>
          </div>
          <p id="wu-msg" style="font-size:13px;min-height:18px;color:var(--accent-red);"></p>
        `, [
          { label: "取消", class: "btn-ghost" },
          {
            label: "建立", class: "btn-primary", close: false, onClick: async function (modalBody) {
              var username = modalBody.querySelector("#wu-username").value.trim();
              var password = modalBody.querySelector("#wu-password").value;
              var isAdmin = modalBody.querySelector("#wu-is-admin").checked;
              var msgEl = modalBody.querySelector("#wu-msg");
              msgEl.textContent = "";

              if (!username || !password) { msgEl.textContent = "請填寫所有欄位"; return; }
              if (password.length < 8) { msgEl.textContent = "密碼至少需要 8 字元"; return; }

              try {
                await API.post("/web/api/admin/web-users", { username: username, password: password, isAdmin: isAdmin });
                toast("用戶已建立", "success");
                closeModal();
                pageWebUsers();
              } catch (err) {
                msgEl.textContent = err.message || "建立失敗";
              }
            }
          }
        ]);
      };

      window._toggleWebUser = function (id, currentlyActive) {
        var action = currentlyActive ? "停用" : "啟用";
        confirm("確定要" + action + "此用戶嗎？" + (currentlyActive ? "停用後該用戶將立即被登出。" : ""), async function () {
          try {
            await API.put("/web/api/admin/web-users/" + id + "/status", { isActive: !currentlyActive });
            toast("已" + action, "success");
            pageWebUsers();
          } catch (err) {
            toast(err.message, "error");
          }
        });
      };

      window._resetWebUserPwd = function (id, username) {
        showModal("重設 " + esc(username) + " 的密碼", `
          <div style="margin-bottom:12px;">
            <label style="display:block;margin-bottom:4px;font-size:13px;">新密碼（至少 8 字元）</label>
            <input type="password" id="rp-new-pwd" style="width:100%;padding:8px 12px;box-sizing:border-box;" autocomplete="new-password">
          </div>
          <p style="font-size:13px;color:var(--text-secondary);">重設後該用戶的所有登入狀態將失效。</p>
          <p id="rp-msg" style="font-size:13px;min-height:18px;color:var(--accent-red);"></p>
        `, [
          { label: "取消", class: "btn-ghost" },
          {
            label: "重設", class: "btn-primary", close: false, onClick: async function (modalBody) {
              var newPwd = modalBody.querySelector("#rp-new-pwd").value;
              var msgEl = modalBody.querySelector("#rp-msg");
              msgEl.textContent = "";
              if (!newPwd) { msgEl.textContent = "請輸入新密碼"; return; }
              if (newPwd.length < 8) { msgEl.textContent = "密碼至少需要 8 字元"; return; }
              try {
                await API.put("/web/api/admin/web-users/" + id + "/password", { newPassword: newPwd });
                toast("密碼已重設", "success");
                closeModal();
              } catch (err) {
                msgEl.textContent = err.message || "重設失敗";
              }
            }
          }
        ]);
      };

      window._deleteWebUser = function (id, username) {
        confirm("確定要刪除用戶「" + username + "」嗎？此操作不可復原。", async function () {
          try {
            await API.del("/web/api/admin/web-users/" + id);
            toast("用戶已刪除", "success");
            pageWebUsers();
          } catch (err) {
            toast(err.message, "error");
          }
        });
      };
    } catch (err) {
      body.innerHTML = errorState(err.message);
    }
  }

  // =========================================================================
  // Init
  // =========================================================================

  function init() {
    // Modal close
    $("#modal-close").onclick = closeModal;
    $("#modal-overlay").onclick = (e) => {
      if (e.target === $("#modal-overlay")) closeModal();
    };

    // 行動端側欄切換
    $("#mobile-nav-toggle").onclick = toggleMobileNav;
    $("#mobile-nav-overlay").onclick = closeMobileNav;

    // Logout
    $("#btn-logout").onclick = async () => {
      try {
        await API.post("/web/api/auth/logout");
      } catch { /* ignore */ }
      handleSessionExpired("已登出");
    };

    // Password mode: login form
    const loginForm = $("#login-form");
    if (loginForm) {
      loginForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const username = $("#login-username").value.trim();
        const password = $("#login-password-input").value;
        const msgEl = $("#login-password-msg");
        if (!username || !password) {
          msgEl.textContent = "請輸入帳號和密碼";
          return;
        }
        const btn = $("#login-submit");
        btn.disabled = true;
        btn.textContent = "登入中...";
        msgEl.textContent = "";
        try {
          const result = await API.post("/web/api/auth/login", { username, password });
          state.sessionToken = result.sessionToken;
          localStorage.setItem("web_session", result.sessionToken);
          const me = await API.get("/web/api/auth/me");
          onLoginSuccess(me);
        } catch (err) {
          msgEl.textContent = err.message || "登入失敗";
        } finally {
          btn.disabled = false;
          btn.textContent = "登入";
        }
      });
    }

    // Password mode: setup form (首次建立管理員)
    const setupForm = $("#setup-form");
    if (setupForm) {
      setupForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const username = $("#setup-username").value.trim();
        const password = $("#setup-password").value;
        const confirmPw = $("#setup-password-confirm").value;
        const msgEl = $("#setup-msg");
        if (!username || !password) {
          msgEl.textContent = "請輸入帳號和密碼";
          return;
        }
        if (password !== confirmPw) {
          msgEl.textContent = "兩次密碼不一致";
          return;
        }
        if (password.length < 8) {
          msgEl.textContent = "密碼至少需要 8 個字元";
          return;
        }
        const btn = $("#setup-submit");
        btn.disabled = true;
        btn.textContent = "建立中...";
        msgEl.textContent = "";
        try {
          const result = await API.post("/web/api/auth/setup", { username, password });
          state.sessionToken = result.sessionToken;
          localStorage.setItem("web_session", result.sessionToken);
          state.authConfig = { authMode: "password", needsSetup: false };
          const me = await API.get("/web/api/auth/me");
          onLoginSuccess(me);
        } catch (err) {
          msgEl.textContent = err.message || "建立失敗";
        } finally {
          btn.disabled = false;
          btn.textContent = "建立管理員";
        }
      });
    }

    // 密碼顯示/隱藏切換（事件委託，涵蓋 login + setup 所有 pwd-toggle 按鈕）
    document.addEventListener("click", (e) => {
      const btn = e.target.closest(".pwd-toggle");
      if (!btn) return;
      const input = document.getElementById(btn.dataset.target);
      if (!input) return;
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      btn.setAttribute("aria-label", show ? "隱藏密碼" : "顯示密碼");
    });

    // ESC 關閉 modal / mobile nav
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        closeModal();
        closeMobileNav();
      }
    });

    // 啟動登入流程
    tryLogin();
  }

  // DOM ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
