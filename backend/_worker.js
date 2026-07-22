const CONFIG = {
  MAIN_API: 'https://uapis.cn/api/v1/social/bilibili/liveroom',
  USER_API: 'https://uapis.cn/api/v1/social/bilibili/userinfo',
  IS_LIVE_STATUS: [1],
  CACHE_TTL: 3600,
  USER_INFO_TTL: 86400,
  MAX_LOG_ENTRIES: 200,
  MAX_LEVEL: 6,
  POPULARITY_MILESTONES: [1000, 5000, 10000, 50000, 100000, 500000, 1000000],
  DEFAULT_TEMPLATE: `[{{事件}}] {{主播}}\n标题：{{标题}}\n房间号：{{房间号}} | UID：{{UID}}\n分区：{{父分区}} - {{分区}}\n人气：{{人气}} | 直播时间：{{直播时间}}\n直播间链接：{{直播链接}}\n封面：{{封面}}\n等级：{{等级}} | 粉丝：{{粉丝}} | 关注：{{关注}} | 性别：{{性别}}\nVIP：{{VIP类型}} ({{VIP状态}})\n投稿数：{{投稿数}} | 文章数：{{文章数}}\n签名：{{签名}}\n头像：{{头像}}\n更新时间：{{时间}}`
};

function toRoomId(id) { return String(id).trim(); }
function buildCacheKey(...parts) { return parts.join(':'); }
function normalizeCover(url) { if (!url) return ''; return url.split('?')[0].trim(); }
function formatLevel(level) { const lv = parseInt(level || 0) || 1; return 'LV ' + Math.min(lv, CONFIG.MAX_LEVEL); }
function renderTemplate(template, vars) { if (!template) template = CONFIG.DEFAULT_TEMPLATE; return template.replace(/\{\{(.*?)\}\}/g, (_, key) => { const val = vars[key.trim()]; return val !== undefined && val !== null ? String(val) : ''; }); }

async function getCache(key) { const cache = caches.default; const req = new Request('https://cache/' + key); const resp = await cache.match(req); if (resp && resp.ok) return resp.json(); return null; }
async function setCache(key, data, ttl) { ttl = ttl || CONFIG.CACHE_TTL; const cache = caches.default; const resp = new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=' + ttl } }); await cache.put(new Request('https://cache/' + key), resp); }

async function getRoomList(env) { const { results } = await env.DB.prepare('SELECT room_id FROM rooms').all(); return results.map(row => row.room_id); }
async function addRoom(env, roomId) { await env.DB.prepare('INSERT OR IGNORE INTO rooms (room_id) VALUES (?)').bind(roomId).run(); }
async function removeRoom(env, roomId) { await env.DB.prepare('DELETE FROM rooms WHERE room_id = ?').bind(roomId).run(); await env.DB.prepare('DELETE FROM monitor_states WHERE room_id = ?').bind(roomId).run(); }

async function getMonitorState(env, roomId) {
  const row = await env.DB.prepare('SELECT * FROM monitor_states WHERE room_id = ?').bind(roomId).first();
  if (!row) return { room_id: roomId, state: 'OFFLINE', last_title: '', last_cover: '', last_area: '', last_parent_area: '', last_online: 0, last_live_time: '', last_events: [], last_check: 0, last_update: null, version: 3 };
  return { ...row, last_events: JSON.parse(row.last_events || '[]'), last_online: Number(row.last_online) || 0, last_check: Number(row.last_check) || 0 };
}

async function setMonitorState(env, roomId, state) {
  await env.DB.prepare(`INSERT OR REPLACE INTO monitor_states (room_id, state, last_title, last_cover, last_area, last_parent_area, last_online, last_live_time, last_events, last_check, last_update, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(roomId, state.state, state.last_title || '', state.last_cover || '', state.last_area || '', state.last_parent_area || '', state.last_online || 0, state.last_live_time || '', JSON.stringify(state.last_events || []), state.last_check || Date.now(), state.last_update || new Date().toISOString(), state.version || 3).run();
}

async function getNotifyConfigs(env) { const { results } = await env.DB.prepare('SELECT * FROM notify_configs ORDER BY created_at').all(); return results.map(row => ({ ...row, enabled: row.enabled === 1, extra_params: row.extra_params ? JSON.parse(row.extra_params) : {}, template: row.template || CONFIG.DEFAULT_TEMPLATE })); }
async function addNotifyConfig(env, config) { const id = Date.now().toString(36) + Math.random().toString(36).substr(2, 5); await env.DB.prepare(`INSERT INTO notify_configs (id, name, protocol, api_url, chat_id, receiver_key, message_key, template, extra_params, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, config.name, config.protocol, config.api_url, config.chat_id || '', config.receiver_key || 'chat_id', config.message_key || 'text', config.template || CONFIG.DEFAULT_TEMPLATE, JSON.stringify(config.extra_params || {}), config.enabled ? 1 : 0, new Date().toISOString()).run(); return { ...config, id }; }
async function deleteNotifyConfig(env, id) { await env.DB.prepare('DELETE FROM notify_configs WHERE id = ?').bind(id).run(); }
async function toggleNotifyConfig(env, id) { const current = await env.DB.prepare('SELECT enabled FROM notify_configs WHERE id = ?').bind(id).first(); if (!current) throw new Error('配置不存在'); const newEnabled = current.enabled === 1 ? 0 : 1; await env.DB.prepare('UPDATE notify_configs SET enabled = ? WHERE id = ?').bind(newEnabled, id).run(); }

async function getLogs(env) { const { results } = await env.DB.prepare('SELECT time, level, message FROM system_logs ORDER BY time DESC LIMIT ?').bind(CONFIG.MAX_LOG_ENTRIES).all(); return results; }
async function addLog(level, message, env) { const time = new Date().toISOString(); await env.DB.prepare('INSERT INTO system_logs (time, level, message) VALUES (?, ?, ?)').bind(time, level, message).run(); await env.DB.prepare(`DELETE FROM system_logs WHERE id NOT IN (SELECT id FROM system_logs ORDER BY time DESC LIMIT ?)`).bind(CONFIG.MAX_LOG_ENTRIES).run(); console.log(`[${time}] [${level.toUpperCase()}] ${message}`); }
async function clearLogs(env) { await env.DB.prepare('DELETE FROM system_logs').run(); await addLog('info', '日志已清除', env); }

async function fetchLiveStatus(roomId) { roomId = toRoomId(roomId); const url = CONFIG.MAIN_API + '?room_id=' + encodeURIComponent(roomId); const resp = await fetch(url, { headers: { 'User-Agent': 'CloudflareWorker/1.0', 'Accept': 'application/json' } }); if (!resp.ok) throw new Error('UAPI请求失败 (' + resp.status + ')'); const data = await resp.json(); if (!data.room_id) throw new Error('UAPI返回数据缺少room_id'); return data; }
async function fetchUserInfo(uid) { const cacheKey = buildCacheKey('userinfo', uid); const cached = await getCache(cacheKey); if (cached) return cached; const url = CONFIG.USER_API + '?uid=' + encodeURIComponent(uid); const resp = await fetch(url, { headers: { 'User-Agent': 'CloudflareWorker/1.0', 'Accept': 'application/json' } }); if (!resp.ok) throw new Error('用户信息API请求失败 (' + resp.status + ')'); const data = await resp.json(); if (!data.mid) throw new Error('用户信息API返回缺少mid'); await setCache(cacheKey, data, CONFIG.USER_INFO_TTL); return data; }

async function sendNotificationToConfig(config, text, extra) { extra = extra || {}; try { let payload = {}; if (config.protocol === 'discord') { payload = { content: text }; } else if (config.protocol === 'custom_webhook') { payload = extra; } else { const receiverKey = config.receiver_key || 'chat_id'; const messageKey = config.message_key || 'text'; payload[receiverKey] = config.chat_id; payload[messageKey] = text; } if (config.extra_params) Object.assign(payload, config.extra_params); const resp = await fetch(config.api_url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); if (resp.ok) return { success: true }; const errText = await resp.text(); return { success: false, error: errText }; } catch (e) { return { success: false, error: e.message }; } }
async function sendNotification(text, env, extra) { extra = extra || {}; const configs = await getNotifyConfigs(env); const enabled = configs.filter(c => c.enabled); if (enabled.length === 0) { await addLog('warn', '没有启用的通知配置', env); return false; } let success = false; for (const config of enabled) { const result = await sendNotificationToConfig(config, text, extra); if (result.success) success = true; } return success; }

async function buildNotification(roomId, current, env, eventType, extra) { extra = extra || {}; let userInfo = null; try { userInfo = await fetchUserInfo(current.uid); } catch (e) {} const anchorName = (userInfo && userInfo.name) ? userInfo.name : '房间 ' + roomId; const vipTypeMap = { 0: '无', 1: '月度大会员', 2: '年度大会员' }; const vipType = (userInfo && userInfo.vip_type !== undefined) ? vipTypeMap[userInfo.vip_type] || userInfo.vip_type : ''; const vipStatus = (userInfo && userInfo.vip_status !== undefined) ? (userInfo.vip_status === 1 ? '已开通' : '未开通') : ''; const levelDisplay = formatLevel(userInfo ? userInfo.level : 0); const eventNameMap = { 'live_start': '开播', 'live_end': '直播结束', 'title_change': '标题修改', 'cover_change': '封面变化', 'area_change': '分区切换', 'popularity_milestone': '人气里程碑' }; const eventDisplay = eventNameMap[eventType] || eventType; const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }); const baseVars = { '事件': eventDisplay, '主播': anchorName, '标题': current.title || '未知', 'UID': current.uid || '', '房间号': current.room_id || roomId, '直播时间': current.live_time || '', '直播链接': 'https://live.bilibili.com/' + (current.room_id || roomId), '分区': current.area_name || '未知', '父分区': current.parent_area_name || '未知', '人气': current.online || 0, '封面': current.user_cover || '', '签名': (userInfo && userInfo.sign) || '', '粉丝': (userInfo && userInfo.follower) || 0, '关注': (userInfo && userInfo.following) || 0, '等级': levelDisplay, '性别': (userInfo && userInfo.sex) || '', 'VIP类型': vipType, 'VIP状态': vipStatus, '投稿数': (userInfo && userInfo.archive_count) || 0, '文章数': (userInfo && userInfo.article_count) || 0, '头像': (userInfo && userInfo.face) || '', '时间': now }; const configs = await getNotifyConfigs(env); let template = null; for (const cfg of configs) { if (cfg.template && cfg.template.trim()) { template = cfg.template; break; } } return renderTemplate(template, baseVars); }

async function processRoom(roomId, env, options) { options = options || {}; roomId = toRoomId(roomId); let current; try { current = await fetchLiveStatus(roomId); const liveStatus = Number(current.live_status ?? current.livestatus ?? current.liveStatus ?? 0); current.live_status = liveStatus; const prev = await getMonitorState(env, roomId); await addLog('info', '[' + roomId + '] 检查: API状态=' + liveStatus + ', 人气=' + (current.online || 0) + ', 标题=' + (current.title || '未知') + ', 旧状态=' + (prev.state || '未知'), env); } catch (e) { await addLog('error', '[' + roomId + '] 获取状态失败: ' + e.message, env); return { error: e.message }; } const isLive = CONFIG.IS_LIVE_STATUS.includes(current.live_status); const state = isLive ? 'LIVE' : 'OFFLINE'; const oldState = prev.state || 'OFFLINE'; const events = []; if (oldState !== state) { await addLog('info', '[' + roomId + '] 状态变化: ' + oldState + ' -> ' + state, env); if (state === 'LIVE') { events.push({ type: 'live_start', data: current }); } else { events.push({ type: 'live_end', data: current }); } } else if (state === 'LIVE') { const oldTitle = (prev.last_title || '').trim(); const newTitle = (current.title || '').trim(); if (oldTitle && oldTitle !== newTitle) { events.push({ type: 'title_change', data: current, old_title: prev.last_title || '' }); } if (normalizeCover(prev.last_cover) !== normalizeCover(current.user_cover)) { events.push({ type: 'cover_change', data: current, old_cover: prev.last_cover }); } if (String(prev.last_area || '') !== String(current.area_name || '') || String(prev.last_parent_area || '') !== String(current.parent_area_name || '')) { events.push({ type: 'area_change', data: current, old_area: prev.last_area || '', old_parent_area: prev.last_parent_area || '' }); } const prevOnline = prev.last_online || 0; for (const milestone of CONFIG.POPULARITY_MILESTONES) { if (prevOnline < milestone && current.online >= milestone) { events.push({ type: 'popularity_milestone', data: current, milestone: milestone }); } } } const changed = (prev.state !== state) || (prev.last_title !== (current.title || '')) || (normalizeCover(prev.last_cover) !== normalizeCover(current.user_cover)) || (prev.last_area !== (current.area_name || '')) || (prev.last_parent_area !== (current.parent_area_name || '')) || (prev.last_online !== Number(current.online || 0)); if (changed) { const newState = { room_id: roomId, state: state, last_live_time: current.live_time || prev.last_live_time || '', last_title: current.title || '', last_cover: current.user_cover || '', last_area: current.area_name || '', last_parent_area: current.parent_area_name || '', last_online: Number(current.online || 0), last_events: events.map(e => e.type), last_update: new Date().toISOString(), last_check: Date.now(), version: 3 }; await setMonitorState(env, roomId, newState); } for (const evt of events) { const text = await buildNotification(roomId, evt.data, env, evt.type, evt); const success = await sendNotification(text, env, { event: evt.type, room_id: roomId, ...evt.data }); if (success) { await addLog('info', '[' + roomId + '] 事件 ' + evt.type + ' 已通知', env); } else { await addLog('error', '[' + roomId + '] 事件 ' + evt.type + ' 发送失败', env); } } return { state: state, events: events }; }

async function monitorAll(env, options) { options = options || {}; const roomIds = await getRoomList(env); if (roomIds.length === 0) { await addLog('warn', '房间列表为空，跳过检查', env); return { error: '房间列表为空' }; } await addLog('info', '开始批量检查 ' + roomIds.length + ' 个房间' + (options.force ? ' (强制刷新)' : ''), env); const results = []; for (const id of roomIds) { const roomId = toRoomId(id); try { const res = await processRoom(roomId, env, { force: options.force }); results.push({ room_id: roomId, ...res }); } catch (e) { await addLog('error', '处理房间 ' + roomId + ' 失败: ' + e.message, env); results.push({ room_id: roomId, error: e.message }); } } await addLog('info', '批量检查完成，共 ' + results.length + ' 个结果', env); return results; }

function isAuthenticated(request, env) {
  const cookie = request.headers.get('Cookie') || '';
  const authCookie = cookie.split(';').find(c => c.trim().startsWith('auth='));
  if (!authCookie) return false;
  const authValue = authCookie.split('=')[1];
  try {
    const decoded = atob(authValue);
    const parts = decoded.split(':');
    return parts[0] === env.ADMIN_USER && parts[1] === env.ADMIN_PASSWORD;
  } catch { return false; }
}

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.FRONTEND_URL || 'https://live.262832.xyz',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true'
  };
}

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders(env) });
  }

  if (path === '/api/login' && method === 'POST') {
    let body; try { body = await request.json(); } catch { body = {}; }
    const { username, password } = body;
    if (username === env.ADMIN_USER && password === env.ADMIN_PASSWORD) {
      const auth = btoa(username + ':' + password);
      const headers = {
        ...corsHeaders(env),
        'Set-Cookie': 'auth=' + auth + '; HttpOnly; Secure; Path=/; Max-Age=86400; SameSite=Lax',
        'Content-Type': 'application/json'
      };
      return new Response(JSON.stringify({ success: true }), { headers });
    } else {
      return new Response(JSON.stringify({ success: false, error: '用户名或密码错误' }), { status: 401, headers: corsHeaders(env) });
    }
  }

  if (path === '/api/logout' && method === 'POST') {
    const headers = {
      ...corsHeaders(env),
      'Set-Cookie': 'auth=; HttpOnly; Secure; Path=/; Max-Age=0; SameSite=Lax',
      'Content-Type': 'application/json'
    };
    return new Response(JSON.stringify({ success: true }), { headers });
  }

  if (path === '/api/me' && method === 'GET') {
    if (!isAuthenticated(request, env)) {
      return new Response(JSON.stringify({ error: '未认证' }), { status: 401, headers: corsHeaders(env) });
    }
    return new Response(JSON.stringify({ username: env.ADMIN_USER }), { headers: { ...corsHeaders(env), 'Content-Type': 'application/json' } });
  }

  if (!isAuthenticated(request, env)) {
    return new Response(JSON.stringify({ error: '未认证' }), { status: 401, headers: corsHeaders(env) });
  }

  if (path === '/api/rooms' && method === 'GET') {
    const rooms = await getRoomList(env);
    const states = {};
    for (const id of rooms) {
      states[id] = await getMonitorState(env, id);
    }
    return new Response(JSON.stringify({ rooms, states }), { headers: { ...corsHeaders(env), 'Content-Type': 'application/json' } });
  }

  if (path === '/api/rooms' && method === 'POST') {
    let body; try { body = await request.json(); } catch { body = {}; }
    const roomId = toRoomId(body.room_id || '');
    if (!roomId) return new Response(JSON.stringify({ error: '缺少房间号' }), { status: 400, headers: corsHeaders(env) });
    await addRoom(env, roomId);
    await addLog('info', '添加房间 ' + roomId, env);
    try { await processRoom(roomId, env, { force: true }); } catch (e) {}
    return new Response(JSON.stringify({ success: true }), { headers: corsHeaders(env) });
  }

  if (path === '/api/rooms' && method === 'DELETE') {
    let body; try { body = await request.json(); } catch { body = {}; }
    const roomId = toRoomId(body.room_id || '');
    if (!roomId) return new Response(JSON.stringify({ error: '缺少房间号' }), { status: 400, headers: corsHeaders(env) });
    await removeRoom(env, roomId);
    await addLog('info', '删除房间 ' + roomId, env);
    return new Response(JSON.stringify({ success: true }), { headers: corsHeaders(env) });
  }

  if (path === '/api/logs' && method === 'GET') {
    const logs = await getLogs(env);
    return new Response(JSON.stringify(logs), { headers: { ...corsHeaders(env), 'Content-Type': 'application/json' } });
  }
  if (path === '/api/logs/clear' && method === 'POST') {
    await clearLogs(env);
    return new Response(JSON.stringify({ success: true }), { headers: corsHeaders(env) });
  }

  if (path === '/api/notify-configs' && method === 'GET') {
    const configs = await getNotifyConfigs(env);
    return new Response(JSON.stringify(configs), { headers: { ...corsHeaders(env), 'Content-Type': 'application/json' } });
  }
  if (path === '/api/notify-configs' && method === 'POST') {
    let body; try { body = await request.json(); } catch { body = {}; }
    const { name, protocol, api_url, chat_id, template, extra_params } = body;
    if (!name) return new Response(JSON.stringify({ error: '缺少名称' }), { status: 400, headers: corsHeaders(env) });
    const config = { name, protocol: protocol || 'telegram', api_url: api_url || '', chat_id: chat_id || '', receiver_key: body.receiver_key || 'chat_id', message_key: body.message_key || 'text', template: template || CONFIG.DEFAULT_TEMPLATE, extra_params: extra_params || {}, enabled: true };
    const result = await addNotifyConfig(env, config);
    await addLog('info', '添加通知配置 ' + name, env);
    return new Response(JSON.stringify(result), { headers: { ...corsHeaders(env), 'Content-Type': 'application/json' } });
  }
  if (path === '/api/notify-configs' && method === 'DELETE') {
    let body; try { body = await request.json(); } catch { body = {}; }
    const id = body.id; if (!id) return new Response(JSON.stringify({ error: '缺少ID' }), { status: 400, headers: corsHeaders(env) });
    await deleteNotifyConfig(env, id);
    await addLog('info', '删除通知配置 ' + id, env);
    return new Response(JSON.stringify({ success: true }), { headers: corsHeaders(env) });
  }
  if (path === '/api/notify-configs/toggle' && method === 'POST') {
    let body; try { body = await request.json(); } catch { body = {}; }
    const id = body.id; if (!id) return new Response(JSON.stringify({ error: '缺少ID' }), { status: 400, headers: corsHeaders(env) });
    try { await toggleNotifyConfig(env, id); await addLog('info', '切换通知配置状态 ' + id, env); return new Response(JSON.stringify({ success: true }), { headers: corsHeaders(env) }); } catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 404, headers: corsHeaders(env) }); }
  }
  if (path === '/api/notify-configs/test' && method === 'POST') {
    let body; try { body = await request.json(); } catch { body = {}; }
    const id = body.id; if (!id) return new Response(JSON.stringify({ error: '缺少ID' }), { status: 400, headers: corsHeaders(env) });
    const configs = await getNotifyConfigs(env); const config = configs.find(c => c.id === id);
    if (!config) return new Response(JSON.stringify({ error: '配置不存在' }), { status: 404, headers: corsHeaders(env) });
    const roomIds = await getRoomList(env); if (!roomIds.length) return new Response(JSON.stringify({ error: '房间列表为空' }), { status: 400, headers: corsHeaders(env) });
    const roomId = toRoomId(roomIds[Math.floor(Math.random() * roomIds.length)]);
    try {
      const current = await fetchLiveStatus(roomId);
      const liveStatus = Number(current.live_status ?? current.livestatus ?? current.liveStatus ?? 0);
      current.live_status = liveStatus;
      const isLive = CONFIG.IS_LIVE_STATUS.includes(liveStatus);
      if (!isLive) { const last = await getMonitorState(env, roomId); current.title = last.last_title || current.title || '模拟标题'; current.online = last.last_online || 0; current.area_name = last.last_area || current.area_name || '未知分区'; current.parent_area_name = last.last_parent_area || current.parent_area_name || '未知父分区'; current.live_time = last.last_live_time || ''; current.uid = current.uid || 0; }
      const eventType = isLive ? 'live_start' : 'live_end';
      const text = await buildNotification(roomId, current, env, eventType);
      const testText = '[测试] ' + text;
      const result = await sendNotificationToConfig(config, testText, { event: eventType, room_id: roomId, ...current });
      if (result.success) { await addLog('info', '测试通知成功 ' + config.name + ' 房间 ' + roomId, env); return new Response(JSON.stringify({ success: true, message: '测试通知发送成功' }), { headers: corsHeaders(env) }); } else { return new Response(JSON.stringify({ success: false, error: result.error }), { status: 500, headers: corsHeaders(env) }); }
    } catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders(env) }); }
  }

  if (path === '/api/monitor' && method === 'POST') {
    let body; try { body = await request.json(); } catch { body = {}; }
    const force = body.force === true;
    await addLog('info', force ? '手动强制刷新' : '手动检查', env);
    const result = await monitorAll(env, { force: force });
    return new Response(JSON.stringify(result), { headers: { ...corsHeaders(env), 'Content-Type': 'application/json' } });
  }

  if (path === '/api/send-live-notify' && method === 'POST') {
    const roomIds = await getRoomList(env);
    if (!roomIds.length) return new Response(JSON.stringify({ error: '房间列表为空' }), { status: 400, headers: corsHeaders(env) });
    const roomId = toRoomId(roomIds[Math.floor(Math.random() * roomIds.length)]);
    try {
      const current = await fetchLiveStatus(roomId);
      const liveStatus = Number(current.live_status ?? current.livestatus ?? current.liveStatus ?? 0);
      current.live_status = liveStatus;
      const isLive = CONFIG.IS_LIVE_STATUS.includes(liveStatus);
      if (!isLive) { const last = await getMonitorState(env, roomId); current.title = last.last_title || current.title || '模拟标题'; current.online = last.last_online || 0; current.area_name = last.last_area || current.area_name || '未知分区'; current.parent_area_name = last.last_parent_area || current.parent_area_name || '未知父分区'; current.live_time = last.last_live_time || ''; current.uid = current.uid || 0; }
      const eventType = isLive ? 'live_start' : 'live_end';
      const text = await buildNotification(roomId, current, env, eventType);
      const success = await sendNotification(text, env, { event: eventType, room_id: roomId, ...current });
      if (success) { await addLog('info', '手动发送模拟通知 ' + roomId, env); return new Response(JSON.stringify({ success: true, message: '已发送 ' + eventType + ' 通知' }), { headers: corsHeaders(env) }); } else { return new Response(JSON.stringify({ success: false, error: '通知发送失败，请检查配置' }), { status: 500, headers: corsHeaders(env) }); }
    } catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders(env) }); }
  }

  return new Response(JSON.stringify({ error: 'Not Found' }), { status: 404, headers: corsHeaders(env) });
}

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },
  async scheduled(event, env) {
    await addLog('info', 'Cron检测启动', env);
    try {
      const result = await monitorAll(env);
      await addLog('info', 'Cron检测完成: ' + JSON.stringify(result), env);
    } catch (e) {
      await addLog('error', 'Cron检测异常: ' + e.message, env);
    }
  }
};
