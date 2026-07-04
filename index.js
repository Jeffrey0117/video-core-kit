'use strict';

/*
 * video-core-kit — Headless 影片播放核心（vanilla JS，零依賴）
 * ---------------------------------------------------------------------------
 * 這是一顆「無頭（headless）」的影片播放核心：它只負責把串流引擎接上你傳進來的
 * <video> 元素、統一 HLS / DASH / MP4 / YouTube 的載入與畫質切換邏輯，然後對外
 * 「發事件 + 開方法」。它「不」畫任何 UI、不建立多餘的 DOM（YouTube 型別除外，
 * 需要自管 iframe）。控制列、樣式、播放器外觀全部是使用「消費端（React / Vue /
 * 原生）」自己的事——這正是三個站台（lurlhub / meetube / coursebloom）能共用同一
 * 顆核心、卻各自長不同殼的關鍵。
 *
 * 【零依賴 / engine 注入】
 *   本檔案不 require、也不 bundle 任何串流函式庫。hls.js、Shaka、YouTube IframeAPI
 *   一律由呼叫端透過 `engine: { Hls, shaka, YT }` 注入，或由核心自動在 window 上偵測。
 *   好處：核心可被任何打包器安全引入、版本由宿主決定、`node --check` 全乾淨。
 *
 * 【三站功能聯集】
 *   - lurlhub：預覽片段「秒開」→ 背景載入 HLS →「無縫切換」（保留 currentTime /
 *     volume / rate / 播放狀態）；短影片直出 MP4；Safari 原生 HLS；HLS fatal 回退 MP4；
 *     由 hls.levels 匯出畫質。
 *   - meetube：Shaka 引擎 attach + DASH/HLS 的 variant 畫質選取。
 *   - coursebloom：~250-500ms 進度回呼、±10 秒快轉、主來源健康檢查失敗自動切備援。
 *
 * 【組合縫（不在本核心實作，只留接點）】
 *   - media-gate：來源 URL 可帶授權 token（?t=），核心原樣沿用，不解析。
 *   - audio-dsp-kit：音訊後處理可掛在 video 的 MediaElementSource 上。
 *   - bilingual-subtitle-kit：字幕/雙語軌可外掛 <track> 或自繪，核心只發進度事件。
 */

/* ------------------------------------------------------------------ *
 * 小型事件發射器（on / off / once / emit）
 * ------------------------------------------------------------------ */
function createEmitter() {
  const map = new Map(); // event -> Set<fn>
  function on(evt, fn) {
    if (!map.has(evt)) map.set(evt, new Set());
    map.get(evt).add(fn);
    return () => off(evt, fn);
  }
  function off(evt, fn) {
    const set = map.get(evt);
    if (set) set.delete(fn);
  }
  function once(evt, fn) {
    const disposer = on(evt, function wrapped(payload) {
      disposer();
      fn(payload);
    });
    return disposer;
  }
  function emit(evt, payload) {
    const set = map.get(evt);
    if (!set) return;
    // 複製一份避免回呼中 off 造成迭代錯亂
    for (const fn of Array.from(set)) {
      try {
        fn(payload);
      } catch (e) {
        // 單一 listener 出錯不該拖垮其他 listener
        if (typeof console !== 'undefined') console.error('[video-core] listener error', e);
      }
    }
  }
  function clear() {
    map.clear();
  }
  return { on, off, once, emit, clear };
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */
var HLS_MIME = 'application/vnd.apple.mpegurl';

function canPlayNativeHls(video) {
  return !!(video && typeof video.canPlayType === 'function' && video.canPlayType(HLS_MIME));
}

function resolveEngine(engine, key) {
  if (engine && engine[key]) return engine[key];
  if (typeof window !== 'undefined' && window[key]) return window[key];
  return null;
}

// 判斷某個 source 在目前環境是否可能可播（不含 async 的 healthCheck）
function isSourcePlayable(source, video, engine) {
  if (!source || !source.type) return false;
  switch (source.type) {
    case 'hls': {
      var Hls = resolveEngine(engine, 'Hls');
      if (Hls && typeof Hls.isSupported === 'function' && Hls.isSupported()) return true;
      if (canPlayNativeHls(video)) return true;
      return false; // 無 Hls.js 也非 Safari → 交給後面的 mp4 來源
    }
    case 'dash': {
      var shaka = resolveEngine(engine, 'shaka');
      return !!(shaka && shaka.Player && typeof shaka.Player.isBrowserSupported === 'function'
        ? shaka.Player.isBrowserSupported()
        : !!shaka);
    }
    case 'mp4':
      return true; // 交給瀏覽器原生
    case 'youtube':
      return true; // YT API 會在需要時載入
    default:
      return false;
  }
}

/* ------------------------------------------------------------------ *
 * Adapter：MP4（原生）
 * ------------------------------------------------------------------ */
function createMp4Adapter(video, source) {
  video.src = source.src;
  return {
    kind: 'mp4',
    getQualities: function () { return []; },
    setQuality: function () { /* 單一畫質，無操作 */ },
    destroy: function () { /* 不動 video.src，交給核心 */ }
  };
}

/* ------------------------------------------------------------------ *
 * Adapter：HLS（注入 Hls.js，或 Safari 原生）
 * 保留 lurlhub 的 fatal → 回退 mp4、由 hls.levels 匯出畫質
 * ------------------------------------------------------------------ */
function createHlsAdapter(video, source, engine, emit, opts) {
  var Hls = resolveEngine(engine, 'Hls');
  var hls = null;

  if (Hls && typeof Hls.isSupported === 'function' && Hls.isSupported()) {
    hls = new Hls(Object.assign({
      // 與 lurlhub 相近的低延遲秒開設定
      maxBufferLength: 5,
      maxMaxBufferLength: 15,
      maxBufferSize: 30 * 1000 * 1000,
      maxBufferHole: 0.5,
      startLevel: 0,
      enableWorker: true,
      backBufferLength: 30
    }, (opts && opts.hlsConfig) || {}));
    hls.loadSource(source.src);
    hls.attachMedia(video);

    hls.on(Hls.Events.ERROR, function (event, data) {
      if (data && data.fatal) {
        emit('error', { fatal: true, engine: 'hls', detail: data, fallbackSrc: source.fallbackSrc || null });
      }
    });
  } else if (canPlayNativeHls(video)) {
    // Safari 原生 HLS
    video.src = source.src;
  } else {
    emit('error', { fatal: true, engine: 'hls', detail: 'HLS not supported', fallbackSrc: source.fallbackSrc || null });
  }

  function getQualities() {
    if (!hls || !hls.levels) return [];
    var list = [{ id: -1, height: 0, label: '自動', auto: true, active: hls.autoLevelEnabled }];
    hls.levels.forEach(function (lv, i) {
      list.push({
        id: i,
        height: lv.height,
        bitrate: lv.bitrate,
        label: lv.height ? lv.height + 'p' : ('level ' + i),
        active: !hls.autoLevelEnabled && hls.currentLevel === i
      });
    });
    return list;
  }

  function setQuality(id) {
    if (!hls) return;
    hls.currentLevel = (id == null || id === -1) ? -1 : id;
    emit('qualitychange', { id: hls.currentLevel, auto: hls.currentLevel === -1 });
  }

  function destroy() {
    if (hls) {
      try { hls.destroy(); } catch (e) { /* noop */ }
      hls = null;
    }
  }

  return { kind: 'hls', getQualities: getQualities, setQuality: setQuality, destroy: destroy, _engine: function () { return hls; } };
}

/* ------------------------------------------------------------------ *
 * Adapter：DASH（注入 Shaka）
 * 保留 meetube 的 attach → load → variant 畫質選取
 * ------------------------------------------------------------------ */
function createDashAdapter(video, source, engine, emit, opts) {
  var shaka = resolveEngine(engine, 'shaka');
  if (!shaka || !shaka.Player) {
    emit('error', { fatal: true, engine: 'dash', detail: 'shaka not injected', fallbackSrc: source.fallbackSrc || null });
    return { kind: 'dash', getQualities: function () { return []; }, setQuality: function () {}, destroy: function () {} };
  }

  var player = new shaka.Player();
  var ready = player.attach(video).then(function () {
    player.addEventListener('error', function (e) {
      emit('error', { fatal: true, engine: 'dash', detail: (e && e.detail) || e, fallbackSrc: source.fallbackSrc || null });
    });
    var onQ = function () { emit('qualitychange', { id: activeTrackId() }); };
    player.addEventListener('adaptation', onQ);
    player.addEventListener('variantchanged', onQ);
    return player.load(source.src, (opts && opts.startTime) || null, source.mimeType);
  }).catch(function (err) {
    emit('error', { fatal: true, engine: 'dash', detail: err, fallbackSrc: source.fallbackSrc || null });
  });

  function tracks() {
    try { return player.getVariantTracks() || []; } catch (e) { return []; }
  }
  function activeTrackId() {
    var t = tracks().find(function (x) { return x.active; });
    return t ? t.id : -1;
  }
  function getQualities() {
    var abrOn = true;
    try { abrOn = player.getConfiguration().abr.enabled; } catch (e) { /* noop */ }
    var list = [{ id: -1, height: 0, label: '自動', auto: true, active: abrOn }];
    tracks()
      .slice()
      .sort(function (a, b) { return (b.height || 0) - (a.height || 0); })
      .forEach(function (t) {
        list.push({ id: t.id, height: t.height, bitrate: t.bandwidth, label: t.height ? t.height + 'p' : String(t.id), active: !abrOn && t.active });
      });
    return list;
  }
  function setQuality(id) {
    if (id == null || id === -1) {
      try { player.configure({ abr: { enabled: true } }); } catch (e) { /* noop */ }
      emit('qualitychange', { id: -1, auto: true });
      return;
    }
    try { player.configure({ abr: { enabled: false } }); } catch (e) { /* noop */ }
    var t = tracks().find(function (x) { return x.id === id; });
    if (t) {
      player.selectVariantTrack(t, true);
      emit('qualitychange', { id: id, auto: false });
    }
  }
  function destroy() {
    try { player.destroy(); } catch (e) { /* noop */ }
  }

  return { kind: 'dash', ready: ready, getQualities: getQualities, setQuality: setQuality, destroy: destroy, _engine: function () { return player; } };
}

/* ------------------------------------------------------------------ *
 * Adapter：YouTube（注入 YT IframeAPI）
 * 保留 coursebloom 的 iframe adapter + ~500ms 進度輪詢
 * ------------------------------------------------------------------ */
function createYouTubeAdapter(video, source, engine, emit, opts, hooks) {
  var YT = resolveEngine(engine, 'YT');
  var container = (opts && opts.youtube && opts.youtube.container) || null;
  var mount = null;
  var yt = null;
  var pollTimer = null;

  // 建立 iframe 掛載點（headless 例外：youtube 需要自管 iframe）
  if (typeof document !== 'undefined') {
    mount = document.createElement('div');
    if (container) container.appendChild(mount);
    else if (video && video.parentNode) {
      video.parentNode.insertBefore(mount, video);
      video.style.display = 'none';
    }
  }

  function boot() {
    YT = resolveEngine(engine, 'YT');
    if (!YT || !YT.Player || !mount) {
      emit('error', { fatal: true, engine: 'youtube', detail: 'YT IframeAPI not ready' });
      return;
    }
    yt = new YT.Player(mount, {
      videoId: source.videoId || source.src,
      playerVars: Object.assign({ controls: 0, modestbranding: 1, disablekb: 1, rel: 0, fs: 0, iv_load_policy: 3 },
        (opts && opts.youtube && opts.youtube.playerVars) || {}),
      events: {
        onReady: function () { hooks.onReady(); },
        onStateChange: function (e) {
          var S = YT.PlayerState;
          if (e.data === S.PLAYING) { hooks.onState('playing'); startPoll(); }
          else if (e.data === S.PAUSED) { hooks.onState('paused'); stopPoll(); }
          else if (e.data === S.BUFFERING) { hooks.onState('buffering'); }
          else if (e.data === S.ENDED) { hooks.onState('ended'); stopPoll(); emit('ended', {}); }
        }
      }
    });
  }

  function startPoll() {
    stopPoll();
    pollTimer = setInterval(function () {
      if (!yt || typeof yt.getCurrentTime !== 'function') return;
      emit('progress', {
        currentTime: yt.getCurrentTime(),
        duration: yt.getDuration ? yt.getDuration() : 0,
        percent: yt.getDuration && yt.getDuration() ? yt.getCurrentTime() / yt.getDuration() : 0
      });
    }, (opts && opts.progressInterval) || 500);
  }
  function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  // 若 YT 尚未就緒，掛上全域 ready 回呼（YouTube API 慣例）
  if (YT && YT.Player) boot();
  else if (typeof window !== 'undefined') {
    var prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = function () { if (typeof prev === 'function') prev(); boot(); };
  }

  return {
    kind: 'youtube',
    yt: function () { return yt; },
    play: function () { if (yt) yt.playVideo(); },
    pause: function () { if (yt) yt.pauseVideo(); },
    seek: function (t) { if (yt) yt.seekTo(t, true); },
    setVolume: function (v) { if (yt) yt.setVolume(Math.round(v * 100)); },
    mute: function (m) { if (yt) (m ? yt.mute() : yt.unMute()); },
    setRate: function (r) { if (yt && yt.setPlaybackRate) yt.setPlaybackRate(r); },
    getCurrentTime: function () { return yt && yt.getCurrentTime ? yt.getCurrentTime() : 0; },
    getDuration: function () { return yt && yt.getDuration ? yt.getDuration() : 0; },
    getQualities: function () { return []; },
    setQuality: function () {},
    destroy: function () { stopPoll(); try { if (yt) yt.destroy(); } catch (e) {} if (mount && mount.parentNode) mount.parentNode.removeChild(mount); }
  };
}

/* ------------------------------------------------------------------ *
 * 核心
 * ------------------------------------------------------------------ */
function createVideoCore(video, options) {
  var opts = options || {};
  var engine = opts.engine || {};
  var emitter = createEmitter();
  var sources = (opts.sources || []).filter(Boolean);
  var adapter = null;      // 目前正片 adapter
  var activeSource = null;
  var previewMode = false; // 是否正在播放預覽片段
  var destroyed = false;
  var progressTimer = null;
  var domListeners = [];

  /* ---- 進度輪詢（原生 video 型別；youtube 走自己的輪詢）---- */
  function startProgress() {
    stopProgress();
    if (activeSource && activeSource.type === 'youtube') return;
    progressTimer = setInterval(function () {
      if (video.paused || video.ended) return;
      var dur = video.duration || 0;
      var buffered = 0;
      try { if (video.buffered && video.buffered.length) buffered = video.buffered.end(video.buffered.length - 1); } catch (e) {}
      emitter.emit('progress', {
        currentTime: video.currentTime,
        duration: dur,
        buffered: buffered,
        percent: dur ? video.currentTime / dur : 0,
        preview: previewMode
      });
    }, opts.progressInterval || 300);
  }
  function stopProgress() { if (progressTimer) { clearInterval(progressTimer); progressTimer = null; } }

  /* ---- 綁定原生 video 事件 → statechange ---- */
  function bindVideoEvents() {
    var on = function (evt, fn) { video.addEventListener(evt, fn); domListeners.push([evt, fn]); };
    on('play', function () { emitter.emit('statechange', { state: 'playing' }); startProgress(); });
    on('playing', function () { emitter.emit('statechange', { state: 'playing' }); startProgress(); });
    on('pause', function () { emitter.emit('statechange', { state: 'paused' }); stopProgress(); });
    on('waiting', function () { emitter.emit('statechange', { state: 'buffering' }); });
    on('ended', function () { emitter.emit('statechange', { state: 'ended' }); stopProgress(); emitter.emit('ended', {}); });
    on('volumechange', function () { emitter.emit('statechange', { state: video.paused ? 'paused' : 'playing', volume: video.volume, muted: video.muted }); });
  }

  /* ---- 掛上某個 source 的正片 adapter ---- */
  function attachSource(source) {
    activeSource = source;
    switch (source.type) {
      case 'hls': adapter = createHlsAdapter(video, source, engine, emitter.emit, opts); break;
      case 'dash': adapter = createDashAdapter(video, source, engine, emitter.emit, opts); break;
      case 'mp4': adapter = createMp4Adapter(video, source); break;
      case 'youtube':
        adapter = createYouTubeAdapter(video, source, engine, emitter.emit, opts, {
          onReady: function () { emitter.emit('ready', { source: source, engine: 'youtube' }); if (opts.autoplay) core.play(); },
          onState: function (s) { emitter.emit('statechange', { state: s }); }
        });
        return; // youtube 自行處理 ready/progress
      default: break;
    }
    // 非 youtube：套用 poster / startTime / autoplay
    if (opts.poster && !video.poster) video.poster = opts.poster;
    if (opts.startTime) {
      var seekOnce = function () { try { video.currentTime = opts.startTime; } catch (e) {} video.removeEventListener('loadedmetadata', seekOnce); };
      video.addEventListener('loadedmetadata', seekOnce);
    }
    emitter.emit('ready', { source: source, engine: adapter ? adapter.kind : source.type });
    if (opts.autoplay) core.play();
  }

  /* ---- 預覽秒開 → 無縫切正片（lurlhub 核心特性）---- */
  function startWithPreview(fullSource) {
    previewMode = true;
    video.src = opts.preview.src;
    if (opts.poster) video.poster = opts.poster;
    emitter.emit('ready', { source: { type: 'preview', src: opts.preview.src }, engine: 'preview', preview: true });
    if (opts.autoplay) core.play();

    // 背景準備正片 adapter；就緒後保留播放狀態、無縫切換
    var swap = function () {
      if (destroyed) return;
      var snapshot = {
        currentTime: video.currentTime,
        wasPlaying: !video.paused,
        volume: video.volume,
        muted: video.muted,
        rate: video.playbackRate
      };
      // 建立正片 adapter（會 attachMedia / 設 src）
      attachFull(fullSource);
      var restore = function () {
        try {
          video.currentTime = snapshot.currentTime;
          video.volume = snapshot.volume;
          video.muted = snapshot.muted;
          video.playbackRate = snapshot.rate;
          if (snapshot.wasPlaying) video.play().catch(function () {});
        } catch (e) {}
        previewMode = false;
        emitter.emit('statechange', { state: 'switched', from: 'preview', to: fullSource.type });
      };
      video.addEventListener('loadedmetadata', function once() { video.removeEventListener('loadedmetadata', once); restore(); });
    };

    // 給預覽片段一點播放時間再切（避免搶跑）；實務上 HLS manifest 一到就切
    if (fullSource.type === 'hls' || fullSource.type === 'dash') {
      // 直接建立引擎，靠 loadedmetadata 觸發 restore
      swap();
    } else {
      // mp4 正片：等預覽播一會兒或使用者互動後再切
      setTimeout(swap, opts.previewSwapDelay || 1200);
    }
  }
  function attachFull(source) {
    if (adapter && adapter.destroy) { try { adapter.destroy(); } catch (e) {} }
    adapter = null;
    attachSource(source);
  }

  /* ---- 挑選可播來源（依序 + healthCheck），必要時往後 fallback ---- */
  function pickAndAttach(startIndex) {
    var idx = startIndex || 0;
    function tryNext(i) {
      if (destroyed) return;
      if (i >= sources.length) {
        emitter.emit('error', { fatal: true, detail: 'no playable source' });
        return;
      }
      var src = sources[i];
      if (!isSourcePlayable(src, video, engine)) { tryNext(i + 1); return; }

      var proceed = function (ok) {
        if (destroyed) return;
        if (!ok) { tryNext(i + 1); return; }
        // 找到可播來源
        if (opts.preview && opts.preview.src && src.type !== 'youtube') startWithPreview(src);
        else attachSource(src);
      };

      if (typeof opts.healthCheck === 'function') {
        Promise.resolve()
          .then(function () { return opts.healthCheck(src.src, src); })
          .then(function (ok) { proceed(ok !== false); })
          .catch(function () { proceed(false); });
      } else {
        proceed(true);
      }
    }
    tryNext(idx);
  }

  // 監聽 HLS/DASH fatal → 依 fallbackSrc 或下一個來源自動切換
  emitter.on('error', function (info) {
    if (!info || !info.fatal || destroyed) return;
    if (previewMode || !activeSource) return;
    // 找出目前來源在 sources 的位置，往後找下一個
    var curIdx = sources.indexOf(activeSource);
    if (curIdx >= 0 && curIdx + 1 < sources.length) {
      if (adapter && adapter.destroy) { try { adapter.destroy(); } catch (e) {} }
      adapter = null;
      pickAndAttach(curIdx + 1);
    }
  });

  /* ---------------- 對外 API ---------------- */
  var core = {
    on: emitter.on,
    off: emitter.off,
    once: emitter.once,

    play: function () {
      if (adapter && adapter.kind === 'youtube') { adapter.play(); return Promise.resolve(); }
      var p = video.play();
      return (p && p.catch) ? p.catch(function () {}) : Promise.resolve();
    },
    pause: function () {
      if (adapter && adapter.kind === 'youtube') { adapter.pause(); return; }
      video.pause();
    },
    seek: function (t) {
      if (adapter && adapter.kind === 'youtube') { adapter.seek(t); return; }
      try { video.currentTime = t; } catch (e) {}
    },
    skip: function (delta) {
      var cur = (adapter && adapter.kind === 'youtube') ? adapter.getCurrentTime() : video.currentTime;
      var dur = (adapter && adapter.kind === 'youtube') ? adapter.getDuration() : (video.duration || Infinity);
      var next = Math.max(0, Math.min(dur, cur + delta));
      core.seek(next);
      return next;
    },
    setRate: function (r) {
      if (adapter && adapter.kind === 'youtube') { adapter.setRate(r); return; }
      video.playbackRate = r;
    },
    setVolume: function (v) {
      var vol = Math.max(0, Math.min(1, v));
      if (adapter && adapter.kind === 'youtube') { adapter.setVolume(vol); return; }
      video.volume = vol;
    },
    mute: function (m) {
      var on = m !== false;
      if (adapter && adapter.kind === 'youtube') { adapter.mute(on); return; }
      video.muted = on;
    },

    getQualities: function () { return adapter && adapter.getQualities ? adapter.getQualities() : []; },
    setQuality: function (id) { if (adapter && adapter.setQuality) adapter.setQuality(id); },

    getSource: function () { return activeSource; },
    getEngine: function () { return adapter ? adapter.kind : null; },
    isPreview: function () { return previewMode; },

    destroy: function () {
      destroyed = true;
      stopProgress();
      if (adapter && adapter.destroy) { try { adapter.destroy(); } catch (e) {} }
      adapter = null;
      domListeners.forEach(function (pair) { try { video.removeEventListener(pair[0], pair[1]); } catch (e) {} });
      domListeners = [];
      try { video.removeAttribute('src'); video.load && video.load(); } catch (e) {}
      emitter.clear();
    }
  };

  // 啟動
  bindVideoEvents();
  // 允許 sources 為空時只掛事件（測試/延後 load）
  if (sources.length) pickAndAttach(0);

  return core;
}

/* ------------------------------------------------------------------ *
 * 匯出（CJS）
 * ------------------------------------------------------------------ */
module.exports = createVideoCore;
module.exports.createVideoCore = createVideoCore;
module.exports.createEmitter = createEmitter;
module.exports.isSourcePlayable = isSourcePlayable;
module.exports.canPlayNativeHls = canPlayNativeHls;
