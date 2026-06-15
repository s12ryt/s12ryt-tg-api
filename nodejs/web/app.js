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
    user: null, // { tgUserId, isAdmin, username, isActive }
    models: [],
  };

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

      const resp = await fetch(path, opts);
      const data = await resp.json().catch(() => ({}));

      if (!resp.ok) {
        const msg = data.error || `HTTP ${resp.status}`;
        if (resp.status === 401) {
          // session 過期，清除並跳轉
          state.sessionToken = null;
          localStorage.removeItem("web_session");
          showLogin("登入已過期，請重新從 Bot 取得連結");
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
    $("#modal-title").textContent = title;
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

  // =========================================================================
  // Login Flow
  // =========================================================================

  function showLogin(msg = "請稍候") {
    $("#app").classList.add("hidden");
    $("#login-screen").classList.remove("hidden");
    $("#login-msg").textContent = msg;
  }

  function showApp() {
    $("#login-screen").classList.add("hidden");
    $("#app").classList.remove("hidden");
  }

  async function tryLogin() {
    // 從 URL 取 token
    const params = new URLSearchParams(location.search);
    const token = params.get("token");

    // 從 localStorage 取已有 session
    const saved = localStorage.getItem("web_session");
    if (saved && !token) {
      state.sessionToken = saved;
      // 驗證 session 是否有效
      try {
        const me = await API.get("/web/api/auth/me");
        onLoginSuccess(me);
        return;
      } catch {
        localStorage.removeItem("web_session");
        state.sessionToken = null;
      }
    }

    // 用 OTP token 換 session
    if (token) {
      try {
        const result = await API.post("/web/api/auth/login", { token });
        state.sessionToken = result.sessionToken;
        localStorage.setItem("web_session", result.sessionToken);
        const me = await API.get("/web/api/auth/me");
        onLoginSuccess(me);
        // 清除 URL 中的 token
        history.replaceState(null, "", location.pathname);
        return;
      } catch (err) {
        showLogin(err.message || "登入連結已過期，請重新從 Bot 取得");
        return;
      }
    }

    showLogin("請從 Telegram Bot 使用 /web 指令取得登入連結");
  }

  function onLoginSuccess(me) {
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
    "/providers": pageProviders,
    "/users": pageUsers,
    "/groups": pageGroups,
    "/all-usage": pageAllUsage,
    "/settings": pageSettings,
    "/api-test": pageApiTest,
    "/model-catch": pageModelCatch,
    "/system": pageSystem,
  };

  window.addEventListener("hashchange", handleRoute);

  function handleRoute() {
    const hash = location.hash.slice(1) || "/dashboard";
    const route = routes[hash];

    // 更新導覽列
    $$(".nav-item").forEach((el) => el.classList.remove("active"));
    const navEl = $(`.nav-item[data-route="${hash.slice(1)}"]`);
    if (navEl) navEl.classList.add("active");

    // 行動端：導航後自動收合側欄
    $("#sidebar").classList.remove("open");

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

        <div class="card">
          <div class="card-title">${ic.link} 快速操作</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <a href="#/keys" class="btn btn-primary">管理 API Keys</a>
            <a href="#/coding" class="btn btn-ghost">Coding 設定</a>
            <a href="#/usage" class="btn btn-ghost">查看用量</a>
            <a href="#/limits" class="btn btn-ghost">限制詳情</a>
          </div>
        </div>
      `;
    } catch (err) {
      body.innerHTML = `<div class="empty-state"><div class="icon">${ic.alert}</div><div class="title">載入失敗</div><p>${esc(err.message)}</p></div>`;
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
        <div style="margin-bottom:16px;">
          <button class="btn btn-primary" id="btn-add-key">＋ 新增 API Key</button>
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
                    <td><button class="btn-icon danger" onclick="window._delKey(${k.id})">刪除</button></td>
                  </tr>
                `).join("")}
              </tbody>
            </table></div></div>`
        }
      `;

      $("#btn-add-key").onclick = addKey;
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
      body.innerHTML = `<div class="empty-state"><div class="icon">${ic.alert}</div><div class="title">載入失敗</div><p>${esc(err.message)}</p></div>`;
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
            <button class="copy-btn" onclick="navigator.clipboard.writeText('${esc(result.key)}');this.textContent='✓';">${ic.clipboard}</button>
          </div>
        `,
        [{ label: "關閉", class: "btn-primary" }]
      );
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
        byModel[m].cost += Number(r.input_cost) + Number(r.output_cost) || 0;
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
      body.innerHTML = `<div class="empty-state"><div class="icon">${ic.alert}</div><div class="title">載入失敗</div><p>${esc(err.message)}</p></div>`;
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
            <label class="checkbox-wrap">
              <input type="checkbox" id="coding-active" ${cfg && Number(cfg.is_active) === 1 ? "checked" : ""}>
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
      body.innerHTML = `<div class="empty-state"><div class="icon">${ic.alert}</div><div class="title">載入失敗</div><p>${esc(err.message)}</p></div>`;
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
      body.innerHTML = `<div class="empty-state"><div class="icon">${ic.alert}</div><div class="title">載入失敗</div><p>${esc(err.message)}</p></div>`;
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
      body.innerHTML = `<div class="empty-state"><div class="icon">${ic.alert}</div><div class="title">載入失敗</div><p>${esc(err.message)}</p></div>`;
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
                <div style="display:flex;gap:6px;">
                  <button class="btn-icon" onclick="window._editProvider(${p.id})">編輯</button>
                  <button class="btn-icon" onclick="window._providerPrices(${p.id},'${esc(p.name)}')">定價</button>
                  <button class="btn-icon danger" onclick="window._delProvider(${p.id},'${esc(p.name)}')">刪除</button>
                </div>
              </div>
              <div style="font-size:13px;">
                <strong>Keys:</strong> ${(p.api_keys || []).length} 個 &nbsp;|&nbsp;
                <strong>模型:</strong> ${(p.models_list || []).length} 個
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
    } catch (err) {
      body.innerHTML = `<div class="empty-state"><div class="icon">${ic.alert}</div><div class="title">載入失敗</div><p>${esc(err.message)}</p></div>`;
    }
  }

  function showProviderForm(p = null) {
    const isEdit = !!p;
    const keys = p ? (p.api_keys || []).join(", ") : "";

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
          <label>API Keys（逗號分隔多個）</label>
          <textarea id="pf-keys" placeholder="sk-xxx,sk-yyy">${esc(keys)}</textarea>
        </div>
        <div class="form-group">
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;">
            <button class="btn btn-ghost btn-sm" id="btn-pf-detect-proto">${ic.search} 偵測協議</button>
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
            <label class="checkbox-wrap">
              <input type="checkbox" id="pf-enabled" ${Number(p.enabled) === 1 ? "checked" : ""}>
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

            const payload = {
              name: modalBody.querySelector("#pf-name").value.trim(),
              api_type: modalBody.querySelector("#pf-type").value,
              base_url: modalBody.querySelector("#pf-url").value.trim(),
              api_key: modalBody.querySelector("#pf-keys").value.trim(),
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

    // 綁定「+ 新增模型」按鈕
    const addBtn = $("#btn-pf-add-model");
    if (addBtn) {
      addBtn.onclick = () => addModelRow();
    }

    // 綁定三個獨立按鈕
    const resultDiv = $("#pf-detect-result");

    // 1️⃣ 偵測協議
    const btnProto = $("#btn-pf-detect-proto");
    if (btnProto) {
      btnProto.onclick = async () => {
        const baseUrl = $("#pf-url").value.trim();
        const apiKey = $("#pf-keys").value.trim();
        if (!baseUrl) { toast("請先填入 Base URL", "error"); return; }
        btnProto.disabled = true;
        btnProto.innerHTML = ic.search + " 偵測中...";
        resultDiv.innerHTML = `<span style="color:var(--text-tertiary);">正在偵測協議...</span>`;
        try {
          const data = await API.post("/web/api/admin/provider-detect", { baseUrl, apiKey });
          const det = data.detection;
          const lines = [];
          const protos = Object.entries(det.protocols || {});
          for (const [proto, info] of protos) {
            const icon = info.supported ? ic.check : ic.x;
            if (info.supported) {
              lines.push(`${icon} <strong>${esc(proto)}</strong> — 信心: ${esc(info.confidence)} — ${esc(info.reason)}`);
            } else {
              lines.push(`${icon} <strong>${esc(proto)}</strong> — ${esc(info.reason)}`);
            }
          }
          if (det.recommended) {
            const sel = $("#pf-type");
            if (sel) sel.value = det.recommended;
            lines.push(`${ic.target} <strong>推薦類型已自動選擇: ${esc(det.recommended)}</strong>`);
          }
          resultDiv.innerHTML = lines.join("<br>") || '<span style="color:var(--text-tertiary);">未偵測到結果</span>';
          toast("協議偵測完成", "success");
        } catch (err) {
          resultDiv.innerHTML = `<span style="color:var(--accent-red);">偵測失敗: ${esc(err.message)}</span>`;
          toast(err.message, "error");
        } finally {
          btnProto.disabled = false;
          btnProto.innerHTML = ic.search + " 偵測協議";
        }
      };
    }

    // 2️⃣ 抓取模型
    const btnModels = $("#btn-pf-fetch-models");
    if (btnModels) {
      btnModels.onclick = async () => {
        const baseUrl = $("#pf-url").value.trim();
        const apiKey = $("#pf-keys").value.trim();
        const apiType = $("#pf-type").value;
        if (!baseUrl) { toast("請先填入 Base URL", "error"); return; }
        if (!apiKey) { toast("抓取模型需要 API Key", "error"); return; }
        btnModels.disabled = true;
        btnModels.innerHTML = ic.clipboard + " 抓取中...";
        resultDiv.innerHTML = `<span style="color:var(--text-tertiary);">正在抓取模型列表...</span>`;
        try {
          const data = await API.post("/web/api/admin/provider-models", { baseUrl, apiKey, apiType });
          if (data.models && data.models.length > 0) {
            const container = $("#pf-models-container");
            if (container) container.innerHTML = "";
            data.models.forEach((modelId) => addModelRow(modelId));
            resultDiv.innerHTML = `${ic.clipboard} 已填入 <strong>${data.models.length}</strong> 個模型`;
            toast(`已填入 ${data.models.length} 個模型`, "success");
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
      body.innerHTML = `<div class="empty-state"><div class="icon">${ic.alert}</div><div class="title">載入失敗</div><p>${esc(err.message)}</p></div>`;
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
                <tr><th>ID</th><th>名稱</th><th>顯示名</th><th>RPM</th><th>TPM</th><th>並發</th><th>日Token</th><th>月Token</th><th>日費</th><th>月費</th><th>操作</th></tr>
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
                    <td style="display:flex;gap:4px;">
                      <button class="btn-icon" onclick="window._editGroup(${g.id})">編輯</button>
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
    } catch (err) {
      body.innerHTML = `<div class="empty-state"><div class="icon">${ic.alert}</div><div class="title">載入失敗</div><p>${esc(err.message)}</p></div>`;
    }
  }

  function showGroupForm(g = null) {
    const isEdit = !!g;
    const fields = [
      ["name", "名稱（英文）"], ["display_name", "顯示名"],
      ["rpm_limit", "RPM"], ["tpm_limit", "TPM"],
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
      `).join(""),
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
      body.innerHTML = `<div class="empty-state"><div class="icon">${ic.alert}</div><div class="title">載入失敗</div><p>${esc(err.message)}</p></div>`;
    }
  }

  // =========================================================================
  // Pages — Settings (Admin)
  // =========================================================================

  async function pageSettings() {
    if (!state.user?.isAdmin) { location.hash = "#/dashboard"; return; }
    const body = setPage("系統設定", "管理 API 端點 URL 等系統設定");
    body.innerHTML = loading();

    try {
      const data = await API.get("/web/api/admin/settings");
      const settings = data.settings || {};

      body.innerHTML = `
        <div class="card">
          <div class="card-title">${ic.settings} 系統設定</div>
          <div class="form-group">
            <label>API 端點 URL</label>
            <input type="url" id="set-api-url" value="${esc(settings.api_url || "")}">
            <div class="hint">這是顯示給用戶的 API 端點地址（如 https://api.example.com:8000）</div>
          </div>
          <button class="btn btn-primary" id="btn-save-settings">儲存</button>
        </div>
      `;

      $("#btn-save-settings").onclick = async () => {
        try {
          await API.put("/web/api/admin/settings", {
            api_url: $("#set-api-url").value.trim(),
          });
          toast("設定已儲存", "success");
        } catch (err) { toast(err.message, "error"); }
      };
    } catch (err) {
      body.innerHTML = `<div class="empty-state"><div class="icon">${ic.alert}</div><div class="title">載入失敗</div><p>${esc(err.message)}</p></div>`;
    }
  }

  // =========================================================================
  // Pages — API Test (Admin)
  // =========================================================================

  async function pageApiTest() {
    if (!state.user?.isAdmin) { location.hash = "#/dashboard"; return; }
    const body = setPage("API 協議測試", "偵測 API 端點支援的協議類型");
    body.innerHTML = `
      <div class="card">
        <div class="card-title">${ic.flask} API 協議偵測</div>
        <div class="form-group">
          <label>Base URL</label>
          <input type="url" id="at-url" placeholder="https://api.openai.com/v1">
        </div>
        <div class="form-group">
          <label>API Key（可選，填入可提高偵測準確度）</label>
          <input type="text" id="at-key" placeholder="sk-xxx">
        </div>
        <button class="btn btn-primary" id="btn-api-test">開始偵測</button>
      </div>
      <div id="at-result" style="margin-top:16px;"></div>
    `;

    $("#btn-api-test").onclick = async () => {
      const baseUrl = $("#at-url").value.trim();
      const apiKey = $("#at-key").value.trim();
      if (!baseUrl) { toast("請輸入 Base URL", "error"); return; }

      const btn = $("#btn-api-test");
      const resultDiv = $("#at-result");
      btn.disabled = true;
      btn.textContent = "偵測中...";
      resultDiv.innerHTML = loading();

      try {
        const data = await API.post("/web/api/admin/api-test", {
          baseUrl, apiKey: apiKey || undefined,
        });
        const det = data.result || data;
        const protos = Object.entries(det.protocols || {});

        let html = `<div class="card"><div class="card-title">${ic.flask} 偵測結果</div>`;
        if (data.allUnreachable) {
          html += `<div class="empty-state"><div class="icon">${ic.alert}</div><div class="title">所有端點無法連通</div><p>請檢查 URL 是否正確，或網路是否通暢</p></div>`;
        } else {
          html += '<table class="table"><thead><tr><th>協議</th><th>支援</th><th>信心等級</th><th>說明</th></tr></thead><tbody>';
          for (const [proto, info] of protos) {
            const supportIcon = info.supported
              ? `<span class="badge badge-success">${ic.check} 支援</span>`
              : `<span class="badge badge-danger">${ic.x} 不支援</span>`;
            const confClass = info.confidence === "high" ? "badge-success" : (info.confidence === "medium" ? "badge-warning" : "badge-muted");
            html += `<tr><td><strong>${esc(proto)}</strong></td><td>${supportIcon}</td><td><span class="badge ${confClass}">${esc(info.confidence || "low")}</span></td><td style="font-size:12px;">${esc(info.reason || "")}</td></tr>`;
          }
          html += "</tbody></table>";
          if (det.recommended) {
            html += `<div style="margin-top:12px;padding:12px;background:var(--bg-accent);border-radius:8px;">${ic.target} <strong>推薦協議: ${esc(det.recommended)}</strong></div>`;
          }
        }
        html += "</div>";
        resultDiv.innerHTML = html;
      } catch (err) {
        resultDiv.innerHTML = `<div class="empty-state"><div class="icon">${ic.alert}</div><div class="title">偵測失敗</div><p>${esc(err.message)}</p></div>`;
      } finally {
        btn.disabled = false;
        btn.textContent = "開始偵測";
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
          html += '<div class="empty-state"><div class="icon">${ic.lock}</div><div class="title">需要認證</div><p>此 API 需要提供有效的 API Key 才能取得模型列表</p></div>';
        } else if (models.length === 0) {
          html += '<div class="empty-state"><div class="icon">${ic.inbox}</div><div class="title">未找到模型</div></div>';
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
  // Pages — System Management (Admin)
  // =========================================================================

  async function pageSystem() {
    if (!state.user?.isAdmin) { location.hash = "#/dashboard"; return; }
    const body = setPage("系統管理", "版本資訊、更新與重啟");
    body.innerHTML = loading();

    try {
      const data = await API.get("/web/api/admin/version");
      const ver = data.version || {};
      const clean = data.workingDirClean;

      let html = `
        <div class="card">
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
          <div class="card-title">${ic.alert} 危險操作</div>
          <div class="form-group">
            <button class="btn btn-danger" id="btn-restart">重啟進程</button>
            <div class="hint">重啟後 Web 和 Bot 服務會短暫中斷（約 5 秒）</div>
          </div>
        </div>
      `;
      body.innerHTML = html;

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
            updateHtml = `
              <div style="padding:12px;background:var(--bg-accent);border-radius:8px;margin-bottom:12px;">
                <p>${ic.sparkles} <strong>有新版本可用！</strong></p>
                <p style="margin-top:6px;">最新版本: <strong>${esc(release?.tag || "N/A")}</strong></p>
                <p style="font-size:12px;color:var(--text-secondary);">${esc(release?.name || "")}</p>
                ${checkData.commitsBehind > 0 ? `<p style="font-size:12px;color:var(--text-secondary);">落後 ${checkData.commitsBehind} 個 commit</p>` : ""}
              </div>
              <button class="btn btn-primary" id="btn-do-update">立即更新並重啟</button>
            `;
            resultDiv.innerHTML = updateHtml;

            $("#btn-do-update").onclick = () => {
              confirm("確定要更新並重啟嗎？更新期間服務會短暫中斷。", async () => {
                const updateBtn = $("#btn-do-update");
                updateBtn.disabled = true;
                updateBtn.textContent = "更新中...";
                try {
                  const updateData = await API.post("/web/api/admin/update", { restart: true });
                  resultDiv.innerHTML = `
                    <div style="padding:12px;background:var(--bg-accent);border-radius:8px;">
                      <p>${updateData.success ? ic.check : ic.alert} ${esc(updateData.message)}</p>
                      ${updateData.method ? `<p style="font-size:12px;">更新方式: ${esc(updateData.method)}</p>` : ""}
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
    } catch (err) {
      body.innerHTML = `<div class="empty-state"><div class="icon">${ic.alert}</div><div class="title">載入失敗</div><p>${esc(err.message)}</p></div>`;
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
    $("#mobile-nav-toggle").onclick = () => {
      $("#sidebar").classList.toggle("open");
    };
    $("#mobile-nav-overlay").onclick = () => {
      $("#sidebar").classList.remove("open");
    };

    // Logout
    $("#btn-logout").onclick = async () => {
      try {
        await API.post("/web/api/auth/logout");
      } catch { /* ignore */ }
      state.sessionToken = null;
      state.user = null;
      localStorage.removeItem("web_session");
      showLogin("已登出，請從 Bot 重新取得連結");
    };

    // ESC 關閉 modal
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeModal();
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
