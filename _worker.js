var CONFIG = {
  MAIN_API: 'https://uapis.cn/api/v1/social/bilibili/liveroom',
  USER_API: 'https://uapis.cn/api/v1/social/bilibili/userinfo',
  IS_LIVE_STATUS: [1],
  CACHE_TTL: 86400,
  USER_INFO_TTL: 86400,
  MAX_LOG_ENTRIES: 500,
  POPULARITY_MILESTONES: [1000, 5000, 10000, 50000, 100000]
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
  config.enabled = true;
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
    state: 'OFFLINE',
    last_title: '',
    last_cover: '',
    last_area: '',
    last_parent_area: '',
    last_online: 0,
    last_live_time: ''
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

  var vipTypeMap = { 0: '无', 1: '月度大会员', 2: '年度大会员' };
  var vipType = (userInfo && userInfo.vip_type !== undefined) ? vipTypeMap[userInfo.vip_type] || userInfo.vip_type : '';
  var vipStatus = (userInfo && userInfo.vip_status !== undefined) ? (userInfo.vip_status === 1 ? '已开通' : '未开通') : '';

  var baseVars = {
    '主播': anchorName,
    '标题': current.title || '未知',
    'UID': current.uid || '',
    '房间号': current.room_id || roomId,
    '直播时间': current.live_time || '',
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
    'VIP类型': vipType,
    'VIP状态': vipStatus,
    '生日': (userInfo && userInfo.birthday) || '',
    '投稿数': (userInfo && userInfo.archive_count) || 0,
    '文章数': (userInfo && userInfo.article_count) || 0,
    '头像': (userInfo && userInfo.face) || '',
  };

  var message = '';
  switch (eventType) {
    case 'live_start':
      message = '[开播] ' + anchorName + ' 开播了\n标题：' + current.title + '\n人气：' + current.online + '\n开播时间：' + (current.live_time || '') + '\n房间号：' + current.room_id + '\n分区：' + current.parent_area_name + ' - ' + current.area_name + '\n直播间链接：https://live.bilibili.com/' + current.room_id;
      if (userInfo) {
        if (userInfo.sign) message += '\n签名：' + userInfo.sign;
        if (userInfo.follower !== undefined) message += '\n粉丝：' + userInfo.follower;
        if (userInfo.following !== undefined) message += '\n关注：' + userInfo.following;
        if (userInfo.level !== undefined) message += '\n等级：' + userInfo.level;
        if (userInfo.sex) message += '\n性别：' + userInfo.sex;
        if (vipType) message += '\nVIP类型：' + vipType;
        if (vipStatus) message += '\nVIP状态：' + vipStatus;
        if (userInfo.birthday) message += '\n生日：' + userInfo.birthday;
        if (userInfo.archive_count !== undefined) message += '\n投稿数：' + userInfo.archive_count;
        if (userInfo.article_count !== undefined) message += '\n文章数：' + userInfo.article_count;
      }
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
  roomId = toRoomId(roomId);
  var current;
  try {
    current = await fetchLiveStatus(roomId);
    var liveStatus = Number(current.live_status ?? current.livestatus ?? current.liveStatus ?? 0);
    current.live_status = liveStatus;
    var prev = await getMonitorState(env, roomId);
    await addLog('info', `[${roomId}] 检查: API状态=${liveStatus}, 人气=${current.online || 0}, 标题=${current.title || '未知'}, 旧状态=${prev.state || '未知'}`);
  } catch (e) {
    await addLog('error', '[' + roomId + '] 获取状态失败: ' + e.message);
    return { error: e.message };
  }
  var isLive = CONFIG.IS_LIVE_STATUS.includes(current.live_status);
  var state = isLive ? 'LIVE' : 'OFFLINE';
  // 注意：这里不再重复声明 prev
  var oldState = prev.state || 'OFFLINE';
  var events = [];

  if (oldState !== state) {
    await addLog('info', `[${roomId}] 状态变化: ${oldState} -> ${state}`);
    if (state === 'LIVE') {
      events.push({ type: 'live_start', data: current });
    } else {
      events.push({ type: 'live_end', data: current });
    }
  } else if (state === 'LIVE') {
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

  var newState = {
    room_id: roomId,
    state: state,
    last_live_time: current.live_time || prev.last_live_time || '',
    last_title: current.title || '',
    last_cover: current.user_cover || '',
    last_area: current.area_name || '',
    last_parent_area: current.parent_area_name || '',
    last_online: Number(current.online || 0),
    last_update: new Date().toISOString(),
    version: 2
  };
  await setMonitorState(env, roomId, newState);

  for (var j = 0; j < events.length; j++) {
    var evt = events[j];
    var text = await buildNotification(roomId, evt.data, env, evt.type, evt);
    var success = await sendNotification(text, env, { event: evt.type, room_id: roomId, ...evt.data });
    if (success) {
      await addLog('info', `[${roomId}] 事件 ${evt.type} 已通知`);
    } else {
      await addLog('error', `[${roomId}] 事件 ${evt.type} 发送失败（无可用通知配置或发送错误）`);
    }
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

var HTML_TEMPLATE = `
<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>直播监控管理</title>
<link href="https://cdnjs.cloudflare.com/ajax/libs/bootstrap/5.3.8/css/bootstrap.min.css" rel="stylesheet">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/bootstrap-icons/1.11.3/font/bootstrap-icons.min.css">
<script defer src="https://cdnjs.cloudflare.com/ajax/libs/axios/1.11.0/axios.min.js"></script>
<script defer src="https://cdnjs.cloudflare.com/ajax/libs/bootstrap/5.3.8/js/bootstrap.bundle.min.js"></script>
</head>
<body>
<div class="container-fluid p-3">
  <div class="row mb-3">
    <div class="col">
      <h1 class="d-flex align-items-center">
        <i class="bi bi-broadcast me-2"></i>直播监控管理
        <small class="text-muted ms-3 fs-6">状态机 + KV 持久化</small>
      </h1>
    </div>
    <div class="col-auto">
      <button id="themeToggle" class="btn btn-outline-secondary me-2">深色</button>
      <button id="logoutBtn" class="btn btn-outline-danger">退出</button>
      <form id="logoutForm" method="POST" action="/logout" style="display:none"></form>
    </div>
  </div>

  <div id="messageArea"></div>

  <ul class="nav nav-tabs mb-3" id="myTab" role="tablist">
    <li class="nav-item" role="presentation">
      <button class="nav-link active" id="rooms-tab" data-bs-toggle="tab" data-bs-target="#rooms" type="button" role="tab">房间</button>
    </li>
    <li class="nav-item" role="presentation">
      <button class="nav-link" id="notifies-tab" data-bs-toggle="tab" data-bs-target="#notifies" type="button" role="tab">通知</button>
    </li>
    <li class="nav-item" role="presentation">
      <button class="nav-link" id="logs-tab" data-bs-toggle="tab" data-bs-target="#logs" type="button" role="tab">日志</button>
    </li>
  </ul>

  <div class="tab-content">
    <div class="tab-pane active" id="rooms" role="tabpanel">
      <div class="mb-3 d-flex flex-wrap gap-2">
        <button id="addRoomBtn" class="btn btn-primary"><i class="bi bi-plus-circle"></i> 添加房间</button>
        <button id="checkAllBtn" class="btn btn-success"><i class="bi bi-arrow-repeat"></i> 检查全部</button>
        <button id="refreshRoomsBtn" class="btn btn-info"><i class="bi bi-cloud-refresh"></i> 刷新状态</button>
        <button id="sendLiveBtn" class="btn btn-warning"><i class="bi bi-broadcast"></i> 模拟开播</button>
        <div class="input-group" style="width:auto;">
          <input id="singleCheckInput" class="form-control" placeholder="房间号" style="width:120px;">
          <button id="singleCheckBtn" class="btn btn-outline-secondary">单查</button>
        </div>
        <button id="exportLogsBtn" class="btn btn-outline-secondary"><i class="bi bi-download"></i> 导出日志</button>
      </div>
      <div id="roomContainer" class="row row-cols-1 row-cols-md-2 row-cols-lg-3 g-3">{{ROOMS}}</div>
    </div>

    <div class="tab-pane" id="notifies" role="tabpanel">
      <div class="card mb-3">
        <div class="card-body">
          <h5 class="card-title"><i class="bi bi-plus-circle"></i> 添加通知配置</h5>
          <form id="addNotifyForm" class="row g-3">
            <div class="col-md-4">
              <label class="form-label">名称</label>
              <input type="text" name="name" class="form-control" placeholder="主Telegram" required>
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
            <div class="col-md-4" id="apiUrlGroup">
              <label class="form-label">API 地址</label>
              <input type="url" name="api_url" id="apiUrl" class="form-control" placeholder="https://api.telegram.org/bot<token>/sendMessage">
            </div>
            <div class="col-md-4 d-none" id="tgTokenGroup">
              <label class="form-label">Bot Token</label>
              <input type="text" id="tgToken" name="tg_token" class="form-control" placeholder="例如：123456:ABC-DEF...">
              <small class="text-muted">系统将自动构建 API 地址</small>
            </div>
            <div class="col-md-4">
              <label class="form-label" id="receiverLabel">接收者 ID</label>
              <input type="text" name="chat_id" id="chatId" class="form-control" placeholder="例如：123456789">
            </div>
            <div class="col-12">
              <label class="form-label">通知模板 (可选)</label>
              <textarea name="template" id="templateArea" class="form-control" rows="3"></textarea>
            </div>
            <div class="col-12">
              <button type="submit" class="btn btn-primary"><i class="bi bi-plus-circle"></i> 添加配置</button>
            </div>
          </form>
        </div>
      </div>
      <div class="card">
        <div class="card-body">
          <h5 class="card-title"><i class="bi bi-list-ul"></i> 现有配置</h5>
          <div class="table-responsive">
            <table class="table table-hover">
              <thead><tr><th>名称</th><th>协议</th><th>状态</th><th>操作</th></tr></thead>
              <tbody id="configTableBody">{{CONFIGS}}</tbody>
            </table>
          </div>
        </div>
      </div>
    </div>

    <div class="tab-pane" id="logs" role="tabpanel">
      <div class="card">
        <div class="card-body">
          <div class="d-flex justify-content-between align-items-center mb-3 flex-wrap gap-2">
            <h5 class="card-title mb-0"><i class="bi bi-journal-text"></i> 日志</h5>
            <div class="d-flex gap-2 flex-wrap">
              <button id="clearLogsBtn" class="btn btn-danger btn-sm"><i class="bi bi-trash"></i> 清除</button>
              <button id="refreshLogsBtn" class="btn btn-outline-secondary btn-sm"><i class="bi bi-arrow-clockwise"></i> 刷新</button>
              <div class="form-check form-switch">
                <input class="form-check-input" type="checkbox" id="autoRefresh" checked>
                <label class="form-check-label" for="autoRefresh">自动刷新</label>
              </div>
              <input id="logSearch" class="form-control form-control-sm" placeholder="搜索..." style="width:150px;">
              <select id="logLevelFilter" class="form-select form-select-sm" style="width:auto;">
                <option value="">全部</option>
                <option value="info">Info</option>
                <option value="warn">Warn</option>
                <option value="error">Error</option>
              </select>
            </div>
          </div>
          <div id="logContainer" class="bg-dark text-light p-2 rounded" style="max-height:400px;overflow-y:auto;font-family:monospace;font-size:0.85rem;">{{LOGS}}</div>
        </div>
      </div>
    </div>
  </div>
</div>

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
document.addEventListener('DOMContentLoaded', function() {
  var addRoomModal = new bootstrap.Modal(document.getElementById('addRoomModal'));
  var customModal = new bootstrap.Modal(document.getElementById('customModal'));

  // 清理 modal backdrop 残留
  function clearModalBackdrop() {
    document.querySelectorAll('.modal-backdrop').forEach(function(el) { el.remove(); });
    document.body.classList.remove('modal-open');
    document.body.style = '';
  }

  // Tab 状态持久化
  function saveTab() {
    var active = document.querySelector('.nav-link.active');
    if (active) {
      localStorage.setItem('activeTab', active.id);
    }
  }
  document.querySelectorAll('[data-bs-toggle="tab"]').forEach(function(tab) {
    tab.addEventListener('shown.bs.tab', saveTab);
  });
  var savedTab = localStorage.getItem('activeTab');
  if (savedTab) {
    var tabEl = document.getElementById(savedTab);
    if (tabEl) {
      new bootstrap.Tab(tabEl).show();
    }
  }

  // 浮动提示框
  function showMessage(msg, type) {
    type = type || 'info';
    var box = document.createElement('div');
    box.className = 'position-fixed top-0 start-50 translate-middle-x mt-3 alert alert-' + (type === 'error' ? 'danger' : type === 'warn' ? 'warning' : 'success');
    box.style.zIndex = '99999';
    box.style.minWidth = '320px';
    box.style.textAlign = 'center';
    box.innerHTML = msg;
    document.body.appendChild(box);
    setTimeout(function() {
      box.style.transition = 'opacity .5s';
      box.style.opacity = '0';
      setTimeout(function() { box.remove(); }, 500);
    }, 5000);
  }

  // 日志渲染（转义）
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderLogs(logs) {
    var container = document.getElementById('logContainer');
    var search = document.getElementById('logSearch').value.toLowerCase();
    var level = document.getElementById('logLevelFilter').value;
    var filtered = logs;
    if (search) filtered = filtered.filter(function(e) { return e.message.toLowerCase().includes(search); });
    if (level) filtered = filtered.filter(function(e) { return e.level === level; });
    if (!filtered.length) {
      container.innerHTML = '<div class="text-secondary">暂无日志</div>';
      return;
    }
    var html = '';
    filtered.forEach(function(entry) {
      var levelColor = { info: 'text-info', warn: 'text-warning', error: 'text-danger' }[entry.level] || '';
      html += '<div><span class="text-secondary">' + escapeHtml(entry.time) + '</span> <span class="' + levelColor + '">[' + escapeHtml(entry.level.toUpperCase()) + ']</span> ' + escapeHtml(entry.message) + '</div>';
    });
    container.innerHTML = html;
  }

  function fetchLogs() {
    axios.get('/logs').then(function(res) { renderLogs(res.data); }).catch(function(e) { console.error('获取日志失败', e); });
  }

  // 主题切换
  document.getElementById('themeToggle').addEventListener('click', function() {
    var html = document.documentElement;
    var theme = html.getAttribute('data-bs-theme') === 'dark' ? 'light' : 'dark';
    html.setAttribute('data-bs-theme', theme);
    this.textContent = theme === 'dark' ? '亮色' : '深色';
  });
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    document.documentElement.setAttribute('data-bs-theme', 'dark');
    document.getElementById('themeToggle').textContent = '亮色';
  }

  // 退出
  document.getElementById('logoutBtn').addEventListener('click', function() {
    document.getElementById('logoutForm').submit();
  });

  // 日志自动刷新
  var logTimer = null;
  document.getElementById('autoRefresh').addEventListener('change', function() {
    if (this.checked) { logTimer = setInterval(fetchLogs, 5000); fetchLogs(); }
    else { clearInterval(logTimer); logTimer = null; }
  });
  document.getElementById('refreshLogsBtn').addEventListener('click', fetchLogs);
  document.getElementById('logSearch').addEventListener('input', fetchLogs);
  document.getElementById('logLevelFilter').addEventListener('change', fetchLogs);
  logTimer = setInterval(fetchLogs, 5000);
  fetchLogs();

  // 协议切换
  function updateNotifyForm() {
    var val = document.getElementById('protocolSelect').value;
    var apiUrlGroup = document.getElementById('apiUrlGroup');
    var tgTokenGroup = document.getElementById('tgTokenGroup');
    var apiUrl = document.getElementById('apiUrl');
    var template = document.getElementById('templateArea');
    var defaultTemplate = '[开播] {{主播}} 开播了\n标题：{{标题}}\n人气：{{人气}}\n开播时间：{{直播时间}}\n房间号：{{房间号}}\n分区：{{分区}}\n直播间链接：{{直播链接}}\n签名：{{签名}}\n粉丝：{{粉丝}}\n关注：{{关注}}\n等级：{{等级}}\n性别：{{性别}}\nVIP类型：{{VIP类型}}\nVIP状态：{{VIP状态}}\n生日：{{生日}}\n投稿数：{{投稿数}}\n文章数：{{文章数}}';
    if (val === 'telegram') {
      apiUrlGroup.classList.add('d-none');
      tgTokenGroup.classList.remove('d-none');
      apiUrl.placeholder = 'https://api.telegram.org/bot<token>/sendMessage';
      template.value = defaultTemplate;
    } else {
      apiUrlGroup.classList.remove('d-none');
      tgTokenGroup.classList.add('d-none');
      if (val === 'onebot_private') {
        apiUrl.placeholder = 'http://127.0.0.1:5700/send_private_msg';
        template.value = defaultTemplate;
      } else if (val === 'onebot_group') {
        apiUrl.placeholder = 'http://127.0.0.1:5700/send_group_msg';
        template.value = defaultTemplate;
      } else if (val === 'discord') {
        apiUrl.placeholder = 'https://discord.com/api/webhooks/...';
        template.value = '**[开播] {{主播}}**\n标题：{{标题}}\n人气：{{人气}}\n开播时间：{{直播时间}}\n房间号：{{房间号}}\n分区：{{分区}}\n[直播间链接]({{直播链接}})\n签名：{{签名}}\n粉丝：{{粉丝}}\n关注：{{关注}}\n等级：{{等级}}\n性别：{{性别}}\nVIP类型：{{VIP类型}}\nVIP状态：{{VIP状态}}\n生日：{{生日}}\n投稿数：{{投稿数}}\n文章数：{{文章数}}';
      } else if (val === 'custom_webhook') {
        apiUrl.placeholder = 'https://your-server.com/webhook';
        template.value = '{"event":"live_start","anchor":"{{主播}}","title":"{{标题}}","online":{{人气}},"room_id":"{{房间号}}","link":"{{直播链接}}","sign":"{{签名}}","fans":{{粉丝}},"follow":{{关注}},"level":{{等级}},"sex":"{{性别}}","vip_type":"{{VIP类型}}","vip_status":"{{VIP状态}}","birthday":"{{生日}}","archive_count":{{投稿数}},"article_count":{{文章数}}}';
      }
    }
    var receiverLabel = document.getElementById('receiverLabel');
    var chatId = document.getElementById('chatId');
    if (val === 'telegram') {
      receiverLabel.textContent = '接收者 ID (chat_id)';
      chatId.placeholder = '例如：123456789';
    } else if (val === 'onebot_private') {
      receiverLabel.textContent = '用户 ID (user_id)';
      chatId.placeholder = '例如：123456789';
    } else if (val === 'onebot_group') {
      receiverLabel.textContent = '群 ID (group_id)';
      chatId.placeholder = '例如：123456789';
    } else {
      receiverLabel.textContent = '接收者 ID (可选)';
      chatId.placeholder = '可不填';
    }
  }
  document.getElementById('protocolSelect').addEventListener('change', updateNotifyForm);
  updateNotifyForm();

  // 添加通知
  document.getElementById('addNotifyForm').addEventListener('submit', function(e) {
    e.preventDefault();
    var form = this;
    var protocol = document.getElementById('protocolSelect').value;
    if (protocol === 'telegram') {
      var token = document.getElementById('tgToken').value.trim();
      if (!token) { showMessage('请输入 Bot Token', 'error'); return; }
      document.getElementById('apiUrl').value = 'https://api.telegram.org/bot' + token + '/sendMessage';
    }
    var formData = new FormData(form);
    axios.post('/add-notify', formData, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
      .then(function() {
        showMessage('配置添加成功', 'info');
        setTimeout(function() { location.reload(); }, 1200);
      })
      .catch(function(err) {
        showMessage('添加失败: ' + (err.response ? err.response.data : err.message), 'error');
      });
  });

  // 事件委托：所有按钮
  document.addEventListener('click', function(e) {
    var btn = e.target.closest('button');
    if (!btn) return;

    if (btn.id === 'addRoomBtn') {
      addRoomModal.show();
      document.getElementById('roomInput').value = '';
      document.getElementById('roomInput').focus();
      return;
    }
    if (btn.id === 'addRoomConfirmBtn') {
      var roomId = document.getElementById('roomInput').value.trim();
      if (!roomId) { showMessage('请输入房间号', 'error'); return; }
      btn.disabled = true;
      btn.textContent = '提交中...';
      var formData = new URLSearchParams();
      formData.append('room_id', roomId);
      axios.post('/add-room', formData, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
        .then(function() {
          addRoomModal.hide();
          setTimeout(clearModalBackdrop, 300);
          showMessage('房间 ' + roomId + ' 已添加', 'info');
          setTimeout(function() { location.reload(); }, 1200);
        })
        .catch(function(err) {
          showMessage('添加失败: ' + (err.response ? err.response.data : err.message), 'error');
          btn.disabled = false;
          btn.textContent = '完成';
        });
      return;
    }
    if (btn.id === 'checkAllBtn') {
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> 检查中...';
      axios.get('/monitor?force=1')
        .then(function() { location.reload(); })
        .catch(function() { location.reload(); });
      return;
    }
    if (btn.id === 'refreshRoomsBtn') {
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> 刷新中...';
      axios.get('/monitor?force=1')
        .then(function() { location.reload(); })
        .catch(function() { location.reload(); });
      return;
    }
    if (btn.id === 'sendLiveBtn') {
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> 发送中...';
      axios.post('/send-live-notify')
        .then(function(res) {
          showMessage(res.data.message, res.data.success ? 'info' : 'error');
          btn.disabled = false;
          btn.innerHTML = '<i class="bi bi-broadcast"></i> 模拟开播';
        })
        .catch(function(err) {
          showMessage('操作失败: ' + (err.response ? err.response.data : err.message), 'error');
          btn.disabled = false;
          btn.innerHTML = '<i class="bi bi-broadcast"></i> 模拟开播';
        });
      return;
    }
    if (btn.id === 'singleCheckBtn') {
      var roomId = document.getElementById('singleCheckInput').value.trim();
      if (!roomId) { showMessage('请输入房间号', 'error'); return; }
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> 查询中...';
      axios.get('/check?room_id=' + encodeURIComponent(roomId))
        .then(function(res) {
          showMessage(JSON.stringify(res.data, null, 2), 'info');
          btn.disabled = false;
          btn.innerHTML = '<i class="bi bi-search"></i> 单查';
        })
        .catch(function(err) {
          showMessage('查询失败: ' + (err.response ? err.response.data : err.message), 'error');
          btn.disabled = false;
          btn.innerHTML = '<i class="bi bi-search"></i> 单查';
        });
      return;
    }
    if (btn.id === 'exportLogsBtn') {
      axios.get('/logs')
        .then(function(res) {
          var blob = new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json' });
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = url; a.download = 'logs.json'; a.click();
          URL.revokeObjectURL(url);
        })
        .catch(function(err) {
          showMessage('导出失败: ' + err.message, 'error');
        });
      return;
    }
    if (btn.id === 'clearLogsBtn') {
      customModal.show();
      document.getElementById('modalTitle').textContent = '确认';
      document.getElementById('modalMessage').textContent = '确定清除所有日志吗？';
      document.getElementById('modalConfirmBtn').onclick = function() {
        customModal.hide();
        setTimeout(clearModalBackdrop, 300);
        axios.post('/clear-logs')
          .then(function() {
            showMessage('日志已清除', 'info');
            fetchLogs();
          })
          .catch(function(err) {
            showMessage('清除失败: ' + err.message, 'error');
          });
      };
      document.getElementById('modalCancelBtn').onclick = function() { customModal.hide(); };
      return;
    }
    // 删除房间（动态生成的按钮）
    if (btn.classList.contains('delete-room-btn')) {
      var roomId = btn.dataset.room;
      if (!confirm('确定删除房间 ' + roomId + ' 吗？')) return;
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span>';
      var formData = new URLSearchParams();
      formData.append('room_id', roomId);
      axios.post('/remove-room', formData, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
        .then(function() {
          showMessage('房间 ' + roomId + ' 已删除', 'info');
          setTimeout(function() { location.reload(); }, 1200);
        })
        .catch(function(err) {
          showMessage('删除失败: ' + (err.response ? err.response.data : err.message), 'error');
          btn.disabled = false;
          btn.innerHTML = '删除';
        });
      return;
    }
    // 测试/切换配置
    if (btn.classList.contains('test-btn')) {
      var id = btn.dataset.id;
      btn.disabled = true;
      btn.textContent = '测试中...';
      var formData = new URLSearchParams();
      formData.append('config_id', id);
      axios.post('/test-notify', formData, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
        .then(function(res) {
          showMessage(res.data.message, res.data.success ? 'info' : 'error');
          btn.disabled = false;
          btn.textContent = '测试';
        })
        .catch(function(err) {
          showMessage('测试失败: ' + (err.response ? err.response.data : err.message), 'error');
          btn.disabled = false;
          btn.textContent = '测试';
        });
      return;
    }
    if (btn.classList.contains('toggle-btn')) {
      var id = btn.dataset.id;
      btn.disabled = true;
      btn.textContent = '切换中...';
      var formData = new URLSearchParams();
      formData.append('config_id', id);
      axios.post('/toggle-notify', formData, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
        .then(function(res) {
          showMessage(res.data.message, 'info');
          setTimeout(function() { location.reload(); }, 500);
        })
        .catch(function(err) {
          showMessage('切换失败: ' + (err.response ? err.response.data : err.message), 'error');
          btn.disabled = false;
          btn.textContent = '切换';
        });
      return;
    }
  });

  // 添加房间模态框回车提交
  document.getElementById('roomInput').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
      document.getElementById('addRoomConfirmBtn').click();
    }
  });

  // 清理所有 modal backdrop（全局）
  document.addEventListener('hidden.bs.modal', function() {
    setTimeout(clearModalBackdrop, 300);
  });

});
</script>
</body>
</html>
`;

function renderLoginPage(error) {
  error = error || '';
  return '<!DOCTYPE html>\n<html><head><meta charset="UTF-8"><title>管理登录</title><link href="https://cdnjs.cloudflare.com/ajax/libs/bootstrap/5.3.8/css/bootstrap.min.css" rel="stylesheet"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>\n<body class="d-flex align-items-center justify-content-center vh-100 bg-light"><div class="card shadow" style="width:100%;max-width:400px;"><div class="card-body"><h1 class="card-title text-center">管理登录</h1>' + (error ? '<div class="alert alert-danger">' + error + '</div>' : '') + '<form method="POST" action="/login"><div class="mb-3"><label class="form-label">用户名</label><input type="text" name="username" class="form-control" required></div><div class="mb-3"><label class="form-label">密码</label><input type="password" name="password" class="form-control" required></div><button type="submit" class="btn btn-primary w-100">登录</button></form></div></div></body></html>';
}

async function renderAdminPage(env, message) {
  var roomIds = await getRoomList(env);
  var configs = await getNotifyConfigs(env);
  var roomsHtml = '';
  for (var i = 0; i < roomIds.length; i++) {
    var roomId = toRoomId(roomIds[i]);
    var state = await getMonitorState(env, roomId);
    var isLive = state.state === 'LIVE';
    var statusColor = isLive ? 'success' : 'secondary';
    var statusText = isLive ? '直播中' : '未开播';
    var title = state.last_title || '未知';
    var online = state.last_online || 0;
    var area = state.last_parent_area ? state.last_parent_area + ' - ' + state.last_area : '未知分区';
    var updateTime = state.last_update ? new Date(state.last_update).toLocaleString() : '从未更新';
    roomsHtml += '<div class="col"><div class="card h-100"><div class="card-body d-flex align-items-start"><div class="flex-shrink-0"><span class="badge bg-' + statusColor + ' rounded-pill me-2">' + statusText + '</span></div><div class="flex-grow-1"><h6 class="card-subtitle text-muted">房间 ' + roomId + '</h6><h5 class="card-title">' + title + '</h5><p class="card-text small">人气 ' + online + ' · ' + area + '<br><span class="text-muted">更新于 ' + updateTime + '</span></p></div><button class="delete-room-btn btn btn-outline-danger btn-sm" data-room="' + roomId + '">删除</button></div></div></div>';
  }
  if (!roomsHtml) roomsHtml = '<div class="col-12 text-center text-muted py-4">暂无房间，请添加</div>';

  var configsHtml = '';
  for (var j = 0; j < configs.length; j++) {
    var cfg = configs[j];
    var protocolLabel = { telegram: 'Telegram', onebot_private: 'OneBot私聊', onebot_group: 'OneBot群聊', discord: 'Discord', custom_webhook: '自定义Webhook' }[cfg.protocol] || cfg.protocol;
    var status = cfg.enabled !== false ? '启用' : '禁用';
    var statusColor = cfg.enabled !== false ? 'success' : 'secondary';
    configsHtml += '<tr><td>' + cfg.name + '</td><td>' + protocolLabel + '</td><td><span class="badge bg-' + statusColor + '">' + status + '</span></td><td><button class="test-btn btn btn-sm btn-outline-primary" data-id="' + cfg.id + '">测试</button><button class="toggle-btn btn btn-sm btn-outline-warning" data-id="' + cfg.id + '">' + (cfg.enabled !== false ? '禁用' : '启用') + '</button><form method="POST" action="/delete-notify" style="display:inline"><input type="hidden" name="config_id" value="' + cfg.id + '"><button type="submit" class="btn btn-sm btn-outline-danger">删除</button></form></td></tr>';
  }
  if (!configsHtml) configsHtml = '<tr><td colspan="4" class="text-center text-muted">暂无配置</td></tr>';

  var logsPlaceholder = '<div class="text-secondary">加载日志中...</div>';
  var html = HTML_TEMPLATE.replace('{{ROOMS}}', roomsHtml).replace('{{CONFIGS}}', configsHtml).replace('{{LOGS}}', logsPlaceholder);
  if (message) {
    var msgHtml = '<div class="alert alert-success alert-dismissible fade show" role="alert">' + message + '<button type="button" class="btn-close" data-bs-dismiss="alert"></button></div>';
    html = html.replace('<div id="messageArea"></div>', '<div id="messageArea">' + msgHtml + '</div>');
  }
  return html;
}

export default {
  async fetch(request, env) {
    var url = new URL(request.url);
    var path = url.pathname;
    var method = request.method;

    // 日志接口需认证
    if (path === '/logs') {
      if (!isAuthenticated(request, env)) {
        return new Response(JSON.stringify([]), { headers: { 'Content-Type': 'application/json' } });
      }
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
      var roomId = toRoomId(roomIds[Math.floor(Math.random() * roomIds.length)]);
      try {
        var current = await fetchLiveStatus(roomId);
        var liveStatus = Number(current.live_status ?? current.livestatus ?? current.liveStatus ?? 0);
        current.live_status = liveStatus;
        var isLive = CONFIG.IS_LIVE_STATUS.includes(liveStatus);
        if (!isLive) {
          var last = await getMonitorState(env, roomId);
          current.title = last.last_title || current.title || '未知';
          current.online = last.last_online || 0;
          current.area_name = last.last_area || current.area_name || '未知分区';
          current.parent_area_name = last.last_parent_area || current.parent_area_name || '未知父分区';
          current.live_time = last.last_live_time || '';
          current.uid = current.uid || 0;
        }
        var eventType = isLive ? 'live_start' : 'live_end';
        var text = await buildNotification(roomId, current, env, eventType);
        var success = await sendNotification(text, env, { event: eventType, room_id: roomId, ...current });
        if (success) {
          await addLog('info', '手动发送模拟通知 ' + roomId + (isLive ? ' (直播)' : ' (历史)'));
          return new Response(JSON.stringify({ success: true, message: '已发送 ' + (isLive ? '开播' : '下播') + ' 通知 (房间 ' + roomId + ')' }));
        } else {
          return new Response(JSON.stringify({ success: false, message: '通知发送失败，请检查配置' }), { status: 500 });
        }
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
      var template = form.get('template') || '';
      if (!name || !chat_id) return new Response('缺少必要字段', { status: 400 });
      // 如果是 telegram 且 api_url 为空，从 tg_token 构建
      if (protocol === 'telegram') {
        var tgToken = form.get('tg_token') || '';
        if (!tgToken) {
          // 如果已经有完整 api_url 则跳过
          if (api_url && api_url.includes('bot') && api_url.includes('/sendMessage')) {
            // 保持原样
          } else {
            return new Response('请输入 Bot Token', { status: 400 });
          }
        } else {
          api_url = 'https://api.telegram.org/bot' + tgToken + '/sendMessage';
        }
      }
      // 非 telegram 协议必须提供 api_url
      if (protocol !== 'telegram' && !api_url) {
        return new Response('缺少 API 地址', { status: 400 });
      }
      var receiver_key = 'chat_id', message_key = 'text';
      if (protocol === 'onebot_private') { receiver_key = 'user_id'; message_key = 'message'; }
      else if (protocol === 'onebot_group') { receiver_key = 'group_id'; message_key = 'message'; }
      else if (protocol === 'discord' || protocol === 'custom_webhook') { receiver_key = ''; message_key = ''; }
      await addNotifyConfig(env, { name: name, protocol: protocol, api_url: api_url, chat_id: chat_id, receiver_key: receiver_key, message_key: message_key, template: template, extra_params: {} });
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

      var roomId = toRoomId(roomIds[Math.floor(Math.random() * roomIds.length)]);
      try {
        var current = await fetchLiveStatus(roomId);
        var liveStatus = Number(current.live_status ?? current.livestatus ?? current.liveStatus ?? 0);
        current.live_status = liveStatus;
        var isLive = CONFIG.IS_LIVE_STATUS.includes(liveStatus);
        if (!isLive) {
          var last = await getMonitorState(env, roomId);
          current.title = last.last_title || current.title || '模拟标题';
          current.online = last.last_online || 0;
          current.area_name = last.last_area || current.area_name || '未知分区';
          current.parent_area_name = last.last_parent_area || current.parent_area_name || '未知父分区';
          current.live_time = last.last_live_time || '';
          current.uid = current.uid || 0;
        }
        var eventType = isLive ? 'live_start' : 'live_end';
        var text = await buildNotification(roomId, current, env, eventType);
        if (!isLive) text = '[测试] ' + text;
        var result = await sendNotificationToConfig(config, text, { event: eventType, room_id: roomId, ...current });
        if (result.success) {
          await addLog('info', '测试通知成功 ' + config.name + ' 房间 ' + roomId);
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
        await processRoom(roomId, env, { force: true });
        await addLog('info', '添加后同步完成 ' + roomId);
      } catch(e) {
        await addLog('error', '添加后同步失败 ' + e.message);
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
