/**
 * Core.Sync - Supabase 云同步
 * 用 REST API 直接调 (不依赖 supabase-js SDK, 0 依赖, APK 也能用)
 *
 * 功能:
 *   - 邮箱密码注册 / 登录 / 登出
 *   - 推送本地变更到云 (last-write-wins, 按 updatedAt 合并)
 *   - 拉取云端变更到本地
 *   - 全量双向同步
 *
 * Schema: scripts/supabase_schema.sql
 */
(function() {
  'use strict';

  const TABLES = ['watchlist', 'holdings', 'transactions', 'journals', 'alerts', 'funds', 'cashflow', 'kv'];

  // ===== 配置 =====
  function getConfig() {
    const s = Core.State.get();
    const sync = s.sync || {};
    return {
      url: sync.url || '',
      anonKey: sync.anonKey || '',
      autoSync: !!sync.autoSync,
      userEmail: sync.userEmail || '',
      userId: sync.userId || ''
    };
  }

  function setConfig(patch) {
    const cur = Core.State.get().sync || {};
    Core.State.set('sync', { ...cur, ...patch });
  }

  // ===== Session (内存, 刷新后从 state 恢复) =====
  let _session = null;  // { access_token, refresh_token, user }

  function setSession(s) {
    _session = s;
    if (s) {
      setConfig({
        userId: s.user?.id || '',
        userEmail: s.user?.email || '',
        accessToken: s.access_token
      });
    } else {
      setConfig({ userId: '', userEmail: '', accessToken: '' });
    }
  }

  function getAccessToken() {
    if (_session?.access_token) return _session.access_token;
    return Core.State.get().sync?.accessToken || '';
  }

  // ===== HTTP helpers =====
  async function _request(path, opts = {}) {
    const cfg = getConfig();
    if (!cfg.url || !cfg.anonKey) throw new Error('Supabase 未配置 - 请到 ⚙️ 设置页填 URL 和 anon key');
    const url = `${cfg.url.replace(/\/$/, '')}${path}`;
    const token = getAccessToken();
    const headers = {
      'apikey': cfg.anonKey,
      'Authorization': `Bearer ${token || cfg.anonKey}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    };
    let resp;
    try {
      resp = await fetch(url, { ...opts, headers: { ...headers, ...opts.headers } });
    } catch (e) {
      throw new Error(`网络错误: ${e.message} (检查 Supabase URL 是否对)`);
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      let errMsg = `HTTP ${resp.status}`;
      try {
        const j = JSON.parse(text);
        if (j.msg) errMsg = j.msg;
        else if (j.error_description) errMsg = j.error_description;
        else if (j.message) errMsg = j.message;
        else if (j.error) errMsg = typeof j.error === 'string' ? j.error : JSON.stringify(j.error);
      } catch (e) { /* not JSON, use HTTP code */ }
      if (resp.status === 401) errMsg = '未登录或 token 过期, 请重新登录';
      throw new Error(errMsg);
    }
    // 204 No Content
    if (resp.status === 204) return null;
    return await resp.json();
  }

  // ===== Auth =====
  async function signUp(email, password) {
    const data = await _request('/auth/v1/signup', {
      method: 'POST',
      body: JSON.stringify({ email, password })
    });
    // Supabase 默认要邮箱确认; 如果没确认, session 为 null
    if (data?.session) {
      setSession(data.session);
      toastSuccess('注册成功, 已自动登录');
    } else {
      toastInfo('注册成功, 请去邮箱点确认链接 (或在 Supabase Auth 设置里关掉确认)');
    }
    return data;
  }

  async function signIn(email, password) {
    const data = await _request('/auth/v1/token?grant_type=password', {
      method: 'POST',
      body: JSON.stringify({ email, password })
    });
    if (data?.access_token) {
      setSession(data);
      toastSuccess('登录成功');
      return data;
    }
    throw new Error('登录失败: 未返回 token');
  }

  async function signOut() {
    const token = getAccessToken();
    if (token) {
      try {
        await _request('/auth/v1/logout', { method: 'POST' });
      } catch (e) { /* 忽略登出错误 */ }
    }
    setSession(null);
    toastSuccess('已登出');
  }

  async function getUser() {
    if (!getAccessToken()) return null;
    try {
      const user = await _request('/auth/v1/user');
      return user;
    } catch (e) {
      return null;
    }
  }

  // ===== 单表 Push =====
  /**
   * 推送表的所有本地记录到云 (upsert)
   * @param {string} table 表名
   * @param {Array} records 本地记录 (每条必须有主键字段)
   */
  async function pushTable(table, records) {
    if (!records || records.length === 0) return { count: 0 };
    const userId = getConfig().userId;
    if (!userId) throw new Error('未登录, 无法推送');

    // 注入 user_id, 去掉 updated_at (DB 自动维护)
    const rows = records.map(r => {
      const { updatedAt, updated_at, ...rest } = r;
      return { ...rest, user_id: userId };
    });

    // Supabase REST upsert: POST + Prefer: resolution=merge-duplicates
    const data = await _request(`/rest/v1/${table}`, {
      method: 'POST',
      headers: { 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify(rows)
    });
    return { count: rows.length, data };
  }

  // ===== 单表 Pull =====
  /**
   * 拉取云端所有记录 (限当前用户)
   * @param {string} table 表名
   * @param {string} since 可选 ISO 时间, 只拉该时间之后的 (增量)
   */
  async function pullTable(table, since) {
    const userId = getConfig().userId;
    if (!userId) throw new Error('未登录, 无法拉取');
    const q = since
      ? `?user_id=eq.${userId}&updated_at=gt.${encodeURIComponent(since)}&order=updated_at.asc`
      : `?user_id=eq.${userId}&order=updated_at.asc`;
    const data = await _request(`/rest/v1/${table}${q}`);
    return Array.isArray(data) ? data : [];
  }

  // ===== 全量双向同步 =====
  /**
   * 同步所有 8 张表
   * 策略: 简单粗暴 last-write-wins
   *   - Push: 拉本地所有记录 → upsert 到云
   *   - Pull: 拉云端所有记录 → 按 user_id 过滤 → 与本地合并
   *
   * @returns {object} 同步统计
   */
  async function fullSync() {
    if (!getConfig().userId) throw new Error('未登录, 请先在 ⚙️ 设置页登录 Supabase');
    const stats = { pushed: 0, pulled: 0, tables: {} };

    for (const table of TABLES) {
      try {
        // 1. Push 本地
        const localAll = await Core.Storage.all(table);
        if (localAll && localAll.length > 0) {
          // 剥离 user_id (本地没有, 由 supabase trigger 注入)
          await pushTable(table, localAll);
          stats.pushed += localAll.length;
        }

        // 2. Pull 云端
        const cloudAll = await pullTable(table);
        if (cloudAll && cloudAll.length > 0) {
          // 转换: 去掉 user_id, 应用到本地
          const localRecords = cloudAll.map(r => {
            const { user_id, updated_at, ...rest } = r;
            return rest;
          });

          // 简单策略: 全替换本地
          await Core.Storage.clear(table);
          for (const r of localRecords) {
            await Core.Storage.add(table, r);
          }
          stats.pulled += cloudAll.length;
        }
        stats.tables[table] = { pushed: localAll?.length || 0, pulled: cloudAll?.length || 0 };
      } catch (e) {
        stats.tables[table] = { error: e.message };
        console.error(`[Sync] ${table} 失败:`, e);
      }
    }

    return stats;
  }

  /**
   * 仅推送本地变更 (增量同步, 不拉)
   * 适合: 用户在本地改了数据, 想立刻同步
   */
  async function pushOnly() {
    if (!getConfig().userId) throw new Error('未登录');
    let count = 0;
    for (const table of TABLES) {
      const localAll = await Core.Storage.all(table);
      if (localAll && localAll.length > 0) {
        await pushTable(table, localAll);
        count += localAll.length;
      }
    }
    return { pushed: count };
  }

  /**
   * 仅拉取云端变更 (单向同步)
   * 适合: 用户在另一端改了, 想拉到本地
   */
  async function pullOnly() {
    if (!getConfig().userId) throw new Error('未登录');
    let count = 0;
    for (const table of TABLES) {
      const cloudAll = await pullTable(table);
      if (cloudAll && cloudAll.length > 0) {
        const localRecords = cloudAll.map(r => {
          const { user_id, updated_at, ...rest } = r;
          return rest;
        });
        await Core.Storage.clear(table);
        for (const r of localRecords) {
          await Core.Storage.add(table, r);
        }
        count += cloudAll.length;
      }
    }
    return { pulled: count };
  }

  /**
   * 检查是否已登录 (内存或 state)
   */
  function isLoggedIn() {
    return !!(getAccessToken() && getConfig().userId);
  }

  function getStatus() {
    const cfg = getConfig();
    return {
      configured: !!(cfg.url && cfg.anonKey),
      loggedIn: isLoggedIn(),
      email: cfg.userEmail,
      userId: cfg.userId
    };
  }

  // ===== AI 记忆同步 (5.3.2) =====
  // 存储位置: kv 表, key='ai_memory_journals' / 'ai_memory_alerts'
  // 内容: [{refId, kind, payload, ts}, ...]
  // 不动 schema, 用现有 kv 表即可

  // 5.3.2: 判断一个 journal 是否"有 AI 痕迹", 需要同步
  function _isAIJournal(j) {
    if (!j || typeof j !== 'object') return false;
    return !!(
      j.aiSuggested ||
      j.aiApplied ||
      j.verifiedAt ||
      j.assumption || j.emotion || j.verify ||
      (j.verifyReport && j.verifyReport.length > 0)
    );
  }

  // 5.3.2: 判断一个 alert 是否"有 AI 触发历史"
  function _isAIAlert(a) {
    if (!a || typeof a !== 'object') return false;
    return !!(a.lastHit || (a.hitHistory && a.hitHistory.length > 0));
  }

  /**
   * 推送 AI 记忆 (journals + alerts) 到云端 kv 表
   * 只同步"有 AI 痕迹"的记录, 节省带宽
   * 返回: { journals: N, alerts: M, ts }
   */
  async function pushAIMemory(opts = {}) {
    if (!getConfig().userId) throw new Error('未登录, 无法推送 AI 记忆');
    const allJournals = (await Core.Storage.all('journals')) || [];
    const allAlerts = (await Core.Storage.all('alerts')) || [];
    const aiJournals = allJournals.filter(_isAIJournal);
    const aiAlerts = allAlerts.filter(_isAIAlert);
    const ts = Date.now();

    const journalRows = aiJournals.map(j => ({
      refId: j.id,
      kind: 'journal_ai',
      payload: {
        id: j.id,
        code: j.code,
        date: j.date,
        title: j.title,
        // 关键 AI 字段
        aiSuggested: j.aiSuggested || null,
        aiApplied: j.aiApplied || null,
        verifiedAt: j.verifiedAt || null,
        verifyReport: j.verifyReport || null,
        assumption: j.assumption || null,
        emotion: j.emotion || null,
        verify: j.verify || null,
        // 关键事实字段 (跨端显示需要)
        content: (j.content || '').slice(0, 2000),
        tags: j.tags || null
      },
      ts
    }));
    const alertRows = aiAlerts.map(a => ({
      refId: a.id,
      kind: 'alert_hit',
      payload: {
        id: a.id,
        code: a.code,
        name: a.name,
        type: a.type,
        hitCount: a.hitCount || 0,
        lastHit: a.lastHit || null,
        hitHistory: (a.hitHistory || []).slice(-20)  // 最多保留 20 条
      },
      ts
    }));

    // 推送到 kv 表, 一次 upsert 一行 (key 是 namespace)
    // 合并本次所有 rows 到一个数组, 用单一 key 存储, 简化云端 schema
    const allRows = [...journalRows, ...alertRows];
    if (allRows.length > 0) {
      await _request('/rest/v1/kv', {
        method: 'POST',
        headers: { 'Prefer': 'resolution=merge-duplicates' },
        body: JSON.stringify([{
          user_id: getConfig().userId,
          key: 'ai_memory',
          value: allRows,
          updated_at: new Date().toISOString()
        }])
      });
    }

    return {
      journals: journalRows.length,
      alerts: alertRows.length,
      total: allRows.length,
      ts,
      dryRun: !!opts.dryRun
    };
  }

  /**
   * 拉取 AI 记忆, 合并回本地 (不覆盖已有字段)
   * 策略: 读 kv.ai_memory → 写回 journals/alerts (按 id 找本地记录, 合并 AI 字段)
   * 返回: { journals: applied, alerts: applied, ts }
   */
  async function pullAIMemory(opts = {}) {
    if (!getConfig().userId) throw new Error('未登录, 无法拉取 AI 记忆');
    const data = await _request('/rest/v1/kv?user_id=eq.' + getConfig().userId + '&key=eq.ai_memory&limit=1');
    if (!Array.isArray(data) || data.length === 0) {
      return { journals: 0, alerts: 0, total: 0, reason: 'no-cloud-data' };
    }
    const rows = data[0]?.value;
    if (!Array.isArray(rows) || rows.length === 0) {
      return { journals: 0, alerts: 0, total: 0, reason: 'empty-cloud-data' };
    }
    const ts = Date.now();
    let jApplied = 0, aApplied = 0;
    const localJournals = (await Core.Storage.all('journals')) || [];
    const localAlerts = (await Core.Storage.all('alerts')) || [];
    const jMap = new Map(localJournals.map(j => [j.id, j]));
    const aMap = new Map(localAlerts.map(a => [a.id, a]));

    for (const row of rows) {
      if (row.kind === 'journal_ai' && row.payload?.id) {
        const local = jMap.get(row.payload.id);
        if (local) {
          // 合并: 只覆盖 AI 字段, 不动 content/title/date
          if (row.payload.aiSuggested) local.aiSuggested = row.payload.aiSuggested;
          if (row.payload.aiApplied) local.aiApplied = row.payload.aiApplied;
          if (row.payload.verifiedAt) local.verifiedAt = row.payload.verifiedAt;
          if (row.payload.verifyReport) local.verifyReport = row.payload.verifyReport;
          if (row.payload.assumption) local.assumption = row.payload.assumption;
          if (row.payload.emotion) local.emotion = row.payload.emotion;
          if (row.payload.verify) local.verify = row.payload.verify;
          await Core.Storage.add('journals', local);
          jApplied++;
        }
      } else if (row.kind === 'alert_hit' && row.payload?.id) {
        const local = aMap.get(row.payload.id);
        if (local) {
          if (row.payload.hitCount != null) local.hitCount = row.payload.hitCount;
          if (row.payload.lastHit) local.lastHit = row.payload.lastHit;
          if (Array.isArray(row.payload.hitHistory) && row.payload.hitHistory.length > 0) {
            local.hitHistory = row.payload.hitHistory;
          }
          await Core.Storage.add('alerts', local);
          aApplied++;
        }
      }
    }

    return { journals: jApplied, alerts: aApplied, total: rows.length, ts, dryRun: !!opts.dryRun };
  }

  window.Core = window.Core || {};
  window.Core.Sync = {
    getConfig, setConfig,
    getStatus, isLoggedIn,
    signUp, signIn, signOut, getUser,
    pushTable, pullTable,
    fullSync, pushOnly, pullOnly,
    pushAIMemory, pullAIMemory,
    _isAIJournal, _isAIAlert,
    TABLES
  };
})();
