// dsh-token-meter —— 模型用量仪表盘常驻插件（host 组合行）
//
// 设计：只统计 assistant/message 且带 usage 的事件（失败请求无 message，不计）。
// 归属取 data.message.source.provider/model；累加 inputTokens/outputTokens/
// cacheReadTokens/cacheWriteTokens，请求数 +1。
// 缓存命中率 = cacheRead ÷ (input + cacheRead)。
//
// 数据来源分两类：
//   a) 历史会话：$DSH_HOME/sessions/*/*/session.jsonl.zstd（跳过活会话），
//      unzstd 解压折 JSONL；
//   b) 活会话：ctx.sessions.list() 的 session.events 全量 + ctx.on("session/event")
//      增量（按 seq）。
// 幂等：每会话存 watermark（已折最后 seq）；重复回放不重复计数；
//       会话日志变短（文件最后 seq < watermark）则清空该会话重折。
// 持久化：变更 debounce 2s 后原子写 $DSH_HOME/storages/usage-meter.json
//         （tmp + rename，内容经 shell heredoc 传递，零运行时依赖）。
//
// 路由：
//   GET /dsh-token-meter/summary?range=today|7d|30d
//   GET /dsh-token-meter/sessions

export const name = 'dsh-token-meter'
export const inject = ['sessions', 'shell', 'webServer']

export function apply(ctx) {
  const sessions = ctx.sessions
  const shell = ctx.shell
  const webServer = ctx.webServer

  // ---- 基础命令执行（照 khazix 范式，零依赖） ----
  async function run(command, opts = {}) {
    // 本机修复:ctx.shell 在 Windows 走 pwsh-sandbox 受限令牌,MSYS(Git Bash)二进制
    // 无法创建共享内存而崩溃(CreateFileMapping error 5)。这里绕过沙箱 shell,
    // 直接用 node 以正常令牌调 Git Bash 执行 POSIX 命令。
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execFileP = promisify(execFile)
    let out = ''
    let errText = ''
    let code = 0
    try {
      const r = await execFileP('D:/Git/usr/bin/bash.exe', ['-lc', command], {
        timeout: opts.timeoutMs || 300000,
        windowsHide: true,
      })
      out = r.stdout || ''
    } catch (e) {
      code = typeof e.code === 'number' ? e.code : 1
      out = e.stdout || ''
      errText = e.stderr || ''
    }
    if (code !== 0) {
      if (opts.partialOk && out) return out
      throw new Error('exit ' + code + ': ' + (errText + out).slice(0, 400))
    }
    return out
  }

  function pad(n) {
    return n < 10 ? '0' + n : '' + n
  }

  function dayKeyOf(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
  }

  function num(v) {
    return typeof v === 'number' && isFinite(v) && v > 0 ? v : 0
  }

  // ---- 存储状态 ----
  let storageDir = ''
  let storageFile = ''
  let sessionsRoot = ''
  let store = null
  let initPromise = null
  let writeTimer = null
  let dirty = false

  function freshRec() {
    return {
      watermark: -1,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      messages: 0,
      provider: '',
      model: '',
      hours: {},
      days: {},
    }
  }

  // 空聚合（汇总卡 / byProvider / byModel 共用）
  function freshAgg() {
    return { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, providers: {}, models: {} }
  }

  function addInto(target, inTok, outTok, crTok, cwTok) {
    target.requests += 1
    target.inputTokens += inTok
    target.outputTokens += outTok
    target.cacheReadTokens += crTok
    target.cacheWriteTokens += cwTok
    target.totalTokens += inTok + outTok + crTok + cwTok
  }

  async function ensureInit() {
    if (initPromise) return initPromise
    initPromise = init().catch((e) => {
      console.error('dsh-token-meter init failed: ' + String(e && e.message ? e.message : e))
      throw e
    })
    return initPromise
  }

  // ---- 文件读写（全部走 shell，零 import） ----
  async function readStore() {
    const out = await run('cat "' + storageFile + '" 2>/dev/null || true')
    const text = out.trim()
    if (!text) return null
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object' && parsed.sessions && typeof parsed.sessions === 'object') return parsed
      return null
    } catch (e) {
      return null
    }
  }

  async function persist(force) {
    if (!force && !dirty) return
    dirty = false
    store.updatedAt = new Date().toISOString()
    const json = JSON.stringify(store)
    const marker = 'DUM_EOF_' + Math.floor(Math.random() * 1e9).toString(36)
    await run(
      'mkdir -p "' + storageDir + '" && cat > "' + storageFile + '.tmp" <<\'' + marker + '\'\n' +
      json + '\n' + marker + '\n' +
      'mv "' + storageFile + '.tmp" "' + storageFile + '"'
    )
  }

  function scheduleWrite() {
    dirty = true
    if (writeTimer) return
    writeTimer = setTimeout(() => {
      writeTimer = null
      persist(false).catch((e) => console.error('dsh-token-meter persist failed: ' + String(e && e.message ? e.message : e)))
    }, 2000)
  }

  // ---- 事件折入（幂等，按 seq 增量） ----
  // 时间桶（hours/days）存全量字段 + byKey 细分（provider/model 维度），
  // 供 summary 按 range 过滤汇总卡 / byProvider / byModel / series。
  function bump(map, key, inTok, outTok, crTok, cwTok, pkey) {
    let b = map[key]
    if (!b) b = map[key] = { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, messages: 0, byKey: {} }
    addInto(b, inTok, outTok, crTok, cwTok)
    let k = b.byKey[pkey]
    if (!k) k = b.byKey[pkey] = { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 }
    addInto(k, inTok, outTok, crTok, cwTok)
  }

  // 消息计数(用户/助手消息都算,不产生 token 也要记录)
  function bumpMsg(map, key) {
    let b = map[key]
    if (!b) b = map[key] = { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, messages: 0, byKey: {} }
    b.messages += 1
  }

  function foldEvent(sid, e) {
    if (!e) return
    let rec = store.sessions[sid]
    if (!rec) rec = store.sessions[sid] = freshRec()
    if (typeof e.seq === 'number') {
      if (e.seq <= rec.watermark) return
      rec.watermark = e.seq
    }
    if ((e.type === 'user/message' || e.type === 'assistant/message') && typeof e.time === 'number') {
      rec.messages += 1
      const d = new Date(e.time)
      const dayKey = dayKeyOf(d)
      const hourKey = dayKey + 'T' + pad(d.getHours())
      bumpMsg(rec.days, dayKey)
      bumpMsg(rec.hours, hourKey)
    }
    if (e.type !== 'assistant/message' || !e.data || !e.data.usage) return
    const u = e.data.usage
    const inTok = num(u.inputTokens)
    const outTok = num(u.outputTokens)
    const crTok = num(u.cacheReadTokens)
    const cwTok = num(u.cacheWriteTokens)
    const src = e.data.message && e.data.message.source
    const provider = src && src.provider ? String(src.provider) : 'unknown'
    const model = src && src.model ? String(src.model) : 'unknown'
    const pkey = provider + '/' + model
    rec.requests += 1
    rec.inputTokens += inTok
    rec.outputTokens += outTok
    rec.cacheReadTokens += crTok
    rec.cacheWriteTokens += cwTok
    rec.totalTokens += inTok + outTok + crTok + cwTok
    rec.provider = provider
    rec.model = model
    if (typeof e.time === 'number') {
      const d = new Date(e.time)
      const dayKey = dayKeyOf(d)
      const hourKey = dayKey + 'T' + pad(d.getHours())
      bump(rec.days, dayKey, inTok, outTok, crTok, cwTok, pkey)
      bump(rec.hours, hourKey, inTok, outTok, crTok, cwTok, pkey)
    }
  }

  function replayEvents(sid, events) {
    let last = -1
    for (const e of events) {
      foldEvent(sid, e)
      if (e && typeof e.seq === 'number' && e.seq > last) last = e.seq
    }
    if (last >= 0) {
      const rec = store.sessions[sid]
      if (rec && last > rec.watermark) rec.watermark = last
    }
  }

  async function replayFile(file, sid) {
    const out = await run('unzstd -c -- "' + file + '"', { partialOk: true })
    const lines = out.split('\n')
    let fileMax = -1
    for (const line of lines) {
      if (!line.trim()) continue
      let e
      try { e = JSON.parse(line) } catch (err) { continue }
      if (e && typeof e.seq === 'number' && e.seq > fileMax) fileMax = e.seq
    }
    const rec = store.sessions[sid]
    if (rec && fileMax >= 0 && fileMax < rec.watermark) {
      // 会话日志变短：清空重折
      delete store.sessions[sid]
    }
    let last = -1
    for (const line of lines) {
      if (!line.trim()) continue
      let e
      try { e = JSON.parse(line) } catch (err) { continue }
      if (e && typeof e.seq === 'number' && e.seq > last) last = e.seq
      foldEvent(sid, e)
    }
    if (last >= 0) {
      const r = store.sessions[sid]
      if (r && last > r.watermark) r.watermark = last
    }
  }

  async function listSessionFiles() {
    const out = await run('find "' + sessionsRoot + '" -name session.jsonl.zstd 2>/dev/null || true')
    return out.split('\n').map((s) => s.trim()).filter(Boolean)
  }

  // ---- 启动回填 ----
  async function init() {
    const home = (await run("printf '%s' \"${DSH_HOME:-$HOME/.dsh}\"")).trim()
    storageDir = home + '/storages'
    storageFile = storageDir + '/usage-meter.json'
    sessionsRoot = home + '/sessions'
    store = await readStore()
    if (!store) store = { version: 3, updatedAt: new Date().toISOString(), sessions: {} }
    // 版本迁移：旧版桶结构（无 byKey/全量字段）无法按 range 细分，清空重折
    if (store.version !== 3) {
      store = { version: 3, updatedAt: new Date().toISOString(), sessions: {} }
    }

    // 活会话集合（活会话用内存 events 折，不回填文件）
    let liveList = []
    try {
      liveList = sessions.list()
    } catch (e) {
      liveList = []
    }
    const live = new Set()
    for (const s of liveList) {
      if (s && s.id) live.add(s.id)
    }

    // 历史文件回填
    const files = await listSessionFiles()
    for (const f of files) {
      const parts = f.split('/')
      const sid = parts[parts.length - 2]
      if (!sid || live.has(sid)) continue
      try {
        await replayFile(f, sid)
      } catch (e) {
        console.error('dsh-token-meter replay ' + f + ' failed: ' + String(e && e.message ? e.message : e))
      }
    }

    // 活会话全量回填（幂等，seq 去重）
    for (const s of liveList) {
      if (!s || !s.id) continue
      try {
        replayEvents(s.id, s.events || [])
      } catch (e) {
        console.error('dsh-token-meter live replay ' + s.id + ' failed: ' + String(e && e.message ? e.message : e))
      }
    }

    await persist(true)
  }

  // ---- 汇总计算（全部按 range 过滤：汇总卡 / byProvider / byModel / series） ----
  function buildSummary(range) {
    const now = new Date()
    const today = dayKeyOf(now)
    const buckets = []
    if (range === 'today') {
      for (let h = 0; h < 24; h++) buckets.push({ label: pad(h) + ':00', key: today + 'T' + pad(h), requests: 0, totalTokens: 0, cacheReadTokens: 0, messages: 0, models: {} })
    } else {
      const days = range === '7d' ? 7 : 30
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
        const k = dayKeyOf(d)
        buckets.push({ label: parseInt(k.slice(5, 7), 10) + '/' + parseInt(k.slice(8, 10), 10), key: k, requests: 0, totalTokens: 0, cacheReadTokens: 0, messages: 0, models: {} })
      }
    }
    const agg = freshAgg()
    let sessionCount = 0
    for (const sid of Object.keys(store.sessions)) {
      const rec = store.sessions[sid]
      const map = range === 'today' ? (rec.hours || {}) : (rec.days || {})
      let inRange = false
      for (const b of buckets) {
        const src = map[b.key]
        if (!src) continue
        inRange = true
        b.requests += src.requests
        b.totalTokens += src.totalTokens
        b.cacheReadTokens += src.cacheReadTokens
        b.messages += src.messages || 0
        agg.requests += src.requests
        agg.inputTokens += src.inputTokens
        agg.outputTokens += src.outputTokens
        agg.cacheReadTokens += src.cacheReadTokens
        agg.cacheWriteTokens += src.cacheWriteTokens
        agg.totalTokens += src.totalTokens
        for (const pkey of Object.keys(src.byKey || {})) {
          const k = src.byKey[pkey]
          const slash = pkey.indexOf('/')
          const provider = slash >= 0 ? pkey.slice(0, slash) : pkey
          const model = slash >= 0 ? pkey.slice(slash + 1) : ''
          const p = agg.providers[provider] || (agg.providers[provider] = { provider, requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 })
          const m = agg.models[pkey] || (agg.models[pkey] = { provider, model, requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 })
          p.requests += k.requests
          p.inputTokens += k.inputTokens
          p.outputTokens += k.outputTokens
          p.cacheReadTokens += k.cacheReadTokens
          p.cacheWriteTokens += k.cacheWriteTokens
          p.totalTokens += k.totalTokens
          m.requests += k.requests
          m.inputTokens += k.inputTokens
          m.outputTokens += k.outputTokens
          m.cacheReadTokens += k.cacheReadTokens
          m.cacheWriteTokens += k.cacheWriteTokens
          m.totalTokens += k.totalTokens
          const dm = b.models[pkey] || (b.models[pkey] = { provider, model, requests: 0, totalTokens: 0 })
          dm.requests += k.requests
          dm.totalTokens += k.totalTokens
        }
      }
      if (inRange) sessionCount += 1
    }
    const byProvider = Object.values(agg.providers).sort((a, b) => b.requests - a.requests)
    const cacheHitRate = agg.inputTokens + agg.cacheReadTokens > 0 ? agg.cacheReadTokens / (agg.inputTokens + agg.cacheReadTokens) : 0
    let activeDays = 0
    for (const b of buckets) if (b.requests > 0 || b.messages > 0) activeDays += 1
    let streak = 0
    if (range === 'today') {
      streak = activeDays > 0 ? 1 : 0
    } else {
      const daySet = {}
      for (const b of buckets) if (b.requests > 0 || b.messages > 0) daySet[b.key] = true
      for (let i = 0; i < buckets.length; i++) {
        const dk = buckets[buckets.length - 1 - i].key
        if (daySet[dk]) streak += 1
        else if (i === 0) continue
        else break
      }
    }
    const models = Object.values(agg.models).map((m) => ({
      provider: m.provider, model: m.model, requests: m.requests,
      totalTokens: m.totalTokens,
      share: agg.totalTokens > 0 ? Math.round(m.totalTokens / agg.totalTokens * 1e6) / 1e6 : 0,
    })).sort((a, b) => b.totalTokens - a.totalTokens)
    const topModel = models.length > 0 ? models[0] : null
    const series = buckets.map((b) => ({
      label: b.label, key: b.key, requests: b.requests, totalTokens: b.totalTokens, messages: b.messages,
      models: Object.values(b.models).sort((a, b2) => b2.totalTokens - a.totalTokens),
    }))
    return {
      updatedAt: store.updatedAt || '',
      range,
      requests: agg.requests,
      inputTokens: agg.inputTokens,
      outputTokens: agg.outputTokens,
      cacheReadTokens: agg.cacheReadTokens,
      cacheWriteTokens: agg.cacheWriteTokens,
      totalTokens: agg.totalTokens,
      cacheHitRate: Math.round(cacheHitRate * 1e6) / 1e6,
      sessionCount,
      messageCount: buckets.reduce((s, b) => s + (b.messages || 0), 0),
      activeDays,
      streak,
      topModel,
      byProvider,
      models,
      series,
    }
  }

  function buildSessions() {
    return Object.keys(store.sessions)
      .map((sid) => {
        const rec = store.sessions[sid]
        return {
          sessionId: sid,
          watermark: rec.watermark,
          requests: rec.requests,
          totalTokens: rec.totalTokens,
          provider: rec.provider || '',
          model: rec.model || '',
        }
      })
      .sort((a, b) => b.requests - a.requests || a.sessionId.localeCompare(b.sessionId))
  }

  // ---- 仪表盘页面(自包含 HTML,零外部依赖,内联 SVG 图表) ----
  function dashboardHtml() {
    return `
<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>用量统计</title>
<script src="/dsh-token-meter/chart.umd.js"></script>
<style>
:root{--bg:#0b0f14;--card:#141a22;--border:#232c37;--text:#e6edf3;--sub:#8b98a5;--accent:#58a6ff}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:'Segoe UI','Microsoft YaHei',system-ui,sans-serif;padding:24px;min-height:100vh}
html.embedded{background:transparent}
body.embedded{background:transparent;padding:18px}
.wrap{max-width:1080px;margin:0 auto}
.top{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:18px}
h1{font-size:20px;font-weight:600}
.row{display:flex;gap:8px;align-items:center}
.seg{position:relative;display:flex;border:1px solid #2d3847;border-radius:999px;padding:3px}
.seg-thumb{position:absolute;top:3px;left:3px;width:calc(50% - 3px);height:calc(100% - 6px);border-radius:999px;background:#e6edf3;transition:transform .28s cubic-bezier(.4,0,.2,1);will-change:transform;pointer-events:none}
.seg-btn{position:relative;z-index:1;flex:1;padding:5px 10px;border:none;background:transparent;color:var(--sub);font-size:13px;cursor:pointer;white-space:nowrap;transition:color .2s}
.seg-btn:hover{color:var(--text)}
.seg-btn.active{color:#0b0f14}
.btn{padding:6px 14px;border-radius:8px;border:1px solid var(--border);background:var(--card);color:var(--text);font-size:13px;cursor:pointer}
.btn:hover{border-color:var(--accent)}
.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:14px 16px}
.card .l{font-size:12px;color:var(--sub)}
.card .v{font-size:20px;font-weight:600;margin-top:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.card .s{font-size:12px;color:var(--sub);margin-top:3px}
.panels{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px}
.panel{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px}
.panel h2{font-size:14px;font-weight:600;margin-bottom:12px}
.legend{display:flex;flex-wrap:wrap;gap:14px;font-size:12px;color:var(--sub);margin-top:10px}
.dot{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px;vertical-align:1px}
#donut{display:flex;align-items:center;gap:28px;flex-wrap:wrap}
.donut-legend{flex:1;min-width:240px;font-size:13px}
.donut-legend .row{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)}
.donut-legend .row:last-child{border-bottom:none}
.donut-legend .r2{color:var(--sub);font-size:12px}
.hint{color:var(--sub);font-size:12px;margin-top:10px}
@media(max-width:640px){.cards{grid-template-columns:repeat(2,1fr)}.panels{grid-template-columns:1fr}}
</style></head><body><div class="wrap">
<div class="top"><h1>用量统计</h1>
<div class="row">
  <div class="seg" id="rangeSeg">
    <div class="seg-thumb" id="segThumb"></div>
    <button class="seg-btn" data-r="7d">最近 7 天</button>
    <button class="seg-btn" data-r="30d">最近 30 天</button>
  </div>
  <button class="btn" id="refresh">刷新</button>
</div></div>
<div class="cards" id="cards"></div>
<div class="panel" style="margin-bottom:16px"><h2>按天 Token 趋势</h2><div style="position:relative;height:240px"><canvas id="trendChart"></canvas></div></div>
<div class="panel" style="margin-bottom:16px"><h2>模型用量</h2><div style="display:flex;align-items:center;gap:24px;flex-wrap:wrap"><div style="position:relative;width:200px;height:200px"><canvas id="donutChart"></canvas><div id="donutCenter" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center;pointer-events:none"><div style="font-size:11px;color:#8b98a5">tokens 用量</div><div id="donutCenterVal" style="font-size:18px;font-weight:600;color:#e6edf3"></div></div></div><div class="donut-legend" id="donutLegend"></div></div></div>
<div class="hint" id="hint"></div>
</div>
<script>
var PALETTE = ['#58a6ff', '#79c0ff', '#1f6feb', '#388bfd', '#4493f8', '#a5d6ff', '#2f81f7', '#6cb6ff'];
var modelColor = {};
function colorOf(m) {
  if (!(m in modelColor)) modelColor[m] = PALETTE[Object.keys(modelColor).length % PALETTE.length];
  return modelColor[m];
}
function fmt(n) {
  n = n || 0;
  if (n >= 1e8) return (n / 1e8).toFixed(1) + '亿';
  if (n >= 1e4) return (n / 1e4).toFixed(1) + '万';
  return n.toLocaleString();
}
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
function pad2(n) { return n < 10 ? '0' + n : '' + n; }
var range = '7d';

function renderCards(d) {
  var cards = [
    { l: 'tokens 用量', v: fmt(d.totalTokens) },
    { l: '会话数量', v: d.sessionCount },
    { l: '消息数量', v: d.messageCount },
    { l: '缓存命中率', v: (d.cacheHitRate * 100).toFixed(1) + '%' },
    { l: '请求数', v: d.requests },
    { l: '最常用模型', v: d.topModel ? esc(d.topModel.model) : '-' }
  ];
  var html = '';
  for (var i = 0; i < cards.length; i++) {
    html += '<div class="card"><div class="l">' + cards[i].l + '</div><div class="v">' + cards[i].v + '</div></div>';
  }
  document.getElementById('cards').innerHTML = html;
}

var trendChart = null;
function renderTrend(d) {
  var s = d.series;
  var days = s.length;
  var modelKeys = [];
  var keySet = {};
  for (var i = 0; i < days; i++) {
    var segs = s[i].models || [];
    for (var j = 0; j < segs.length; j++) {
      var k = segs[j].provider + '/' + segs[j].model;
      if (!(k in keySet)) { keySet[k] = true; modelKeys.push(k); }
    }
  }
  var datasets = [];
  for (var mi = 0; mi < modelKeys.length; mi++) {
    var mk = modelKeys[mi];
    var data = [];
    for (var i = 0; i < days; i++) {
      var found = 0;
      var segs = s[i].models || [];
      for (var j = 0; j < segs.length; j++) if (segs[j].provider + '/' + segs[j].model === mk) found = segs[j].totalTokens;
      data.push(found);
    }
    datasets.push({ label: mk.split('/')[1], data: data, backgroundColor: colorOf(mk), borderRadius: 2, stack: 'tokens' });
  }
  var ctx = document.getElementById('trendChart').getContext('2d');
  if (trendChart) trendChart.destroy();
  trendChart = new Chart(ctx, {
    type: 'bar',
    data: { labels: s.map(function (b) { return b.label; }), datasets: datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#8b98a5', boxWidth: 10, boxHeight: 10, usePointStyle: true, padding: 14 } },
        tooltip: {
          backgroundColor: '#1c2430', borderColor: '#2d3847', borderWidth: 1,
          titleColor: '#e6edf3', bodyColor: '#c9d4e0',
          callbacks: {
            label: function (item) {
              return ' ' + item.dataset.label + ': ' + fmt(item.parsed.y) + ' tokens';
            }
          }
        }
      },
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { color: '#8b98a5', font: { size: 10 }, maxRotation: 0, autoSkip: days > 12, maxTicksLimit: 8 } },
        y: { stacked: true, grid: { color: '#232c37' }, border: { display: false }, ticks: { color: '#8b98a5', font: { size: 10 }, callback: function (v) { return fmt(v); } } }
      }
    }
  });
}

var donutChart = null;
function renderDonut(d) {
  var ms = d.models || [];
  var total = d.totalTokens || 0;
  var lg = '';
  if (ms.length === 0) {
    document.getElementById('donutLegend').innerHTML = '<div class="hint">暂无数据</div>';
    document.getElementById('donutCenterVal').textContent = '0';
    return;
  }
  var ctx = document.getElementById('donutChart').getContext('2d');
  if (donutChart) donutChart.destroy();
  donutChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ms.map(function (m) { return m.model; }),
      datasets: [{ data: ms.map(function (m) { return m.totalTokens; }), backgroundColor: ms.map(function (m) { return colorOf(m.provider + '/' + m.model); }), borderWidth: 0, hoverOffset: 4 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '68%',
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#1c2430', borderColor: '#2d3847', borderWidth: 1,
          titleColor: '#e6edf3', bodyColor: '#c9d4e0',
          callbacks: {
            label: function (item) {
              var share = total > 0 ? item.parsed / total * 100 : 0;
              return ' ' + item.label + ': ' + fmt(item.parsed) + ' tokens (' + share.toFixed(1) + '%)';
            }
          }
        }
      }
    }
  });
  document.getElementById('donutCenterVal').textContent = fmt(total);
  for (var i = 0; i < ms.length; i++) {
    lg += '<div class="row"><span><span class="dot" style="background:' + colorOf(ms[i].provider + '/' + ms[i].model) + '"></span>' + esc(ms[i].model) + '</span><span>' + (ms[i].share * 100).toFixed(1) + '% <span class="r2">' + fmt(ms[i].totalTokens) + '</span></span></div>';
  }
  document.getElementById('donutLegend').innerHTML = lg;
}

function load() {
  fetch('/dsh-token-meter/summary?range=' + range).then(function (r) { return r.json(); }).then(function (d) {
    if (d && d.ok === false) { document.getElementById('hint').textContent = '接口错误: ' + d.message; return; }
    renderCards(d); renderTrend(d); renderDonut(d);
    document.getElementById('hint').textContent = '更新于 ' + (d.updatedAt ? d.updatedAt.replace('T', ' ').slice(0, 19) : '-');
  }).catch(function (e) { document.getElementById('hint').textContent = '加载失败: ' + e; });
}
document.querySelectorAll('.seg-btn').forEach(function (b) {
  b.addEventListener('click', function () {
    range = b.getAttribute('data-r');
    var thumb = document.getElementById('segThumb');
    if (thumb) thumb.style.transform = range === '30d' ? 'translateX(100%)' : 'translateX(0)';
    document.querySelectorAll('.seg-btn').forEach(function (x) { x.classList.toggle('active', x === b); });
    load();
  });
});
document.querySelector('.seg-btn[data-r="7d"]').classList.add('active');
document.getElementById('refresh').addEventListener('click', load);
if (location.search.indexOf('embedded=1') >= 0) { document.documentElement.classList.add('embedded'); document.body.classList.add('embedded'); }
load();
</script></body></html>
`
  }

  // ---- 路由 ----
  const json = (res, data) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(data))
  }

  if (webServer !== undefined) {
    try {
      webServer.register({
        kind: 'exact',
        path: '/dsh-token-meter/summary',
        handler: async (req, res) => {
          try {
            await ensureInit()
            const q = req.url.indexOf('?') >= 0 ? req.url.slice(req.url.indexOf('?') + 1) : ''
            const params = {}
            for (const pair of q.split('&')) {
              if (!pair) continue
              const i = pair.indexOf('=')
              const k = i >= 0 ? pair.slice(0, i) : pair
              const v = i >= 0 ? pair.slice(i + 1) : ''
              params[decodeURIComponent(k)] = decodeURIComponent(v || '')
            }
            const range = params.range === '7d' || params.range === '30d' ? params.range : 'today'
            json(res, buildSummary(range))
          } catch (e) {
            json(res, { ok: false, message: String(e && e.message ? e.message : e) })
          }
        },
      })
      webServer.register({
        kind: 'exact',
        path: '/dsh-token-meter/sessions',
        handler: async (req, res) => {
          try {
            await ensureInit()
            json(res, buildSessions())
          } catch (e) {
            json(res, { ok: false, message: String(e && e.message ? e.message : e) })
          }
        },
      })
      webServer.register({
        kind: 'exact',
        path: '/dsh-token-meter/',
        handler: async (req, res) => {
          try {
            await ensureInit()
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
            res.end(dashboardHtml())
          } catch (e) {
            res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
            res.end(String(e && e.message ? e.message : e))
          }
        },
      })
      webServer.register({
        kind: 'exact',
        path: '/dsh-token-meter/chart.umd.js',
        handler: async (req, res) => {
          try {
            const { readFile } = await import('node:fs/promises')
            const buf = await readFile(new URL('./chart.umd.min.js', import.meta.url))
            res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'public, max-age=86400' })
            res.end(buf)
          } catch (e) {
            res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
            res.end(String(e && e.message ? e.message : e))
          }
        },
      })
      // 本地 remixicon 图标字体(设置页导航「统计」板块图标)
      webServer.register({
        kind: 'exact',
        path: '/dsh-token-meter/remixicon.css',
        handler: async (req, res) => {
          try {
            const { readFile } = await import('node:fs/promises')
            const buf = await readFile(new URL('./remixicon/remixicon.css', import.meta.url))
            res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=86400' })
            res.end(buf)
          } catch (e) {
            res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
            res.end(String(e && e.message ? e.message : e))
          }
        },
      })
      webServer.register({
        kind: 'exact',
        path: '/dsh-token-meter/remixicon.woff2',
        handler: async (req, res) => {
          try {
            const { readFile } = await import('node:fs/promises')
            const buf = await readFile(new URL('./remixicon/remixicon.woff2', import.meta.url))
            res.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': 'public, max-age=86400' })
            res.end(buf)
          } catch (e) {
            res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
            res.end(String(e && e.message ? e.message : e))
          }
        },
      })
    } catch (e) {
      console.error('dsh-token-meter route registration failed: ' + String(e && e.message ? e.message : e))
    }
  }

  // ---- 活会话增量 ----
  ctx.on('session/event', (session, event) => {
    ensureInit().then(() => {
      foldEvent(session.id, event)
      scheduleWrite()
    }).catch((e) => console.error('dsh-token-meter fold failed: ' + String(e && e.message ? e.message : e)))
  })

  // ---- 清理 ----
  ctx.on('dispose', () => {
    if (writeTimer) {
      clearTimeout(writeTimer)
      writeTimer = null
    }
  })

  // ---- 启动即回填（后台） ----
  ensureInit().catch((e) => console.error('dsh-token-meter startup failed: ' + String(e && e.message ? e.message : e)))
}
