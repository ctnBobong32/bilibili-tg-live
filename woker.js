var MAIN_API = 'https://uapis.cn/api/v1/social/bilibili/liveroom';
var USER_API = 'https://uapis.cn/api/v1/social/bilibili/userinfo';
var IS_LIVE_STATUS = [1, 2];
var CACHE_TTL = 604800;
var NOTIFY_COOLDOWN_MS = 12 * 60 * 60 * 1000;
var MAX_LOG_ENTRIES = 200;
var USER_INFO_TTL = 86400;

function getRoomList(env) {
  return env.ROOM_STORE.get('rooms', 'json').then(function(val) {
    return val || [];
  });
}

function setRoomList(env, rooms) {
  return env.ROOM_STORE.put('rooms', JSON.stringify(rooms));
}

function addRoom(env, roomId) {
  return getRoomList(env).then(function(rooms) {
    if (rooms.indexOf(roomId) === -1) {
      rooms.push(roomId);
      return setRoomList(env, rooms);
    }
    return rooms;
  });
}

function removeRoom(env, roomId) {
  return getRoomList(env).then(function(rooms) {
    rooms = rooms.filter(function(id) { return id !== roomId; });
    return setRoomList(env, rooms);
  });
}

function getNotifyConfigs(env) {
  return env.ROOM_STORE.get('notify_configs', 'json').then(function(val) {
    return val || [];
  });
}

function setNotifyConfigs(env, configs) {
  return env.ROOM_STORE.put('notify_configs', JSON.stringify(configs));
}

function addNotifyConfig(env, config) {
  return getNotifyConfigs(env).then(function(configs) {
    config.id = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    configs.push(config);
    return setNotifyConfigs(env, configs);
  });
}

function deleteNotifyConfig(env, id) {
  return getNotifyConfigs(env).then(function(configs) {
    configs = configs.filter(function(c) { return c.id !== id; });
    return setNotifyConfigs(env, configs);
  });
}

function buildCacheKey() {
  var parts = Array.prototype.slice.call(arguments);
  return parts.join(':');
}

function getCache(key) {
  var cache = caches.default;
  var req = new Request('https://cache/' + key);
  return cache.match(req).then(function(resp) {
    if (resp && resp.ok) {
      return resp.json();
    }
    return null;
  });
}

function setCache(key, data, ttl) {
  ttl = ttl || CACHE_TTL;
  var cache = caches.default;
  var resp = new Response(JSON.stringify(data), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'max-age=' + ttl
    }
  });
  return cache.put(new Request('https://cache/' + key), resp);
}

function getLogs() {
  return getCache('logs').then(function(logs) {
    return logs || [];
  });
}

function addLog(level, message) {
  var timestamp = new Date().toISOString();
  var logEntry = {
    time: timestamp,
    level: level,
    message: message
  };
  // 同时输出到控制台（Worker 日志）
  if (level === 'error') {
    console.error('[' + timestamp + '] [' + level.toUpperCase() + '] ' + message);
  } else if (level === 'warn') {
    console.warn('[' + timestamp + '] [' + level.toUpperCase() + '] ' + message);
  } else {
    console.log('[' + timestamp + '] [' + level.toUpperCase() + '] ' + message);
  }
  return getLogs().then(function(logs) {
    logs.unshift(logEntry);
    if (logs.length > MAX_LOG_ENTRIES) {
      logs.length = MAX_LOG_ENTRIES;
    }
    return setCache('logs', logs, 86400);
  });
}

function clearLogs() {
  return setCache('logs', [], 86400).then(function() {
    return addLog('info', '日志已清除');
  });
}

function getMonitorState(roomId) {
  var key = buildCacheKey('monitor', roomId);
  return getCache(key).then(function(state) {
    return state || {
      last_status: null,
      last_data: null,
      last_notify_type: null,
      last_notify_time: 0,
      last_update: null
    };
  });
}

function setMonitorState(roomId, state) {
  state.last_update = new Date().toISOString();
  var key = buildCacheKey('monitor', roomId);
  return setCache(key, state);
}

function saveLiveData(roomId, liveInfo) {
  var key = buildCacheKey('livedata', roomId);
  return setCache(key, liveInfo);
}

function shouldNotify(roomId, type, now) {
  now = now || Date.now();
  return getMonitorState(roomId).then(function(state) {
    if (state.last_notify_type === type && (now - state.last_notify_time) < NOTIFY_COOLDOWN_MS) {
      return addLog('info', '[' + roomId + '] 跳过重复通知 (' + type + ')，冷却中').then(function() {
        return false;
      });
    }
    return true;
  });
}

function markNotified(roomId, type, now) {
  now = now || Date.now();
  return getMonitorState(roomId).then(function(state) {
    state.last_notify_type = type;
    state.last_notify_time = now;
    return setMonitorState(roomId, state);
  });
}

function fetchLiveStatus(roomId) {
  var url = MAIN_API + '?room_id=' + encodeURIComponent(roomId);
  return addLog('info', '[' + roomId + '] 请求UAPI: ' + url).then(function() {
    return fetch(url, {
      headers: { 'User-Agent': 'CloudflareWorker/1.0', 'Accept': 'application/json' }
    });
  }).then(function(resp) {
    if (!resp.ok) {
      throw new Error('UAPI请求失败 (' + resp.status + ')');
    }
    return resp.json();
  }).then(function(data) {
    if (!data.room_id) {
      throw new Error('UAPI返回数据缺少room_id');
    }
    return data;
  });
}

function fetchUserInfo(uid) {
  var cacheKey = buildCacheKey('userinfo', uid);
  return getCache(cacheKey).then(function(cached) {
    if (cached) {
      return addLog('info', '用户信息缓存命中: ' + uid).then(function() {
        return cached;
      });
    }
    var url = USER_API + '?uid=' + encodeURIComponent(uid);
    return fetch(url, {
      headers: { 'User-Agent': 'CloudflareWorker/1.0', 'Accept': 'application/json' }
    }).then(function(resp) {
      if (!resp.ok) {
        throw new Error('用户信息API请求失败 (' + resp.status + ')');
      }
      return resp.json();
    }).then(function(data) {
      if (!data.mid) {
        throw new Error('用户信息API返回缺少mid');
      }
      return setCache(cacheKey, data, USER_INFO_TTL).then(function() {
        return data;
      });
    });
  });
}

function sendNotificationToConfig(config, text) {
  try {
    var payload = {};
    var receiverKey = config.receiver_key || 'chat_id';
    var messageKey = config.message_key || 'text';
    payload[receiverKey] = config.chat_id;
    payload[messageKey] = text;
    if (config.extra_params) {
      Object.assign(payload, config.extra_params);
    }
    return addLog('info', '发送通知到 ' + config.name + ': ' + config.api_url).then(function() {
      return fetch(config.api_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }).then(function(resp) {
      if (resp.ok) {
        return addLog('info', '通知发送成功 (' + config.name + ')').then(function() {
          return { success: true };
        });
      } else {
        return resp.text().then(function(errText) {
          return addLog('error', '通知发送失败 (' + config.name + '): HTTP ' + resp.status + ' ' + errText).then(function() {
            return { success: false, error: 'HTTP ' + resp.status + ' ' + errText };
          });
        });
      }
    });
  } catch (e) {
    return addLog('error', '通知发送异常 (' + config.name + '): ' + e.message).then(function() {
      return { success: false, error: e.message };
    });
  }
}

function sendNotification(text, env) {
  return getNotifyConfigs(env).then(function(configs) {
    var enabled = configs.filter(function(c) { return c.enabled !== false; });
    if (enabled.length === 0) {
      return addLog('warn', '没有启用的通知配置').then(function() {
        return false;
      });
    }
    var successCount = 0;
    var promise = Promise.resolve();
    enabled.forEach(function(config) {
      promise = promise.then(function() {
        return sendNotificationToConfig(config, text).then(function(result) {
          if (result.success) {
            successCount++;
          }
        });
      });
    });
    return promise.then(function() {
      return successCount > 0;
    });
  });
}

function buildLiveNotification(roomId, current, env) {
  var userInfo = null;
  return fetchUserInfo(current.uid).then(function(info) {
    userInfo = info;
    return addLog('info', '[' + roomId + '] 获取主播信息成功: ' + userInfo.name);
  }).catch(function(e) {
    return addLog('warn', '[' + roomId + '] 获取主播信息失败: ' + e.message);
  }).then(function() {
    var anchorName = (userInfo && userInfo.name) ? userInfo.name : '房间 ' + roomId;
    var msg = '[开播] ' + anchorName + ' 开播了\n' +
              '标题：' + current.title + '\n' +
              '人气：' + current.online + '\n' +
              '开播时间：' + (current.live_time || '刚刚') + '\n' +
              '房间号：' + current.room_id + '\n' +
              '分区：' + current.parent_area_name + ' - ' + current.area_name;
    if (userInfo) {
      if (userInfo.sign) msg += '\n签名：' + userInfo.sign;
      if (userInfo.follower !== undefined) msg += '\n粉丝：' + userInfo.follower;
      if (userInfo.following !== undefined) msg += '\n关注：' + userInfo.following;
      if (userInfo.level !== undefined) msg += '\n等级：' + userInfo.level;
      if (userInfo.sex) msg += '\n性别：' + userInfo.sex;
    }
    return msg;
  });
}

function sendLiveNotification(roomId, current, env) {
  return buildLiveNotification(roomId, current, env).then(function(msg) {
    return sendNotification(msg, env);
  });
}

function monitorOne(roomId, env) {
  var current = null;
  return addLog('info', '[' + roomId + '] 开始监控检查').then(function() {
    return fetchLiveStatus(roomId);
  }).then(function(data) {
    current = data;
    var statusText = current.live_status === 1 ? '直播中' : (current.live_status === 2 ? '轮播中' : '未开播');
    return addLog('info', '[' + roomId + '] 检查完成，直播状态: ' + statusText + ', 人气: ' + current.online);
  }).catch(function(err) {
    var msg = '[' + roomId + '] 获取状态失败: ' + err.message;
    return addLog('error', msg).then(function() {
      return { error: err.message };
    });
  }).then(function() {
    if (current && current.error) {
      return current;
    }
    var isLive = IS_LIVE_STATUS.indexOf(current.live_status) !== -1;
    if (isLive && current.online === 0) {
      return addLog('warn', '[' + roomId + '] 开播但人气为0，跳过本次检查').then(function() {
        return { current: current, skipped: true };
      });
    }
    return getMonitorState(roomId).then(function(prev) {
      var statusChanged = (prev.last_status !== isLive);
      return addLog('info', '[' + roomId + '] 状态变化: ' + prev.last_status + ' -> ' + isLive + ', changed: ' + statusChanged).then(function() {
        return setMonitorState(roomId, {
          last_status: isLive,
          last_data: current
        });
      }).then(function() {
        if (isLive) {
          return saveLiveData(roomId, current);
        }
      }).then(function() {
        if (statusChanged) {
          if (isLive) {
            return shouldNotify(roomId, 'live').then(function(canNotify) {
              if (canNotify) {
                return sendLiveNotification(roomId, current, env).then(function() {
                  return markNotified(roomId, 'live');
                }).then(function() {
                  return addLog('info', '[' + roomId + '] 发送开播通知');
                });
              } else {
                return addLog('info', '[' + roomId + '] 开播通知被跳过（冷却中）');
              }
            });
          } else {
            if (current.online > 0) {
              return shouldNotify(roomId, 'offline').then(function(canNotify) {
                if (canNotify) {
                  var anchorName = '房间 ' + roomId;
                  return fetchUserInfo(current.uid).then(function(userInfo) {
                    if (userInfo.name) anchorName = userInfo.name;
                  }).catch(function() {}).then(function() {
                    var msg = '[下播] ' + anchorName + ' 直播已结束\n最后人气：' + current.online;
                    return sendNotification(msg, env);
                  }).then(function() {
                    return markNotified(roomId, 'offline');
                  }).then(function() {
                    return addLog('info', '[' + roomId + '] 发送下播通知（人气 ' + current.online + '）');
                  });
                } else {
                  return addLog('info', '[' + roomId + '] 下播通知被跳过（冷却中）');
                }
              });
            } else {
              return addLog('info', '[' + roomId + '] 下播但人气为0，不发送下播通知');
            }
          }
        } else {
          return addLog('info', '[' + roomId + '] 状态无变化，跳过通知');
        }
      });
    });
  }).then(function(result) {
    return result || { current: current, changed: false };
  });
}

function monitorAll(env) {
  return addLog('info', '========== 开始批量检查所有房间 ==========').then(function() {
    return getRoomList(env);
  }).then(function(roomIds) {
    if (roomIds.length === 0) {
      return addLog('warn', '房间列表为空，跳过检查').then(function() {
        return { error: '房间列表为空' };
      });
    }
    return addLog('info', '共有 ' + roomIds.length + ' 个房间需要检查').then(function() {
      var results = [];
      var promise = Promise.resolve();
      roomIds.forEach(function(roomId) {
        promise = promise.then(function() {
          return monitorOne(roomId, env).then(function(res) {
            var item = { room_id: roomId };
            for (var key in res) {
              if (res.hasOwnProperty(key)) {
                item[key] = res[key];
              }
            }
            results.push(item);
          }).catch(function(err) {
            var msg = '监控失败 ' + roomId + ': ' + err.message;
            return addLog('error', msg).then(function() {
              results.push({ room_id: roomId, error: err.message });
            });
          });
        });
      });
      return promise.then(function() {
        return addLog('info', '========== 批量检查完成，共 ' + results.length + ' 个结果 ==========').then(function() {
          return results;
        });
      });
    });
  });
}

function isAuthenticated(request, env) {
  var cookie = request.headers.get('Cookie') || '';
  var authCookie = cookie.split(';').filter(function(c) { return c.trim().startsWith('auth='); })[0];
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

function renderLoginPage(redirect) {
  redirect = redirect || '';
  return '<!DOCTYPE html>\n<html lang="zh">\n<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>管理员登录</title><link href="https://cdnjs.cloudflare.com/ajax/libs/tailwindcss/2.2.19/tailwind.min.css" rel="stylesheet"></head>\n<body class="bg-gray-100 min-h-screen flex items-center justify-center">\n  <div class="bg-white p-8 rounded-xl shadow-md w-96">\n    <h1 class="text-2xl font-bold text-center text-gray-800 mb-6">管理登录</h1>\n    <form method="POST" action="/login" class="space-y-4">\n      <input type="hidden" name="redirect" value="' + redirect + '">\n      <div><label class="block text-sm font-medium text-gray-700">用户名</label><input type="text" name="username" required class="mt-1 w-full px-4 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500"></div>\n      <div><label class="block text-sm font-medium text-gray-700">密码</label><input type="password" name="password" required class="mt-1 w-full px-4 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500"></div>\n      <button type="submit" class="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded-md transition">登录</button>\n    </form>\n  </div>\n</body></html>';
}

function renderAdminPage(env, message, messageType) {
  message = message || '';
  messageType = messageType || 'info';
  return getRoomList(env).then(function(roomIds) {
    return getNotifyConfigs(env).then(function(configs) {
      var cards = '';
      var promise = Promise.resolve();
      roomIds.forEach(function(roomId) {
        promise = promise.then(function() {
          return getMonitorState(roomId).then(function(state) {
            var isLive = state.last_status;
            var data = state.last_data || {};
            var title = data.title || '未知';
            var online = data.online !== undefined ? data.online : 0;
            var area = data.parent_area_name ? data.parent_area_name + ' - ' + data.area_name : '未知分区';
            var updateTime = state.last_update ? new Date(state.last_update).toLocaleString() : '从未更新';
            var statusText = isLive ? '直播中' : '未开播';
            var statusColorCls = isLive ? 'bg-green-500' : 'bg-gray-400';
            cards += '\n      <div class="flex items-start gap-4 p-4 bg-white rounded-xl border border-gray-200 hover:shadow-md transition-shadow">\n        <div class="w-3 h-3 rounded-full mt-1 flex-shrink-0 ' + statusColorCls + '"></div>\n        <div class="flex-1 min-w-0">\n          <div class="font-semibold text-sm text-gray-800">房间 ' + roomId + '</div>\n          <div class="text-base font-medium text-gray-900 truncate">' + title + '</div>\n          <div class="text-sm text-gray-600 mt-1">' + statusText + ' · 人气 ' + online + ' · ' + area + '</div>\n          <div class="text-xs text-gray-400 mt-1">更新于 ' + updateTime + '</div>\n        </div>\n        <form method="POST" action="/remove-room" class="m-0"><input type="hidden" name="room_id" value="' + roomId + '"><button type="submit" class="text-red-500 hover:text-red-700 text-sm">删除</button></form>\n      </div>';
          });
        });
      });
      return promise.then(function() {
        var configRows = '';
        configs.forEach(function(cfg) {
          var protocolLabel = {
            'telegram': 'Telegram',
            'onebot_private': 'OneBot私聊',
            'onebot_group': 'OneBot群聊'
          }[cfg.protocol] || cfg.protocol || '自定义';
          var status = cfg.enabled !== false ? '启用' : '禁用';
          var statusTextCls = cfg.enabled !== false ? 'text-green-600' : 'text-gray-400';
          configRows += '\n      <tr class="border-b border-gray-200">\n        <td class="py-2 px-3 text-sm">' + cfg.name + '</td>\n        <td class="py-2 px-3 text-sm text-gray-600">' + protocolLabel + '</td>\n        <td class="py-2 px-3 text-sm text-gray-600 truncate max-w-xs">' + cfg.api_url + '</td>\n        <td class="py-2 px-3 text-sm">' + cfg.chat_id + '</td>\n        <td class="py-2 px-3 text-sm ' + statusTextCls + '">' + status + '</td>\n        <td class="py-2 px-3 text-sm">\n          <button class="test-notify-btn text-blue-500 hover:text-blue-700 text-sm mr-2" data-id="' + cfg.id + '">测试</button>\n          <form method="POST" action="/delete-notify" class="inline"><input type="hidden" name="config_id" value="' + cfg.id + '"><button type="submit" class="text-red-500 hover:text-red-700 text-sm">删除</button></form>\n        </td>\n      </tr>';
        });
        var messageHtml = message ? '<div class="p-3 rounded-md mb-4 ' + (messageType === 'error' ? 'bg-red-100 text-red-700 border border-red-400' : 'bg-green-100 text-green-700 border border-green-400') + '">' + message + '</div>' : '';
        var html = '<!DOCTYPE html>\n<html lang="zh">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <title>直播监控管理</title>\n  <link href="https://cdnjs.cloudflare.com/ajax/libs/tailwindcss/2.2.19/tailwind.min.css" rel="stylesheet">\n  <script src="https://cdnjs.cloudflare.com/ajax/libs/axios/1.6.0/axios.min.js"></script>\n</head>\n<body class="bg-gray-50 font-sans p-4">\n  <div class="max-w-7xl mx-auto">\n    <div class="flex justify-between items-center mb-6">\n      <div><h1 class="text-3xl font-bold text-gray-800">直播监控管理</h1><p class="text-sm text-gray-500">管理监控房间和通知配置</p></div>\n      <form method="POST" action="/logout"><button type="submit" class="px-4 py-2 bg-gray-200 text-gray-700 rounded-md hover:bg-gray-300 transition">退出</button></form>\n    </div>\n    <div id="messageArea">' + messageHtml + '</div>\n    <div class="flex space-x-2 mb-6">\n      <button id="tabRooms" class="tab-btn px-4 py-2 rounded-md bg-blue-600 text-white" onclick="switchTab(\'rooms\')">监控房间</button>\n      <button id="tabNotifies" class="tab-btn px-4 py-2 rounded-md bg-gray-200 text-gray-700 hover:bg-gray-300" onclick="switchTab(\'notifies\')">通知配置</button>\n    </div>\n    <div id="panelRooms">\n      <div class="flex flex-wrap gap-4 mb-6">\n        <form method="POST" action="/add-room" class="flex gap-2 items-center">\n          <input type="text" name="room_id" placeholder="输入房间号" required class="px-3 py-2 border border-gray-300 rounded-md text-sm w-48">\n          <button type="submit" class="px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 transition">添加房间</button>\n        </form>\n        <button id="checkAllBtn" class="px-4 py-2 bg-green-600 text-white text-sm rounded-md hover:bg-green-700 transition">检查全部</button>\n        <button id="sendLiveNotifyBtn" class="px-4 py-2 bg-yellow-600 text-white text-sm rounded-md hover:bg-yellow-700 transition">发送开播通知</button>\n        <div class="flex gap-2 items-center">\n          <input id="singleCheckInput" placeholder="房间号" class="px-3 py-2 border border-gray-300 rounded-md text-sm w-32">\n          <button id="singleCheckBtn" class="px-4 py-2 bg-purple-600 text-white text-sm rounded-md hover:bg-purple-700 transition">单独检查</button>\n        </div>\n        <a href="/monitor" target="_blank" class="px-4 py-2 bg-gray-200 text-gray-700 text-sm rounded-md hover:bg-gray-300 transition">原始数据</a>\n      </div>\n      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">' + (cards || '<div class="col-span-full text-gray-500 text-center py-8">暂无监控房间，请添加</div>') + '</div>\n    </div>\n    <div id="panelNotifies" style="display:none;">\n      <div class="bg-white rounded-xl border border-gray-200 p-4 mb-6">\n        <h3 class="text-lg font-semibold mb-4">添加通知配置</h3>\n        <form method="POST" action="/add-notify" class="grid grid-cols-1 md:grid-cols-2 gap-4" id="addNotifyForm">\n          <div><label class="block text-sm font-medium text-gray-700">名称</label><input type="text" name="name" placeholder="例如：主Telegram" required class="mt-1 w-full px-3 py-2 border border-gray-300 rounded-md text-sm"></div>\n          <div><label class="block text-sm font-medium text-gray-700">协议类型</label>\n            <select name="protocol" id="protocolSelect" class="mt-1 w-full px-3 py-2 border border-gray-300 rounded-md text-sm">\n              <option value="telegram">Telegram Bot API</option>\n              <option value="onebot_private">OneBot 私聊</option>\n              <option value="onebot_group">OneBot 群聊</option>\n            </select>\n          </div>\n          <div class="md:col-span-2" id="apiUrlGroup">\n            <label class="block text-sm font-medium text-gray-700">API 地址</label>\n            <input type="url" name="api_url" id="apiUrl" placeholder="https://api.telegram.org/bot<token>/sendMessage" class="mt-1 w-full px-3 py-2 border border-gray-300 rounded-md text-sm">\n          </div>\n          <div class="md:col-span-2" id="tgTokenGroup" style="display:none;">\n            <label class="block text-sm font-medium text-gray-700">Bot Token</label>\n            <input type="text" id="tgToken" placeholder="例如：123456:ABC-DEF..." class="mt-1 w-full px-3 py-2 border border-gray-300 rounded-md text-sm">\n            <p class="text-xs text-gray-500 mt-1">系统将自动构建 API 地址</p>\n          </div>\n          <div><label class="block text-sm font-medium text-gray-700" id="receiverLabel">接收者 ID (chat_id)</label>\n            <input type="text" name="chat_id" id="chatId" placeholder="例如：123456789" required class="mt-1 w-full px-3 py-2 border border-gray-300 rounded-md text-sm">\n          </div>\n          <div class="flex items-end"><label class="flex items-center text-sm text-gray-600"><input type="checkbox" name="enabled" checked value="1" class="mr-1"> 启用</label></div>\n          <div class="md:col-span-2"><button type="submit" class="px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 transition">添加配置</button></div>\n        </form>\n      </div>\n      <div class="bg-white rounded-xl border border-gray-200 p-4">\n        <h3 class="text-lg font-semibold mb-4">现有配置</h3>\n        <div class="overflow-x-auto">\n          <table class="min-w-full divide-y divide-gray-200">\n            <thead><tr><th class="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">名称</th><th class="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">协议</th><th class="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">API 地址</th><th class="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">接收 ID</th><th class="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">状态</th><th class="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">操作</th></tr></thead>\n            <tbody>' + (configRows || '<tr><td colspan="6" class="text-center text-gray-500 py-4">暂无配置</td></tr>') + '</tbody>\n          </table>\n        </div>\n      </div>\n    </div>\n    <div class="mt-8 bg-white rounded-xl border border-gray-200 p-4">\n      <div class="flex justify-between items-center mb-3">\n        <h2 class="text-lg font-semibold text-gray-800">详细日志</h2>\n        <div class="flex gap-2">\n          <button id="clearLogsBtn" class="px-3 py-1 bg-red-500 text-white text-sm rounded hover:bg-red-600 transition">清除日志</button>\n          <button id="refreshLogsBtn" class="px-3 py-1 bg-gray-200 text-gray-700 text-sm rounded hover:bg-gray-300 transition">刷新</button>\n          <label class="flex items-center text-sm text-gray-600"><input type="checkbox" id="autoRefresh" checked class="mr-1"> 自动刷新</label>\n        </div>\n      </div>\n      <div id="logContainer" class="max-h-64 overflow-y-auto"></div>\n    </div>\n  </div>\n  <script>\n    function switchTab(tab) {\n      document.getElementById(\'panelRooms\').style.display = tab === \'rooms\' ? \'block\' : \'none\';\n      document.getElementById(\'panelNotifies\').style.display = tab === \'notifies\' ? \'block\' : \'none\';\n      var roomsBtn = document.getElementById(\'tabRooms\');\n      var notifiesBtn = document.getElementById(\'tabNotifies\');\n      if (tab === \'rooms\') {\n        roomsBtn.className = \'tab-btn px-4 py-2 rounded-md bg-blue-600 text-white\';\n        notifiesBtn.className = \'tab-btn px-4 py-2 rounded-md bg-gray-200 text-gray-700 hover:bg-gray-300\';\n      } else {\n        roomsBtn.className = \'tab-btn px-4 py-2 rounded-md bg-gray-200 text-gray-700 hover:bg-gray-300\';\n        notifiesBtn.className = \'tab-btn px-4 py-2 rounded-md bg-blue-600 text-white\';\n      }\n    }\n\n    document.addEventListener(\'DOMContentLoaded\', function() {\n      var protocolSelect = document.getElementById(\'protocolSelect\');\n      var apiUrl = document.getElementById(\'apiUrl\');\n      var chatId = document.getElementById(\'chatId\');\n      var receiverLabel = document.getElementById(\'receiverLabel\');\n      var apiUrlGroup = document.getElementById(\'apiUrlGroup\');\n      var tgTokenGroup = document.getElementById(\'tgTokenGroup\');\n      var tgToken = document.getElementById(\'tgToken\');\n      var form = document.getElementById(\'addNotifyForm\');\n\n      function updateForm() {\n        var protocol = protocolSelect.value;\n        if (protocol === \'telegram\') {\n          apiUrl.placeholder = \'https://api.telegram.org/bot<token>/sendMessage\';\n          receiverLabel.textContent = \'接收者 ID (chat_id)\';\n          chatId.placeholder = \'例如：123456789\';\n          apiUrlGroup.style.display = \'none\';\n          tgTokenGroup.style.display = \'block\';\n          apiUrl.value = \'\';\n        } else if (protocol === \'onebot_private\') {\n          apiUrl.placeholder = \'http://127.0.0.1:5700/send_private_msg\';\n          receiverLabel.textContent = \'用户 ID (user_id)\';\n          chatId.placeholder = \'例如：123456789\';\n          apiUrlGroup.style.display = \'block\';\n          tgTokenGroup.style.display = \'none\';\n        } else if (protocol === \'onebot_group\') {\n          apiUrl.placeholder = \'http://127.0.0.1:5700/send_group_msg\';\n          receiverLabel.textContent = \'群 ID (group_id)\';\n          chatId.placeholder = \'例如：123456789\';\n          apiUrlGroup.style.display = \'block\';\n          tgTokenGroup.style.display = \'none\';\n        }\n      }\n      protocolSelect.addEventListener(\'change\', updateForm);\n      updateForm();\n\n      form.addEventListener(\'submit\', function(e) {\n        var protocol = protocolSelect.value;\n        if (protocol === \'telegram\') {\n          var token = tgToken.value.trim();\n          if (!token) {\n            alert(\'请输入 Bot Token\');\n            e.preventDefault();\n            return;\n          }\n          apiUrl.value = \'https://api.telegram.org/bot\' + token + \'/sendMessage\';\n        }\n        if (protocol !== \'telegram\' && !apiUrl.value.trim()) {\n          alert(\'请输入 API 地址\');\n          e.preventDefault();\n          return;\n        }\n        if (!chatId.value.trim()) {\n          alert(\'请输入接收者 ID\');\n          e.preventDefault();\n          return;\n        }\n      });\n\n      var logTimer = null;\n\n      function renderLogs(logs) {\n        var container = document.getElementById(\'logContainer\');\n        if (!logs || logs.length === 0) {\n          container.innerHTML = \'<div class="text-gray-400 text-sm">暂无日志</div>\';\n          return;\n        }\n        var html = \'\';\n        logs.forEach(function(entry) {\n          var levelColor = { info: \'text-blue-600\', warn: \'text-yellow-600\', error: \'text-red-600\' }[entry.level] || \'text-gray-600\';\n          html += \'<div class="text-xs font-mono py-1 border-b border-gray-100"><span class="text-gray-500 mr-2">\' + entry.time + \'</span><span class="\' + levelColor + \'">[\' + entry.level.toUpperCase() + \']</span> \' + entry.message + \'</div>\';\n        });\n        container.innerHTML = html;\n      }\n\n      function fetchLogs() {\n        axios.get(\'/logs\').then(function(res) { renderLogs(res.data); }).catch(function(err) { console.error(\'获取日志失败:\', err); });\n      }\n\n      document.getElementById(\'refreshLogsBtn\').addEventListener(\'click\', fetchLogs);\n\n      document.getElementById(\'clearLogsBtn\').addEventListener(\'click\', function() {\n        if (!confirm(\'确定清除所有日志吗？\')) return;\n        axios.post(\'/clear-logs\').then(function() { alert(\'日志已清除\'); fetchLogs(); }).catch(function(err) { alert(\'清除失败: \' + err.message); });\n      });\n\n      document.getElementById(\'autoRefresh\').addEventListener(\'change\', function() {\n        if (this.checked) { logTimer = setInterval(fetchLogs, 5000); fetchLogs(); } else { clearInterval(logTimer); logTimer = null; }\n      });\n\n      document.getElementById(\'autoRefresh\').checked = true;\n      logTimer = setInterval(fetchLogs, 5000);\n      fetchLogs();\n\n      document.getElementById(\'checkAllBtn\').addEventListener(\'click\', function() {\n        var btn = this; btn.disabled = true; btn.textContent = \'检查中...\';\n        axios.get(\'/monitor\').then(function() { location.reload(); }).catch(function() { location.reload(); });\n      });\n\n      document.getElementById(\'sendLiveNotifyBtn\').addEventListener(\'click\', function() {\n        var btn = this; btn.disabled = true; btn.textContent = \'发送中...\';\n        axios.post(\'/send-live-notify\').then(function(res) { alert(res.data.message); btn.disabled = false; btn.textContent = \'发送开播通知\'; }).catch(function(err) { alert(\'操作失败: \' + err.message); btn.disabled = false; btn.textContent = \'发送开播通知\'; });\n      });\n\n      document.getElementById(\'singleCheckBtn\').addEventListener(\'click\', function() {\n        var roomId = document.getElementById(\'singleCheckInput\').value.trim();\n        if (!roomId) return alert(\'请输入房间号\');\n        var btn = this; btn.disabled = true; btn.textContent = \'查询中...\';\n        axios.get(\'/check?room_id=\' + encodeURIComponent(roomId)).then(function(res) { alert(JSON.stringify(res.data, null, 2)); btn.disabled = false; btn.textContent = \'单独检查\'; }).catch(function(err) { alert(\'查询失败: \' + err.message); btn.disabled = false; btn.textContent = \'单独检查\'; });\n      });\n\n      document.querySelectorAll(\'.test-notify-btn\').forEach(function(btn) {\n        btn.addEventListener(\'click\', function() {\n          var id = this.dataset.id;\n          var originalText = this.textContent;\n          this.textContent = \'测试中...\';\n          this.disabled = true;\n          var formData = new URLSearchParams();\n          formData.append(\'config_id\', id);\n          axios.post(\'/test-notify\', formData, { headers: { \'Content-Type\': \'application/x-www-form-urlencoded\' } })\n            .then(function(res) {\n              document.getElementById(\'messageArea\').innerHTML = \'<div class="p-3 rounded-md mb-4 bg-green-100 text-green-700 border border-green-400">\' + res.data.message + \'</div>\';\n              this.textContent = originalText;\n              this.disabled = false;\n            }.bind(this))\n            .catch(function(err) {\n              document.getElementById(\'messageArea\').innerHTML = \'<div class="p-3 rounded-md mb-4 bg-red-100 text-red-700 border border-red-400">测试失败: \' + (err.response?.data?.message || err.message) + \'</div>\';\n              this.textContent = originalText;\n              this.disabled = false;\n            }.bind(this));\n        });\n      });\n    });\n  </script>\n</body>\n</html>';
        return html;
      });
    });
  });
}

export default {
  fetch: function(request, env) {
    var url = new URL(request.url);
    var path = url.pathname;

    if (path === '/logs') {
      return getLogs().then(function(logs) {
        return new Response(JSON.stringify(logs), { headers: { 'Content-Type': 'application/json' } });
      });
    }

    if (path === '/clear-logs') {
      if (!isAuthenticated(request, env)) return Promise.resolve(new Response('Unauthorized', { status: 401 }));
      return clearLogs().then(function() {
        return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
      });
    }

    if (path === '/send-live-notify') {
      if (!isAuthenticated(request, env)) return Promise.resolve(new Response('Unauthorized', { status: 401 }));
      return getRoomList(env).then(function(roomIds) {
        if (roomIds.length === 0) {
          return new Response(JSON.stringify({ success: false, message: '监控列表为空' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }
        var roomId = roomIds[0];
        return fetchLiveStatus(roomId).then(function(data) {
          var isLive = IS_LIVE_STATUS.indexOf(data.live_status) !== -1;
          if (isLive) {
            return sendLiveNotification(roomId, data, env).then(function() {
              return markNotified(roomId, 'live');
            }).then(function() {
              return addLog('info', '[' + roomId + '] 手动发送开播通知');
            }).then(function() {
              return new Response(JSON.stringify({ success: true, message: '已发送 ' + roomId + ' 的开播通知' }), { headers: { 'Content-Type': 'application/json' } });
            });
          } else {
            return new Response(JSON.stringify({ success: false, message: '房间 ' + roomId + ' 当前未开播' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
          }
        }).catch(function(err) {
          return new Response(JSON.stringify({ success: false, message: err.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
        });
      });
    }

    if (path === '/add-notify' && request.method === 'POST') {
      if (!isAuthenticated(request, env)) return Promise.resolve(new Response('Unauthorized', { status: 401 }));
      return request.formData().then(function(form) {
        var name = form.get('name');
        var protocol = form.get('protocol') || 'telegram';
        var api_url = form.get('api_url');
        var chat_id = form.get('chat_id');
        var enabled = form.get('enabled') === '1';
        if (!name || !chat_id) return new Response('缺少必要字段', { status: 400 });
        if (protocol === 'telegram' && !api_url) {
          var token = form.get('tg_token');
          if (token) {
            api_url = 'https://api.telegram.org/bot' + token + '/sendMessage';
          } else {
            return new Response('缺少 Bot Token', { status: 400 });
          }
        }
        if (!api_url) return new Response('缺少 API 地址', { status: 400 });
        var receiver_key = 'chat_id', message_key = 'text';
        if (protocol === 'onebot_private') { receiver_key = 'user_id'; message_key = 'message'; }
        else if (protocol === 'onebot_group') { receiver_key = 'group_id'; message_key = 'message'; }
        return addNotifyConfig(env, { name: name, protocol: protocol, api_url: api_url, chat_id: chat_id, receiver_key: receiver_key, message_key: message_key, extra_params: {}, enabled: enabled }).then(function() {
          return addLog('info', '添加通知配置: ' + name + ' (' + protocol + ')');
        }).then(function() {
          return renderAdminPage(env, '通知配置 "' + name + '" 已添加').then(function(html) {
            return new Response(html, { headers: { 'Content-Type': 'text/html' } });
          });
        });
      });
    }

    if (path === '/delete-notify' && request.method === 'POST') {
      if (!isAuthenticated(request, env)) return Promise.resolve(new Response('Unauthorized', { status: 401 }));
      return request.formData().then(function(form) {
        var id = form.get('config_id');
        if (!id) return new Response('缺少ID', { status: 400 });
        return deleteNotifyConfig(env, id).then(function() {
          return addLog('info', '删除通知配置 ID: ' + id);
        }).then(function() {
          return renderAdminPage(env, '通知配置已删除').then(function(html) {
            return new Response(html, { headers: { 'Content-Type': 'text/html' } });
          });
        });
      });
    }

    if (path === '/test-notify' && request.method === 'POST') {
      if (!isAuthenticated(request, env)) return Promise.resolve(new Response('Unauthorized', { status: 401 }));
      return request.formData().then(function(form) {
        var id = form.get('config_id');
        if (!id) return new Response('缺少ID', { status: 400 });
        return getNotifyConfigs(env).then(function(configs) {
          var config = null;
          for (var i = 0; i < configs.length; i++) {
            if (configs[i].id === id) { config = configs[i]; break; }
          }
          if (!config) return new Response('配置不存在', { status: 404 });
          return getRoomList(env).then(function(roomIds) {
            if (roomIds.length === 0) {
              return new Response(JSON.stringify({ success: false, message: '监控列表为空，无法测试' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
            }
            var roomId = roomIds[0];
            return fetchLiveStatus(roomId).then(function(data) {
              var isLive = IS_LIVE_STATUS.indexOf(data.live_status) !== -1;
              if (!isLive) {
                return new Response(JSON.stringify({ success: false, message: '房间 ' + roomId + ' 当前未开播，无法测试' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
              }
              return buildLiveNotification(roomId, data, env).then(function(msg) {
                return sendNotificationToConfig(config, msg);
              }).then(function(result) {
                if (result.success) {
                  return addLog('info', '测试通知成功 (' + config.name + ')').then(function() {
                    return new Response(JSON.stringify({ success: true, message: '测试通知发送成功 (' + config.name + ')' }), { headers: { 'Content-Type': 'application/json' } });
                  });
                } else {
                  return addLog('error', '测试通知失败 (' + config.name + '): ' + result.error).then(function() {
                    return new Response(JSON.stringify({ success: false, message: '发送失败: ' + result.error }), { status: 500, headers: { 'Content-Type': 'application/json' } });
                  });
                }
              });
            }).catch(function(err) {
              return addLog('error', '测试通知异常: ' + err.message).then(function() {
                return new Response(JSON.stringify({ success: false, message: err.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
              });
            });
          });
        });
      });
    }

    if (path === '/login') {
      if (request.method === 'POST') {
        return request.formData().then(function(form) {
          var username = form.get('username');
          var password = form.get('password');
          var redirect = form.get('redirect') || '/admin';
          if (username === env.ADMIN_USER && password === env.ADMIN_PASSWORD) {
            var auth = btoa(username + ':' + password);
            return new Response(null, { status: 302, headers: { 'Location': redirect, 'Set-Cookie': 'auth=' + auth + '; HttpOnly; Path=/; Max-Age=86400' } });
          } else {
            return new Response(renderLoginPage(redirect), { headers: { 'Content-Type': 'text/html' } });
          }
        });
      }
      return new Response(renderLoginPage(), { headers: { 'Content-Type': 'text/html' } });
    }

    if (path === '/logout') {
      return new Response(null, { status: 302, headers: { 'Location': '/login', 'Set-Cookie': 'auth=; HttpOnly; Path=/; Max-Age=0' } });
    }

    if (path === '/admin' || path === '/add-room' || path === '/remove-room') {
      if (!isAuthenticated(request, env)) {
        return new Response(renderLoginPage('/admin'), { headers: { 'Content-Type': 'text/html' }, status: 401 });
      }
    }

    if (path === '/add-room' && request.method === 'POST') {
      return request.formData().then(function(form) {
        var roomId = form.get('room_id');
        if (!roomId) return new Response('缺少房间号', { status: 400 });
        return addRoom(env, roomId.trim()).then(function() {
          return addLog('info', '添加房间 ' + roomId);
        }).then(function() {
          var notifyMsg = '';
          return fetchLiveStatus(roomId).then(function(data) {
            var isLive = IS_LIVE_STATUS.indexOf(data.live_status) !== -1;
            if (isLive) {
              return sendLiveNotification(roomId, data, env).then(function() {
                return markNotified(roomId, 'live');
              }).then(function() {
                return addLog('info', '[' + roomId + '] 添加后检测到开播，已发送开播通知');
              }).then(function() {
                notifyMsg = ' 检测到正在直播，已发送开播通知。';
              });
            } else {
              notifyMsg = ' 当前未开播。';
              return Promise.resolve();
            }
          }).catch(function(e) {
            return addLog('warn', '[' + roomId + '] 添加后检测开播失败: ' + e.message).then(function() {
              notifyMsg = ' 但检测开播失败: ' + e.message;
            });
          }).then(function() {
            return renderAdminPage(env, '房间 ' + roomId + ' 已添加。' + notifyMsg).then(function(html) {
              return new Response(html, { headers: { 'Content-Type': 'text/html' } });
            });
          });
        });
      });
    }

    if (path === '/remove-room' && request.method === 'POST') {
      return request.formData().then(function(form) {
        var roomId = form.get('room_id');
        if (!roomId) return new Response('缺少房间号', { status: 400 });
        return removeRoom(env, roomId).then(function() {
          return addLog('info', '删除房间 ' + roomId);
        }).then(function() {
          return renderAdminPage(env, '房间 ' + roomId + ' 已删除').then(function(html) {
            return new Response(html, { headers: { 'Content-Type': 'text/html' } });
          });
        });
      });
    }

    if (path === '/admin' || path === '/dashboard') {
      return renderAdminPage(env).then(function(html) {
        return new Response(html, { headers: { 'Content-Type': 'text/html' } });
      });
    }

    if (path === '/monitor') {
      return addLog('info', '手动触发检查全部房间').then(function() {
        return monitorAll(env);
      }).then(function(result) {
        return new Response(JSON.stringify(result, null, 2), { headers: { 'Content-Type': 'application/json' } });
      });
    }

    if (path === '/check') {
      var roomId = url.searchParams.get('room_id');
      if (!roomId) return new Response(JSON.stringify({ error: '缺少 room_id' }), { status: 400 });
      return fetchLiveStatus(roomId).then(function(data) {
        return addLog('info', '[' + roomId + '] 单查成功').then(function() {
          return new Response(JSON.stringify(data, null, 2), { headers: { 'Content-Type': 'application/json' } });
        });
      }).catch(function(err) {
        return addLog('error', '[' + roomId + '] 单查失败: ' + err.message).then(function() {
          return new Response(JSON.stringify({ error: err.message }), { status: 500 });
        });
      });
    }

    if (path === '/') {
      return new Response(null, { status: 302, headers: { 'Location': '/admin' } });
    }

    return new Response('B站直播监控 Worker 已运行。访问 /admin 管理。', { headers: { 'Content-Type': 'text/plain' } });
  },

  scheduled: function(event, env) {
    var startMsg = '定时任务开始执行 (Cron triggered)';
    console.log('[' + new Date().toISOString() + '] [INFO] ' + startMsg);
    return addLog('info', startMsg).then(function() {
      return monitorAll(env);
    }).then(function(result) {
      if (result && result.error) {
        var errMsg = '定时任务失败: ' + result.error;
        console.error('[' + new Date().toISOString() + '] [ERROR] ' + errMsg);
        return addLog('error', errMsg);
      } else {
        var sucMsg = '定时任务完成，共检查 ' + (result ? result.length : 0) + ' 个房间';
        console.log('[' + new Date().toISOString() + '] [INFO] ' + sucMsg);
        return addLog('info', sucMsg);
      }
    }).catch(function(err) {
      var errMsg = '定时任务异常: ' + err.message;
      console.error('[' + new Date().toISOString() + '] [ERROR] ' + errMsg);
      return addLog('error', errMsg);
    });
  }
};
