var CONFIG = {
  MAIN_API: 'https://uapis.cn/api/v1/social/bilibili/liveroom',
  USER_API: 'https://uapis.cn/api/v1/social/bilibili/userinfo',
  IS_LIVE_STATUS: [1, 2],
  CACHE_TTL: 86400,
  USER_INFO_TTL: 86400,
  MAX_LOG_ENTRIES: 500,
  POPULARITY_MILESTONES: [1000, 5000, 10000, 50000, 100000],
  FIRST_SYNC_DIRECT: true
};

function toRoomId(id) {
  return String(id).trim();
}

async function getRoomList(env) {
  var val = await env.ROOM_STORE.get('rooms', 'json');
  return val || [];
}

async function setRoomList(env, rooms) {
  await env.ROOM_STORE.put('rooms', JSON.stringify(rooms));
}

async function addRoom(env, roomId) {
  roomId = toRoomId(roomId);
  var rooms = await getRoomList(env);
  rooms = rooms.map(String);
  if (!rooms.includes(roomId)) {
    rooms.push(roomId);
    await setRoomList(env, rooms);
  }
  await clearPageCache();
  return rooms;
}

async function removeRoom(env, roomId) {
  roomId = toRoomId(roomId);
  var rooms = await getRoomList(env);
  rooms = rooms.filter(function(id) { return String(id) !== roomId; });
  await setRoomList(env, rooms);
  await env.ROOM_STORE.delete('monitor:' + roomId);
  await clearPageCache();
  return rooms;
}

async function getNotifyConfigs(env) {
  var val = await env.ROOM_STORE.get('notify_configs', 'json');
  return val || [];
}

async function setNotifyConfigs(env, configs) {
  await env.ROOM_STORE.put('notify_configs', JSON.stringify(configs));
}

async function addNotifyConfig(env, config) {
  var configs = await getNotifyConfigs(env);
  config.id = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
  configs.push(config);
  await setNotifyConfigs(env, configs);
  return config;
}

async function deleteNotifyConfig(env, id) {
  var configs = await getNotifyConfigs(env);
  configs = configs.filter(function(c) { return c.id !== id; });
  await setNotifyConfigs(env, configs);
}

async function toggleNotifyConfig(env, id) {
  var configs = await getNotifyConfigs(env);
  var found = false;
  var updated = configs.map(function(c) {
    if (c.id === id) { found = true; return { ...c, enabled: !c.enabled }; }
    return c;
  });
  if (!found) throw new Error('配置不存在');
  await setNotifyConfigs(env, updated);
}

async function getMonitorState(env, roomId) {
  roomId = toRoomId(roomId);
  var key = 'monitor:' + roomId;
  var val = await env.ROOM_STORE.get(key, 'json');
  if (val) return val;
  return {
    room_id: roomId,
    state: 'UNKNOWN',
    last_live_time: '',
    notified_live_time: '',
    last_title: '',
    last_cover: '',
    last_area: '',
    last_parent_area: '',
    last_online: 0,
    last_update: '',
    version: 2
  };
}

async function setMonitorState(env, roomId, state) {
  roomId = toRoomId(roomId);
  var key = 'monitor:' + roomId;
  state.last_update = new Date().toISOString();
  state.version = 2;
  await env.ROOM_STORE.put(key, JSON.stringify(state));
}

function buildCacheKey() {
  var parts = Array.prototype.slice.call(arguments);
  return parts.join(':');
}

async function getCache(key) {
  var cache = caches.default;
  var req = new Request('https://cache/' + key);
  var resp = await cache.match(req);
  if (resp && resp.ok) return resp.json();
  return null;
}

async function setCache(key, data, ttl) {
  ttl = ttl || CONFIG.CACHE_TTL;
  var cache = caches.default;
  var resp = new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=' + ttl }
  });
  await cache.put(new Request('https://cache/' + key), resp);
}

async function clearPageCache() {
  var cache = caches.default;
  await cache.delete(new Request('https://cache/admin'));
}

async function getLogs() {
  return (await getCache('logs')) || [];
}

async function addLog(level, message) {
  var timestamp = new Date().toISOString();
  var entry = { time: timestamp, level: level, message: message };
  if (level === 'error') console.error('[' + timestamp + '] [' + level.toUpperCase() + '] ' + message);
  else if (level === 'warn') console.warn('[' + timestamp + '] [' + level.toUpperCase() + '] ' + message);
  else console.log('[' + timestamp + '] [' + level.toUpperCase() + '] ' + message);
  var logs = await getLogs();
  logs.unshift(entry);
  if (logs.length > CONFIG.MAX_LOG_ENTRIES) logs.length = CONFIG.MAX_LOG_ENTRIES;
  await setCache('logs', logs, 86400);
}

async function clearLogs() {
  await setCache('logs', [], 86400);
  await addLog('info', '日志已清除');
}

async function fetchLiveStatus(roomId) {
  roomId = toRoomId(roomId);
  var url = CONFIG.MAIN_API + '?room_id=' + encodeURIComponent(roomId);
  var resp = await fetch(url, {
    headers: { 'User-Agent': 'CloudflareWorker/1.0', 'Accept': 'application/json' }
  });
  if (!resp.ok) throw new Error('UAPI请求失败 (' + resp.status + ')');
  var data = await resp.json();
  if (!data.room_id) throw new Error('UAPI返回数据缺少room_id');
  return data;
}

async function fetchUserInfo(uid) {
  var cacheKey = buildCacheKey('userinfo', uid);
  var cached = await getCache(cacheKey);
  if (cached) return cached;
  var url = CONFIG.USER_API + '?uid=' + encodeURIComponent(uid);
  var resp = await fetch(url, {
    headers: { 'User-Agent': 'CloudflareWorker/1.0', 'Accept': 'application/json' }
  });
  if (!resp.ok) throw new Error('用户信息API请求失败 (' + resp.status + ')');
  var data = await resp.json();
  if (!data.mid) throw new Error('用户信息API返回缺少mid');
  await setCache(cacheKey, data, CONFIG.USER_INFO_TTL);
  return data;
}

async function sendNotificationToConfig(config, text, extra) {
  extra = extra || {};
  try {
    var payload = {};
    var receiverKey = config.receiver_key || 'chat_id';
    var messageKey = config.message_key || 'text';
    if (config.protocol === 'discord') {
      payload = { content: text };
    } else if (config.protocol === 'custom_webhook') {
      payload = extra;
    } else {
      payload[receiverKey] = config.chat_id;
      payload[messageKey] = text;
    }
    if (config.extra_params) Object.assign(payload, config.extra_params);
    var resp = await fetch(config.api_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (resp.ok) {
      await addLog('info', '通知发送成功 (' + config.name + ')');
      return { success: true };
    } else {
      var errText = await resp.text();
      await addLog('error', '通知发送失败 (' + config.name + '): HTTP ' + resp.status + ' ' + errText);
      return { success: false, error: errText };
    }
  } catch (e) {
    await addLog('error', '通知发送异常 (' + config.name + '): ' + e.message);
    return { success: false, error: e.message };
  }
}

async function sendNotification(text, env, extra) {
  extra = extra || {};
  var configs = await getNotifyConfigs(env);
  var enabled = configs.filter(function(c) { return c.enabled !== false; });
  if (enabled.length === 0) {
    await addLog('warn', '没有启用的通知配置');
    return false;
  }
  var success = false;
  for (var i = 0; i < enabled.length; i++) {
    var result = await sendNotificationToConfig(enabled[i], text, extra);
    if (result.success) success = true;
  }
  return success;
}

function renderTemplate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, function(match, key) {
    return vars[key] !== undefined ? vars[key] : match;
  });
}

async function buildNotification(roomId, current, env, eventType, extra) {
  extra = extra || {};
  var userInfo = null;
  try {
    userInfo = await fetchUserInfo(current.uid);
  } catch (e) { }
  var anchorName = (userInfo && userInfo.name) ? userInfo.name : '房间 ' + roomId;
  var baseVars = {
    '主播': anchorName,
    '标题': current.title || '未知',
    'UID': current.uid || '',
    '房间号': current.room_id || roomId,
    '直播时间': current.live_time || '刚刚',
    '直播链接': 'https://live.bilibili.com/' + (current.room_id || roomId),
    '分区': current.area_name || '未知',
    '父分区': current.parent_area_name || '未知',
    '人气': current.online || 0,
    '封面': current.user_cover || '',
    '签名': (userInfo && userInfo.sign) || '',
    '粉丝': (userInfo && userInfo.follower) || 0,
    '关注': (userInfo && userInfo.following) || 0,
    '等级': (userInfo && userInfo.level) || 0,
    '性别': (userInfo && userInfo.sex) || '',
  };
  var message = '';
  switch (eventType) {
    case 'live_start':
      message = '[开播] ' + anchorName + ' 开播了\n标题：' + current.title + '\n人气：' + current.online + '\n开播时间：' + (current.live_time || '刚刚') + '\n房间号：' + current.room_id + '\n分区：' + current.parent_area_name + ' - ' + current.area_name;
      break;
    case 'live_end':
      message = '[下播] ' + anchorName + ' 直播已结束\n最后人气：' + current.online;
      break;
    case 'title_change':
      message = '[标题修改] ' + anchorName + ' 修改了直播标题\n旧标题：' + extra.old_title + '\n新标题：' + current.title;
      break;
    case 'cover_change':
      message = '[封面修改] ' + anchorName + ' 更换了直播封面';
      break;
    case 'area_change':
      message = '[分区切换] ' + anchorName + ' 切换了直播分区\n旧分区：' + extra.old_parent_area + ' - ' + extra.old_area + '\n新分区：' + current.parent_area_name + ' - ' + current.area_name;
      break;
    case 'popularity_milestone':
      message = '[人气里程碑] ' + anchorName + ' 人气达到 ' + extra.milestone + '！当前人气：' + current.online;
      break;
    default:
      message = text;
  }
  var configs = await getNotifyConfigs(env);
  var template = null;
  for (var i = 0; i < configs.length; i++) {
    if (configs[i].template) { template = configs[i].template; break; }
  }
  if (template) {
    return renderTemplate(template, baseVars);
  }
  return message;
}

async function processRoom(roomId, env, options) {
  options = options || {};
  var force = options.force || false;
  roomId = toRoomId(roomId);
  var current;
  try {
    current = await fetchLiveStatus(roomId);
    var liveStatus = Number(current.live_status ?? current.livestatus ?? current.liveStatus ?? 0);
    current.live_status = liveStatus;
    await addLog('info', '房间 ' + roomId + ' 状态=' + current.live_status + ' 人气=' + (current.online || 0));
  } catch (e) {
    await addLog('error', '[' + roomId + '] 获取状态失败: ' + e.message);
    return { error: e.message };
  }
  var isLive = CONFIG.IS_LIVE_STATUS.includes(current.live_status);
  var prev = await getMonitorState(env, roomId);
  var firstSync = force || (CONFIG.FIRST_SYNC_DIRECT && (!prev.last_update || prev.state === 'UNKNOWN'));
  var state = prev.state || 'UNKNOWN';
  var notified_live_time = prev.notified_live_time || '';
  var events = [];

  if (state === 'UNKNOWN') {
    if (isLive) {
      state = 'LIVE';
      events.push({ type: 'live_start', data: current });
      notified_live_time = current.live_time || '';
    } else {
      state = 'OFFLINE';
    }
  } else if (state === 'OFFLINE') {
    if (isLive) {
      state = 'LIVE';
      events.push({ type: 'live_start', data: current });
      notified_live_time = current.live_time || '';
    }
  } else if (state === 'LIVE') {
    if (!isLive) {
      state = 'OFFLINE';
      events.push({ type: 'live_end', data: current });
      notified_live_time = '';
    } else {
      if (prev.last_title && prev.last_title !== current.title) {
        events.push({ type: 'title_change', data: current, old_title: prev.last_title });
      }
      if (prev.last_cover && prev.last_cover !== current.user_cover) {
        events.push({ type: 'cover_change', data: current });
      }
      if (prev.last_area !== current.area_name || prev.last_parent_area !== current.parent_area_name) {
        events.push({ type: 'area_change', data: current, old_area: prev.last_area, old_parent_area: prev.last_parent_area });
      }
      var prevOnline = prev.last_online || 0;
      for (var i = 0; i < CONFIG.POPULARITY_MILESTONES.length; i++) {
        var milestone = CONFIG.POPULARITY_MILESTONES[i];
        if (prevOnline < milestone && current.online >= milestone) {
          events.push({ type: 'popularity_milestone', data: current, milestone: milestone });
        }
      }
    }
  }

  var newState = {
    room_id: roomId,
    state: state,
    last_live_time: current.live_time || prev.last_live_time || '',
    notified_live_time: notified_live_time,
    last_title: current.title || '',
    last_cover: current.user_cover || '',
    last_area: current.area_name || '',
    last_parent_area: current.parent_area_name || '',
    last_online: current.online || 0,
    last_update: new Date().toISOString(),
    version: 2
  };
  await setMonitorState(env, roomId, newState);

  for (var j = 0; j < events.length; j++) {
    var evt = events[j];
    var text = await buildNotification(roomId, evt.data, env, evt.type, evt);
    await sendNotification(text, env, { event: evt.type, room_id: roomId, ...evt.data });
    await addLog('info', '[' + roomId + '] 事件 ' + evt.type + ' 已通知');
  }
  return { state: state, events: events };
}

async function monitorAll(env, options) {
  options = options || {};
  var force = options.force || false;
  var roomIds = await getRoomList(env);
  if (roomIds.length === 0) {
    await addLog('warn', '房间列表为空，跳过检查');
    return { error: '房间列表为空' };
  }
  await addLog('info', '开始批量检查 ' + roomIds.length + ' 个房间' + (force ? ' (强制刷新)' : ''));
  var results = [];
  for (var i = 0; i < roomIds.length; i++) {
    var roomId = toRoomId(roomIds[i]);
    try {
      var res = await processRoom(roomId, env, { force: force });
      results.push({ room_id: roomId, ...res });
    } catch (e) {
      await addLog('error', '处理房间 ' + roomId + ' 失败: ' + e.message);
      results.push({ room_id: roomId, error: e.message });
    }
  }
  await addLog('info', '批量检查完成，共 ' + results.length + ' 个结果');
  return results;
}

function isAuthenticated(request, env) {
  var cookie = request.headers.get('Cookie') || '';
  var authCookie = cookie.split(';').find(function(c) { return c.trim().startsWith('auth='); });
  if (!authCookie) return false;
  var authValue = authCookie.split('=')[1];
  try {
    var decoded = atob(authValue);
    var parts = decoded.split(':');
    return parts[0] === env.ADMIN_USER && parts[1] === env.ADMIN_PASSWORD;
  } catch (e) {
    return false;
  }
}

var HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>直播监控管理</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#f3f4f6;font-family:system-ui;padding:1rem;color:#1f2937;line-height:1.5;-webkit-tap-highlight-color:transparent}
.container{max-width:1200px;margin:0 auto}
.header{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:0.5rem;margin-bottom:1rem}
.header h1{font-size:1.6rem;font-weight:600;color:#1f2937}
.header-actions{display:flex;gap:0.5rem;flex-wrap:wrap}
.btn{display:inline-flex;align-items:center;justify-content:center;padding:0.6rem 1.2rem;min-height:44px;border:none;border-radius:8px;font-size:1rem;font-weight:500;cursor:pointer;transition:0.2s;touch-action:manipulation;user-select:none;background:#e5e7eb;color:#1f2937;position:relative;z-index:10;pointer-events:auto}
.btn:active{transform:scale(0.96)}
.btn-primary{background:#2563eb;color:#fff}
.btn-primary:hover{background:#1d4ed8}
.btn-success{background:#16a34a;color:#fff}
.btn-success:hover{background:#15803d}
.btn-warning{background:#d97706;color:#fff}
.btn-warning:hover{background:#b45309}
.btn-danger{background:#dc2626;color:#fff}
.btn-danger:hover{background:#b91c1c}
.btn-sm{padding:0.3rem 0.7rem;min-height:32px;font-size:0.85rem}
.tab-bar{display:flex;gap:0.5rem;margin-bottom:1rem;flex-wrap:wrap}
.tab-btn{padding:0.4rem 1rem;border:none;border-radius:6px;cursor:pointer;background:#e5e7eb;color:#1f2937;font-size:0.9rem;touch-action:manipulation;position:relative;z-index:10}
.tab-active{background:#2563eb;color:#fff}
.panel{background:#fff;border-radius:12px;border:1px solid #e5e7eb;padding:1rem;margin-bottom:1.5rem;box-shadow:0 1px 3px rgba(0,0,0,0.05)}
.panel h3{font-size:1.1rem;font-weight:600;margin-bottom:0.75rem}
.flex-row{display:flex;flex-wrap:wrap;gap:0.5rem;align-items:center;margin-bottom:1rem}
.card-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:1rem}
.room-card{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:0.75rem;display:flex;gap:0.75rem;align-items:flex-start}
.status-dot{width:12px;height:12px;border-radius:50%;flex-shrink:0;margin-top:4px}
.room-info{flex:1;min-width:0}
.room-id{font-weight:600;font-size:0.85rem}
.room-title{font-size:0.95rem;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.room-meta{font-size:0.75rem;color:#6b7280;margin-top:2px}
.room-actions{display:flex;gap:0.3rem;flex-wrap:wrap}
table{width:100%;border-collapse:collapse;font-size:0.85rem;display:block;overflow-x:auto}
thead,tbody{display:table;width:100%}
th{text-align:left;padding:0.4rem 0.6rem;border-bottom:2px solid #e5e7eb}
td{padding:0.4rem 0.6rem;border-bottom:1px solid #e5e7eb}
.log-container{background:#111827;color:#e5e7eb;padding:0.5rem;border-radius:6px;max-height:400px;overflow-y:auto;font-family:monospace;font-size:0.75rem;line-height:1.5;border:1px solid #374151}
.log-entry{border-bottom:1px solid #1f2937;padding:0.15rem 0}
.log-time{color:#9ca3af;margin-right:0.5rem}
.log-info{color:#60a5fa}
.log-warn{color:#fbbf24}
.log-error{color:#f87171}
.modal-overlay{display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:999;justify-content:center;align-items:center;padding:1rem;pointer-events:none}
.modal-overlay.active{display:flex;pointer-events:auto}
.modal-box{background:#fff;padding:1.5rem;border-radius:12px;max-width:500px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.3)}
.modal-actions{margin-top:1rem;display:flex;gap:0.5rem;justify-content:flex-end}
.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:0.5rem}
.form-grid .full{grid-column:span 2}
label{display:block;font-size:0.8rem;font-weight:500;margin-bottom:0.2rem}
input,select,textarea{width:100%;padding:0.4rem;border:1px solid #d1d5db;border-radius:6px;font-size:0.9rem;background:#fff;color:#1f2937}
input:focus,select:focus,textarea:focus{outline:2px solid #2563eb;outline-offset:1px}
#messageArea{position:relative;z-index:20}
@media(max-width:640px){
.header h1{font-size:1.3rem}
.btn{padding:0.8rem;width:100%;justify-content:center}
.btn-sm{width:auto;padding:0.4rem 0.8rem}
.flex-row .btn{width:100%}
.card-grid{grid-template-columns:1fr}
.form-grid{grid-template-columns:1fr}
.form-grid .full{grid-column:span 1}
.tab-bar{gap:0.3rem}
.tab-btn{flex:1;text-align:center;padding:0.4rem 0.5rem;font-size:0.8rem}
.modal-box{padding:1rem}
.room-card{flex-wrap:wrap}
.room-actions{width:100%;justify-content:flex-end}
}
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>直播监控管理</h1>
    <div class="header-actions">
      <button id="themeToggle" class="btn">深色</button>
      <button id="logoutBtn" class="btn">退出</button>
      <form id="logoutForm" method="POST" action="/logout" style="display:none"></form>
    </div>
  </div>
  <div id="messageArea"></div>
  <div class="tab-bar">
    <button class="tab-btn tab-active" data-tab="rooms">房间</button>
    <button class="tab-btn" data-tab="notifies">通知</button>
    <button class="tab-btn" data-tab="logs">日志</button>
  </div>
  <div id="panelRooms" class="panel">
    <div class="flex-row">
      <button id="addRoomBtn" class="btn btn-primary">添加房间</button>
      <button id="checkAllBtn" class="btn btn-success">检查全部</button>
      <button id="refreshRoomsBtn" class="btn btn-primary">刷新状态</button>
      <button id="sendLiveBtn" class="btn btn-warning">模拟开播</button>
      <div style="display:flex;gap:0.3rem;flex:1;flex-wrap:wrap">
        <input id="singleCheckInput" placeholder="房间号" style="flex:1;min-width:100px">
        <button id="singleCheckBtn" class="btn btn-primary">单查</button>
      </div>
      <button id="exportLogsBtn" class="btn">导出日志</button>
    </div>
    <div id="roomContainer" class="card-grid">{{ROOMS}}</div>
  </div>
  <div id="panelNotifies" style="display:none" class="panel">
    <div style="margin-bottom:1rem">
      <h3>添加通知配置</h3>
      <form method="POST" action="/add-notify" id="addNotifyForm" class="form-grid">
        <div><label>名称</label><input type="text" name="name" placeholder="主Telegram" required></div>
        <div><label>协议</label>
          <select name="protocol" id="protocolSelect">
            <option value="telegram">Telegram</option>
            <option value="onebot_private">OneBot 私聊</option>
            <option value="onebot_group">OneBot 群聊</option>
            <option value="discord">Discord Webhook</option>
            <option value="custom_webhook">自定义 Webhook</option>
          </select>
        </div>
        <div class="full"><label>API 地址</label><input type="url" name="api_url" id="apiUrl" placeholder="https://api.telegram.org/bot<token>/sendMessage"></div>
        <div><label id="receiverLabel">接收者 ID</label><input type="text" name="chat_id" id="chatId" placeholder="例如：123456789"></div>
        <div class="full"><label><input type="checkbox" name="enabled" checked value="1"> 启用</label></div>
        <div class="full"><label>通知模板 (可选)</label><textarea name="template" id="templateArea" placeholder="支持 {{主播}} {{标题}} {{人气}} 等变量" rows="2"></textarea></div>
        <div class="full"><button type="submit" class="btn btn-primary" style="width:100%">添加配置</button></div>
      </form>
    </div>
    <div>
      <h3>现有配置</h3>
      <table><thead><tr><th>名称</th><th>协议</th><th>状态</th><th>操作</th></tr></thead><tbody id="configTableBody">{{CONFIGS}}</tbody></table>
    </div>
  </div>
  <div id="panelLogs" style="display:none" class="panel">
    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:0.5rem;margin-bottom:0.5rem">
      <h3>日志</h3>
      <div style="display:flex;gap:0.3rem;flex-wrap:wrap">
        <button id="clearLogsBtn" class="btn btn-danger btn-sm">清除</button>
        <button id="refreshLogsBtn" class="btn btn-sm">刷新</button>
        <label style="font-size:0.8rem;display:flex;align-items:center"><input type="checkbox" id="autoRefresh" checked> 自动刷新</label>
        <input id="logSearch" placeholder="搜索..." style="flex:1;min-width:80px">
        <select id="logLevelFilter"><option value="">全部</option><option value="info">Info</option><option value="warn">Warn</option><option value="error">Error</option></select>
      </div>
    </div>
    <div id="logContainer" class="log-container">{{LOGS}}</div>
  </div>
</div>
<div id="customModal" class="modal-overlay">
  <div class="modal-box">
    <h3 id="modalTitle">提示</h3>
    <p id="modalMessage"></p>
    <div class="modal-actions">
      <button id="modalConfirmBtn" class="btn btn-primary">确定</button>
      <button id="modalCancelBtn" class="btn">取消</button>
    </div>
  </div>
</div>
<div id="addRoomModal" class="modal-overlay">
  <div class="modal-box">
    <h3>添加房间</h3>
    <p>请输入直播间房间号：</p>
    <input type="text" id="roomInput" placeholder="例如：1768500100" style="width:100%;margin:0.5rem 0;padding:0.5rem;border:1px solid #d1d5db;border-radius:6px;font-size:1rem">
    <div class="modal-actions">
      <button id="addRoomConfirmBtn" class="btn btn-primary">完成</button>
      <button id="addRoomCancelBtn" class="btn">取消</button>
    </div>
  </div>
</div>
<script>
(function(){
  window.onerror = function(message, source, line, col) {
    console.error('[JS错误]', message, '行:', line, '列:', col);
    var area = document.getElementById('messageArea');
    if (area) {
      area.innerHTML = '<div style="padding:0.75rem;border-radius:6px;margin-bottom:0.75rem;background:#fef2f2;border:1px solid #fecaca;color:#991b1b">JS错误: '+message+' (行:'+line+')</div>';
    }
  };

  function getEl(id) {
    var el = document.getElementById(id);
    if (!el) console.warn('元素未找到:', id);
    return el;
  }

  var themeToggle = getEl('themeToggle');
  var logoutBtn = getEl('logoutBtn');
  var logoutForm = getEl('logoutForm');
  var addRoomBtn = getEl('addRoomBtn');
  var checkAllBtn = getEl('checkAllBtn');
  var refreshRoomsBtn = getEl('refreshRoomsBtn');
  var sendLiveBtn = getEl('sendLiveBtn');
  var singleCheckBtn = getEl('singleCheckBtn');
  var singleCheckInput = getEl('singleCheckInput');
  var exportLogsBtn = getEl('exportLogsBtn');
  var clearLogsBtn = getEl('clearLogsBtn');
  var refreshLogsBtn = getEl('refreshLogsBtn');
  var autoRefresh = getEl('autoRefresh');
  var logSearch = getEl('logSearch');
  var logLevelFilter = getEl('logLevelFilter');
  var addRoomConfirmBtn = getEl('addRoomConfirmBtn');
  var addRoomCancelBtn = getEl('addRoomCancelBtn');
  var roomInput = getEl('roomInput');
  var messageArea = getEl('messageArea');
  var logContainer = getEl('logContainer');
  var customModal = getEl('customModal');
  var modalTitle = getEl('modalTitle');
  var modalMessage = getEl('modalMessage');
  var modalConfirmBtn = getEl('modalConfirmBtn');
  var modalCancelBtn = getEl('modalCancelBtn');
  var addRoomModal = getEl('addRoomModal');
  var protocolSelect = getEl('protocolSelect');
  var templateArea = getEl('templateArea');

  var modalResolve = null;
  function showModal(title, msg, confirmText, cancelText) {
    return new Promise(function(resolve) {
      if (!customModal || !modalTitle || !modalMessage || !modalConfirmBtn || !modalCancelBtn) {
        resolve(false);
        return;
      }
      modalTitle.textContent = title || '提示';
      modalMessage.textContent = msg || '';
      modalConfirmBtn.textContent = confirmText || '确定';
      modalCancelBtn.textContent = cancelText || '取消';
      customModal.classList.add('active');
      modalResolve = resolve;
    });
  }
  function closeModal(result) {
    if (customModal) customModal.classList.remove('active');
    if (modalResolve) { modalResolve(result); modalResolve = null; }
  }
  if (modalConfirmBtn) modalConfirmBtn.addEventListener('click', function(){ closeModal(true); });
  if (modalCancelBtn) modalCancelBtn.addEventListener('click', function(){ closeModal(false); });
  if (customModal) customModal.addEventListener('click', function(e){ if (e.target === customModal) closeModal(false); });

  function showMessage(msg, type) {
    type = type || 'info';
    if (!messageArea) { console.warn('messageArea不存在'); return; }
    var colors = { info: '#f0fdf4', error: '#fef2f2', warn: '#fffbeb' };
    var borders = { info: '#bbf7d0', error: '#fecaca', warn: '#fde68a' };
    var textColors = { info: '#166534', error: '#991b1b', warn: '#92400e' };
    messageArea.innerHTML = '<div style="padding:0.75rem;border-radius:6px;margin-bottom:0.75rem;background:'+colors[type]+';border:1px solid '+borders[type]+';color:'+textColors[type]+'">'+msg+'</div>';
  }

  function renderLogs(logs) {
    if (!logContainer) return;
    var search = logSearch ? logSearch.value.toLowerCase() : '';
    var level = logLevelFilter ? logLevelFilter.value : '';
    var filtered = logs;
    if (search) filtered = filtered.filter(function(e){ return e.message.toLowerCase().includes(search); });
    if (level) filtered = filtered.filter(function(e){ return e.level === level; });
    if (!filtered.length) { logContainer.innerHTML = '<div style="color:#9ca3af">暂无日志</div>'; return; }
    var html = '';
    filtered.forEach(function(entry) {
      var cls = 'log-'+entry.level;
      html += '<div class="log-entry"><span class="log-time">'+entry.time+'</span><span class="'+cls+'">['+entry.level.toUpperCase()+']</span> '+entry.message+'</div>';
    });
    logContainer.innerHTML = html;
  }

  function fetchLogs() {
    fetch('/logs').then(function(res){ return res.json(); }).then(function(data){ renderLogs(data); }).catch(function(e){ console.error('获取日志失败', e); });
  }

  if (themeToggle) {
    themeToggle.addEventListener('click', function() {
      var html = document.documentElement;
      var theme = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      html.setAttribute('data-theme', theme);
      themeToggle.textContent = theme === 'dark' ? '亮色' : '深色';
    });
  }
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    document.documentElement.setAttribute('data-theme', 'dark');
    if (themeToggle) themeToggle.textContent = '亮色';
  }

  if (logoutBtn && logoutForm) {
    logoutBtn.addEventListener('click', function(){ logoutForm.submit(); });
  }

  document.querySelectorAll('.tab-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.tab-btn').forEach(function(b){ b.classList.remove('tab-active'); });
      this.classList.add('tab-active');
      var tab = this.dataset.tab;
      var panelRooms = document.getElementById('panelRooms');
      var panelNotifies = document.getElementById('panelNotifies');
      var panelLogs = document.getElementById('panelLogs');
      if (panelRooms) panelRooms.style.display = tab === 'rooms' ? 'block' : 'none';
      if (panelNotifies) panelNotifies.style.display = tab === 'notifies' ? 'block' : 'none';
      if (panelLogs) panelLogs.style.display = tab === 'logs' ? 'block' : 'none';
    });
  });

  if (addRoomBtn && addRoomModal) {
    addRoomBtn.addEventListener('click', function() {
      addRoomModal.classList.add('active');
      if (roomInput) { roomInput.value = ''; setTimeout(function(){ roomInput.focus(); }, 100); }
    });
  }
  if (addRoomCancelBtn && addRoomModal) {
    addRoomCancelBtn.addEventListener('click', function(){ addRoomModal.classList.remove('active'); });
  }
  if (addRoomModal) {
    addRoomModal.addEventListener('click', function(e){ if (e.target === addRoomModal) addRoomModal.classList.remove('active'); });
  }
  if (roomInput) {
    roomInput.addEventListener('keydown', function(e){ if (e.key === 'Enter') addRoomConfirm(); });
  }

  function addRoomConfirm() {
    if (!roomInput) { showMessage('页面错误，请刷新', 'error'); return; }
    var roomId = roomInput.value.trim();
    if (!roomId) { showMessage('请输入房间号', 'error'); return; }
    if (!addRoomConfirmBtn) return;
    addRoomConfirmBtn.disabled = true;
    addRoomConfirmBtn.textContent = '提交中...';
    var formData = new URLSearchParams();
    formData.append('room_id', roomId);
    fetch('/add-room', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: formData })
      .then(function(res) {
        if (res.ok) {
          if (addRoomModal) addRoomModal.classList.remove('active');
          showMessage('房间 '+roomId+' 已添加', 'info');
          setTimeout(function(){ location.reload(); }, 1500);
        } else {
          return res.text().then(function(err){ showMessage('添加失败: '+err, 'error'); });
        }
      })
      .catch(function(e){ showMessage('添加失败: '+e.message, 'error'); })
      .finally(function() {
        if (addRoomConfirmBtn) { addRoomConfirmBtn.disabled = false; addRoomConfirmBtn.textContent = '完成'; }
      });
  }
  if (addRoomConfirmBtn) {
    addRoomConfirmBtn.addEventListener('click', addRoomConfirm);
  }

  function bindClick(id, handler) {
    var el = document.getElementById(id);
    if (el) {
      el.addEventListener('click', handler);
    } else {
      console.warn('按钮未找到:', id);
    }
  }

  bindClick('checkAllBtn', function() {
    var btn = document.getElementById('checkAllBtn');
    if (btn) { btn.disabled = true; btn.textContent = '检查中...'; }
    fetch('/monitor?force=1').then(function(){ location.reload(); }).catch(function(){ location.reload(); });
  });

  bindClick('refreshRoomsBtn', function() {
    var btn = document.getElementById('refreshRoomsBtn');
    if (btn) { btn.disabled = true; btn.textContent = '刷新中...'; }
    fetch('/monitor?force=1').then(function(){ location.reload(); }).catch(function(){ location.reload(); });
  });

  bindClick('sendLiveBtn', function() {
    var btn = document.getElementById('sendLiveBtn');
    if (btn) { btn.disabled = true; btn.textContent = '发送中...'; }
    fetch('/send-live-notify', { method: 'POST' })
      .then(function(res){ return res.json(); })
      .then(function(data){ showMessage(data.message, data.success ? 'info' : 'error'); })
      .catch(function(e){ showMessage('操作失败: '+e.message, 'error'); })
      .finally(function(){ if (btn) { btn.disabled = false; btn.textContent = '模拟开播'; } });
  });

  bindClick('singleCheckBtn', function() {
    var input = document.getElementById('singleCheckInput');
    if (!input) return;
    var roomId = input.value.trim();
    if (!roomId) { showMessage('请输入房间号', 'error'); return; }
    var btn = document.getElementById('singleCheckBtn');
    if (btn) { btn.disabled = true; btn.textContent = '查询中...'; }
    fetch('/check?room_id=' + encodeURIComponent(roomId))
      .then(function(res){ return res.json(); })
      .then(function(data){ showMessage(JSON.stringify(data, null, 2), 'info'); })
      .catch(function(e){ showMessage('查询失败: '+e.message, 'error'); })
      .finally(function(){ if (btn) { btn.disabled = false; btn.textContent = '单查'; } });
  });

  bindClick('exportLogsBtn', function() {
    fetch('/logs')
      .then(function(res){ return res.json(); })
      .then(function(data){
        var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url; a.download = 'logs.json'; a.click();
        URL.revokeObjectURL(url);
      })
      .catch(function(e){ showMessage('导出失败: '+e.message, 'error'); });
  });

  bindClick('clearLogsBtn', function() {
    showModal('确认', '确定清除所有日志吗？').then(function(confirmed) {
      if (confirmed) {
        fetch('/clear-logs', { method: 'POST' })
          .then(function(){ showMessage('日志已清除', 'info'); fetchLogs(); })
          .catch(function(e){ showMessage('清除失败: '+e.message, 'error'); });
      }
    });
  });

  if (refreshLogsBtn) refreshLogsBtn.addEventListener('click', fetchLogs);
  if (autoRefresh) {
    autoRefresh.addEventListener('change', function() {
      if (this.checked) { logTimer = setInterval(fetchLogs, 5000); fetchLogs(); }
      else { clearInterval(logTimer); logTimer = null; }
    });
  }
  if (logSearch) logSearch.addEventListener('input', fetchLogs);
  if (logLevelFilter) logLevelFilter.addEventListener('change', fetchLogs);
  var logTimer = setInterval(fetchLogs, 5000);
  fetchLogs();

  if (protocolSelect) {
    protocolSelect.addEventListener('change', function() {
      var val = this.value;
      var apiUrl = getEl('apiUrl');
      var receiverLabel = getEl('receiverLabel');
      var chatId = getEl('chatId');
      if (!apiUrl || !receiverLabel || !chatId) return;
      if (val === 'telegram') {
        apiUrl.placeholder = 'https://api.telegram.org/bot<token>/sendMessage';
        receiverLabel.textContent = '接收者 ID (chat_id)';
        chatId.placeholder = '例如：123456789';
        if (templateArea) templateArea.value = '[开播] {{主播}} 开播了\\n标题：{{标题}}\\n人气：{{人气}}\\n房间号：{{房间号}}\\n分区：{{分区}}';
      } else if (val === 'onebot_private') {
        apiUrl.placeholder = 'http://127.0.0.1:5700/send_private_msg';
        receiverLabel.textContent = '用户 ID (user_id)';
        chatId.placeholder = '例如：123456789';
        if (templateArea) templateArea.value = '[开播] {{主播}} 开播了\\n标题：{{标题}}\\n人气：{{人气}}\\n房间号：{{房间号}}\\n分区：{{分区}}';
      } else if (val === 'onebot_group') {
        apiUrl.placeholder = 'http://127.0.0.1:5700/send_group_msg';
        receiverLabel.textContent = '群 ID (group_id)';
        chatId.placeholder = '例如：123456789';
        if (templateArea) templateArea.value = '[开播] {{主播}} 开播了\\n标题：{{标题}}\\n人气：{{人气}}\\n房间号：{{房间号}}\\n分区：{{分区}}';
      } else if (val === 'discord') {
        apiUrl.placeholder = 'https://discord.com/api/webhooks/...';
        receiverLabel.textContent = '无 (使用 Webhook URL)';
        chatId.placeholder = '可不填';
        if (templateArea) templateArea.value = '**[开播] {{主播}}**\\n标题：{{标题}}\\n人气：{{人气}}\\n房间号：{{房间号}}\\n分区：{{分区}}';
      } else if (val === 'custom_webhook') {
        apiUrl.placeholder = 'https://your-server.com/webhook';
        receiverLabel.textContent = '无 (使用 Webhook URL)';
        chatId.placeholder = '可不填';
        if (templateArea) templateArea.value = '{"event":"live_start","anchor":"{{主播}}","title":"{{标题}}","online":{{人气}},"room_id":"{{房间号}}"}';
      }
    });
  }

  document.addEventListener('click', function(e) {
    var target = e.target.closest('button');
    if (!target) return;

    if (target.classList && target.classList.contains('test-btn')) {
      var id = target.dataset.id;
      if (!id) return;
      target.disabled = true;
      target.textContent = '测试中...';
      var formData = new URLSearchParams();
      formData.append('config_id', id);
      fetch('/test-notify', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: formData })
        .then(function(res){ return res.json(); })
        .then(function(data){ showMessage(data.message, data.success ? 'info' : 'error'); })
        .catch(function(e){ showMessage('测试失败: '+e.message, 'error'); })
        .finally(function(){ target.disabled = false; target.textContent = '测试'; });
      return;
    }

    if (target.classList && target.classList.contains('toggle-btn')) {
      var id = target.dataset.id;
      if (!id) return;
      target.disabled = true;
      target.textContent = '切换中...';
      var formData = new URLSearchParams();
      formData.append('config_id', id);
      fetch('/toggle-notify', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: formData })
        .then(function(res){ return res.json(); })
        .then(function(data){ showMessage(data.message, 'info'); setTimeout(function(){ location.reload(); }, 500); })
        .catch(function(e){ showMessage('切换失败: '+e.message, 'error'); })
        .finally(function(){ target.disabled = false; target.textContent = '切换'; });
      return;
    }
  });

})();
</script>
</body>
</html>`;

function renderLoginPage(error) {
  error = error || '';
  return '<!DOCTYPE html>\n<html><head><meta charset="UTF-8"><title>管理登录</title><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;background:#f3f4f6;margin:0;padding:1rem}.card{background:white;padding:2rem;border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,0.1);width:100%;max-width:400px}h1{text-align:center}label{display:block;margin-top:1rem}input{width:100%;padding:0.5rem;border:1px solid #ccc;border-radius:6px;font-size:1rem}button{width:100%;padding:0.5rem;margin-top:1rem;background:#2563eb;color:white;border:none;border-radius:6px;font-size:1rem;cursor:pointer}.error{color:red;text-align:center}</style></head>\n<body><div class="card"><h1>管理登录</h1>' + (error ? '<p class="error">' + error + '</p>' : '') + '<form method="POST" action="/login"><label>用户名</label><input type="text" name="username" required><label>密码</label><input type="password" name="password" required><button type="submit">登录</button></form></div></body></html>';
}

async function renderAdminPage(env, message) {
  var roomIds = await getRoomList(env);
  var configs = await getNotifyConfigs(env);
  var roomsHtml = '';
  for (var i = 0; i < roomIds.length; i++) {
    var roomId = toRoomId(roomIds[i]);
    var state = await getMonitorState(env, roomId);
    var isLive = state.state === 'LIVE';
    var statusColor = isLive ? '#22c55e' : '#9ca3af';
    var statusText = isLive ? '直播中' : '未开播';
    var title = state.last_title || '未知';
    var online = state.last_online || 0;
    var area = state.last_parent_area ? state.last_parent_area + ' - ' + state.last_area : '未知分区';
    var updateTime = state.last_update ? new Date(state.last_update).toLocaleString() : '从未更新';
    roomsHtml += '<div class="room-card"><div class="status-dot" style="background:' + statusColor + '"></div><div class="room-info"><div class="room-id">房间 ' + roomId + '</div><div class="room-title">' + title + '</div><div class="room-meta">' + statusText + ' · 人气 ' + online + ' · ' + area + '</div><div class="room-meta">更新于 ' + updateTime + '</div></div><div class="room-actions"><form method="POST" action="/remove-room" onsubmit="return confirm(\'确定删除房间 \'+this.room_id.value+\' 吗？\')"><input type="hidden" name="room_id" value="' + roomId + '"><button type="submit" class="btn btn-danger btn-sm">删除</button></form></div></div>';
  }
  if (!roomsHtml) roomsHtml = '<div style="grid-column:span 3;text-align:center;padding:1.5rem 0;color:#6b7280">暂无房间，请添加</div>';
  var configsHtml = '';
  for (var j = 0; j < configs.length; j++) {
    var cfg = configs[j];
    var protocolLabel = { telegram: 'Telegram', onebot_private: 'OneBot私聊', onebot_group: 'OneBot群聊', discord: 'Discord', custom_webhook: '自定义Webhook' }[cfg.protocol] || cfg.protocol;
    var status = cfg.enabled !== false ? '启用' : '禁用';
    configsHtml += '<tr><td>' + cfg.name + '</td><td>' + protocolLabel + '</td><td style="color:' + (cfg.enabled !== false ? '#16a34a' : '#6b7280') + '">' + status + '</td><td><button class="test-btn btn btn-sm" data-id="' + cfg.id + '">测试</button><button class="toggle-btn btn btn-sm" data-id="' + cfg.id + '">' + (cfg.enabled !== false ? '禁用' : '启用') + '</button><form method="POST" action="/delete-notify" style="display:inline"><input type="hidden" name="config_id" value="' + cfg.id + '"><button type="submit" class="btn btn-danger btn-sm">删除</button></form></td></tr>';
  }
  if (!configsHtml) configsHtml = '<tr><td colspan="4" style="text-align:center;color:#6b7280;padding:1rem 0">暂无配置</td></tr>';
  var logsPlaceholder = '<div style="color:#9ca3af">加载日志中...</div>';
  var html = HTML_TEMPLATE.replace('{{ROOMS}}', roomsHtml).replace('{{CONFIGS}}', configsHtml).replace('{{LOGS}}', logsPlaceholder);
  if (message) {
    html = html.replace('<div id="messageArea"></div>', '<div id="messageArea"><div style="padding:0.75rem;border-radius:6px;margin-bottom:0.75rem;background:#f0fdf4;border:1px solid #bbf7d0;color:#166534">' + message + '</div></div>');
  }
  return html;
}

export default {
  async fetch(request, env) {
    var url = new URL(request.url);
    var path = url.pathname;
    var method = request.method;
    if (path === '/logs') {
      var logs = await getLogs();
      return new Response(JSON.stringify(logs), { headers: { 'Content-Type': 'application/json' } });
    }
    var needAuth = ['/clear-logs', '/send-live-notify', '/add-notify', '/delete-notify', '/toggle-notify', '/test-notify', '/admin', '/add-room', '/remove-room', '/check', '/monitor'];
    if (needAuth.includes(path) || path === '/') {
      if (!isAuthenticated(request, env)) {
        return new Response(renderLoginPage(), { headers: { 'Content-Type': 'text/html' }, status: 401 });
      }
    }
    if (path === '/clear-logs') {
      await clearLogs();
      return new Response(JSON.stringify({ success: true }));
    }
    if (path === '/send-live-notify') {
      var roomIds = await getRoomList(env);
      if (!roomIds.length) return new Response(JSON.stringify({ success: false, message: '房间列表为空' }), { status: 400 });
      var roomId = toRoomId(roomIds[0]);
      try {
        var testData = {
          room_id: roomId,
          uid: 0,
          title: '测试直播通知',
          online: 9999,
          live_status: 1,
          live_time: new Date().toISOString(),
          parent_area_name: '测试分区',
          area_name: '测试子分区'
        };
        var text = await buildNotification(roomId, testData, env, 'live_start');
        await sendNotification(text, env, { event: 'live_start', room_id: roomId, ...testData });
        await addLog('info', '手动发送模拟开播通知 ' + roomId);
        return new Response(JSON.stringify({ success: true, message: '已发送模拟开播通知' }));
      } catch(e) {
        return new Response(JSON.stringify({ success: false, message: e.message }), { status: 500 });
      }
    }
    if (path === '/add-notify' && method === 'POST') {
      var form = await request.formData();
      var name = form.get('name');
      var protocol = form.get('protocol') || 'telegram';
      var api_url = form.get('api_url');
      var chat_id = form.get('chat_id') || '';
      var enabled = form.get('enabled') === '1';
      var template = form.get('template') || '';
      if (!name || !api_url) return new Response('缺少必要字段', { status: 400 });
      var receiver_key = 'chat_id', message_key = 'text';
      if (protocol === 'onebot_private') { receiver_key = 'user_id'; message_key = 'message'; }
      else if (protocol === 'onebot_group') { receiver_key = 'group_id'; message_key = 'message'; }
      else if (protocol === 'discord' || protocol === 'custom_webhook') { receiver_key = ''; message_key = ''; }
      await addNotifyConfig(env, { name: name, protocol: protocol, api_url: api_url, chat_id: chat_id, receiver_key: receiver_key, message_key: message_key, enabled: enabled, template: template, extra_params: {} });
      await addLog('info', '添加通知配置 ' + name);
      return new Response(await renderAdminPage(env, '配置 "' + name + '" 已添加'), { headers: { 'Content-Type': 'text/html' } });
    }
    if (path === '/delete-notify' && method === 'POST') {
      var form = await request.formData();
      var id = form.get('config_id');
      if (!id) return new Response('缺少ID', { status: 400 });
      await deleteNotifyConfig(env, id);
      await addLog('info', '删除通知配置 ' + id);
      return new Response(await renderAdminPage(env, '配置已删除'), { headers: { 'Content-Type': 'text/html' } });
    }
    if (path === '/toggle-notify' && method === 'POST') {
      var form = await request.formData();
      var id = form.get('config_id');
      if (!id) return new Response('缺少ID', { status: 400 });
      await toggleNotifyConfig(env, id);
      await addLog('info', '切换通知配置状态 ' + id);
      return new Response(JSON.stringify({ success: true, message: '切换成功' }));
    }
    if (path === '/test-notify' && method === 'POST') {
      var form = await request.formData();
      var id = form.get('config_id');
      if (!id) return new Response('缺少ID', { status: 400 });
      var configs = await getNotifyConfigs(env);
      var config = null;
      for (var k = 0; k < configs.length; k++) {
        if (configs[k].id === id) { config = configs[k]; break; }
      }
      if (!config) return new Response('配置不存在', { status: 404 });
      var roomIds = await getRoomList(env);
      if (!roomIds.length) return new Response(JSON.stringify({ success: false, message: '房间列表为空' }), { status: 400 });
      try {
        var roomId = toRoomId(roomIds[0]);
        var current = await fetchLiveStatus(roomId);
        var isLive = CONFIG.IS_LIVE_STATUS.includes(Number(current.live_status));
        if (!isLive) return new Response(JSON.stringify({ success: false, message: '当前未开播，无法测试' }), { status: 400 });
        var text = await buildNotification(roomId, current, env, 'live_start');
        var result = await sendNotificationToConfig(config, text, { event: 'live_start', room_id: roomId, ...current });
        if (result.success) {
          await addLog('info', '测试通知成功 ' + config.name);
          return new Response(JSON.stringify({ success: true, message: '测试通知发送成功 (' + config.name + ')' }));
        } else {
          return new Response(JSON.stringify({ success: false, message: '发送失败: ' + result.error }), { status: 500 });
        }
      } catch(e) {
        return new Response(JSON.stringify({ success: false, message: e.message }), { status: 500 });
      }
    }
    if (path === '/add-room' && method === 'POST') {
      var form = await request.formData();
      var roomId = toRoomId(form.get('room_id') || '');
      if (!roomId) {
        return new Response('缺少房间号', { status: 400 });
      }
      await addRoom(env, roomId);
      await addLog('info', '添加房间 ' + roomId);
      try {
        var data = await fetchLiveStatus(roomId);
        var isLive = CONFIG.IS_LIVE_STATUS.includes(Number(data.live_status));
        await setMonitorState(env, roomId, {
          room_id: roomId,
          state: isLive ? 'LIVE' : 'OFFLINE',
          last_live_time: data.live_time || '',
          notified_live_time: data.live_time || '',
          last_title: data.title || '',
          last_cover: data.user_cover || '',
          last_area: data.area_name || '',
          last_parent_area: data.parent_area_name || '',
          last_online: data.online || 0,
          last_update: new Date().toISOString(),
          version: 2
        });
        await addLog('info', '初始化监控状态成功 ' + roomId + (isLive ? ' (直播中)' : ' (未开播)'));
      } catch(e) {
        await addLog('error', '初始化状态失败 ' + e.message);
      }
      return new Response(await renderAdminPage(env, '房间 ' + roomId + ' 已添加'), { headers: { 'Content-Type': 'text/html' } });
    }
    if (path === '/remove-room' && method === 'POST') {
      var form = await request.formData();
      var roomId = toRoomId(form.get('room_id') || '');
      if (!roomId) {
        return new Response('缺少房间号', { status: 400 });
      }
      await removeRoom(env, roomId);
      await addLog('info', '删除房间 ' + roomId);
      return new Response(await renderAdminPage(env, '房间 ' + roomId + ' 已删除'), { headers: { 'Content-Type': 'text/html' } });
    }
    if (path === '/monitor') {
      var force = url.searchParams.get('force') === '1';
      await addLog('info', force ? '手动强制刷新' : '自动检查');
      var result = await monitorAll(env, { force: force });
      return new Response(JSON.stringify(result, null, 2), { headers: { 'Content-Type': 'application/json' } });
    }
    if (path === '/check') {
      var roomId = url.searchParams.get('room_id');
      if (!roomId) return new Response(JSON.stringify({ error: '缺少 room_id' }), { status: 400 });
      try {
        var data = await fetchLiveStatus(roomId);
        return new Response(JSON.stringify(data, null, 2), { headers: { 'Content-Type': 'application/json' } });
      } catch(e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
      }
    }
    if (path === '/admin' || path === '/') {
      var html = await renderAdminPage(env);
      return new Response(html, { headers: { 'Content-Type': 'text/html' } });
    }
    if (path === '/login' && method === 'POST') {
      var form = await request.formData();
      var username = form.get('username');
      var password = form.get('password');
      if (username === env.ADMIN_USER && password === env.ADMIN_PASSWORD) {
        var auth = btoa(username + ':' + password);
        return new Response(null, { status: 302, headers: { 'Location': '/admin', 'Set-Cookie': 'auth=' + auth + '; HttpOnly; Path=/; Max-Age=86400' } });
      } else {
        return new Response(renderLoginPage('用户名或密码错误'), { headers: { 'Content-Type': 'text/html' }, status: 401 });
      }
    }
    if (path === '/logout') {
      return new Response(null, { status: 302, headers: { 'Location': '/login', 'Set-Cookie': 'auth=; HttpOnly; Path=/; Max-Age=0' } });
    }
    return new Response('Not Found', { status: 404 });
  },
  async scheduled(event, env) {
    await addLog('info', '定时任务触发');
    try {
      await monitorAll(env);
      await addLog('info', '定时任务完成');
    } catch(e) {
      await addLog('error', '定时任务异常: ' + e.message);
    }
  }
};
