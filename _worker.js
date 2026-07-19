var CONFIG = {
  MAIN_API: 'https://uapis.cn/api/v1/social/bilibili/liveroom',
  USER_API: 'https://uapis.cn/api/v1/social/bilibili/userinfo',
  IS_LIVE_STATUS: [1, 2],
  CACHE_TTL: 86400,
  USER_INFO_TTL: 86400,
  MAX_LOG_ENTRIES: 500,
  POPULARITY_MILESTONES: [1000, 5000, 10000, 50000, 100000],
  LIVE_CONFIRM_THRESHOLD: 2,
  OFFLINE_CONFIRM_THRESHOLD: 3,
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
    live_confirm: 0,
    offline_confirm: 0,
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

async function processRoom(roomId, env) {
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
  var state = prev.state || 'UNKNOWN';
  var live_confirm = prev.live_confirm || 0;
  var offline_confirm = prev.offline_confirm || 0;
  var notified_live_time = prev.notified_live_time || '';
  var events = [];

  if (state === 'UNKNOWN') {
    if (isLive) {
      state = 'STARTING';
      live_confirm = 1;
    } else {
      state = 'OFFLINE';
      offline_confirm = 1;
    }
  } else if (state === 'OFFLINE' || state === 'STOPPING') {
    if (isLive) {
      live_confirm++;
      if (live_confirm >= CONFIG.LIVE_CONFIRM_THRESHOLD) {
        state = 'LIVE';
        if (current.live_time !== notified_live_time) {
          events.push({ type: 'live_start', data: current });
          notified_live_time = current.live_time;
        }
        live_confirm = 0;
      } else {
        state = 'STARTING';
      }
      offline_confirm = 0;
    } else {
      live_confirm = 0;
      if (state === 'STOPPING') {
        offline_confirm++;
        if (offline_confirm >= CONFIG.OFFLINE_CONFIRM_THRESHOLD) {
          state = 'OFFLINE';
          events.push({ type: 'live_end', data: current });
          offline_confirm = 0;
        }
      } else {
        state = 'OFFLINE';
        offline_confirm = 0;
      }
    }
  } else if (state === 'STARTING') {
    if (isLive) {
      live_confirm++;
      if (live_confirm >= CONFIG.LIVE_CONFIRM_THRESHOLD) {
        state = 'LIVE';
        if (current.live_time !== notified_live_time) {
          events.push({ type: 'live_start', data: current });
          notified_live_time = current.live_time;
        }
        live_confirm = 0;
      }
      offline_confirm = 0;
    } else {
      live_confirm = 0;
      offline_confirm++;
      if (offline_confirm >= CONFIG.OFFLINE_CONFIRM_THRESHOLD) {
        state = 'OFFLINE';
        offline_confirm = 0;
      } else {
        state = 'STOPPING';
      }
    }
  } else if (state === 'LIVE') {
    if (isLive) {
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
      offline_confirm = 0;
      live_confirm = 0;
      state = 'LIVE';
    } else {
      offline_confirm++;
      if (offline_confirm >= CONFIG.OFFLINE_CONFIRM_THRESHOLD) {
        state = 'OFFLINE';
        events.push({ type: 'live_end', data: current });
        offline_confirm = 0;
        notified_live_time = '';
      } else {
        state = 'STOPPING';
      }
      live_confirm = 0;
    }
  }

  var newState = {
    room_id: roomId,
    state: state,
    live_confirm: live_confirm,
    offline_confirm: offline_confirm,
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

async function monitorAll(env) {
  var roomIds = await getRoomList(env);
  if (roomIds.length === 0) {
    await addLog('warn', '房间列表为空，跳过检查');
    return { error: '房间列表为空' };
  }
  await addLog('info', '开始批量检查 ' + roomIds.length + ' 个房间');
  var results = [];
  for (var i = 0; i < roomIds.length; i++) {
    var roomId = toRoomId(roomIds[i]);
    try {
      var res = await processRoom(roomId, env);
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

// ---------- HTML 模板（已优化移动端） ----------
var HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>直播监控管理</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui;background:#f3f4f6;padding:1rem;color:#1f2937;-webkit-tap-highlight-color:transparent}
.container{max-width:1400px;margin:0 auto}
.header{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:0.5rem;margin-bottom:1rem}
.header h1{font-size:1.5rem;font-weight:600}
.btn{display:inline-flex;align-items:center;justify-content:center;padding:12px 20px;min-height:48px;border:none;border-radius:10px;font-size:16px;font-weight:600;cursor:pointer;transition:all .2s;touch-action:manipulation;-webkit-tap-highlight-color:transparent;user-select:none;gap:6px;flex-shrink:0}
.btn:active{transform:scale(0.96)}
.btn-primary{background:#2563eb;color:#fff}
.btn-primary:hover{background:#1d4ed8}
.btn-success{background:#16a34a;color:#fff}
.btn-success:hover{background:#15803d}
.btn-warning{background:#d97706;color:#fff}
.btn-warning:hover{background:#b45309}
.btn-danger{background:#dc2626;color:#fff}
.btn-danger:hover{background:#b91c1c}
.btn-add{background:#16a34a;color:#fff}
.btn-add:hover{background:#15803d}
.btn-check{background:#2563eb;color:#fff}
.btn-check:hover{background:#1d4ed8}
.btn-test{background:#9333ea;color:#fff}
.btn-test:hover{background:#7e22ce}
.btn-refresh{background:#0891b2;color:#fff}
.btn-refresh:hover{background:#0e7490}
.btn-sm{padding:8px 14px;min-height:36px;font-size:14px}
.tab-bar{display:flex;gap:0.5rem;margin-bottom:1rem;flex-wrap:wrap}
.tab-btn{padding:0.5rem 1rem;border:none;border-radius:6px;cursor:pointer;background:#e5e7eb;color:#1f2937;font-size:0.9rem;touch-action:manipulation}
.tab-active{background:#2563eb;color:#fff}
.panel{background:#fff;border-radius:12px;border:1px solid #e5e7eb;padding:1rem;margin-bottom:1.5rem;box-shadow:0 1px 3px rgba(0,0,0,0.05);overflow:hidden}
.panel h3{font-size:1.2rem;font-weight:600;margin-bottom:0.75rem}
.flex-row{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:15px}
.card-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:15px}
.room-card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:0.75rem;display:flex;gap:0.75rem;align-items:flex-start;transition:0.2s;box-shadow:0 1px 3px rgba(0,0,0,0.05);word-break:break-word}
.room-card:hover{transform:translateY(-2px);box-shadow:0 4px 12px rgba(0,0,0,0.1)}
.status-dot{width:12px;height:12px;border-radius:50%;flex-shrink:0;margin-top:3px}
.room-info{flex:1;min-width:0}
.room-id{font-weight:600;font-size:0.8rem}
.room-title{font-size:0.95rem;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.room-meta{font-size:0.75rem;color:#6b7280;margin-top:2px}
.room-actions{display:flex;gap:0.3rem;flex-wrap:wrap}
table{width:100%;border-collapse:collapse;font-size:0.85rem;overflow-x:auto;display:block}
thead, tbody{display:table;width:100%}
th{text-align:left;padding:0.4rem 0.6rem;border-bottom:2px solid #e5e7eb}
td{padding:0.4rem 0.6rem;border-bottom:1px solid #e5e7eb}
.log-container{max-height:400px;overflow-y:auto;font-family:monospace;font-size:0.7rem;background:#f9fafb;padding:0.5rem;border-radius:6px;border:1px solid #e5e7eb;-webkit-overflow-scrolling:touch}
.log-entry{border-bottom:1px solid #e5e7eb;padding:0.1rem 0}
.log-time{color:#6b7280;margin-right:0.5rem}
.log-info{color:#2563eb}
.log-warn{color:#d97706}
.log-error{color:#dc2626}
.modal-overlay{display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:999;justify-content:center;align-items:center;padding:1rem}
.modal-overlay.active{display:flex}
.modal-box{background:#fff;padding:1.5rem;border-radius:12px;max-width:500px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.3);overflow:hidden}
.modal-actions{margin-top:1rem;display:flex;gap:0.5rem;justify-content:flex-end}
.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:0.5rem}
.form-grid .full{grid-column:span 2}
label{display:block;font-size:0.75rem;font-weight:500;margin-bottom:0.1rem}
input,select,textarea{width:100%;padding:0.5rem;border:1px solid #d1d5db;border-radius:6px;font-size:0.9rem;background:#fff;color:#1f2937}
input:focus,select:focus,textarea:focus{outline:2px solid #2563eb;outline-offset:1px}
@media(max-width:640px){
  .header h1{font-size:1.3rem}
  .btn{padding:12px 16px;min-height:48px;font-size:15px;width:100%;justify-content:center}
  .btn-sm{padding:10px 12px;min-height:40px;font-size:14px}
  .flex-row{gap:8px}
  .flex-row .btn{width:100%}
  .card-grid{grid-template-columns:1fr}
  .form-grid{grid-template-columns:1fr}
  .form-grid .full{grid-column:span 1}
  .modal-box{padding:1rem}
  .tab-bar{gap:0.3rem}
  .tab-btn{flex:1;text-align:center;padding:0.4rem 0.5rem;font-size:0.8rem}
  .room-card{flex-wrap:wrap}
  .room-actions{width:100%;justify-content:flex-end}
  table{display:block;overflow-x:auto;white-space:nowrap}
}
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>直播监控管理</h1>
    <div style="display:flex;gap:0.5rem;flex-wrap:wrap">
      <button id="themeToggle" class="btn" onclick="toggleTheme()">深色</button>
      <button class="btn" onclick="document.getElementById('logoutForm').submit();">退出</button>
      <form id="logoutForm" method="POST" action="/logout" style="display:none"></form>
    </div>
  </div>

  <div id="messageArea"></div>

  <div class="tab-bar">
    <button class="tab-btn tab-active" data-tab="rooms" onclick="switchTab('rooms')">房间</button>
    <button class="tab-btn" data-tab="notifies" onclick="switchTab('notifies')">通知</button>
    <button class="tab-btn" data-tab="logs" onclick="switchTab('logs')">日志</button>
  </div>

  <div id="panelRooms" class="panel">
    <div class="flex-row">
      <button class="btn btn-add" onclick="showAddRoomModal()">添加房间</button>
      <button class="btn btn-check" onclick="checkAll()">检查全部</button>
      <button class="btn btn-refresh" onclick="refreshRooms()">刷新状态</button>
      <button class="btn btn-warning" onclick="sendLiveNotify()">模拟开播</button>
      <div style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap;width:100%">
        <input id="singleCheckInput" placeholder="房间号" style="flex:1;min-width:120px">
        <button class="btn btn-test" onclick="singleCheck()">单查</button>
      </div>
      <button class="btn" onclick="exportLogs()">导出日志</button>
    </div>
    <div id="roomContainer" class="card-grid">{{ROOMS}}</div>
  </div>

  <div id="panelNotifies" style="display:none" class="panel">
    <div style="margin-bottom:1rem">
      <h3>添加通知配置</h3>
      <form method="POST" action="/add-notify" id="addNotifyForm" class="form-grid">
        <div><label>名称</label><input type="text" name="name" placeholder="主Telegram" required></div>
        <div><label>协议</label>
          <select name="protocol" id="protocolSelect" onchange="updateProtocol()">
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
        <button class="btn btn-danger btn-sm" onclick="clearLogsAction()">清除</button>
        <button class="btn btn-sm" onclick="fetchLogs()">刷新</button>
        <label style="font-size:0.75rem;display:flex;align-items:center"><input type="checkbox" id="autoRefresh" checked> 自动刷新</label>
        <input id="logSearch" placeholder="搜索..." style="flex:1;min-width:80px">
        <select id="logLevelFilter"><option value="">全部</option><option value="info">Info</option><option value="warn">Warn</option><option value="error">Error</option></select>
      </div>
    </div>
    <div id="logContainer" class="log-container">{{LOGS}}</div>
  </div>
</div>

<!-- 通用模态框 -->
<div id="customModal" class="modal-overlay">
  <div class="modal-box">
    <h3 id="modalTitle">提示</h3>
    <p id="modalMessage"></p>
    <div class="modal-actions">
      <button id="modalConfirmBtn" class="btn btn-primary" onclick="closeModal(true)">确定</button>
      <button id="modalCancelBtn" class="btn" onclick="closeModal(false)">取消</button>
    </div>
  </div>
</div>

<!-- 添加房间模态框 -->
<div id="addRoomModal" class="modal-overlay">
  <div class="modal-box">
    <h3>添加房间</h3>
    <p>请输入直播间房间号：</p>
    <input type="text" id="roomInput" placeholder="例如：1768500100" style="width:100%;margin:0.5rem 0;padding:0.5rem;border:1px solid #d1d5db;border-radius:6px;font-size:1rem">
    <div class="modal-actions">
      <button class="btn btn-primary" onclick="addRoomConfirm()">完成</button>
      <button class="btn" onclick="closeAddRoomModal()">取消</button>
    </div>
  </div>
</div>

<script>
// ---------- 全局变量 ----------
var modalResolve = null;

// ---------- 主题切换 ----------
function toggleTheme() {
  var html = document.documentElement;
  var theme = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  html.setAttribute('data-theme', theme);
  document.getElementById('themeToggle').textContent = theme === 'dark' ? '亮色' : '深色';
}
if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
  document.documentElement.setAttribute('data-theme', 'dark');
  document.getElementById('themeToggle').textContent = '亮色';
}

// ---------- 选项卡切换 ----------
function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('tab-active'); });
  document.querySelector('.tab-btn[data-tab="'+tab+'"]').classList.add('tab-active');
  document.getElementById('panelRooms').style.display = tab === 'rooms' ? 'block' : 'none';
  document.getElementById('panelNotifies').style.display = tab === 'notifies' ? 'block' : 'none';
  document.getElementById('panelLogs').style.display = tab === 'logs' ? 'block' : 'none';
}

// ---------- 模态框 ----------
function showModal(title, message, confirmText, cancelText) {
  return new Promise(function(resolve) {
    var overlay = document.getElementById('customModal');
    document.getElementById('modalTitle').textContent = title || '提示';
    document.getElementById('modalMessage').textContent = message || '';
    document.getElementById('modalConfirmBtn').textContent = confirmText || '确定';
    document.getElementById('modalCancelBtn').textContent = cancelText || '取消';
    overlay.classList.add('active');
    modalResolve = resolve;
  });
}
function closeModal(result) {
  var overlay = document.getElementById('customModal');
  overlay.classList.remove('active');
  if (modalResolve) { modalResolve(result); modalResolve = null; }
}

// ---------- 消息提示 ----------
function showMessage(msg, type) {
  type = type || 'info';
  var area = document.getElementById('messageArea');
  var colors = { info: '#f0fdf4', error: '#fef2f2', warn: '#fffbeb' };
  var borders = { info: '#bbf7d0', error: '#fecaca', warn: '#fde68a' };
  var textColors = { info: '#166534', error: '#991b1b', warn: '#92400e' };
  area.innerHTML = '<div style="padding:0.75rem;border-radius:6px;margin-bottom:0.75rem;background:' + colors[type] + ';border:1px solid ' + borders[type] + ';color:' + textColors[type] + '">' + msg + '</div>';
}

// ---------- 日志 ----------
function renderLogs(logs) {
  var container = document.getElementById('logContainer');
  var search = document.getElementById('logSearch').value.toLowerCase();
  var level = document.getElementById('logLevelFilter').value;
  var filtered = logs;
  if (search) filtered = filtered.filter(function(e) { return e.message.toLowerCase().includes(search); });
  if (level) filtered = filtered.filter(function(e) { return e.level === level; });
  if (!filtered.length) { container.innerHTML = '<div style="color:#6b7280;font-size:0.7rem">暂无日志</div>'; return; }
  var html = '';
  filtered.forEach(function(entry) {
    var cls = 'log-' + entry.level;
    html += '<div class="log-entry"><span class="log-time">' + entry.time + '</span><span class="' + cls + '">[' + entry.level.toUpperCase() + ']</span> ' + entry.message + '</div>';
  });
  container.innerHTML = html;
}

async function fetchLogs() {
  try {
    var res = await fetch('/logs');
    var data = await res.json();
    renderLogs(data);
  } catch(e) { console.error('获取日志失败', e); }
}

async function exportLogs() {
  var res = await fetch('/logs');
  var data = await res.json();
  var blob = new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'});
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = 'logs.json'; a.click();
  URL.revokeObjectURL(url);
}

async function clearLogsAction() {
  if (await showModal('确认', '确定清除所有日志吗？')) {
    await fetch('/clear-logs', { method: 'POST' });
    showMessage('日志已清除', 'info');
    fetchLogs();
  }
}

// ---------- 房间操作 ----------
function showAddRoomModal() {
  document.getElementById('addRoomModal').classList.add('active');
  document.getElementById('roomInput').value = '';
  setTimeout(function() { document.getElementById('roomInput').focus(); }, 100);
}
function closeAddRoomModal() {
  document.getElementById('addRoomModal').classList.remove('active');
}
async function addRoomConfirm() {
  var roomId = document.getElementById('roomInput').value.trim();
  if (!roomId) { showMessage('请输入房间号', 'error'); return; }
  var btn = document.querySelector('#addRoomModal .btn-primary');
  btn.disabled = true;
  btn.textContent = '提交中...';
  try {
    var formData = new URLSearchParams();
    formData.append('room_id', roomId);
    var res = await fetch('/add-room', { method: 'POST', headers: {'Content-Type':'application/x-www-form-urlencoded'}, body: formData });
    if (res.ok) {
      closeAddRoomModal();
      showMessage('房间 ' + roomId + ' 已添加', 'info');
      setTimeout(function() { location.reload(); }, 1500);
    } else {
      var err = await res.text();
      showMessage('添加失败: ' + err, 'error');
    }
  } catch(e) { showMessage('添加失败: ' + e.message, 'error'); }
  btn.disabled = false;
  btn.textContent = '完成';
}

async function checkAll() {
  var btn = document.querySelector('.btn-check');
  btn.disabled = true;
  btn.textContent = '检查中...';
  try {
    await fetch('/monitor');
    location.reload();
  } catch(e) { location.reload(); }
}

async function refreshRooms() {
  var btn = document.querySelector('.btn-refresh');
  btn.disabled = true;
  btn.textContent = '刷新中...';
  try {
    await fetch('/monitor');
    location.reload();
  } catch(e) { location.reload(); }
}

async function sendLiveNotify() {
  var btn = document.querySelector('.btn-warning');
  btn.disabled = true;
  btn.textContent = '发送中...';
  try {
    var res = await fetch('/send-live-notify', { method: 'POST' });
    var data = await res.json();
    showMessage(data.message, data.success ? 'info' : 'error');
  } catch(e) { showMessage('操作失败: ' + e.message, 'error'); }
  btn.disabled = false;
  btn.textContent = '模拟开播';
}

async function singleCheck() {
  var roomId = document.getElementById('singleCheckInput').value.trim();
  if (!roomId) { showMessage('请输入房间号', 'error'); return; }
  var btn = document.querySelector('.btn-test');
  btn.disabled = true;
  btn.textContent = '查询中...';
  try {
    var res = await fetch('/check?room_id=' + encodeURIComponent(roomId));
    var data = await res.json();
    showMessage(JSON.stringify(data, null, 2), 'info');
  } catch(e) { showMessage('查询失败: ' + e.message, 'error'); }
  btn.disabled = false;
  btn.textContent = '单查';
}

// ---------- 通知配置 ----------
function updateProtocol() {
  var val = document.getElementById('protocolSelect').value;
  var apiUrl = document.getElementById('apiUrl');
  var receiverLabel = document.getElementById('receiverLabel');
  var chatId = document.getElementById('chatId');
  var templateArea = document.getElementById('templateArea');
  if (val === 'telegram') {
    apiUrl.placeholder = 'https://api.telegram.org/bot<token>/sendMessage';
    receiverLabel.textContent = '接收者 ID (chat_id)';
    chatId.placeholder = '例如：123456789';
    templateArea.value = '[开播] {{主播}} 开播了\n标题：{{标题}}\n人气：{{人气}}\n房间号：{{房间号}}\n分区：{{分区}}';
  } else if (val === 'onebot_private') {
    apiUrl.placeholder = 'http://127.0.0.1:5700/send_private_msg';
    receiverLabel.textContent = '用户 ID (user_id)';
    chatId.placeholder = '例如：123456789';
    templateArea.value = '[开播] {{主播}} 开播了\n标题：{{标题}}\n人气：{{人气}}\n房间号：{{房间号}}\n分区：{{分区}}';
  } else if (val === 'onebot_group') {
    apiUrl.placeholder = 'http://127.0.0.1:5700/send_group_msg';
    receiverLabel.textContent = '群 ID (group_id)';
    chatId.placeholder = '例如：123456789';
    templateArea.value = '[开播] {{主播}} 开播了\n标题：{{标题}}\n人气：{{人气}}\n房间号：{{房间号}}\n分区：{{分区}}';
  } else if (val === 'discord') {
    apiUrl.placeholder = 'https://discord.com/api/webhooks/...';
    receiverLabel.textContent = '无 (使用 Webhook URL)';
    chatId.placeholder = '可不填';
    templateArea.value = '**[开播] {{主播}}**\n标题：{{标题}}\n人气：{{人气}}\n房间号：{{房间号}}\n分区：{{分区}}';
  } else if (val === 'custom_webhook') {
    apiUrl.placeholder = 'https://your-server.com/webhook';
    receiverLabel.textContent = '无 (使用 Webhook URL)';
    chatId.placeholder = '可不填';
    templateArea.value = '{"event":"live_start","anchor":"{{主播}}","title":"{{标题}}","online":{{人气}},"room_id":"{{房间号}}"}';
  }
}

// ---------- 事件监听（测试/切换） ----------
document.addEventListener('click', async function(e) {
  var target = e.target;
  if (target.classList.contains('test-btn')) {
    var id = target.dataset.id;
    var btn = target; btn.disabled = true; btn.textContent = '测试中...';
    try {
      var res = await fetch('/test-notify', { method: 'POST', headers: {'Content-Type':'application/x-www-form-urlencoded'}, body: 'config_id=' + id });
      var data = await res.json();
      showMessage(data.message, data.success ? 'info' : 'error');
    } catch(e) { showMessage('测试失败: ' + e.message, 'error'); }
    btn.disabled = false; btn.textContent = '测试';
  }
  if (target.classList.contains('toggle-btn')) {
    var id = target.dataset.id;
    var btn = target; btn.disabled = true; btn.textContent = '切换中...';
    try {
      var res = await fetch('/toggle-notify', { method: 'POST', headers: {'Content-Type':'application/x-www-form-urlencoded'}, body: 'config_id=' + id });
      var data = await res.json();
      showMessage(data.message, 'info');
      setTimeout(function() { location.reload(); }, 500);
    } catch(e) { showMessage('切换失败: ' + e.message, 'error'); }
    btn.disabled = false; btn.textContent = '切换';
  }
});

// ---------- 日志自动刷新 ----------
var logTimer = null;
document.getElementById('autoRefresh').addEventListener('change', function() {
  if (this.checked) { logTimer = setInterval(fetchLogs, 5000); fetchLogs(); }
  else { clearInterval(logTimer); logTimer = null; }
});
document.getElementById('logSearch').addEventListener('input', fetchLogs);
document.getElementById('logLevelFilter').addEventListener('change', fetchLogs);

// ---------- 初始化 ----------
document.addEventListener('DOMContentLoaded', function() {
  document.getElementById('autoRefresh').checked = true;
  logTimer = setInterval(fetchLogs, 5000);
  fetchLogs();
  // 添加房间模态框回车提交
  document.getElementById('roomInput').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { addRoomConfirm(); }
  });
  // 关闭模态框点击背景
  document.getElementById('addRoomModal').addEventListener('click', function(e) {
    if (e.target === this) { closeAddRoomModal(); }
  });
  document.getElementById('customModal').addEventListener('click', function(e) {
    if (e.target === this) { closeModal(false); }
  });
});
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
    var isStarting = state.state === 'STARTING';
    var statusColor = isLive ? '#22c55e' : (isStarting ? '#eab308' : '#9ca3af');
    var statusText = isStarting ? '检测直播中' : (isLive ? '直播中' : '未开播');
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
  var logsPlaceholder = '<div style="color:#6b7280;font-size:0.7rem">加载日志中...</div>';
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
          live_confirm: 0,
          offline_confirm: 0,
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
      await addLog('info', '手动触发检查');
      var result = await monitorAll(env);
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
