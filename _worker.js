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
  return '<!DOCTYPE html>\n<html lang="zh">\n<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>管理员登录</title><style>body{margin:0;font-family:system-ui;background:#f3f4f6;display:flex;align-items:center;justify-content:center;min-height:100vh}.container{background:white;padding:2rem;border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,0.1);width:100%;max-width:400px}h1{text-align:center;font-weight:600;color:#1f2937;margin-bottom:1.5rem}label{display:block;font-size:0.875rem;font-weight:500;color:#374151;margin-bottom:0.25rem}input{width:100%;padding:0.5rem 0.75rem;border:1px solid #d1d5db;border-radius:6px;font-size:0.875rem;margin-bottom:1rem}button{width:100%;background:#2563eb;color:white;font-weight:500;padding:0.5rem;border:none;border-radius:6px;font-size:0.875rem;cursor:pointer}button:hover{background:#1d4ed8}</style></head>\n<body>\n  <div class="container">\n    <h1>管理登录</h1>\n    <form method="POST" action="/login">\n      <input type="hidden" name="redirect" value="' + redirect + '">\n      <label>用户名</label>\n      <input type="text" name="username" required>\n      <label>密码</label>\n      <input type="password" name="password" required>\n      <button type="submit">登录</button>\n    </form>\n  </div>\n</body></html>';
}

function renderAdminPage(env, message, messageType) {
  message = message || '';
  messageType = messageType || 'info';
  return getRoomList(env).then(function(roomIds) {
    return getNotifyConfigs(env).then(function(configs) {
      var cardsHtml = '';
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
            var statusColor = isLive ? '#22c55e' : '#9ca3af';
            cardsHtml += '\n          <div style="background:white;border:1px solid #e5e7eb;border-radius:12px;padding:1rem;display:flex;gap:1rem;align-items:flex-start;transition:0.2s;box-shadow:0 1px 3px rgba(0,0,0,0.05)">\n            <div style="width:12px;height:12px;border-radius:50%;background:' + statusColor + ';flex-shrink:0;margin-top:4px"></div>\n            <div style="flex:1;min-width:0">\n              <div style="font-weight:600;font-size:0.875rem;color:#1f2937">房间 ' + roomId + '</div>\n              <div style="font-size:1rem;font-weight:500;color:#111827;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + title + '</div>\n              <div style="font-size:0.875rem;color:#4b5563;margin-top:4px">' + statusText + ' · 人气 ' + online + ' · ' + area + '</div>\n              <div style="font-size:0.75rem;color:#9ca3af;margin-top:4px">更新于 ' + updateTime + '</div>\n            </div>\n            <form method="POST" action="/remove-room" style="margin:0"><input type="hidden" name="room_id" value="' + roomId + '"><button type="submit" style="background:none;border:none;color:#ef4444;cursor:pointer;font-size:0.875rem">删除</button></form>\n          </div>';
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
          var statusColor = cfg.enabled !== false ? 'green' : 'gray';
          configRows += '\n          <tr style="border-bottom:1px solid #e5e7eb">\n            <td style="padding:0.5rem 0.75rem;font-size:0.875rem">' + cfg.name + '</td>\n            <td style="padding:0.5rem 0.75rem;font-size:0.875rem;color:#4b5563">' + protocolLabel + '</td>\n            <td style="padding:0.5rem 0.75rem;font-size:0.875rem;color:#4b5563;max-width:12rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + cfg.api_url + '</td>\n            <td style="padding:0.5rem 0.75rem;font-size:0.875rem">' + cfg.chat_id + '</td>\n            <td style="padding:0.5rem 0.75rem;font-size:0.875rem;color:' + (cfg.enabled !== false ? '#16a34a' : '#6b7280') + '">' + status + '</td>\n            <td style="padding:0.5rem 0.75rem;font-size:0.875rem">\n              <button class="test-btn" data-id="' + cfg.id + '" style="background:none;border:none;color:#2563eb;cursor:pointer;font-size:0.875rem;margin-right:0.5rem">测试</button>\n              <form method="POST" action="/delete-notify" style="display:inline"><input type="hidden" name="config_id" value="' + cfg.id + '"><button type="submit" style="background:none;border:none;color:#ef4444;cursor:pointer;font-size:0.875rem">删除</button></form>\n            </td>\n          </tr>';
        });

        var messageHtml = message ? '<div style="padding:0.75rem;border-radius:6px;margin-bottom:1rem;background:' + (messageType === 'error' ? '#fef2f2' : '#f0fdf4') + ';border:1px solid ' + (messageType === 'error' ? '#fecaca' : '#bbf7d0') + ';color:' + (messageType === 'error' ? '#991b1b' : '#166534') + '">' + message + '</div>' : '';

        var html = '<!DOCTYPE html>\n<html lang="zh">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <title>直播监控管理</title>\n  <style>\n    * { box-sizing: border-box; margin: 0; padding: 0; }\n    body { font-family: system-ui; background: #f3f4f6; padding: 1rem; }\n    .container { max-width: 1200px; margin: 0 auto; }\n    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem; }\n    .header h1 { font-size: 1.875rem; font-weight: 700; color: #1f2937; }\n    .header p { font-size: 0.875rem; color: #6b7280; }\n    .btn { padding: 0.5rem 1rem; border-radius: 6px; border: none; font-size: 0.875rem; cursor: pointer; transition: 0.2s; }\n    .btn-primary { background: #2563eb; color: white; }\n    .btn-primary:hover { background: #1d4ed8; }\n    .btn-success { background: #16a34a; color: white; }\n    .btn-success:hover { background: #15803d; }\n    .btn-warning { background: #ca8a04; color: white; }\n    .btn-warning:hover { background: #a16207; }\n    .btn-danger { background: #dc2626; color: white; }\n    .btn-danger:hover { background: #b91c1c; }\n    .btn-gray { background: #e5e7eb; color: #374151; }\n    .btn-gray:hover { background: #d1d5db; }\n    .tab-bar { display: flex; gap: 0.5rem; margin-bottom: 1.5rem; }\n    .tab-btn { padding: 0.5rem 1rem; border-radius: 6px; border: none; cursor: pointer; transition: 0.2s; font-size: 0.875rem; }\n    .tab-active { background: #2563eb; color: white; }\n    .tab-inactive { background: #e5e7eb; color: #374151; }\n    .tab-inactive:hover { background: #d1d5db; }\n    .card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 1rem; margin-bottom: 2rem; }\n    .panel { background: white; border-radius: 12px; border: 1px solid #e5e7eb; padding: 1.5rem; margin-bottom: 1.5rem; }\n    .panel h3 { font-size: 1.125rem; font-weight: 600; margin-bottom: 1rem; }\n    .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }\n    .form-grid .full { grid-column: span 2; }\n    label { display: block; font-size: 0.875rem; font-weight: 500; color: #374151; margin-bottom: 0.25rem; }\n    input, select { width: 100%; padding: 0.5rem; border: 1px solid #d1d5db; border-radius: 6px; font-size: 0.875rem; }\n    .flex-row { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }\n    .mt-4 { margin-top: 1rem; }\n    table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }\n    th { text-align: left; padding: 0.5rem 0.75rem; font-weight: 500; color: #6b7280; text-transform: uppercase; font-size: 0.75rem; border-bottom: 1px solid #e5e7eb; }\n    td { padding: 0.5rem 0.75rem; border-bottom: 1px solid #e5e7eb; }\n    .log-container { max-height: 16rem; overflow-y: auto; font-family: monospace; font-size: 0.75rem; background: #1f2937; color: #e5e7eb; padding: 0.75rem; border-radius: 6px; }\n    .log-entry { border-bottom: 1px solid #374151; padding: 0.25rem 0; }\n    .log-time { color: #9ca3af; margin-right: 0.5rem; }\n    .log-info { color: #60a5fa; }\n    .log-warn { color: #fbbf24; }\n    .log-error { color: #f87171; }\n    @media (max-width: 640px) { .form-grid { grid-template-columns: 1fr; } .form-grid .full { grid-column: span 1; } }\n  </style>\n</head>\n<body>\n  <div class="container">\n    <div class="header">\n      <div><h1>直播监控管理</h1><p>管理监控房间和通知配置</p></div>\n      <form method="POST" action="/logout"><button class="btn btn-gray">退出</button></form>\n    </div>\n\n    <div id="messageArea">' + messageHtml + '</div>\n\n    <div class="tab-bar">\n      <button id="tabRooms" class="tab-btn tab-active" onclick="switchTab(\'rooms\')">监控房间</button>\n      <button id="tabNotifies" class="tab-btn tab-inactive" onclick="switchTab(\'notifies\')">通知配置</button>\n    </div>\n\n    <div id="panelRooms">\n      <div class="flex-row">\n        <form method="POST" action="/add-room" class="flex-row" style="gap:0.5rem">\n          <input type="text" name="room_id" placeholder="输入房间号" required style="width:12rem">\n          <button type="submit" class="btn btn-primary">添加房间</button>\n        </form>\n        <button id="checkAllBtn" class="btn btn-success">检查全部</button>\n        <button id="sendLiveNotifyBtn" class="btn btn-warning">发送开播通知</button>\n        <div class="flex-row" style="gap:0.25rem">\n          <input id="singleCheckInput" placeholder="房间号" style="width:8rem">\n          <button id="singleCheckBtn" class="btn btn-gray">单独检查</button>\n        </div>\n        <a href="/monitor" target="_blank" class="btn btn-gray" style="text-decoration:none">原始数据</a>\n      </div>\n      <div class="card-grid">' + (cardsHtml || '<div style="grid-column:span 3;text-align:center;color:#6b7280;padding:2rem 0">暂无监控房间，请添加</div>') + '</div>\n    </div>\n\n    <div id="panelNotifies" style="display:none">\n      <div class="panel">\n        <h3>添加通知配置</h3>\n        <form method="POST" action="/add-notify" id="addNotifyForm">\n          <div class="form-grid">\n            <div><label>名称</label><input type="text" name="name" placeholder="例如：主Telegram" required></div>\n            <div><label>协议类型</label>\n              <select name="protocol" id="protocolSelect">\n                <option value="telegram">Telegram Bot API</option>\n                <option value="onebot_private">OneBot 私聊</option>\n                <option value="onebot_group">OneBot 群聊</option>\n              </select>\n            </div>\n            <div class="full" id="apiUrlGroup"><label>API 地址</label><input type="url" name="api_url" id="apiUrl" placeholder="https://api.telegram.org/bot<token>/sendMessage"></div>\n            <div class="full" id="tgTokenGroup" style="display:none"><label>Bot Token</label><input type="text" id="tgToken" placeholder="例如：123456:ABC-DEF..."><p style="font-size:0.75rem;color:#6b7280;margin-top:0.25rem">系统将自动构建 API 地址</p></div>\n            <div><label id="receiverLabel">接收者 ID (chat_id)</label><input type="text" name="chat_id" id="chatId" placeholder="例如：123456789" required></div>\n            <div style="display:flex;align-items:flex-end"><label style="display:flex;align-items:center;font-size:0.875rem;color:#374151"><input type="checkbox" name="enabled" checked value="1" style="width:auto;margin-right:0.25rem"> 启用</label></div>\n            <div class="full"><button type="submit" class="btn btn-primary">添加配置</button></div>\n          </div>\n        </form>\n      </div>\n\n      <div class="panel">\n        <h3>现有配置</h3>\n        <table>\n          <thead><tr><th>名称</th><th>协议</th><th>API 地址</th><th>接收 ID</th><th>状态</th><th>操作</th></tr></thead>\n          <tbody>' + (configRows || '<tr><td colspan="6" style="text-align:center;color:#6b7280;padding:1rem 0">暂无配置</td></tr>') + '</tbody>\n        </table>\n      </div>\n    </div>\n\n    <div class="panel">\n      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75rem">\n        <h3>详细日志</h3>\n        <div style="display:flex;gap:0.5rem;align-items:center">\n          <button id="clearLogsBtn" class="btn btn-danger" style="padding:0.25rem 0.75rem;font-size:0.75rem">清除日志</button>\n          <button id="refreshLogsBtn" class="btn btn-gray" style="padding:0.25rem 0.75rem;font-size:0.75rem">刷新</button>\n          <label style="display:flex;align-items:center;font-size:0.75rem;color:#374151"><input type="checkbox" id="autoRefresh" checked style="width:auto;margin-right:0.25rem"> 自动刷新</label>\n        </div>\n      </div>\n      <div id="logContainer" class="log-container"></div>\n    </div>\n  </div>\n\n  <script>\n    function switchTab(tab) {\n      document.getElementById('panelRooms').style.display = tab === 'rooms' ? 'block' : 'none';\n      document.getElementById('panelNotifies').style.display = tab === 'notifies' ? 'block' : 'none';\n      var roomsBtn = document.getElementById('tabRooms');\n      var notifiesBtn = document.getElementById('tabNotifies');\n      if (tab === 'rooms') {\n        roomsBtn.className = 'tab-btn tab-active';\n        notifiesBtn.className = 'tab-btn tab-inactive';\n      } else {\n        roomsBtn.className = 'tab-btn tab-inactive';\n        notifiesBtn.className = 'tab-btn tab-active';\n      }\n    }\n\n    document.addEventListener('DOMContentLoaded', function() {\n      var protocolSelect = document.getElementById('protocolSelect');\n      var apiUrl = document.getElementById('apiUrl');\n      var chatId = document.getElementById('chatId');\n      var receiverLabel = document.getElementById('receiverLabel');\n      var apiUrlGroup = document.getElementById('apiUrlGroup');\n      var tgTokenGroup = document.getElementById('tgTokenGroup');\n      var tgToken = document.getElementById('tgToken');\n      var form = document.getElementById('addNotifyForm');\n\n      function updateForm() {\n        var protocol = protocolSelect.value;\n        if (protocol === 'telegram') {\n          apiUrl.value = 'https://api.telegram.org/bot<token>/sendMessage';\n          receiverLabel.textContent = '接收者 ID (chat_id)';\n          chatId.placeholder = '例如：123456789';\n          apiUrlGroup.style.display = 'none';\n          tgTokenGroup.style.display = 'block';\n        } else if (protocol === 'onebot_private') {\n          apiUrl.value = 'http://127.0.0.1:5700/send_private_msg';\n          receiverLabel.textContent = '用户 ID (user_id)';\n          chatId.placeholder = '例如：123456789';\n          apiUrlGroup.style.display = 'block';\n          tgTokenGroup.style.display = 'none';\n        } else if (protocol === 'onebot_group') {\n          apiUrl.value = 'http://127.0.0.1:5700/send_group_msg';\n          receiverLabel.textContent = '群 ID (group_id)';\n          chatId.placeholder = '例如：123456789';\n          apiUrlGroup.style.display = 'block';\n          tgTokenGroup.style.display = 'none';\n        }\n      }\n      protocolSelect.addEventListener('change', updateForm);\n      updateForm();\n\n      form.addEventListener('submit', function(e) {\n        var protocol = protocolSelect.value;\n        if (protocol === 'telegram') {\n          var token = tgToken.value.trim();\n          if (!token) {\n            showMessage('请输入 Bot Token', 'error');\n            e.preventDefault();\n            return;\n          }\n          apiUrl.value = 'https://api.telegram.org/bot' + token + '/sendMessage';\n        }\n        if (protocol !== 'telegram' && !apiUrl.value.trim()) {\n          showMessage('请输入 API 地址', 'error');\n          e.preventDefault();\n          return;\n        }\n        if (!chatId.value.trim()) {\n          showMessage('请输入接收者 ID', 'error');\n          e.preventDefault();\n          return;\n        }\n      });\n\n      function showMessage(msg, type) {\n        var area = document.getElementById('messageArea');\n        var bg = type === 'error' ? '#fef2f2' : '#f0fdf4';\n        var border = type === 'error' ? '#fecaca' : '#bbf7d0';\n        var color = type === 'error' ? '#991b1b' : '#166534';\n        area.innerHTML = '<div style=\"padding:0.75rem;border-radius:6px;margin-bottom:1rem;background:' + bg + ';border:1px solid ' + border + ';color:' + color + '\">' + msg + '</div>';\n      }\n\n      function renderLogs(logs) {\n        var container = document.getElementById('logContainer');\n        if (!logs || logs.length === 0) { container.innerHTML = '<div style=\"color:#9ca3af\">暂无日志</div>'; return; }\n        var html = '';\n        logs.forEach(function(entry) {\n          var levelClass = 'log-' + entry.level;\n          html += '<div class=\"log-entry\"><span class=\"log-time\">' + entry.time + '</span><span class=\"' + levelClass + '\">[' + entry.level.toUpperCase() + ']</span> ' + entry.message + '</div>';\n        });\n        container.innerHTML = html;\n      }\n\n      function fetchLogs() {\n        fetch('/logs').then(function(res) { return res.json(); }).then(function(data) { renderLogs(data); }).catch(function(err) { console.error('获取日志失败:', err); });\n      }\n\n      document.getElementById('refreshLogsBtn').addEventListener('click', fetchLogs);\n      document.getElementById('clearLogsBtn').addEventListener('click', function() {\n        if (!confirm('确定清除所有日志吗？')) return;\n        fetch('/clear-logs', { method: 'POST' }).then(function() { showMessage('日志已清除', 'info'); fetchLogs(); }).catch(function(err) { showMessage('清除失败: ' + err.message, 'error'); });\n      });\n      document.getElementById('autoRefresh').addEventListener('change', function() {\n        if (this.checked) { logTimer = setInterval(fetchLogs, 5000); fetchLogs(); } else { clearInterval(logTimer); logTimer = null; }\n      });\n      var logTimer = setInterval(fetchLogs, 5000);\n      fetchLogs();\n\n      document.getElementById('checkAllBtn').addEventListener('click', function() {\n        var btn = this; btn.disabled = true; btn.textContent = '检查中...';\n        fetch('/monitor').then(function() { location.reload(); }).catch(function() { location.reload(); });\n      });\n\n      document.getElementById('sendLiveNotifyBtn').addEventListener('click', function() {\n        var btn = this; btn.disabled = true; btn.textContent = '发送中...';\n        fetch('/send-live-notify', { method: 'POST' }).then(function(res) { return res.json(); }).then(function(data) {\n          showMessage(data.message, data.success ? 'info' : 'error');\n          btn.disabled = false; btn.textContent = '发送开播通知';\n        }).catch(function(err) {\n          showMessage('操作失败: ' + err.message, 'error');\n          btn.disabled = false; btn.textContent = '发送开播通知';\n        });\n      });\n\n      document.getElementById('singleCheckBtn').addEventListener('click', function() {\n        var roomId = document.getElementById('singleCheckInput').value.trim();\n        if (!roomId) { showMessage('请输入房间号', 'error'); return; }\n        var btn = this; btn.disabled = true; btn.textContent = '查询中...';\n        fetch('/check?room_id=' + encodeURIComponent(roomId)).then(function(res) { return res.json(); }).then(function(data) {\n          showMessage(JSON.stringify(data, null, 2), 'info');\n          btn.disabled = false; btn.textContent = '单独检查';\n        }).catch(function(err) {\n          showMessage('查询失败: ' + err.message, 'error');\n          btn.disabled = false; btn.textContent = '单独检查';\n        });\n      });\n\n      document.querySelectorAll('.test-btn').forEach(function(btn) {\n        btn.addEventListener('click', function() {\n          var id = this.dataset.id;\n          var originalText = this.textContent;\n          this.textContent = '测试中...';\n          this.disabled = true;\n          var formData = new URLSearchParams();\n          formData.append('config_id', id);\n          fetch('/test-notify', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: formData })\n            .then(function(res) { return res.json(); })\n            .then(function(data) {\n              showMessage(data.message, data.success ? 'info' : 'error');\n              this.textContent = originalText;\n              this.disabled = false;\n            }.bind(this))\n            .catch(function(err) {\n              showMessage('测试失败: ' + err.message, 'error');\n              this.textContent = originalText;\n              this.disabled = false;\n            }.bind(this));\n        });\n      });\n    });\n  </script>\n</body>\n</html>';
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
    console.log('[CRON] 定时任务触发 at ' + new Date().toISOString());
    addLog('info', '定时任务开始执行 (Cron triggered)').catch(function(e) {
      console.error('[CRON] addLog 失败:', e.message);
    });
    return monitorAll(env).then(function(result) {
      if (result && result.error) {
        var errMsg = '定时任务失败: ' + result.error;
        console.error('[CRON] ' + errMsg);
        return addLog('error', errMsg).catch(function(e) { console.error('[CRON] 记录错误日志失败:', e.message); });
      } else {
        var sucMsg = '定时任务完成，共检查 ' + (result ? result.length : 0) + ' 个房间';
        console.log('[CRON] ' + sucMsg);
        return addLog('info', sucMsg).catch(function(e) { console.error('[CRON] 记录成功日志失败:', e.message); });
      }
    }).catch(function(err) {
      var errMsg = '定时任务异常: ' + err.message;
      console.error('[CRON] ' + errMsg);
      addLog('error', errMsg).catch(function(e) { console.error('[CRON] 记录异常日志失败:', e.message); });
      return Promise.resolve();
    });
  }
};
