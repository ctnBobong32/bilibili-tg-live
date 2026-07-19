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

async function getRoomList(env) {
  var val = await env.ROOM_STORE.get('rooms', 'json');
  return val || [];
}

async function setRoomList(env, rooms) {
  await env.ROOM_STORE.put('rooms', JSON.stringify(rooms));
}

async function addRoom(env, roomId) {
  var rooms = await getRoomList(env);
  if (!rooms.includes(roomId)) {
    rooms.push(roomId);
    await setRoomList(env, rooms);
  }
  return rooms;
}

async function removeRoom(env, roomId) {
  var rooms = await getRoomList(env);
  rooms = rooms.filter(function(id) { return id !== roomId; });
  await setRoomList(env, rooms);
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
  var current;
  try {
    current = await fetchLiveStatus(roomId);
  } catch (e) {
    await addLog('error', '[' + roomId + '] 获取状态失败: ' + e.message);
    return { error: e.message };
  }
  var isLive = CONFIG.IS_LIVE_STATUS.indexOf(current.live_status) !== -1;
  var prev = await getMonitorState(env, roomId);
  var state = prev.state || 'UNKNOWN';
  var live_confirm = prev.live_confirm || 0;
  var offline_confirm = prev.offline_confirm || 0;
  var notified_live_time = prev.notified_live_time || '';
  var events = [];
  if (state === 'UNKNOWN') {
    if (isLive) { live_confirm = 1; state = 'STARTING'; }
    else { offline_confirm = 1; state = 'OFFLINE'; }
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
      if (prev.last_parent_area !== current.parent_area_name || prev.last_area !== current.area_name) {
        events.push({ type: 'area_change', data: current, old_parent_area: prev.last_parent_area, old_area: prev.last_area });
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
    var roomId = roomIds[i];
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

var HTML_TEMPLATE = '<!DOCTYPE html>\n<html lang="zh" data-theme="light">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n<title>直播监控管理 v2</title>\n<style>\n*{box-sizing:border-box;margin:0;padding:0}\n:root{--bg:#f3f4f6;--card:#fff;--text:#1f2937;--border:#e5e7eb;--shadow:0 1px 3px rgba(0,0,0,0.1);--btn-bg:#2563eb;--btn-text:#fff;--hover:#1d4ed8}\n[data-theme="dark"]{--bg:#111827;--card:#1f2937;--text:#f3f4f6;--border:#374151;--shadow:0 1px 3px rgba(0,0,0,0.5);--btn-bg:#3b82f6;--hover:#60a5fa}\nbody{font-family:system-ui;background:var(--bg);color:var(--text);padding:1rem;transition:background 0.3s}\n.container{max-width:1400px;margin:0 auto}\n.header{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:1rem;margin-bottom:1.5rem}\n.header h1{font-size:1.8rem;font-weight:700}\n.header-controls{display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap}\n.btn{padding:0.4rem 0.8rem;border:none;border-radius:6px;font-size:0.85rem;cursor:pointer;transition:0.2s;background:var(--border);color:var(--text)}\n.btn-primary{background:var(--btn-bg);color:var(--btn-text)}\n.btn-primary:hover{background:var(--hover)}\n.btn-success{background:#16a34a;color:#fff}\n.btn-success:hover{background:#15803d}\n.btn-warning{background:#ca8a04;color:#fff}\n.btn-warning:hover{background:#a16207}\n.btn-danger{background:#dc2626;color:#fff}\n.btn-danger:hover{background:#b91c1c}\n.btn-sm{padding:0.2rem 0.5rem;font-size:0.75rem}\n.tab-bar{display:flex;gap:0.5rem;margin-bottom:1rem}\n.tab-btn{padding:0.4rem 1rem;border:none;border-radius:6px;cursor:pointer;font-size:0.9rem;transition:0.2s;background:var(--border);color:var(--text)}\n.tab-active{background:var(--btn-bg);color:var(--btn-text)}\n.panel{background:var(--card);border-radius:12px;border:1px solid var(--border);padding:1rem;margin-bottom:1.5rem;box-shadow:var(--shadow)}\n.panel h3{font-size:1.1rem;font-weight:600;margin-bottom:0.75rem}\n.card-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:0.75rem}\n.room-card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:0.75rem;display:flex;gap:0.75rem;align-items:flex-start;transition:0.2s;box-shadow:var(--shadow)}\n.room-card:hover{transform:translateY(-2px);box-shadow:0 4px 12px rgba(0,0,0,0.15)}\n.status-dot{width:12px;height:12px;border-radius:50%;flex-shrink:0;margin-top:3px}\n.room-info{flex:1;min-width:0}\n.room-id{font-weight:600;font-size:0.8rem}\n.room-title{font-size:0.95rem;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n.room-meta{font-size:0.75rem;color:var(--text);opacity:0.7;margin-top:2px}\n.room-actions{display:flex;gap:0.3rem;flex-wrap:wrap}\ntable{width:100%;border-collapse:collapse;font-size:0.85rem}\nth{text-align:left;padding:0.4rem 0.6rem;border-bottom:2px solid var(--border)}\ntd{padding:0.4rem 0.6rem;border-bottom:1px solid var(--border)}\n.log-container{max-height:400px;overflow-y:auto;font-family:monospace;font-size:0.75rem;background:var(--card);color:var(--text);padding:0.5rem;border-radius:6px;border:1px solid var(--border)}\n.log-entry{border-bottom:1px solid var(--border);padding:0.15rem 0}\n.log-time{color:var(--text);opacity:0.6;margin-right:0.5rem}\n.log-info{color:#60a5fa}\n.log-warn{color:#fbbf24}\n.log-error{color:#f87171}\n.modal-overlay{display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:999;justify-content:center;align-items:center}\n.modal-overlay.active{display:flex}\n.modal-box{background:var(--card);padding:1.5rem;border-radius:12px;max-width:500px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.3)}\n.modal-actions{margin-top:1rem;display:flex;gap:0.5rem;justify-content:flex-end}\n.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:0.75rem}\n.form-grid .full{grid-column:span 2}\nlabel{display:block;font-size:0.8rem;font-weight:500;margin-bottom:0.15rem}\ninput,select{width:100%;padding:0.3rem;border:1px solid var(--border);border-radius:4px;background:var(--card);color:var(--text);font-size:0.85rem}\n.flex-row{display:flex;flex-wrap:wrap;gap:0.3rem;align-items:center}\n@media(max-width:640px){.form-grid{grid-template-columns:1fr}.form-grid .full{grid-column:span 1}.header{flex-direction:column;align-items:stretch}.card-grid{grid-template-columns:1fr}}\n</style>\n</head>\n<body>\n<div class="container">\n  <div class="header">\n    <div><h1>🎥 直播监控 v2</h1><small>状态机 + KV 持久化</small></div>\n    <div class="header-controls">\n      <button id="themeToggle" class="btn">🌙 深色</button>\n      <form method="POST" action="/logout"><button class="btn">退出</button></form>\n    </div>\n  </div>\n\n  <div id="messageArea"></div>\n\n  <div class="tab-bar">\n    <button class="tab-btn tab-active" data-tab="rooms">📋 房间</button>\n    <button class="tab-btn" data-tab="notifies">🔔 通知</button>\n    <button class="tab-btn" data-tab="logs">📊 日志</button>\n  </div>\n\n  <div id="panelRooms" class="panel">\n    <div class="flex-row" style="margin-bottom:0.5rem">\n      <button id="addRoomBtn" class="btn btn-primary">添加房间</button>\n      <button id="checkAllBtn" class="btn btn-success">检查全部</button>\n      <button id="sendLiveBtn" class="btn btn-warning">模拟开播</button>\n      <div style="display:flex;gap:0.2rem;align-items:center">\n        <input id="singleCheckInput" placeholder="房间号" style="width:7rem">\n        <button id="singleCheckBtn" class="btn">单查</button>\n      </div>\n      <button id="exportLogsBtn" class="btn">导出日志</button>\n    </div>\n    <div id="roomContainer" class="card-grid">{{ROOMS}}</div>\n  </div>\n\n  <div id="panelNotifies" style="display:none" class="panel">\n    <div class="panel">\n      <h3>添加通知配置</h3>\n      <form method="POST" action="/add-notify" id="addNotifyForm" class="form-grid">\n        <div><label>名称</label><input type="text" name="name" placeholder="主Telegram" required></div>\n        <div><label>协议</label>\n          <select name="protocol" id="protocolSelect">\n            <option value="telegram">Telegram</option>\n            <option value="onebot_private">OneBot 私聊</option>\n            <option value="onebot_group">OneBot 群聊</option>\n            <option value="discord">Discord Webhook</option>\n            <option value="custom_webhook">自定义 Webhook</option>\n          </select>\n        </div>\n        <div class="full"><label>API 地址</label><input type="url" name="api_url" id="apiUrl" placeholder="https://api.telegram.org/bot<token>/sendMessage"></div>\n        <div><label id="receiverLabel">接收者 ID</label><input type="text" name="chat_id" id="chatId" placeholder="例如：123456789"></div>\n        <div class="full"><label><input type="checkbox" name="enabled" checked value="1"> 启用</label></div>\n        <div class="full"><label>通知模板 (可选)</label><textarea name="template" placeholder="支持 {{主播}} {{标题}} {{人气}} 等变量" rows="2"></textarea></div>\n        <div class="full"><button type="submit" class="btn btn-primary">添加配置</button></div>\n      </form>\n    </div>\n    <div class="panel">\n      <h3>现有配置</h3>\n      <table><thead><tr><th>名称</th><th>协议</th><th>状态</th><th>操作</th></tr></thead><tbody id="configTableBody">{{CONFIGS}}</tbody></table>\n    </div>\n  </div>\n\n  <div id="panelLogs" style="display:none" class="panel">\n    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:0.5rem;margin-bottom:0.5rem">\n      <h3>日志</h3>\n      <div style="display:flex;gap:0.3rem;flex-wrap:wrap">\n        <button id="clearLogsBtn" class="btn btn-danger btn-sm">清除</button>\n        <button id="refreshLogsBtn" class="btn btn-sm">刷新</button>\n        <label style="font-size:0.8rem"><input type="checkbox" id="autoRefresh" checked> 自动刷新</label>\n        <input id="logSearch" placeholder="搜索..." style="width:8rem">\n        <select id="logLevelFilter"><option value="">全部</option><option value="info">Info</option><option value="warn">Warn</option><option value="error">Error</option></select>\n      </div>\n    </div>\n    <div id="logContainer" class="log-container">{{LOGS}}</div>\n  </div>\n</div>\n\n<div id="customModal" class="modal-overlay">\n  <div class="modal-box">\n    <h3 id="modalTitle">提示</h3>\n    <p id="modalMessage"></p>\n    <div class="modal-actions">\n      <button id="modalConfirmBtn" class="btn btn-primary">确定</button>\n      <button id="modalCancelBtn" class="btn">取消</button>\n    </div>\n  </div>\n</div>\n\n<div id="addRoomModal" class="modal-overlay">\n  <div class="modal-box">\n    <h3>添加房间</h3>\n    <p>请输入直播间房间号：</p>\n    <input type="text" id="roomInput" placeholder="例如：1768500100" style="width:100%;margin:0.5rem 0;">\n    <div class="modal-actions">\n      <button id="addRoomConfirmBtn" class="btn btn-primary">完成</button>\n      <button id="addRoomCancelBtn" class="btn">取消</button>\n    </div>\n  </div>\n</div>\n\n<script>\ndocument.getElementById('themeToggle').addEventListener('click', function() {\n  var html = document.documentElement;\n  var theme = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';\n  html.setAttribute('data-theme', theme);\n  this.textContent = theme === 'dark' ? '☀️ 亮色' : '🌙 深色';\n});\n\ndocument.querySelectorAll('.tab-btn').forEach(function(btn) {\n  btn.addEventListener('click', function() {\n    document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('tab-active'); });\n    this.classList.add('tab-active');\n    var tab = this.dataset.tab;\n    document.getElementById('panelRooms').style.display = tab === 'rooms' ? 'block' : 'none';\n    document.getElementById('panelNotifies').style.display = tab === 'notifies' ? 'block' : 'none';\n    document.getElementById('panelLogs').style.display = tab === 'logs' ? 'block' : 'none';\n  });\n});\n\nfunction showModal(title, message, confirmText, cancelText) {\n  return new Promise(function(resolve) {\n    var overlay = document.getElementById('customModal');\n    document.getElementById('modalTitle').textContent = title || '提示';\n    document.getElementById('modalMessage').textContent = message || '';\n    document.getElementById('modalConfirmBtn').textContent = confirmText || '确定';\n    document.getElementById('modalCancelBtn').textContent = cancelText || '取消';\n    overlay.classList.add('active');\n    document.getElementById('modalConfirmBtn').onclick = function() { overlay.classList.remove('active'); resolve(true); };\n    document.getElementById('modalCancelBtn').onclick = function() { overlay.classList.remove('active'); resolve(false); };\n    overlay.onclick = function(e) { if (e.target === overlay) { overlay.classList.remove('active'); resolve(false); } };\n  });\n}\n\nfunction showMessage(msg, type) {\n  type = type || 'info';\n  var area = document.getElementById('messageArea');\n  var colors = { info: '#f0fdf4', error: '#fef2f2', warn: '#fffbeb' };\n  var borders = { info: '#bbf7d0', error: '#fecaca', warn: '#fde68a' };\n  var textColors = { info: '#166534', error: '#991b1b', warn: '#92400e' };\n  area.innerHTML = '<div style="padding:0.5rem;border-radius:6px;margin-bottom:0.5rem;background:' + colors[type] + ';border:1px solid ' + borders[type] + ';color:' + textColors[type] + '">' + msg + '</div>';\n}\n\nfunction renderLogs(logs) {\n  var container = document.getElementById('logContainer');\n  var search = document.getElementById('logSearch').value.toLowerCase();\n  var level = document.getElementById('logLevelFilter').value;\n  var filtered = logs;\n  if (search) filtered = filtered.filter(function(e) { return e.message.toLowerCase().includes(search); });\n  if (level) filtered = filtered.filter(function(e) { return e.level === level; });\n  if (!filtered.length) { container.innerHTML = '<div style="color:var(--text);opacity:0.6">暂无日志</div>'; return; }\n  var html = '';\n  filtered.forEach(function(entry) {\n    var cls = 'log-' + entry.level;\n    html += '<div class="log-entry"><span class="log-time">' + entry.time + '</span><span class=\"' + cls + '\">[' + entry.level.toUpperCase() + ']</span> ' + entry.message + '</div>';\n  });\n  container.innerHTML = html;\n}\n\nasync function fetchLogs() {\n  try {\n    var res = await fetch('/logs');\n    var data = await res.json();\n    renderLogs(data);\n  } catch(e) { console.error('获取日志失败', e); }\n}\n\ndocument.getElementById('exportLogsBtn').addEventListener('click', async function() {\n  var res = await fetch('/logs');\n  var data = await res.json();\n  var blob = new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'});\n  var url = URL.createObjectURL(blob);\n  var a = document.createElement('a');\n  a.href = url; a.download = 'logs.json'; a.click();\n  URL.revokeObjectURL(url);\n});\n\nvar logTimer = null;\ndocument.getElementById('autoRefresh').addEventListener('change', function() {\n  if (this.checked) { logTimer = setInterval(fetchLogs, 5000); fetchLogs(); }\n  else { clearInterval(logTimer); logTimer = null; }\n});\ndocument.getElementById('refreshLogsBtn').addEventListener('click', fetchLogs);\ndocument.getElementById('logSearch').addEventListener('input', fetchLogs);\ndocument.getElementById('logLevelFilter').addEventListener('change', fetchLogs);\n\ndocument.getElementById('clearLogsBtn').addEventListener('click', async function() {\n  if (await showModal('确认', '确定清除所有日志吗？')) {\n    await fetch('/clear-logs', { method: 'POST' });\n    showMessage('日志已清除', 'info');\n    fetchLogs();\n  }\n});\n\ndocument.getElementById('checkAllBtn').addEventListener('click', function() {\n  var btn = this; btn.disabled = true; btn.textContent = '检查中...';\n  fetch('/monitor').then(function() { location.reload(); }).catch(function() { location.reload(); });\n});\n\ndocument.getElementById('sendLiveBtn').addEventListener('click', async function() {\n  var btn = this; btn.disabled = true; btn.textContent = '发送中...';\n  try {\n    var res = await fetch('/send-live-notify', { method: 'POST' });\n    var data = await res.json();\n    showMessage(data.message, data.success ? 'info' : 'error');\n  } catch(e) { showMessage('操作失败: ' + e.message, 'error'); }\n  btn.disabled = false; btn.textContent = '模拟开播';\n});\n\ndocument.getElementById('singleCheckBtn').addEventListener('click', async function() {\n  var roomId = document.getElementById('singleCheckInput').value.trim();\n  if (!roomId) { showMessage('请输入房间号', 'error'); return; }\n  var btn = this; btn.disabled = true; btn.textContent = '查询中...';\n  try {\n    var res = await fetch('/check?room_id=' + encodeURIComponent(roomId));\n    var data = await res.json();\n    showMessage(JSON.stringify(data, null, 2), 'info');\n  } catch(e) { showMessage('查询失败: ' + e.message, 'error'); }\n  btn.disabled = false; btn.textContent = '单查';\n});\n\ndocument.getElementById('protocolSelect').addEventListener('change', function() {\n  var val = this.value;\n  var apiUrl = document.getElementById('apiUrl');\n  var receiverLabel = document.getElementById('receiverLabel');\n  var chatId = document.getElementById('chatId');\n  if (val === 'telegram') {\n    apiUrl.placeholder = 'https://api.telegram.org/bot<token>/sendMessage';\n    receiverLabel.textContent = '接收者 ID (chat_id)';\n    chatId.placeholder = '例如：123456789';\n  } else if (val === 'onebot_private') {\n    apiUrl.placeholder = 'http://127.0.0.1:5700/send_private_msg';\n    receiverLabel.textContent = '用户 ID (user_id)';\n    chatId.placeholder = '例如：123456789';\n  } else if (val === 'onebot_group') {\n    apiUrl.placeholder = 'http://127.0.0.1:5700/send_group_msg';\n    receiverLabel.textContent = '群 ID (group_id)';\n    chatId.placeholder = '例如：123456789';\n  } else if (val === 'discord') {\n    apiUrl.placeholder = 'https://discord.com/api/webhooks/...';\n    receiverLabel.textContent = '无 (使用 Webhook URL)';\n    chatId.placeholder = '可不填';\n  } else if (val === 'custom_webhook') {\n    apiUrl.placeholder = 'https://your-server.com/webhook';\n    receiverLabel.textContent = '无 (使用 Webhook URL)';\n    chatId.placeholder = '可不填';\n  }\n});\n\ndocument.addEventListener('click', async function(e) {\n  var target = e.target;\n  if (target.classList.contains('test-btn')) {\n    var id = target.dataset.id;\n    var btn = target; btn.disabled = true; btn.textContent = '测试中...';\n    try {\n      var res = await fetch('/test-notify', { method: 'POST', headers: {'Content-Type':'application/x-www-form-urlencoded'}, body: 'config_id=' + id });\n      var data = await res.json();\n      showMessage(data.message, data.success ? 'info' : 'error');\n    } catch(e) { showMessage('测试失败: ' + e.message, 'error'); }\n    btn.disabled = false; btn.textContent = '测试';\n  }\n  if (target.classList.contains('toggle-btn')) {\n    var id = target.dataset.id;\n    var btn = target; btn.disabled = true; btn.textContent = '切换中...';\n    try {\n      var res = await fetch('/toggle-notify', { method: 'POST', headers: {'Content-Type':'application/x-www-form-urlencoded'}, body: 'config_id=' + id });\n      var data = await res.json();\n      showMessage(data.message, 'info');\n      setTimeout(function() { location.reload(); }, 500);\n    } catch(e) { showMessage('切换失败: ' + e.message, 'error'); }\n    btn.disabled = false; btn.textContent = '切换';\n  }\n});\n\ndocument.getElementById('addRoomBtn').addEventListener('click', function() {\n  document.getElementById('addRoomModal').classList.add('active');\n  document.getElementById('roomInput').value = '';\n  document.getElementById('roomInput').focus();\n});\n\ndocument.getElementById('addRoomCancelBtn').addEventListener('click', function() {\n  document.getElementById('addRoomModal').classList.remove('active');\n});\n\ndocument.getElementById('addRoomConfirmBtn').addEventListener('click', async function() {\n  var roomId = document.getElementById('roomInput').value.trim();\n  if (!roomId) { showMessage('请输入房间号', 'error'); return; }\n  var btn = this;\n  btn.disabled = true;\n  btn.textContent = '提交中...';\n  try {\n    var formData = new URLSearchParams();\n    formData.append('room_id', roomId);\n    var res = await fetch('/add-room', { method: 'POST', headers: {'Content-Type':'application/x-www-form-urlencoded'}, body: formData });\n    if (res.ok) {\n      document.getElementById('addRoomModal').classList.remove('active');\n      showMessage('房间 ' + roomId + ' 已添加', 'info');\n      setTimeout(function() { location.reload(); }, 1000);\n    } else {\n      var err = await res.text();\n      showMessage('添加失败: ' + err, 'error');\n    }\n  } catch(e) { showMessage('添加失败: ' + e.message, 'error'); }\n  btn.disabled = false;\n  btn.textContent = '完成';\n});\n\ndocument.getElementById('addRoomModal').addEventListener('click', function(e) {\n  if (e.target === this) {\n    this.classList.remove('active');\n  }\n});\n\ndocument.getElementById('roomInput').addEventListener('keydown', function(e) {\n  if (e.key === 'Enter') {\n    document.getElementById('addRoomConfirmBtn').click();\n  }\n});\n\ndocument.addEventListener('DOMContentLoaded', function() {\n  document.getElementById('autoRefresh').checked = true;\n  logTimer = setInterval(fetchLogs, 5000);\n  fetchLogs();\n});\n</script>\n</body>\n</html>';

function renderLoginPage(error) {
  error = error || '';
  return '<!DOCTYPE html>\n<html><head><meta charset="UTF-8"><title>管理登录</title><style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;background:#f3f4f6}.card{background:white;padding:2rem;border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,0.1);width:100%;max-width:400px}h1{text-align:center}label{display:block;margin-top:1rem}input{width:100%;padding:0.5rem;border:1px solid #ccc;border-radius:6px}button{width:100%;padding:0.5rem;margin-top:1rem;background:#2563eb;color:white;border:none;border-radius:6px;cursor:pointer}.error{color:red;text-align:center}</style></head>\n<body><div class="card"><h1>管理登录</h1>' + (error ? '<p class="error">' + error + '</p>' : '') + '<form method="POST" action="/login"><label>用户名</label><input type="text" name="username" required><label>密码</label><input type="password" name="password" required><button type="submit">登录</button></form></div></body></html>';
}

async function renderAdminPage(env, message) {
  var roomIds = await getRoomList(env);
  var configs = await getNotifyConfigs(env);
  var roomsHtml = '';
  for (var i = 0; i < roomIds.length; i++) {
    var roomId = roomIds[i];
    var state = await getMonitorState(env, roomId);
    var isLive = state.state === 'LIVE';
    var statusColor = isLive ? '#22c55e' : '#9ca3af';
    var statusText = isLive ? '直播中' : '未开播';
    var title = state.last_title || '未知';
    var online = state.last_online || 0;
    var area = state.last_parent_area ? state.last_parent_area + ' - ' + state.last_area : '未知分区';
    var updateTime = state.last_update ? new Date(state.last_update).toLocaleString() : '从未更新';
    roomsHtml += '<div class="room-card"><div class="status-dot" style="background:' + statusColor + '"></div><div class="room-info"><div class="room-id">房间 ' + roomId + '</div><div class="room-title">' + title + '</div><div class="room-meta">' + statusText + ' · 人气 ' + online + ' · ' + area + '</div><div class="room-meta">更新于 ' + updateTime + '</div></div><div class="room-actions"><form method="POST" action="/remove-room"><input type="hidden" name="room_id" value="' + roomId + '"><button type="submit" class="btn btn-danger btn-sm">删除</button></form></div></div>';
  }
  if (!roomsHtml) roomsHtml = '<div style="grid-column:span 3;text-align:center;padding:2rem 0;color:var(--text);opacity:0.6">暂无房间，请添加</div>';
  var configsHtml = '';
  for (var j = 0; j < configs.length; j++) {
    var cfg = configs[j];
    var protocolLabel = { telegram: 'Telegram', onebot_private: 'OneBot私聊', onebot_group: 'OneBot群聊', discord: 'Discord', custom_webhook: '自定义Webhook' }[cfg.protocol] || cfg.protocol;
    var status = cfg.enabled !== false ? '启用' : '禁用';
    configsHtml += '<tr><td>' + cfg.name + '</td><td>' + protocolLabel + '</td><td style="color:' + (cfg.enabled !== false ? '#16a34a' : '#6b7280') + '">' + status + '</td><td><button class="test-btn btn btn-sm" data-id="' + cfg.id + '">测试</button><button class="toggle-btn btn btn-sm" data-id="' + cfg.id + '">' + (cfg.enabled !== false ? '禁用' : '启用') + '</button><form method="POST" action="/delete-notify" style="display:inline"><input type="hidden" name="config_id" value="' + cfg.id + '"><button type="submit" class="btn btn-danger btn-sm">删除</button></form></td></tr>';
  }
  if (!configsHtml) configsHtml = '<tr><td colspan="4" style="text-align:center;color:var(--text);opacity:0.6">暂无配置</td></tr>';
  var logsPlaceholder = '<div style="color:var(--text);opacity:0.6">加载日志中...</div>';
  var html = HTML_TEMPLATE.replace('{{ROOMS}}', roomsHtml).replace('{{CONFIGS}}', configsHtml).replace('{{LOGS}}', logsPlaceholder);
  if (message) {
    html = html.replace('<div id="messageArea"></div>', '<div id="messageArea"><div style="padding:0.5rem;border-radius:6px;margin-bottom:0.5rem;background:#f0fdf4;border:1px solid #bbf7d0;color:#166534">' + message + '</div></div>');
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
      var roomId = roomIds[0];
      try {
        var current = await fetchLiveStatus(roomId);
        var isLive = CONFIG.IS_LIVE_STATUS.indexOf(current.live_status) !== -1;
        if (!isLive) return new Response(JSON.stringify({ success: false, message: '当前未开播' }), { status: 400 });
        var text = await buildNotification(roomId, current, env, 'live_start');
        await sendNotification(text, env, { event: 'live_start', room_id: roomId, ...current });
        await addLog('info', '手动发送开播通知 ' + roomId);
        return new Response(JSON.stringify({ success: true, message: '已发送开播通知' }));
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
        var roomId = roomIds[0];
        var current = await fetchLiveStatus(roomId);
        var isLive = CONFIG.IS_LIVE_STATUS.indexOf(current.live_status) !== -1;
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
      var roomId = form.get('room_id');
      if (!roomId) return new Response('缺少房间号', { status: 400 });
      await addRoom(env, roomId.trim());
      await addLog('info', '添加房间 ' + roomId);
      return new Response(await renderAdminPage(env, '房间 ' + roomId + ' 已添加'), { headers: { 'Content-Type': 'text/html' } });
    }
    if (path === '/remove-room' && method === 'POST') {
      var form = await request.formData();
      var roomId = form.get('room_id');
      if (!roomId) return new Response('缺少房间号', { status: 400 });
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
