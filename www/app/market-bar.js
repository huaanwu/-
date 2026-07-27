/**
 * MarketBar - 行情看板顶部 widget
 * 3 按键: 宽基 / 风格 / 行业
 * 可折叠(默认展开), 可刷新, 失败降级
 *
 * 用法:
 *   MarketBar.mount('pageAccount', 'wide')   // 挂到资金账户页, 默认宽基
 *   MarketBar.mount('pageScreener', 'industry') // 选股默认看行业
 *   MarketBar.mount('pageFund', 'wide')      // 基金默认宽基(看股债跷跷板)
 *   MarketBar.mount('pageJournal', 'wide')   // 复盘默认宽基
 */
(function() {
  'use strict';

  const _states = {};  // pageId -> { group, collapsed, el, mounted }

  const MarketBar = {
    /**
     * 挂载到某个 page 的 .page-header 或 .market-bar-mount 元素
     * @param {string} pageId  页面 id (e.g. 'pageAccount')
     * @param {string} defaultGroup 默认组 'wide'|'style'|'industry'
     */
    async mount(pageId, defaultGroup = 'wide') {
      const page = document.getElementById(pageId);
      if (!page) { console.warn('[MarketBar] 找不到 page:', pageId); return; }

      // 幂等: 已挂过就只 refresh
      if (_states[pageId] && _states[pageId].mounted) {
        await this.refresh(pageId);
        return;
      }

      // 找挂载点: 优先 .market-bar-mount, 否则插到 page 第一个元素前
      let mount = page.querySelector('.market-bar-mount');
      if (!mount) {
        mount = document.createElement('div');
        mount.className = 'market-bar-mount';
        const firstSection = page.querySelector('section, .summary, .page-content, .empty, table');
        if (firstSection && firstSection.parentNode === page) {
          page.insertBefore(mount, firstSection);
        } else {
          page.insertBefore(mount, page.firstChild);
        }
      }

      // 渲染骨架
      mount.innerHTML = `
        <div class="market-bar" id="marketBar_${pageId}">
          <div class="market-bar-head">
            <div class="market-bar-tabs">
              <button class="mb-tab" data-g="wide">宽基</button>
              <button class="mb-tab" data-g="style">风格</button>
              <button class="mb-tab" data-g="industry">行业</button>
            </div>
            <div class="market-bar-meta">
              <span class="mb-time">⏳</span>
              <button class="btn btn-sm btn-ghost mb-refresh" title="刷新">🔄</button>
              <button class="btn btn-sm btn-ghost mb-toggle" title="折叠/展开">▼</button>
            </div>
          </div>
          <div class="market-bar-body" id="marketBarBody_${pageId}">
            <div class="market-bar-empty">加载中...</div>
          </div>
        </div>
      `;

      // 状态
      const st = _states[pageId] = {
        group: defaultGroup,
        collapsed: false,
        el: mount,
        pageId,
        mounted: true
      };

      // 绑定按键
      mount.querySelectorAll('.mb-tab').forEach(btn => {
        btn.onclick = () => this.switchGroup(pageId, btn.dataset.g);
      });
      mount.querySelector('.mb-refresh').onclick = () => this.refresh(pageId);
      mount.querySelector('.mb-toggle').onclick = () => this.toggle(pageId);

      // 首次加载
      await this.switchGroup(pageId, defaultGroup);
    },

    async switchGroup(pageId, group) {
      const st = _states[pageId];
      if (!st) return;
      st.group = group;

      // 更新按键样式
      const root = st.el.querySelector('.market-bar');
      root.querySelectorAll('.mb-tab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.g === group);
      });

      // 加载
      const body = st.el.querySelector('.market-bar-body');
      const timeEl = st.el.querySelector('.mb-time');
      body.innerHTML = '<div class="market-bar-empty">⏳ 加载 ' + (window.Core.Market.GROUPS[group].label) + '...</div>';
      timeEl.textContent = '⏳';

      try {
        const snap = await window.Core.Market.get(group);
        this._render(pageId, snap);
      } catch (e) {
        body.innerHTML = `<div class="market-bar-empty" style="color:var(--down);">⚠ 加载失败: ${escapeHtml(e.message)}</div>`;
        timeEl.textContent = '✗';
        console.warn('[MarketBar] 加载失败:', pageId, group, e);
      }
    },

    _render(pageId, snap) {
      const st = _states[pageId];
      if (!st) return;
      const body = st.el.querySelector('.market-bar-body');
      const timeEl = st.el.querySelector('.mb-time');

      // 时间
      const timeStr = new Date(snap.ts).toLocaleTimeString();
      timeEl.textContent = (snap.stale ? '⚠ 旧 ' : '') + timeStr;

      let html = '';
      if (snap.group === 'industry') {
        // 行业: 两列(top 涨 / bottom 跌)
        const top = snap.top || [];
        const bottom = snap.bottom || [];
        if (top.length === 0 && bottom.length === 0) {
          html = '<div class="market-bar-empty">无行业数据</div>';
        } else {
          html = `
            <div class="mb-grid">
              <div class="mb-col">
                <div class="mb-col-title" style="color:var(--up);">📈 领涨 ${top.length}</div>
                ${top.map(it => {
                  const c = it.change > 0 ? 'var(--up)' : 'var(--text-muted)';
                  const sign = it.change > 0 ? '+' : '';
                  return `<div class="mb-item">
                    <span class="mb-name" title="${escapeHtml(it.leader || '')}">${escapeHtml(it.name)}</span>
                    <span class="mb-pct" style="color:${c};">${sign}${it.change.toFixed(2)}%</span>
                  </div>`;
                }).join('') || '<div class="mb-item" style="color:var(--text-muted);">-</div>'}
              </div>
              <div class="mb-col">
                <div class="mb-col-title" style="color:var(--down);">📉 领跌 ${bottom.length}</div>
                ${bottom.map(it => {
                  const c = it.change < 0 ? 'var(--down)' : 'var(--text-muted)';
                  return `<div class="mb-item">
                    <span class="mb-name" title="${escapeHtml(it.leader || '')}">${escapeHtml(it.name)}</span>
                    <span class="mb-pct" style="color:${c};">${it.change.toFixed(2)}%</span>
                  </div>`;
                }).join('') || '<div class="mb-item" style="color:var(--text-muted);">-</div>'}
              </div>
            </div>
          `;
        }
      } else {
        // 宽基/风格: 横向一行
        const items = snap.items || [];
        if (items.length === 0) {
          html = '<div class="market-bar-empty">无数据</div>';
        } else {
          html = `<div class="mb-row">${items.map(it => {
            const c = it.change > 0 ? 'var(--up)' : (it.change < 0 ? 'var(--down)' : 'var(--text-muted)');
            const sign = it.change > 0 ? '+' : '';
            return `<div class="mb-item">
              <div class="mb-name" title="${escapeHtml(it.name)} ${escapeHtml(it.code)}">${escapeHtml(it.name)}</div>
              <div class="mb-price">${it.price.toFixed(2)}</div>
              <div class="mb-pct" style="color:${c};">${sign}${it.change.toFixed(2)}%</div>
            </div>`;
          }).join('')}</div>`;
        }
      }

      if (snap.error) {
        html += `<div class="market-bar-empty" style="color:var(--down);font-size:11px;">⚠ ${escapeHtml(snap.error)}</div>`;
      }

      body.innerHTML = html;
    },

    async refresh(pageId) {
      const st = _states[pageId];
      if (!st) return;
      await window.Core.Market.refresh(st.group);
      await this.switchGroup(pageId, st.group);
    },

    toggle(pageId) {
      const st = _states[pageId];
      if (!st) return;
      st.collapsed = !st.collapsed;
      const body = st.el.querySelector('.market-bar-body');
      const btn = st.el.querySelector('.mb-toggle');
      if (st.collapsed) {
        body.style.display = 'none';
        btn.textContent = '▶';
      } else {
        body.style.display = '';
        btn.textContent = '▼';
      }
    },

    /**
     * 卸载某页(切换页面时清理)
     */
    unmount(pageId) {
      const st = _states[pageId];
      if (!st) return;
      st.el.innerHTML = '';
      delete _states[pageId];
    }
  };

  window.MarketBar = MarketBar;
})();
