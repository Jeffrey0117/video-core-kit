<p align="center">
  <img src="logo.svg" width="96" height="96" alt="video-core-kit logo">
</p>

# video-core-kit

> Headless 影片播放核心 — 三站共用一顆邏輯核心。
> HLS / DASH / MP4 / YouTube 統一載入與畫質切換、**engine 注入（零依賴）**、
> **預覽秒開 → 無縫切正片**、~300ms 進度事件、fatal 自動 fallback。UI 你自己畫。

`video-core-kit` 是從三個已上線的播放器抽出來的「共同核心」：

| 來源站台 | 原本用的技術 | 貢獻進核心的能力 |
|---|---|---|
| **lurlhub** | Plyr + hls.js（vanilla） | 預覽片段秒開 → 背景載 HLS →**無縫切換**（保留 currentTime/volume/rate/播放狀態）、短影片直出 MP4、Safari 原生 HLS、HLS fatal 回退 MP4、由 `hls.levels` 匯出畫質 |
| **meetube** | Shaka Player（Vue） | Shaka `attach → load → getVariantTracks / selectVariantTrack` 的 DASH+HLS 畫質選取 |
| **coursebloom** | YouTube IframeAPI（React） | ~500ms 進度回呼、±10 秒快轉、**主來源健康檢查失敗自動切備援** |

核心是 **headless**：它只把串流引擎接上你給的 `<video>`、對外發事件 + 開方法。
控制列、樣式、外觀全是消費端的事 —— 所以同一顆核心可以在 React、Vue、原生各自套薄殼。

---

## 設計原則

- **Headless**：不畫 UI、不建立多餘 DOM（`youtube` 型別例外，需自管 iframe）。
- **零依賴**：`hls.js` / `Shaka` / `YT IframeAPI` 一律由 `engine` 注入，或自動在 `window` 偵測；核心本身不 `require`、不 bundle 任何串流庫（`node --check index.js` 全乾淨）。
- **引擎策略**：
  - `hls` → 有注入的 `Hls` 且 `Hls.isSupported()` 就用它；否則試 Safari 原生 `canPlayType('application/vnd.apple.mpegurl')`；再否則往後找 `mp4` 來源。
  - `dash` → 用注入的 `shaka`。
  - `mp4` → 直接 `video.src`。
  - `youtube` → 用注入的 `YT` 建 iframe adapter。

---

## 安裝

零依賴，直接放進 monorepo 或 `npm i`（引擎由你的專案各自安裝）：

```bash
npm i video-core-kit
# 你的宿主專案自行安裝需要的引擎：
# npm i hls.js          # HLS
# npm i shaka-player    # DASH
# YouTube 走官方 IframeAPI，不需 npm
```

---

## 原生（vanilla）接線

「建立 `<video>` → 注入 Hls → `createVideoCore` → 訂事件 + 自己畫控制列」：

```html
<div class="player">
  <video id="player" playsinline></video>
  <!-- 你自己的控制列（略）-->
</div>

<script src="https://cdn.jsdelivr.net/npm/hls.js@1"></script>
<script src="./index.js"></script>  <!-- 或打包後 import -->
<script>
  const video = document.getElementById('player');

  const core = createVideoCore(video, {
    sources: [
      { type: 'hls', src: '/hls/master.m3u8?t=<media-gate-token>', fallbackSrc: '/v.mp4' },
      { type: 'mp4', src: '/v.mp4' },        // HLS 不支援時的退路
    ],
    preview: { src: '/preview.mp4' },        // 預覽秒開 → 無縫切 HLS
    poster: '/thumb.webp',
    autoplay: true,
    startTime: 0,
    engine: { Hls: window.Hls },             // 只注入你有的引擎
    healthCheck: (src) =>                     // 選用：來源探活，失敗就往下一個 source
      fetch(src, { method: 'HEAD' }).then(r => r.ok).catch(() => false),
  });

  core.on('ready',        e => console.log('ready via', e.engine));
  core.on('progress',     p => myBar.style.width = (p.percent * 100) + '%');   // ~300ms
  core.on('statechange',  s => myPlayBtn.classList.toggle('playing', s.state === 'playing'));
  core.on('qualitychange',q => console.log('now quality', q.id));
  core.on('error',        e => console.warn('fatal?', e.fatal, e.engine));
  core.on('ended',        () => console.log('done'));

  // 你自己的按鈕呼叫核心方法：
  myPlayBtn.onclick   = () => core.play();
  myPauseBtn.onclick  = () => core.pause();
  myFwdBtn.onclick    = () => core.skip(10);
  myBackBtn.onclick   = () => core.skip(-10);
  mySpeed.onchange    = e => core.setRate(+e.target.value);
  // 畫質選單：
  core.getQualities().forEach(q => addOption(q.id, q.label, q.active));
  qualitySelect.onchange = e => core.setQuality(+e.target.value);  // -1 = 自動
</script>
```

### DASH（Shaka）/ YouTube

```js
// DASH：注入 shaka
createVideoCore(video, {
  sources: [{ type: 'dash', src: '/manifest.mpd', mimeType: 'application/dash+xml', fallbackSrc: '/v.mp4' }],
  engine: { shaka: window.shaka },
});

// YouTube：注入 YT（官方 IframeAPI），核心會自管一個 iframe
createVideoCore(video, {
  sources: [{ type: 'youtube', videoId: 'dQw4w9WgXcQ' }],
  engine: { YT: window.YT },
  youtube: { container: document.querySelector('.player') }, // iframe 掛哪裡
});
```

---

## React / Vue 套薄殼

核心是純邏輯，框架殼只做兩件事：**在 mount 時建 core、unmount 時 `destroy()`**，把事件接進自家 state。

**React：**

```jsx
function VideoShell({ opts }) {
  const ref = useRef(null);
  const [state, setState] = useState({ percent: 0, playing: false, qualities: [] });
  useEffect(() => {
    const core = createVideoCore(ref.current, opts);
    core.on('progress',    p => setState(s => ({ ...s, percent: p.percent })));
    core.on('statechange', s => setState(v => ({ ...v, playing: s.state === 'playing' })));
    core.on('ready',       () => setState(s => ({ ...s, qualities: core.getQualities() })));
    return () => core.destroy();        // 乾淨卸載
  }, []);
  return <div className="player"><video ref={ref} playsInline /> {/* 你的控制列 */}</div>;
}
```

**Vue 3：**

```vue
<script setup>
import { onMounted, onBeforeUnmount, ref, reactive } from 'vue';
import createVideoCore from 'video-core-kit';
const el = ref(null); let core;
const ui = reactive({ percent: 0, playing: false });
onMounted(() => {
  core = createVideoCore(el.value, props.opts);
  core.on('progress',    p => (ui.percent = p.percent));
  core.on('statechange', s => (ui.playing = s.state === 'playing'));
});
onBeforeUnmount(() => core && core.destroy());
</script>
<template><div class="player"><video ref="el" playsinline /></div></template>
```

---

## API

### `createVideoCore(videoEl, options)`

| option | 說明 |
|---|---|
| `sources` | `[{ type:'hls'\|'dash'\|'mp4'\|'youtube', src, videoId?, mimeType?, quality?, fallbackSrc? }]`，依序挑第一個可播的 |
| `preview` | `{ src }` — 預覽片段，先秒開再無縫切正片（youtube 型別略過） |
| `poster` | 縮圖 URL |
| `autoplay` | 就緒後自動播放 |
| `startTime` | 起播秒數 |
| `engine` | `{ Hls, shaka, YT }` — 注入的串流庫（未給則自動偵測 `window`） |
| `healthCheck` | `(src, source) => boolean \| Promise<boolean>`，回 `false` 就跳下一個來源 |
| `progressInterval` | 進度事件間隔 ms（預設 300；youtube 預設 500） |
| `hlsConfig` | 額外覆蓋 hls.js 建構參數 |
| `youtube` | `{ container, playerVars }` |

### 方法

| 方法 | 說明 |
|---|---|
| `play()` / `pause()` | 播放 / 暫停 |
| `seek(t)` | 跳到第 `t` 秒 |
| `skip(±s)` | 相對快轉/倒退（回傳新秒數） |
| `setRate(r)` | 播放速率 |
| `setVolume(v)` | 音量 `0..1` |
| `mute(bool)` | 靜音切換 |
| `getQualities()` | `[{ id, height, label, auto?, active }]`，`id === -1` 為自動 |
| `setQuality(id)` | 切畫質（`-1` = 自動 / 開 ABR） |
| `getSource()` / `getEngine()` / `isPreview()` | 目前狀態查詢 |
| `on/off/once(event, cb)` | 事件訂閱 |
| `destroy()` | 卸載引擎 + 移除 listener + 清事件 |

### 事件

| event | payload |
|---|---|
| `ready` | `{ source, engine, preview? }` |
| `progress` | `{ currentTime, duration, buffered, percent, preview }`（~300ms，播放中） |
| `statechange` | `{ state: 'playing'\|'paused'\|'buffering'\|'ended'\|'switched', ... }` |
| `qualitychange` | `{ id, auto? }` |
| `error` | `{ fatal, engine, detail, fallbackSrc? }`（fatal 時核心會自動往下一個 source 切） |
| `ended` | `{}` |

---

## 組合縫（seams，本核心不實作，只留接點）

這顆核心刻意「只做播放」，方便和 Jeff 的其他 kit 串起來：

- **media-gate**：來源 URL 可帶授權 token（`?t=...`）。核心把 `src` 原樣沿用、不解析 token —— 由 `media-gate-kit` 產、由你的後端驗。
- **audio-dsp-kit**：音訊後處理（等化、增益、降噪）可在消費端用 `AudioContext.createMediaElementSource(videoEl)` 掛在同一個 `<video>` 上；核心不碰 Web Audio。
- **bilingual-subtitle-kit**：雙語 / 外掛字幕可用 `<track>` 或自繪 overlay，靠核心的 `progress` 事件對時；核心只發時間，不管字幕渲染。

---

## 驗證

```bash
node --check index.js   # 語法乾淨、無引擎 import
node example.js         # 印出 API surface，不碰 DOM/引擎
```

MIT © Jeffrey0117
