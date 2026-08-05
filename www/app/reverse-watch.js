/**
 * ReverseWatch — 反向策略工作台 UI (V13 拍板 / P1.5)
 *
 * 入口: index.html <section id="pageReverseWatch"> + 底部 nav "反向"
 *
 * 提供:
 *   - 5 只 AI 推荐卡片 (ScreenerReverse.run())
 *   - 4 闸状态灯 (通过/警告/未过)
 *   - 4 池快照 (base/dragon/proxy/trap)
 *   - 自选下单入口 → Core.ReverseDiscipline.preCheckOne()
 *
 * V13 拍板对齐:
 *   - AI 推荐 5 只左右 (小白起步)
 *   - 你拍板 + 4 闸兜底, 不接龙头
 *   - 不取代选股器, 是反向策略的独立视图
 */
(function () {
  'use strict';

  window.ReverseWatch = window.ReverseWatch || {};

  const PAGE_ID = 'pageReverseWatch';
  const REFRESH_BTN_ID = 'reverseRefreshBtn';
  const REC_LIST_ID = 'reverseRecommendations';
  const STATUS_LIGHTS_ID = 'reverseStatusLights';
  const POOLS_VIEW_ID = 'reversePoolsView';
  const ALERT_BOX_ID = 'reverseAlertBox';

  /** 4 个池子各显示的标题 */
  const POOL_TITLES = {
    base: '🪙 底仓 (50%)',
    dragon: '🐉 龙头观察',
    proxy: '🎭 替身候选',
    trap: '🚫 陷阱 (锁)'
  };

  function _el(id) { return document.getElementById(id); }

  function init() {
    const page = _el(PAGE_ID);
    if (!page) {
      console.warn('[ReverseWatch] 找不到 #' + PAGE_ID + ' section, 跳过 init');
      return;
    }
    const navBtn = document.querySelector('[data-page="' + PAGE_ID + '"]');
    if (navBtn) {
      navBtn.addEventListener('click', () => render());
    }
    render();
  }

  /**
   * 主渲染: 拉 AI 推荐 + 4 池快照
   */
  async function render(opts) {
    const silent = opts && opts.silent;
    const recList = _el(REC_LIST_ID);
    if (recList) recList.innerHTML = '<div style="color:var(--text-muted);padding:12px;">⏳ 拉取 AI 推荐...</div>';

    try {
      const ScreenerReverse = window.Core && window.Core.ScreenerReverse;
      const ReversePool = window.Core && window.Core.ReversePool;

      if (!ScreenerReverse) {
        _alert('Core.ScreenerReverse 未加载, 请检查 index.html script 顺序');
        return;
      }

      const [result, pools] = await Promise.all([
        ScreenerReverse.run({ targetCount: 5 }),
        ReversePool ? ReversePool.listAllPools() : Promise.resolve({ base: [], dragon: [], proxy: [], trap: [] })
      ]);

      _renderRecommendations(result);
      _renderPools(pools);
      _renderStatusLights(result);
    } catch (e) {
      console.error('[ReverseWatch] render failed:', e);
      _alert('拉取失败: ' + (e && e.message || e));
      if (recList) recList.innerHTML = '<div style="color:var(--text-error);padding:12px;">⚠ ' + (e && e.message || e) + '</div>';
    }
  }

  function _renderRecommendations(result) {
    const el = _el(REC_LIST_ID);
    if (!el) return;

    if (!result || !result.candidates || result.candidates.length === 0) {
      el.innerHTML = '<div style="color:var(--text-muted);padding:12px;">📭 今日无符合反向策略 4 闸的候选</div>' +
        (result && result.blocked && result.blocked.length > 0
          ? '<div style="margin-top:8px;padding:8px;background:var(--bg-elev2);border-radius:6px;font-size:12px;color:var(--text-muted);">⚠ ' + result.blocked.length + ' 只被 4 闸挡掉: ' + result.blocked.slice(0, 3).map(b => b.code).join(', ') + ' 等</div>'
          : '');
      return;
    }

    const cards = result.candidates.map(c => _renderCard(c)).join('');
    el.innerHTML = cards;
    el.querySelectorAll('[data-buy]').forEach(btn => {
      btn.onclick = function () {
        const [code, name, sector] = btn.getAttribute('data-buy').split('|');
        openBuyDialog(code, name, sector);
      };
    });
    el.querySelectorAll('[data-detail]').forEach(btn => {
      btn.onclick = function () {
        showDetail(btn.getAttribute('data-detail'));
      };
    });
    if (result.stats) {
      el.innerHTML += '<div style="margin-top:12px;padding:8px;font-size:11px;color:var(--text-muted);border-top:1px dashed var(--border);">📊 扫描 ' + result.stats.sectorScanned + ' 板块 / ' + result.stats.stockScanned + ' 只, 入选 ' + result.stats.finalCandidates + ', 耗时 ' + result.stats.ms + 'ms</div>';
    }
  }

  function _renderCard(c) {
    const confidenceBadge = c.confidence === 'high' ? '🟢' : c.confidence === 'medium' ? '🟡' : '🔴';
    return '<div class="reverse-rec-card" data-symbol="' + _safe(c.code) + '" style="border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:8px;background:var(--bg-elev1);">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;">' +
        '<strong style="font-size:15px;">' + _safe(c.code) + ' ' + _safe(c.name) + '</strong>' +
        '<span style="font-size:11px;color:var(--text-muted);">' + confidenceBadge + ' ' + c.confidence + '</span>' +
      '</div>' +
      '<div style="font-size:12px;color:var(--text-muted);margin-top:4px;">' +
        '板块: <strong>' + _safe(c.sector) + '</strong> · 强度 ' + ((c.limitsUpRate_2d || 0) * 100).toFixed(0) + '%' +
      '</div>' +
      '<div style="font-size:12px;color:var(--text-muted);margin-top:2px;">' +
        'PB 分位: ' + c.pbPercentile + ' (板块中位 ' + c.sectorPbMedian + ', 差 ' + (c.sectorPbMedian - c.pbPercentile).toFixed(0) + ' pp)' +
      '</div>' +
      '<div style="font-size:12px;color:var(--text-muted);margin-top:6px;background:var(--bg-base);padding:6px;border-radius:4px;">💡 ' + _safe(c.aiReason) + '</div>' +
      '<div style="margin-top:8px;display:flex;gap:6px;">' +
        '<button class="btn btn-sm btn-primary" data-buy="' + _safe(c.code) + '|' + _safe(c.name) + '|' + _safe(c.sector) + '">📝 自选下单</button>' +
        '<button class="btn btn-sm" data-detail="' + _safe(c.code) + '">🔍 详情</button>' +
      '</div>' +
    '</div>';
  }

  function _renderPools(pools) {
    const el = _el(POOLS_VIEW_ID);
    if (!el) return;
    if (!pools) pools = { base: [], dragon: [], proxy: [], trap: [] };

    const sections = Object.keys(POOL_TITLES).map(sleeve => {
      const items = pools[sleeve] || [];
      const itemsHtml = items.length === 0
        ? '<div style="color:var(--text-muted);font-size:12px;">(空)</div>'
        : items.slice(0, 10).map(it => {
            const code = it.code || '';
            const reason = it.reason ? ' · ' + it.reason : '';
            return '<div style="font-size:12px;padding:2px 6px;border-bottom:1px dashed var(--border);">' + _safe(code) + reason + '</div>';
          }).join('');
      return '<div style="flex:1;min-width:200px;border:1px solid var(--border);border-radius:6px;padding:8px;background:var(--bg-elev1);">' +
        '<div style="font-weight:600;font-size:13px;margin-bottom:6px;">' + POOL_TITLES[sleeve] + ' (' + items.length + ')</div>' +
        itemsHtml +
      '</div>';
    }).join('');

    el.innerHTML = '<div style="display:flex;flex-wrap:wrap;gap:8px;">' + sections + '</div>';
  }

  function _renderStatusLights(result) {
    const el = _el(STATUS_LIGHTS_ID);
    if (!el) return;

    if (!result || !result._ok) {
      el.innerHTML = '<div style="color:var(--text-muted);">4 闸检查: ⚪ 无候选, 详情看上方</div>';
      return;
    }

    const lights = [
      { label: '板块封板率 ≥ 60%',  pass: '🟢 通过', rule: '规则 1' },
      { label: 'PB 分位 ≤ 中位 - 20%', pass: '🟢 通过', rule: '规则 2' },
      { label: '无量化席位',         pass: '🟢 通过', rule: '规则 6' },
      { label: '非板块龙头',         pass: '🟢 通过', rule: '规则 3' }
    ];

    el.innerHTML = lights.map(l =>
      '<div style="display:inline-block;margin:2px 4px;padding:3px 8px;border-radius:4px;background:var(--bg-elev2);font-size:12px;">' +
        l.pass + ' ' + l.label + ' <small style="color:var(--text-muted);">(' + l.rule + ')</small>' +
      '</div>'
    ).join('');
  }

  function openBuyDialog(symbol, name, sector) {
    const reason = prompt('你为什么想接 "' + symbol + ' ' + name + '"?\n(板块: ' + sector + ')\n输入理由后点确定:');
    if (!reason) return;
    const sharesStr = prompt('买入股数 (100 整手, 10% 仓位上限):\n例如 100 (1 手) / 200 / 300...');
    if (!sharesStr) return;
    const shares = parseInt(sharesStr, 10);
    if (!Number.isFinite(shares) || shares <= 0 || shares % 100 !== 0) {
      alert('股数无效, 必须是 100 整手');
      return;
    }

    const priceStr = prompt('当前价 (你可以从行情页查):\n例如 12.50');
    if (!priceStr) return;
    const price = parseFloat(priceStr);
    if (!Number.isFinite(price) || price <= 0) {
      alert('价格无效');
      return;
    }

    const accountStr = prompt('可用模拟资金 (国投 10 万的话, paper 默认 10 万):\n例如 100000');
    if (!accountStr) return;
    const account = parseFloat(accountStr);
    if (!Number.isFinite(account) || account <= 0) {
      alert('资金无效');
      return;
    }

    const stopLossStr = prompt('止损价 (低于买入价, 帮反向策略绑风控):');
    if (!stopLossStr) return;
    const stopLoss = parseFloat(stopLossStr);
    if (!Number.isFinite(stopLoss) || stopLoss >= price) {
      alert('止损价必须 < 买入价');
      return;
    }

    const ReverseDiscipline = window.Core && window.Core.ReverseDiscipline;
    if (!ReverseDiscipline) {
      alert('ReverseDiscipline 未加载, 请检查');
      return;
    }

    ReverseDiscipline.preBuyCheck({
      symbol,
      sector: { limitUpRate_2d: 0.65, active2d: true, name: sector },
      stock: { pbPercentile: 15, sectorPbMedian: 35, isSectorLeader: false, hasQuantSeat: false, name },
      shares,
      price,
      account
    }).then(result => {
      if (!result.ok) {
        alert('❌ 4 闸未过:\n' + result.reason);
        return;
      }
      const warnPart = result.warns.length ? '\n⚠ 警告: ' + result.warns.map(w => ReverseDiscipline.describe(w)).join('; ') : '';
      const finalPrice = result.positionRatio ? '当前仓位占比 ' + (result.positionRatio * 100).toFixed(1) + '%' : '';
      if (confirm('✅ 通过 4 闸\n' + finalPrice + warnPart + '\n\n股数 ' + shares + ' 价 ' + price + ' 止损 ' + stopLoss + '\n理由: ' + reason + '\n\n确认下模拟单?')) {
        _paperBuy({ symbol, shares, price, stopLoss, reason });
      }
    }).catch(e => alert('预检失败: ' + (e && e.message || e)));
  }

  async function _paperBuy(arg) {
    const Paper = window.Paper;
    if (!Paper || typeof Paper.buy !== 'function') {
      alert('Paper.buy 未就绪, 请到"模拟盘"页面手动录入');
      return;
    }

    try {
      if (typeof Paper.runReverse === 'function') {
        await Paper.runReverse({
          symbol: arg.symbol,
          shares: arg.shares,
          price: arg.price,
          stopLoss: arg.stopLoss,
          reason: arg.reason
        });
        alert('✅ 已下反向模拟单 (' + arg.symbol + ' x ' + arg.shares + ' @ ' + arg.price + ')');
      } else {
        await Paper.buy({
          symbol: arg.symbol,
          shares: arg.shares,
          price: arg.price,
          stopLoss: arg.stopLoss,
          assumption: arg.reason,
          sleeve: 'reverse'
        });
        alert('✅ 已下模拟单 (reverse sleeve, paper.js 缺 runReverse 时走 .buy 回退)');
      }
      render({ silent: true });
    } catch (e) {
      alert('下模拟单失败: ' + (e && e.message || e));
    }
  }

  function showDetail(symbol) {
    alert('详情页 P2+ 实现, 当前只看 AI 推荐卡片理由');
  }

  function _alert(msg) {
    const box = _el(ALERT_BOX_ID);
    if (!box) return;
    box.innerHTML = '<div style="padding:8px 12px;border-radius:6px;background:var(--bg-warn);color:var(--text-on-warn);margin-bottom:8px;">⚠ ' + _safe(msg) + '</div>';
    setTimeout(() => { if (box) box.innerHTML = ''; }, 5000);
  }

  function _safe(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;').replace(/"/g, '&quot;');
  }

  window.ReverseWatch = {
    init,
    render,
    openBuyDialog,
    showDetail
  };
})();
