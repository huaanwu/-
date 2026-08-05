/**
 * ResearchPool - 研究池页面 (Phase R)
 * 用户管理的本地股票池, 是 AI 选股的边界 (≤50 只)
 */
(function () {
  'use strict';
  window.Core = window.Core || {};

  const EMOJI = { SH: '🟥', SZ: '🟨', BJ: '🟦' };

  const ResearchPool = {

    init() {
      // 首次进入页面时渲染
      const onShow = () => this.render();
      window._onShow_pageResearchPool = onShow;
    },

    async render() {
      const sumEl = document.getElementById('researchPoolSummary');
      const tblEl = document.getElementById('researchPoolTable');
      if (!sumEl || !tblEl) return;

      const size = await Core.ResearchPool.checkSize();
      const list = await Core.ResearchPool.list();

      // Summary
      sumEl.innerHTML = this._renderSummary(size, list);

      // Table
      if (list.length === 0) {
        tblEl.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text-muted);">
          研究池为空<br><br>
          <button class="btn btn-primary" onclick="ResearchPool.addDialog()">➕ 添加</button>
          &nbsp;
          <button class="btn btn-primary" onclick="ResearchPool.importFromWatchlist()">📥 从自选股导入</button>
          &nbsp;
          <button class="btn btn-primary" onclick="ResearchPool.generateFromScreener()">📡 扫描全市场</button>
        </div>`;
        return;
      }

      const rows = list
        .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
        .map((r, i) => {
          const emoji = EMOJI[r.market] || '⬜';
          const addedDate = new Date(r.addedAt || 0).toLocaleDateString();
          const tags = (r.tags || []).map(t => `<span class="tag" style="background:var(--bg-base);color:var(--text-muted);font-size:10px;padding:1px 6px;border-radius:3px;margin-right:4px;">${escapeHtml(t)}</span>`).join('');
          const note = r.note ? `<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">📝 ${escapeHtml(r.note)}</div>` : '';
          return `
            <tr>
              <td style="font-size:11px;color:var(--text-muted);">${i + 1}</td>
              <td><span style="font-family:monospace;">${emoji} ${escapeHtml(r.code)}</span></td>
              <td>${escapeHtml(r.name || '')}</td>
              <td>${tags}</td>
              <td style="font-size:11px;color:var(--text-muted);">${addedDate}</td>
              <td>${note}</td>
              <td>
                <button class="btn btn-sm btn-ghost" onclick="ResearchPool.removeCode('${r.code}')">🗑</button>
                <button class="btn btn-sm btn-ghost" onclick="ResearchPool.editDialog('${r.code}')">✏️</button>
              </td>
            </tr>`;
        }).join('');

      tblEl.innerHTML = `
        <div style="margin-bottom:12px;display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn btn-sm btn-primary" onclick="ResearchPool.addDialog()">➕ 添加</button>
          <button class="btn btn-sm" onclick="ResearchPool.importFromWatchlist()">📥 自选股导入</button>
          <button class="btn btn-sm" onclick="ResearchPool.generateFromScreener()">📡 扫描全市场</button>
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead>
            <tr style="border-bottom:1px solid var(--border);">
              <th style="text-align:left;padding:6px;">#</th>
              <th style="text-align:left;padding:6px;">代码</th>
              <th style="text-align:left;padding:6px;">名称</th>
              <th style="text-align:left;padding:6px;">标签</th>
              <th style="text-align:left;padding:6px;">添加时间</th>
              <th style="text-align:left;padding:6px;">备注</th>
              <th style="text-align:left;padding:6px;">操作</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>`;
    },

    _renderSummary(size, list) {
      const pct = (size.count / size.limit * 100).toFixed(0);
      const warn = size.count >= size.limit ? '⚠️ 已达上限, 不能再加' : (size.count >= 40 ? '⚠️ 接近上限' : '');
      return `<b>${size.count}</b> / <b>${size.limit}</b> 只 (${pct}%) ${warn}<br>
        <span style="font-size:11px;color:var(--text-muted);">AI 选股 (长线/短线/选股) 只能从这个池子里挑, 池空将禁止 LLM 选股</span>`;
    },

    /** 添加对话框 */
    addDialog() {
      const html = `
        <div class="modal-backdrop" onclick="if(event.target===this)ResearchPool._close()">
          <div class="modal" style="max-width:480px;">
            <h3>➕ 加入研究池</h3>
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:12px;">
              输入 6 位股票代码或 "代码 名称", 例: 600519 或 600519 贵州茅台
            </div>
            <div class="form-row">
              <label>代码 / 名称</label>
              <input type="text" id="rpAddInput" placeholder="600519 贵州茅台" style="width:100%;">
            </div>
            <div class="form-row">
              <label>标签 (可选, 逗号分隔)</label>
              <input type="text" id="rpAddTags" placeholder="消费, 龙头, 长线跟踪">
            </div>
            <div class="form-row">
              <label>备注 (可选)</label>
              <textarea id="rpAddNote" rows="2" placeholder="为什么研究这只"></textarea>
            </div>
            <div style="display:flex;gap:6px;justify-content:flex-end;margin-top:12px;">
              <button class="btn btn-sm" onclick="ResearchPool._close()">取消</button>
              <button class="btn btn-primary btn-sm" onclick="ResearchPool._doAdd()">添加</button>
            </div>
          </div>
        </div>`;
      this._open(html);
      setTimeout(() => {
        const el = document.getElementById('rpAddInput');
        if (el) el.focus();
      }, 100);
    },

    async _doAdd() {
      const input = (document.getElementById('rpAddInput') || {}).value;
      const tagsRaw = (document.getElementById('rpAddTags') || {}).value;
      const note = (document.getElementById('rpAddNote') || {}).value;
      const tags = tagsRaw ? tagsRaw.split(/[,，]/).map(s => s.trim()).filter(Boolean) : [];
      try {
        const r = await Core.ResearchPool.add(input, { tags, note });
        if (r.existed) {
          toastWarning(r.code + ' 已在研究池中');
        } else {
          toastSuccess('已加入研究池: ' + r.code + (r.name ? ' ' + r.name : ''));
          this._close();
          await this.render();
        }
      } catch (e) {
        toastError('添加失败: ' + e.message);
      }
    },

    async removeCode(code) {
      if (!confirm('从研究池移除 ' + code + '?\n\n注意: AI 选股将不再把这只股票作为候选')) return;
      try {
        await Core.ResearchPool.remove(code);
        toastSuccess('已移除 ' + code);
        await this.render();
      } catch (e) {
        toastError('移除失败: ' + e.message);
      }
    },

    async editDialog(code) {
      const list = await Core.ResearchPool.list();
      const target = list.find(r => r.code === code);
      if (!target) return;
      const html = `
        <div class="modal-backdrop" onclick="if(event.target===this)ResearchPool._close()">
          <div class="modal" style="max-width:480px;">
            <h3>✏️ 编辑 ${escapeHtml(target.code)} ${escapeHtml(target.name || '')}</h3>
            <div class="form-row">
              <label>标签 (逗号分隔)</label>
              <input type="text" id="rpEditTags" value="${escapeHtml((target.tags || []).join(', '))}">
            </div>
            <div class="form-row">
              <label>备注</label>
              <textarea id="rpEditNote" rows="3">${escapeHtml(target.note || '')}</textarea>
            </div>
            <div style="display:flex;gap:6px;justify-content:flex-end;margin-top:12px;">
              <button class="btn btn-sm" onclick="ResearchPool._close()">取消</button>
              <button class="btn btn-primary btn-sm" onclick="ResearchPool._doEdit('${code}')">保存</button>
            </div>
          </div>
        </div>`;
      this._open(html);
    },

    async _doEdit(code) {
      const tagsRaw = (document.getElementById('rpEditTags') || {}).value;
      const note = (document.getElementById('rpEditNote') || {}).value;
      const tags = tagsRaw ? tagsRaw.split(/[,，]/).map(s => s.trim()).filter(Boolean) : [];
      try {
        await Core.ResearchPool.update(code, { tags, note });
        toastSuccess('已保存');
        this._close();
        await this.render();
      } catch (e) {
        toastError('保存失败: ' + e.message);
      }
    },

    async importFromWatchlist() {
      if (!confirm('将所有自选股批量导入研究池? (已达上限将跳过)')) return;
      try {
        const r = await Core.ResearchPool.importFromWatchlist();
        const msg = '导入 ' + r.imported + ' 只, 跳过 ' + r.skipped + ' 只 (已在池中), 失败 ' + r.failed + ' 只' +
          (r.message ? '\n' + r.message : '');
        if (r.imported > 0) toastSuccess(msg);
        else toastWarning(msg);
        await this.render();
      } catch (e) {
        toastError('导入失败: ' + e.message);
      }
    },

    /**
     * P4.4: 规则引擎生成候选 — 调 Core.Screener.run('long'+'short') 合并去重,
     *   弹确认卡片 → 用户挑哪些加入研究池。
     *   失败降级: _ok=false → 提示「规则引擎不可用, 请手动添加」
     */
    async generateFromScreener() {
      if (!window.Core || !Core.Screener || typeof Core.Screener.run !== 'function') {
        toastError('规则引擎 Core.Screener 未挂载, 请确认 /core/screener-rules.js 已加载');
        return;
      }
      try {
        toastInfo('正在跑规则引擎...');
        // 收集 toast 进度消息
        const progToasts = [];
        const _lastToast = { id: null, msg: '' };
        const showProg = (phase, detail) => {
          // 同一 phase 的更新不重复吐司，只更新最后一条
          if (_lastToast.msg !== detail) {
            _lastToast.msg = detail;
            if (_lastToast.id) clearTimeout(_lastToast.id);
            toastInfo(detail);
          }
        };
        const [longR, shortR] = await Promise.all([
          Core.Screener.run('long', { onProgress: showProg }).catch(e => ({ _ok: false, long: [], error: e.message })),
          Core.Screener.run('short', { onProgress: showProg }).catch(e => ({ _ok: false, short: [], error: e.message }))
        ]);
        const merged = new Map();
        const addAll = (arr, sleeve) => {
          (arr || []).forEach(p => {
            if (!p || !p.code) return;
            const code = String(p.code).padStart(6, '0');
            if (!/^\d{6}$/.test(code)) return;
            const prev = merged.get(code);
            if (prev) {
              prev.sleeves.push(sleeve);
              prev.score = Math.max(prev.score || 0, p.score || 0);
              prev.confidence = Math.max(prev.confidence || 0, p.confidence || 0);
            } else {
              merged.set(code, {
                code, name: p.name || '',
                score: p.score || 0, confidence: p.confidence || 0,
                reason: p.reason || '', sleeves: [sleeve]
              });
            }
          });
        };
        addAll(longR.long, 'long');
        addAll(shortR.short, 'short');
        const longCands = longR.long ? [...longR.long].sort((a, b) => (b.confidence||0) - (a.confidence||0)).slice(0, 50) : [];
        const shortCands = shortR.short ? [...shortR.short].sort((a, b) => (b.confidence||0) - (a.confidence||0)).slice(0, 50) : [];

        if (longCands.length === 0 && shortCands.length === 0) {
          toastWarning('规则引擎未产出候选 (long _ok=' + longR._ok + ', short _ok=' + shortR._ok + '), 请手动添加');
          return;
        }
        this._openScreenerPicker(longCands, shortCands, longR._ok, shortR._ok);
      } catch (e) {
        toastError('规则引擎调用失败: ' + (e.message || e));
        console.warn('[ResearchPool] generateFromScreener 失败:', e);
      }
    },

    _openScreenerPicker(longCands, shortCands, longOk, shortOk) {
      // longCands / shortCands 各自独立，各50只，互不合并
      function _renderTable(arr, label) {
        if (arr.length === 0) return `<div style="padding:16px;color:var(--text-muted);text-align:center;">${label === 'long' ? '长线' : '短线'} 无候选</div>`;
        const rows = arr.map((c, i) => {
          // 给候选对象补 sleeve 标签，供 _confirmScreenerImport 读取
          c._sleeve = label === 'long' ? '长线' : '短线';
          return `
          <tr>
            <td><input type="checkbox" id="rpScreener_${label}_${i}" data-code="${c.code}" checked></td>
            <td style="font-family:monospace;">${c.code}</td>
            <td>${escapeHtml(c.name)}</td>
            <td><span class="tag" style="background:${label === 'long' ? '#dbeafe' : '#fef3c7'};font-size:10px;padding:1px 6px;border-radius:3px;">${label === 'long' ? '长线' : '短线'}</span></td>
            <td style="font-size:11px;">${c.confidence || c.score || '?'}</td>
            <td style="font-size:11px;color:var(--text-muted);max-width:300px;">${escapeHtml(c.reason)}</td>
          </tr>`;
        }).join('');
        return `<div style="max-height:360px;overflow:auto;border:1px solid var(--border);border-radius:4px;">
          <table style="width:100%;border-collapse:collapse;font-size:12px;">
            <thead>
              <tr style="background:var(--bg-base);">
                <th style="padding:6px;text-align:left;">加入</th>
                <th style="padding:6px;text-align:left;">代码</th>
                <th style="padding:6px;text-align:left;">名称</th>
                <th style="padding:6px;text-align:left;">Sleeve</th>
                <th style="padding:6px;text-align:left;">置信度</th>
                <th style="padding:6px;text-align:left;">原因</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
      }

      // 存两份用于确认导入
      this._screenerPicks = { long: longCands, short: shortCands };

      const activeTab = longCands.length > 0 ? 'long' : 'short';
      const html = `
        <div class="modal-backdrop" onclick="if(event.target===this)ResearchPool._close()">
          <div class="modal" style="max-width:820px;">
            <h3>⚡ 规则引擎候选</h3>
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:12px;">long_ok=${longOk} | short_ok=${shortOk} | 全选 = 两栏都勾选的加入</div>
            <div style="display:flex;gap:8px;margin-bottom:8px;">
              <button class="btn btn-sm ${activeTab === 'long' ? 'btn-primary' : ''}" onclick="ResearchPool._switchTab('long')">长线 (${longCands.length})</button>
              <button class="btn btn-sm ${activeTab === 'short' ? 'btn-primary' : ''}" onclick="ResearchPool._switchTab('short')">短线 (${shortCands.length})</button>
            </div>
            <div id="rpScreenerTabLong" style="display:${activeTab === 'long' ? '' : 'none'}">${_renderTable(longCands, 'long')}</div>
            <div id="rpScreenerTabShort" style="display:${activeTab === 'short' ? '' : 'none'}">${_renderTable(shortCands, 'short')}</div>
            <div class="form-row" style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">
              <button class="btn btn-sm" onclick="ResearchPool._close()">取消</button>
              <button class="btn btn-primary btn-sm" onclick="ResearchPool._confirmScreenerImport()">加入研究池</button>
            </div>
          </div>
        </div>`;
      this._open(html);
    },

    _switchTab(tab) {
      const longEl = document.getElementById('rpScreenerTabLong');
      const shortEl = document.getElementById('rpScreenerTabShort');
      if (longEl) longEl.style.display = tab === 'long' ? '' : 'none';
      if (shortEl) shortEl.style.display = tab === 'short' ? '' : 'none';
      // tab 按钮高亮
      const modal = document.querySelector('#modalRoot .modal');
      if (modal) {
        const btns = modal.querySelectorAll('[onclick*="_switchTab"]');
        btns.forEach(b => {
          const txt = b.textContent.trim();
          if (txt.startsWith('长线')) b.className = 'btn btn-sm' + (tab === 'long' ? ' btn-primary' : '');
          if (txt.startsWith('短线')) b.className = 'btn btn-sm' + (tab === 'short' ? ' btn-primary' : '');
        });
      }
    },

    async _confirmScreenerImport() {
      const picks = this._screenerPicks || { long: [], short: [] };
      // 先读 checkbox, 再关弹窗 (不能先 _close() 清掉 DOM!)
      const checked = [];
      ['long', 'short'].forEach(label => {
        (picks[label] || []).forEach((c, i) => {
          const cb = document.getElementById('rpScreener_' + label + '_' + i);
          if (cb && cb.checked) checked.push(c);
        });
      });
      this._close();
      if (checked.length === 0) { toastWarning('未勾选任何股票'); return; }
      let added = 0, existed = 0, updated = 0, failed = 0;
      for (const c of checked) {
        try {
          const sleeve = c._sleeve || '';
          const r = await Core.ResearchPool.add(`${c.code} ${c.name}`.trim(), { tags: sleeve ? [sleeve] : [] });
          if (r.added) added++;
          else if (r.updated) { updated++; existed++; }
          else if (r.existed) existed++;
        } catch (e) {
          failed++;
          console.warn('[ResearchPool] 加入 ' + c.code + ' 失败:', e);
        }
      }
      const msg = `规则引擎导入: 新增 ${added}, 已存在 ${existed - updated}, 补标签 ${updated}, 失败 ${failed}`;
      if (failed > 0) toastWarning(msg);
      else if (updated > 0) toastInfo(msg);
      else toastSuccess(msg);
      await this.render();
    },

    _open(html) {
      const root = document.getElementById('modalRoot');
      if (root) root.innerHTML = html;
    },

    _close() {
      const root = document.getElementById('modalRoot');
      if (root) root.innerHTML = '';
    }
  };

  window.ResearchPool = ResearchPool;
  window.Core = window.Core || {};
  window.Core.ResearchPoolUI = ResearchPool;
  console.log('[ResearchPool] UI 已注册');
})();