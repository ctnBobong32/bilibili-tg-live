// ======================== 前端 Worker ========================
// 注意：BACKEND_URL 从环境变量读取，在 fetch 中注入

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>直播监控管理</title>
<!-- 强制禁用缓存 -->
<meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">
<meta http-equiv="Pragma" content="no-cache">
<meta http-equiv="Expires" content="0">
<link href="https://cdnjs.cloudflare.com/ajax/libs/bootstrap/5.3.8/css/bootstrap.min.css" rel="stylesheet">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/bootstrap-icons/1.11.3/font/bootstrap-icons.min.css">
<script defer src="https://cdnjs.cloudflare.com/ajax/libs/axios/1.11.0/axios.min.js"></script>
<script defer src="https://cdnjs.cloudflare.com/ajax/libs/bootstrap/5.3.8/js/bootstrap.bundle.min.js"></script>
<style>
:root { --bg: #f0f5ff; --card-bg: #ffffff; --primary: #2b6cb5; --text: #1a365d; }
[data-bs-theme="dark"] { --bg: #1a202c; --card-bg: #2d3748; --primary: #4a8bdb; --text: #e2e8f0; }
body { background: var(--bg); color: var(--text); transition: 0.3s; }
.card { background: var(--card-bg); border: none; border-radius: 16px; box-shadow: 0 4px 12px rgba(43,108,181,0.08); }
.card-header { background: var(--primary); color: white; border-radius: 16px 16px 0 0 !important; padding: 0.75rem 1.25rem; font-weight: 600; }
.btn-primary { background: var(--primary); border-color: var(--primary); }
.btn-outline-primary { color: var(--primary); border-color: var(--primary); }
.btn-outline-primary:hover { background: var(--primary); color: white; }
.btn-outline-danger:hover { background: #dc3545; color: white; }
.status-dot { width: 12px; height: 12px; border-radius: 50%; display: inline-block; margin-right: 8px; flex-shrink: 0; }
.status-dot.live { background: #20c997; box-shadow: 0 0 12px rgba(32,201,151,0.6); }
.status-dot.offline { background: #dc3545; box-shadow: 0 0 12px rgba(220,53,69,0.4); }
.room-card { transition: 0.2s; cursor: default; }
.room-card:hover { transform: translateY(-4px); box-shadow: 0 8px 24px rgba(43,108,181,0.12); }
.room-title { font-weight: 600; font-size: 1.1rem; margin-bottom: 0.25rem; }
.room-meta { font-size: 0.9rem; color: #6c757d; }
.log-box { max-height: 300px; overflow-y: auto; font-size: 0.85rem; background: var(--card-bg); border-radius: 0 0 16px 16px; padding: 0.5rem 1rem; }
.log-entry { padding: 0.25rem 0; border-bottom: 1px solid rgba(0,0,0,0.05); }
.log-time { color: #6c757d; margin-right: 0.5rem; }
.log-level-info { color: #0d6efd; }
.log-level-warn { color: #ffc107; }
.log-level-error { color: #dc3545; }
.tab-btn { border-radius: 12px 12px 0 0; font-weight: 500; }
.tab-btn.active { background: var(--primary); color: white; }
.tab-btn:not(.active) { background: transparent; color: var(--text); }
.tab-btn:not(.active):hover { background: rgba(43,108,181,0.08); }
#notifies .form-control, #notifies .form-select { background: var(--card-bg); color: var(--text); border-color: #ced4da; }
[data-bs-theme="dark"] .form-control, [data-bs-theme="dark"] .form-select { background: #2d3748; color: #e2e8f0; border-color: #4a5568; }
</style>
</head>
<body>
<div class="container-fluid p-3" id="app">
  <!-- 登录界面：默认显示 -->
  <div id="loginPanel" style="display: block;">
    <div class="row justify-content-center mt-5">
      <div class="col-md-4">
        <div class="card shadow">
          <div class="card-body">
            <h1 class="card-title text-center">管理登录</h1>
            <div id="loginError" class="alert alert-danger" style="display:none;"></div>
            <form id="loginForm">
              <div class="mb-3">
                <label class="form-label">用户名</label>
                <input type="text" id="loginUsername" class="form-control" required>
              </div>
              <div class="mb-3">
                <label class="form-label">密码</label>
                <input type="password" id="loginPassword" class="form-control" required>
              </div>
              <button type="submit" class="btn btn-primary w-100">登录</button>
            </form>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- 主界面：默认隐藏 -->
  <div id="mainPanel" style="display: none;">
    <div class="row mb-3 align-items-center">
      <div class="col-md-6">
        <h1 class="d-flex align-items-center gap-2" style="color:var(--primary);">
          <i class="bi bi-broadcast"></i> 直播监控
        </h1>
      </div>
      <div class="col-md-6 text-end">
        <button id="themeToggle" class="btn btn-outline-secondary me-2">深色</button>
        <button id="logoutBtn" class="btn btn-outline-danger">退出</button>
      </div>
    </div>

    <div id="messageArea"></div>

    <ul class="nav nav-tabs mb-3" id="myTab" role="tablist">
      <li class="nav-item">
        <button class="nav-link tab-btn active" id="rooms-tab" data-bs-toggle="tab" data-bs-target="#rooms" type="button">房间</button>
      </li>
      <li class="nav-item">
        <button class="nav-link tab-btn" id="notifies-tab" data-bs-toggle="tab" data-bs-target="#notifies" type="button">通知配置</button>
      </li>
    </ul>

    <div class="tab-content">
      <div class="tab-pane active" id="rooms">
        <div class="card">
          <div class="card-header d-flex flex-wrap gap-2 align-items-center">
            <i class="bi bi-house-door"></i> 监控房间
            <div class="ms-auto d-flex flex-wrap gap-2">
              <button id="addRoomBtn" class="btn btn-sm btn-light"><i class="bi bi-plus-circle"></i> 添加</button>
              <button id="checkAllBtn" class="btn btn-sm btn-light"><i class="bi bi-arrow-repeat"></i> 检查</button>
              <button id="refreshRoomsBtn" class="btn btn-sm btn-light"><i class="bi bi-cloud-refresh"></i> 刷新</button>
              <button id="sendLiveBtn" class="btn btn-sm btn-warning"><i class="bi bi-broadcast"></i> 模拟</button>
              <div class="input-group input-group-sm" style="width:200px;">
                <input id="singleCheckInput" class="form-control" placeholder="房间号">
                <button id="singleCheckBtn" class="btn btn-light">查</button>
              </div>
            </div>
          </div>
          <div class="card-body">
            <div id="roomContainer" class="row row-cols-1 row-cols-md-2 row-cols-lg-3 g-3"></div>
          </div>
        </div>
        <div class="card mt-4">
          <div class="card-header d-flex flex-wrap gap-2 align-items-center">
            <i class="bi bi-journal-text"></i> 运行日志
            <div class="ms-auto d-flex gap-2 flex-wrap">
              <button id="clearLogsBtn" class="btn btn-sm btn-light"><i class="bi bi-trash"></i> 清除</button>
              <button id="refreshLogsBtn" class="btn btn-sm btn-light"><i class="bi bi-arrow-clockwise"></i> 刷新</button>
              <div class="form-check form-switch">
                <input class="form-check-input" type="checkbox" id="autoRefresh" checked>
                <label class="form-check-label" for="autoRefresh">自动</label>
              </div>
              <input id="logSearch" class="form-control form-control-sm" placeholder="搜索..." style="width:120px;">
              <select id="logLevelFilter" class="form-select form-select-sm" style="width:auto;">
                <option value="">全部</option>
                <option value="info">Info</option>
                <option value="warn">Warn</option>
                <option value="error">Error</option>
              </select>
              <button id="exportLogsBtn" class="btn btn-sm btn-light"><i class="bi bi-download"></i></button>
            </div>
          </div>
          <div id="logContainer" class="log-box"></div>
        </div>
      </div>

      <div class="tab-pane" id="notifies">
        <div class="card mb-3">
          <div class="card-header"><i class="bi bi-plus-circle"></i> 添加通知配置</div>
          <div class="card-body">
            <form id="addNotifyForm" class="row g-3">
              <div class="col-md-4">
                <label class="form-label">名称</label>
                <input type="text" name="name" class="form-control" placeholder="" required>
              </div>
              <div class="col-md-4">
                <label class="form-label">协议</label>
                <select name="protocol" id="protocolSelect" class="form-select">
                  <option value="telegram">Telegram</option>
                  <option value="onebot_private">OneBot 私聊</option>
                  <option value="onebot_group">OneBot 群聊</option>
                  <option value="discord">Discord Webhook</option>
                  <option value="custom_webhook">自定义 Webhook</option>
                </select>
              </div>
              <input type="hidden" id="apiUrl" name="api_url">
              <div class="col-md-6" id="tgTokenGroup">
                <label class="form-label">Bot Token</label>
                <input type="text" id="tgToken" name="tg_token" class="form-control" placeholder="">
                <small class="text-muted">自动构建 API 地址</small>
              </div>
              <div class="col-md-6">
                <label class="form-label" id="receiverLabel">接收者 ID</label>
                <input type="text" name="chat_id" id="chatId" class="form-control" placeholder="">
              </div>
              <div class="col-12">
                <label class="form-label">通知模板 (可选)</label>
                <textarea name="template" id="templateArea" class="form-control" rows="6">[{{事件}}] {{主播}}
标题：{{标题}}
房间号：{{房间号}} | UID：{{UID}}
分区：{{父分区}} - {{分区}}
人气：{{人气}} | 直播时间：{{直播时间}}
直播间链接：{{直播链接}}
封面：{{封面}}
等级：{{等级}} | 粉丝：{{粉丝}} | 关注：{{关注}} | 性别：{{性别}}
VIP：{{VIP类型}} ({{VIP状态}})
投稿数：{{投稿数}} | 文章数：{{文章数}}
签名：{{签名}}
头像：{{头像}}
更新时间：{{时间}}</textarea>
              </div>
              <div class="col-12">
                <button type="submit" class="btn btn-primary"><i class="bi bi-plus-circle"></i> 添加配置</button>
              </div>
            </form>
          </div>
        </div>
        <div class="card">
          <div class="card-header"><i class="bi bi-list-ul"></i> 现有配置</div>
          <div class="card-body">
            <div class="table-responsive">
              <table class="table table-hover">
                <thead><tr><th>名称</th><th>协议</th><th>状态</th><th>操作</th></tr></thead>
                <tbody id="configTableBody"></tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- 模态框 -->
<div class="modal fade" id="addRoomModal" tabindex="-1" aria-hidden="true">
  <div class="modal-dialog">
    <div class="modal-content">
      <div class="modal-header">
        <h5 class="modal-title">添加房间</h5>
        <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
      </div>
      <div class="modal-body">
        <p>请输入直播间房间号：</p>
        <input type="text" id="roomInput" class="form-control" placeholder="例如：1768500100">
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">取消</button>
        <button type="button" id="addRoomConfirmBtn" class="btn btn-primary">完成</button>
      </div>
    </div>
  </div>
</div>

<div class="modal fade" id="customModal" tabindex="-1" aria-hidden="true">
  <div class="modal-dialog">
    <div class="modal-content">
      <div class="modal-header">
        <h5 id="modalTitle" class="modal-title">提示</h5>
        <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
      </div>
      <div class="modal-body" id="modalMessage"></div>
      <div class="modal-footer">
        <button type="button" id="modalConfirmBtn" class="btn btn-primary">确定</button>
        <button type="button" id="modalCancelBtn" class="btn btn-secondary" data-bs-dismiss="modal">取消</button>
      </div>
    </div>
  </div>
</div>

<script>
const BACKEND = '${BACKEND_URL}';

// ---------- 全局配置 ----------
axios.defaults.withCredentials = true;
axios.defaults.baseURL = BACKEND;

// ---------- 工具函数 ----------
function showMessage(msg, type) {
  type = type || 'info';
  const box = document.createElement('div');
  box.className = 'position-fixed top-0 start-50 translate-middle-x mt-3 alert alert-' + (type==='error'?'danger':type==='warn'?'warning':'success');
  box.style.zIndex = '99999';
  box.style.minWidth = '320px';
  box.style.textAlign = 'center';
  box.innerHTML = msg;
  document.body.appendChild(box);
  setTimeout(() => {
    box.style.transition = 'opacity .5s';
    box.style.opacity = '0';
    setTimeout(() => box.remove(), 500);
  }, 5000);
}

function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function formatDate(iso) {
  if (!iso) return '从未更新';
  return new Date(iso).toLocaleString();
}

// ---------- 登录/登出 ----------
async function checkAuth() {
  try {
    const res = await axios.get('/api/rooms');
    if (res.status === 200 && res.data && typeof res.data.rooms !== 'undefined') {
      return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

async function login(username, password) {
  try {
    const res = await axios.post('/api/login', { username, password });
    if (res.data.success) {
      return true;
    } else {
      throw new Error(res.data.error || '登录失败');
    }
  } catch (e) {
    throw new Error(e.response?.data?.error || e.message);
  }
}

async function logout() {
  await axios.post('/api/logout');
  document.cookie = 'auth=; Max-Age=0; path=/; domain=.262832.xyz';
  location.reload();
}

// ---------- 渲染房间 ----------
async function renderRooms() {
  const container = document.getElementById('roomContainer');
  try {
    const res = await axios.get('/api/rooms');
    const { rooms, states } = res.data;
    if (!rooms || !rooms.length) {
      container.innerHTML = '<div class="col-12 text-center text-muted py-4">暂无房间，请添加</div>';
      return;
    }
    let html = '';
    for (const id of rooms) {
      const state = states[id] || {};
      const isLive = state.state === 'LIVE';
      const dotClass = isLive ? 'live' : 'offline';
      const title = state.last_title || '未知';
      const online = state.last_online || 0;
      const area = state.last_parent_area ? state.last_parent_area + ' - ' + state.last_area : '未知分区';
      const updateTime = formatDate(state.last_update);
      html += \`<div class="col"><div class="card room-card h-100"><div class="card-body d-flex align-items-start"><span class="status-dot \${dotClass}"></span><div class="flex-grow-1 ms-2"><div class="room-title">\${escapeHtml(title)}</div><div class="room-meta">房间 \${id} · 人气 \${online} · \${escapeHtml(area)}</div><div class="room-meta small">更新于 \${updateTime}</div></div><button class="delete-room-btn btn btn-outline-danger btn-sm" data-room="\${id}" style="writing-mode: vertical-rl; letter-spacing: 2px; padding: 4px 6px; height: auto; min-height: 60px; line-height: 1.2;">删除</button></div></div></div>\`;
    }
    container.innerHTML = html;
  } catch (e) {
    showMessage('加载房间失败: ' + e.message, 'error');
  }
}

// ---------- 渲染日志 ----------
let allLogs = [];

async function fetchLogs() {
  try {
    const res = await axios.get('/api/logs');
    allLogs = res.data;
    renderLogs();
  } catch (e) {
    console.error('获取日志失败', e);
  }
}

function renderLogs() {
  const container = document.getElementById('logContainer');
  const search = document.getElementById('logSearch').value.toLowerCase();
  const level = document.getElementById('logLevelFilter').value;
  let filtered = allLogs;
  if (search) filtered = filtered.filter(e => e.message.toLowerCase().includes(search));
  if (level) filtered = filtered.filter(e => e.level === level);
  if (!filtered.length) {
    container.innerHTML = '<div class="text-secondary">暂无日志</div>';
    return;
  }
  let html = '';
  filtered.forEach(entry => {
    const levelColor = { info: 'log-level-info', warn: 'log-level-warn', error: 'log-level-error' }[entry.level] || '';
    html += \`<div class="log-entry"><span class="log-time">\${escapeHtml(entry.time)}</span><span class="\${levelColor}">[\${escapeHtml(entry.level.toUpperCase())}]</span> \${escapeHtml(entry.message)}</div>\`;
  });
  container.innerHTML = html;
}

// ---------- 渲染通知配置 ----------
async function renderConfigs() {
  const tbody = document.getElementById('configTableBody');
  try {
    const res = await axios.get('/api/notify-configs');
    const configs = res.data;
    if (!configs.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted">暂无配置</td></tr>';
      return;
    }
    let html = '';
    configs.forEach(cfg => {
      const protocolLabel = { telegram: 'Telegram', onebot_private: 'OneBot私聊', onebot_group: 'OneBot群聊', discord: 'Discord', custom_webhook: '自定义Webhook' }[cfg.protocol] || cfg.protocol;
      const status = cfg.enabled ? '启用' : '禁用';
      const statusColor = cfg.enabled ? 'success' : 'secondary';
      html += \`<tr><td>\${escapeHtml(cfg.name)}</td><td>\${escapeHtml(protocolLabel)}</td><td><span class="badge bg-\${statusColor}">\${status}</span></td><td>
        <button class="test-btn btn btn-sm btn-outline-primary" data-id="\${cfg.id}">测试</button>
        <button class="toggle-btn btn btn-sm btn-outline-warning" data-id="\${cfg.id}">\${cfg.enabled ? '禁用' : '启用'}</button>
        <button class="delete-config-btn btn btn-sm btn-outline-danger" data-id="\${cfg.id}">删除</button>
      </td></tr>\`;
    });
    tbody.innerHTML = html;
  } catch (e) {
    showMessage('加载配置失败: ' + e.message, 'error');
  }
}

// ---------- 事件绑定 ----------
document.addEventListener('DOMContentLoaded', async function() {
  // 默认显示登录面板，隐藏主面板
  document.getElementById('loginPanel').style.display = 'block';
  document.getElementById('mainPanel').style.display = 'none';

  // 检查登录状态
  const authed = await checkAuth();
  if (authed) {
    // 已登录，切换到主面板
    document.getElementById('loginPanel').style.display = 'none';
    document.getElementById('mainPanel').style.display = 'block';
    // 加载数据
    await renderRooms();
    await renderConfigs();
    await fetchLogs();

    // ---------- 主题切换 ----------
    document.getElementById('themeToggle').addEventListener('click', function() {
      const html = document.documentElement;
      const theme = html.getAttribute('data-bs-theme') === 'dark' ? 'light' : 'dark';
      html.setAttribute('data-bs-theme', theme);
      this.textContent = theme === 'dark' ? '亮色' : '深色';
    });
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      document.documentElement.setAttribute('data-bs-theme', 'dark');
      document.getElementById('themeToggle').textContent = '亮色';
    }

    // ---------- 登出 ----------
    document.getElementById('logoutBtn').addEventListener('click', logout);

    // ---------- 日志 ----------
    document.getElementById('refreshLogsBtn').addEventListener('click', fetchLogs);
    document.getElementById('logSearch').addEventListener('input', renderLogs);
    document.getElementById('logLevelFilter').addEventListener('change', renderLogs);
    let logTimer = null;
    document.getElementById('autoRefresh').addEventListener('change', function() {
      if (this.checked) {
        logTimer = setInterval(fetchLogs, 5000);
        fetchLogs();
      } else {
        clearInterval(logTimer);
        logTimer = null;
      }
    });
    logTimer = setInterval(fetchLogs, 5000);

    // ---------- 添加房间 ----------
    const addRoomModal = new bootstrap.Modal(document.getElementById('addRoomModal'));
    document.getElementById('addRoomBtn').addEventListener('click', () => {
      document.getElementById('roomInput').value = '';
      addRoomModal.show();
    });
    document.getElementById('addRoomConfirmBtn').addEventListener('click', async function() {
      const roomId = document.getElementById('roomInput').value.trim();
      if (!roomId) { showMessage('请输入房间号', 'error'); return; }
      this.disabled = true;
      this.textContent = '提交中...';
      try {
        await axios.post('/api/rooms', { room_id: roomId });
        addRoomModal.hide();
        showMessage('房间 ' + roomId + ' 已添加', 'info');
        await renderRooms();
      } catch (e) {
        showMessage('添加失败: ' + (e.response?.data?.error || e.message), 'error');
      }
      this.disabled = false;
      this.textContent = '完成';
    });

    // ---------- 删除房间（委托） ----------
    document.addEventListener('click', async function(e) {
      const btn = e.target.closest('.delete-room-btn');
      if (btn) {
        const roomId = btn.dataset.room;
        if (!confirm('确定删除房间 ' + roomId + ' 吗？')) return;
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span>';
        try {
          await axios.delete('/api/rooms', { data: { room_id: roomId } });
          showMessage('房间 ' + roomId + ' 已删除', 'info');
          await renderRooms();
        } catch (e) {
          showMessage('删除失败: ' + (e.response?.data?.error || e.message), 'error');
          btn.disabled = false;
          btn.innerHTML = '删除';
        }
      }
    });

    // ---------- 检查所有房间 ----------
    document.getElementById('checkAllBtn').addEventListener('click', async function() {
      this.disabled = true;
      this.innerHTML = '<span class="spinner-border spinner-border-sm"></span>';
      try {
        await axios.post('/api/monitor', { force: true });
        showMessage('检查完成', 'info');
        await renderRooms();
      } catch (e) {
        showMessage('检查失败: ' + e.message, 'error');
      }
      this.disabled = false;
      this.innerHTML = '<i class="bi bi-arrow-repeat"></i> 检查';
    });

    document.getElementById('refreshRoomsBtn').addEventListener('click', async function() {
      this.disabled = true;
      this.innerHTML = '<span class="spinner-border spinner-border-sm"></span>';
      await renderRooms();
      this.disabled = false;
      this.innerHTML = '<i class="bi bi-cloud-refresh"></i> 刷新';
    });

    // ---------- 模拟直播通知 ----------
    document.getElementById('sendLiveBtn').addEventListener('click', async function() {
      this.disabled = true;
      this.innerHTML = '<span class="spinner-border spinner-border-sm"></span>';
      try {
        const res = await axios.post('/api/send-live-notify');
        showMessage(res.data.message || '发送成功', 'info');
      } catch (e) {
        showMessage('发送失败: ' + (e.response?.data?.error || e.message), 'error');
      }
      this.disabled = false;
      this.innerHTML = '<i class="bi bi-broadcast"></i> 模拟';
    });

    // ---------- 单房间检查 ----------
    document.getElementById('singleCheckBtn').addEventListener('click', async function() {
      const roomId = document.getElementById('singleCheckInput').value.trim();
      if (!roomId) { showMessage('请输入房间号', 'error'); return; }
      this.disabled = true;
      this.innerHTML = '<span class="spinner-border spinner-border-sm"></span>';
      try {
        await axios.post('/api/monitor', { force: true });
        showMessage('已触发检查，请稍后刷新查看', 'info');
        setTimeout(renderRooms, 3000);
      } catch (e) {
        showMessage('操作失败: ' + e.message, 'error');
      }
      this.disabled = false;
      this.innerHTML = '查';
    });

    // ---------- 日志操作 ----------
    document.getElementById('clearLogsBtn').addEventListener('click', async function() {
      if (!confirm('确定清除所有日志吗？')) return;
      try {
        await axios.post('/api/logs/clear');
        showMessage('日志已清除', 'info');
        await fetchLogs();
      } catch (e) {
        showMessage('清除失败: ' + e.message, 'error');
      }
    });

    document.getElementById('exportLogsBtn').addEventListener('click', function() {
      const blob = new Blob([JSON.stringify(allLogs, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'logs.json'; a.click();
      URL.revokeObjectURL(url);
    });

    // ---------- 通知配置表单 ----------
    function updateNotifyForm() {
      const val = document.getElementById('protocolSelect').value;
      const tgTokenGroup = document.getElementById('tgTokenGroup');
      const receiverLabel = document.getElementById('receiverLabel');
      const chatId = document.getElementById('chatId');
      if (val === 'telegram') {
        tgTokenGroup.style.display = 'block';
        receiverLabel.textContent = '接收者 ID (chat_id)';
        chatId.placeholder = '';
      } else {
        tgTokenGroup.style.display = 'none';
        if (val === 'onebot_private') {
          receiverLabel.textContent = '用户 ID (user_id)';
          chatId.placeholder = '';
        } else if (val === 'onebot_group') {
          receiverLabel.textContent = '群 ID (group_id)';
          chatId.placeholder = '';
        } else {
          receiverLabel.textContent = '接收者 ID (可选)';
          chatId.placeholder = '';
        }
      }
    }
    document.getElementById('protocolSelect').addEventListener('change', updateNotifyForm);
    updateNotifyForm();

    document.getElementById('addNotifyForm').addEventListener('submit', async function(e) {
      e.preventDefault();
      const form = this;
      const protocol = document.getElementById('protocolSelect').value;
      let apiUrl = document.getElementById('apiUrl').value;
      if (protocol === 'telegram') {
        const token = document.getElementById('tgToken').value.trim();
        if (!token) { showMessage('请输入 Bot Token', 'error'); return; }
        apiUrl = 'https://api.telegram.org/bot' + token + '/sendMessage';
      }
      const formData = new FormData(form);
      const payload = {
        name: formData.get('name'),
        protocol: protocol,
        api_url: apiUrl,
        chat_id: formData.get('chat_id') || '',
        template: formData.get('template') || '',
        extra_params: {}
      };
      if (protocol === 'telegram') {
        payload.receiver_key = 'chat_id';
        payload.message_key = 'text';
      } else if (protocol === 'onebot_private') {
        payload.receiver_key = 'user_id';
        payload.message_key = 'message';
      } else if (protocol === 'onebot_group') {
        payload.receiver_key = 'group_id';
        payload.message_key = 'message';
      } else {
        payload.receiver_key = '';
        payload.message_key = '';
      }
      try {
        await axios.post('/api/notify-configs', payload);
        showMessage('配置添加成功', 'info');
        await renderConfigs();
        form.reset();
        updateNotifyForm();
      } catch (e) {
        showMessage('添加失败: ' + (e.response?.data?.error || e.message), 'error');
      }
    });

    // ---------- 配置操作（测试、切换、删除） ----------
    document.addEventListener('click', async function(e) {
      const btn = e.target.closest('.test-btn');
      if (btn) {
        const id = btn.dataset.id;
        btn.disabled = true;
        btn.textContent = '测试中...';
        try {
          const res = await axios.post('/api/notify-configs/test', { id });
          showMessage(res.data.message || '测试成功', 'info');
        } catch (e) {
          showMessage('测试失败: ' + (e.response?.data?.error || e.message), 'error');
        }
        btn.disabled = false;
        btn.textContent = '测试';
        return;
      }

      const toggleBtn = e.target.closest('.toggle-btn');
      if (toggleBtn) {
        const id = toggleBtn.dataset.id;
        toggleBtn.disabled = true;
        toggleBtn.textContent = '切换中...';
        try {
          await axios.post('/api/notify-configs/toggle', { id });
          showMessage('切换成功', 'info');
          await renderConfigs();
        } catch (e) {
          showMessage('切换失败: ' + (e.response?.data?.error || e.message), 'error');
          toggleBtn.disabled = false;
          toggleBtn.textContent = '切换';
        }
        return;
      }

      const deleteBtn = e.target.closest('.delete-config-btn');
      if (deleteBtn) {
        const id = deleteBtn.dataset.id;
        if (!confirm('确定删除该配置吗？')) return;
        try {
          await axios.delete('/api/notify-configs', { data: { id } });
          showMessage('删除成功', 'info');
          await renderConfigs();
        } catch (e) {
          showMessage('删除失败: ' + (e.response?.data?.error || e.message), 'error');
        }
      }
    });

  } else {
    // 未认证，保持登录面板显示，并绑定登录事件
    document.getElementById('loginPanel').style.display = 'block';
    document.getElementById('mainPanel').style.display = 'none';

    document.getElementById('loginForm').addEventListener('submit', async function(e) {
      e.preventDefault();
      const username = document.getElementById('loginUsername').value;
      const password = document.getElementById('loginPassword').value;
      const errorEl = document.getElementById('loginError');
      errorEl.style.display = 'none';
      try {
        await login(username, password);
        // 登录成功，刷新页面以重新加载主面板
        location.reload();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.style.display = 'block';
      }
    });
  }
});
</script>
</body>
</html>`;

export default {
  async fetch(request, env) {
    const backendUrl = env.BACKEND_URL || 'https://live-api.262832.xyz';
    const finalHtml = HTML_TEMPLATE.replace(/\$\{BACKEND_URL\}/g, backendUrl);
    return new Response(finalHtml, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      }
    });
  }
};
