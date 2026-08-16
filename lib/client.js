window.__ModuleLoader__.load({ id: "dsh-token-meter", factory: (require) => { var module = { exports: {} }; var exports = module.exports;
"use strict";

// dsh-token-meter 原生仪表盘(重写):设置页「统计」板块
// 全部用 dsh 主题 CSS 变量,随主题自适应,无固定背景;
// 图表用 Chart.js(本地 /dsh-token-meter/chart.umd.js 动态加载)。

var React = require("react");

function fmt(n) {
  n = n || 0;
  if (n >= 1e8) return (n / 1e8).toFixed(1) + "亿";
  if (n >= 1e4) return (n / 1e4).toFixed(1) + "万";
  return n.toLocaleString();
}
function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;"); }
function cssVar(name, fallback) {
  try {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch (e) { return fallback; }
}

var PALETTE = ["#58a6ff", "#79c0ff", "#1f6feb", "#388bfd", "#4493f8", "#a5d6ff", "#2f81f7", "#6cb6ff"];
var modelColor = {};
function colorOf(m) {
  if (!(m in modelColor)) modelColor[m] = PALETTE[Object.keys(modelColor).length % PALETTE.length];
  return modelColor[m];
}

// 胶囊开关样式(注入一次)
var SEG_CSS = ".um-seg{position:relative;display:flex;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:3px}\n" +
  ".um-seg-btn{position:relative;z-index:1;flex:1;padding:5px 12px;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font-size:13px;cursor:pointer;white-space:nowrap;transition:color .2s}\n" +
  ".um-seg-btn:hover{color:var(--dsw-alias-label-primary)}\n" +
  ".um-seg-btn.active{color:var(--dsw-alias-bg-base)}\n" +
  ".um-cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:14px 0}\n" +
  ".um-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:12px 14px}\n" +
  ".um-card .l{font-size:12px;color:var(--dsw-alias-label-secondary)}\n" +
  ".um-card .v{font-size:18px;font-weight:600;margin-top:4px;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n" +
  ".um-panel{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:14px 16px;margin-bottom:12px}\n" +
  ".um-panel h3{margin:0 0 10px;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}\n" +
  ".um-link{font-size:12px;color:var(--dsw-alias-brand-primary);text-decoration:none}\n" +
  ".um-hint{font-size:12px;color:var(--dsw-alias-label-tertiary);margin-top:4px}\n" +
  ".um-donut{display:flex;align-items:center;gap:24px;flex-wrap:wrap}\n" +
  ".um-donut-legend{flex:1;min-width:220px;font-size:13px;color:var(--dsw-alias-label-primary)}\n" +
  ".um-donut-legend .row{display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}\n" +
  ".um-donut-legend .row:last-child{border-bottom:none}\n" +
  ".um-donut-legend .r2{color:var(--dsw-alias-label-secondary);font-size:12px}\n" +
  "@media(max-width:640px){.um-cards{grid-template-columns:repeat(2,1fr)}}";
if (typeof document !== "undefined" && !document.getElementById("um-seg-css")) {
  var st = document.createElement("style");
  st.id = "um-seg-css";
  st.textContent = SEG_CSS;
  document.head.appendChild(st);
}

// 设置页导航「统计」板块图标:官方默认只给 models/agent-presets/plugins 配专属图标,
// 其余板块一律显示齿轮;这里注入 remixicon 并把「统计」行的齿轮换成图表图标
if (typeof document !== "undefined") {
  if (!document.getElementById("um-remix")) {
    var umLk = document.createElement("link");
    umLk.id = "um-remix";
    umLk.rel = "stylesheet";
    umLk.href = "/dsh-token-meter/remixicon.css";
    document.head.appendChild(umLk);
  }
  if (!document.getElementById("um-ri-css")) {
    var umSt = document.createElement("style");
    umSt.id = "um-ri-css";
    umSt.textContent = ".um-ri{flex:none;font-size:16px;color:var(--dsw-alias-label-primary)}";
    document.head.appendChild(umSt);
  }
  function swapStatsIcon() {
    var dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
    for (var d = 0; d < dialogs.length; d++) {
      var nav = dialogs[d].querySelector("nav");
      if (!nav) continue;
      var btns = nav.querySelectorAll("button");
      for (var i = 0; i < btns.length; i++) {
        var b = btns[i];
        if (b.__umIconDone) continue;
        var hasLabel = false;
        var spans = b.querySelectorAll("span");
        for (var j = 0; j < spans.length; j++) {
          if (spans[j].children.length === 0 && spans[j].textContent.trim() === "\u7EDF\u8BA1") { hasLabel = true; break; }
        }
        if (!hasLabel) continue;
        b.__umIconDone = true;
        var svg = b.querySelector("svg");
        if (svg) svg.remove();
        var ic = document.createElement("i");
        ic.className = "ri-bar-chart-2-line um-ri";
        b.insertBefore(ic, b.firstChild);
      }
    }
  }
  var umScheduled = false;
  function scheduleSwap() {
    if (umScheduled) return;
    umScheduled = true;
    setTimeout(function () { umScheduled = false; swapStatsIcon(); }, 120);
  }
  var umObs = new MutationObserver(scheduleSwap);
  umObs.observe(document.body, { childList: true, subtree: true });
  swapStatsIcon();
}

// 动态加载本地 Chart.js
function loadChartLib(cb) {
  if (window.Chart) { cb(); return; }
  var s = document.createElement("script");
  s.src = "/dsh-token-meter/chart.umd.js";
  s.onload = function () { cb(); };
  s.onerror = function () { cb(new Error("Chart.js 加载失败")); };
  document.head.appendChild(s);
}

function UsagePanel() {
  var state = React.useState("7d");
  var range = state[0];
  var setRange = state[1];
  var state2 = React.useState(null);
  var data = state2[0];
  var setData = state2[1];
  var state3 = React.useState("");
  var error = state3[0];
  var setError = state3[1];
  var trendRef = React.useRef(null);
  var donutRef = React.useRef(null);
  var trendInst = React.useRef(null);
  var donutInst = React.useRef(null);
  var thumbRef = React.useRef(null);

  var load = React.useCallback(function (r) {
    setError("");
    return globalThis.fetch("/dsh-token-meter/summary?range=" + r)
      .then(function (res) { if (!res.ok) throw new Error("HTTP " + res.status); return res.json(); })
      .then(function (d) { setData(d); })
      .catch(function (e) { setError("加载用量失败：" + String(e && e.message ? e.message : e)); });
  }, []);

  React.useEffect(function () {
    load(range);
    var t = setInterval(function () { load(range); }, 60000);
    return function () { clearInterval(t); };
  }, [range, load]);

  // 数据就绪后渲染图表(Chart.js 动态加载)
  React.useEffect(function () {
    if (!data) return;
    loadChartLib(function (err) {
      if (err) { setError(String(err.message || err)); return; }
      renderCharts(data, trendRef.current, donutRef.current, trendInst, donutInst);
    });
  }, [data]);

  // 胶囊滑动指示
  React.useEffect(function () {
    if (thumbRef.current) thumbRef.current.style.transform = range === "30d" ? "translateX(100%)" : "translateX(0)";
  }, [range]);

  var d = data || { requests: 0, totalTokens: 0, cacheHitRate: 0, sessionCount: 0, messageCount: 0, topModel: null, models: [], series: [] };

  var cards = [
    { l: "tokens 用量", v: fmt(d.totalTokens) },
    { l: "会话数量", v: d.sessionCount },
    { l: "消息数量", v: d.messageCount },
    { l: "缓存命中率", v: (d.cacheHitRate * 100).toFixed(1) + "%" },
    { l: "请求数", v: d.requests },
    { l: "最常用模型", v: d.topModel ? esc(d.topModel.model) : "-" }
  ];

  var segBtns = ["7d", "30d"].map(function (r) {
    return React.createElement("button", {
      key: r,
      className: "um-seg-btn" + (r === range ? " active" : ""),
      onClick: function () { setRange(r); }
    }, r === "7d" ? "最近 7 天" : "最近 30 天");
  });

  return React.createElement("div", { style: { display: "flex", flexDirection: "column" } },
    React.createElement("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 } },
      React.createElement("div", { className: "um-seg", style: { position: "relative", display: "flex" } },
        React.createElement("div", { ref: thumbRef, style: { position: "absolute", top: 3, left: 3, width: "calc(50% - 3px)", height: "calc(100% - 6px)", borderRadius: 999, background: "var(--dsw-alias-label-primary)", transition: "transform .28s cubic-bezier(.4,0,.2,1)", willChange: "transform", pointerEvents: "none" } }),
        segBtns
      ),
      React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 10 } },
        React.createElement("a", { className: "um-link", href: "/dsh-token-meter/", target: "_blank", rel: "noreferrer" }, "在新窗口打开仪表盘 ↗"),
        React.createElement("button", {
          onClick: function () { load(range); },
          style: { fontSize: 12, padding: "5px 12px", borderRadius: 999, cursor: "pointer", border: "1px solid var(--dsw-alias-border-l1)", background: "transparent", color: "var(--dsw-alias-label-primary)" }
        }, "刷新")
      )
    ),
    error ? React.createElement("div", { className: "um-hint", style: { color: "var(--dsw-alias-state-error-primary)" } }, error) : null,
    React.createElement("div", { className: "um-cards" },
      cards.map(function (c, i) {
        return React.createElement("div", { key: i, className: "um-card" },
          React.createElement("div", { className: "l" }, c.l),
          React.createElement("div", { className: "v" }, c.v));
      })
    ),
    React.createElement("div", { className: "um-panel" },
      React.createElement("h3", null, "按天 Token 趋势"),
      React.createElement("div", { style: { position: "relative", height: 220 } },
        React.createElement("canvas", { ref: trendRef, style: { width: "100%", height: "100%" } })
      )
    ),
    React.createElement("div", { className: "um-panel" },
      React.createElement("h3", null, "模型用量"),
      React.createElement("div", { className: "um-donut" },
        React.createElement("div", { style: { position: "relative", width: 170, height: 170 } },
          React.createElement("canvas", { ref: donutRef, style: { width: "100%", height: "100%" } }),
          React.createElement("div", { style: { position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", textAlign: "center", pointerEvents: "none" } },
            React.createElement("div", { style: { fontSize: 11, color: "var(--dsw-alias-label-secondary)" } }, "tokens 用量"),
            React.createElement("div", { style: { fontSize: 15, fontWeight: 600, color: "var(--dsw-alias-label-primary)" } }, fmt(d.totalTokens))
          )
        ),
        React.createElement("div", { className: "um-donut-legend", id: "um-donut-legend" })
      )
    ),
    data ? React.createElement("div", { className: "um-hint" }, "更新于 " + String(d.updatedAt || "").replace("T", " ").slice(0, 19)) : null
  );
}

function renderCharts(d, trendCanvas, donutCanvas, trendInst, donutInst) {
  var tick = cssVar("--dsw-alias-label-secondary", "#8b98a5");
  var grid = cssVar("--dsw-alias-border-l1", "#232c37");
  var tooltipBg = cssVar("--dsw-alias-bg-layer-2", "#1c2430");
  var tooltipBorder = cssVar("--dsw-alias-border-l2", "#2d3847");
  var legendColor = cssVar("--dsw-alias-label-secondary", "#8b98a5");
  var titleColor = cssVar("--dsw-alias-label-primary", "#e6edf3");

  if (trendCanvas) {
    var s = d.series || [];
    var days = s.length;
    var modelKeys = [];
    var keySet = {};
    for (var i = 0; i < days; i++) {
      var segs = s[i].models || [];
      for (var j = 0; j < segs.length; j++) {
        var k = segs[j].provider + "/" + segs[j].model;
        if (!(k in keySet)) { keySet[k] = true; modelKeys.push(k); }
      }
    }
    var datasets = [];
    for (var mi = 0; mi < modelKeys.length; mi++) {
      var mk = modelKeys[mi];
      var arr = [];
      for (var i = 0; i < days; i++) {
        var found = 0;
        var segs = s[i].models || [];
        for (var j = 0; j < segs.length; j++) if (segs[j].provider + "/" + segs[j].model === mk) found = segs[j].totalTokens;
        arr.push(found);
      }
      datasets.push({ label: mk.split("/")[1], data: arr, backgroundColor: colorOf(mk), borderRadius: 2, stack: "tokens" });
    }
    var ctx = trendCanvas.getContext("2d");
    if (trendInst.current) trendInst.current.destroy();
    trendInst.current = new Chart(ctx, {
      type: "bar",
      data: { labels: s.map(function (b) { return b.label; }), datasets: datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { labels: { color: legendColor, boxWidth: 10, boxHeight: 10, usePointStyle: true, padding: 14 } },
          tooltip: {
            backgroundColor: tooltipBg, borderColor: tooltipBorder, borderWidth: 1,
            titleColor: titleColor, bodyColor: legendColor,
            callbacks: { label: function (item) { return " " + item.dataset.label + ": " + fmt(item.parsed.y) + " tokens"; } }
          }
        },
        scales: {
          x: { stacked: true, grid: { display: false }, ticks: { color: tick, font: { size: 10 }, maxRotation: 0, autoSkip: days > 12, maxTicksLimit: 8 } },
          y: { stacked: true, grid: { color: grid }, border: { display: false }, ticks: { color: tick, font: { size: 10 }, callback: function (v) { return fmt(v); } } }
        }
      }
    });
  }

  if (donutCanvas) {
    var ms = d.models || [];
    var total = d.totalTokens || 0;
    var dctx = donutCanvas.getContext("2d");
    if (donutInst.current) donutInst.current.destroy();
    donutInst.current = new Chart(dctx, {
      type: "doughnut",
      data: {
        labels: ms.map(function (m) { return m.model; }),
        datasets: [{ data: ms.map(function (m) { return m.totalTokens; }), backgroundColor: ms.map(function (m) { return colorOf(m.provider + "/" + m.model); }), borderWidth: 0, hoverOffset: 4 }]
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: "68%",
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: tooltipBg, borderColor: tooltipBorder, borderWidth: 1,
            titleColor: titleColor, bodyColor: legendColor,
            callbacks: { label: function (item) {
              var share = total > 0 ? item.parsed / total * 100 : 0;
              return " " + item.label + ": " + fmt(item.parsed) + " tokens (" + share.toFixed(1) + "%)";
            } }
          }
        }
      }
    });
    var lg = document.getElementById("um-donut-legend");
    if (lg) {
      var html = "";
      for (var i = 0; i < ms.length; i++) {
        html += '<div class="row"><span><span class="dot" style="background:' + colorOf(ms[i].provider + "/" + ms[i].model) + '"></span>' + esc(ms[i].model) + "</span><span>" + (ms[i].share * 100).toFixed(1) + '% <span class="r2">' + fmt(ms[i].totalTokens) + "</span></span></div>";
      }
      lg.innerHTML = html;
    }
  }
}

module.exports = {
  name: "dsh-token-meter",
  inject: ["slots"],
  apply(ctx) {
    const slots = ctx.get("slots");
    if (slots === void 0) return;
    ctx.effect(() => slots.inject("settings.section", () => slots.register(
      { name: "settings.section", id: "usage", order: 20, label: "\u7EDF\u8BA1" },
      () => React.createElement(UsagePanel)
    )));
  }
};
return module.exports; } });
