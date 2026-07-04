'use strict';

/*
 * example.js — ILLUSTRATIVE ONLY
 * 這支範例「不會」在 Node 底下碰真正的 DOM 或串流引擎，跑 `node example.js` 應乾淨結束。
 * 它做兩件事：
 *   1) 用純 JS（不需 DOM）驗證核心的事件發射器真的能運作。
 *   2) 印出對外 API surface + 一段「瀏覽器接線」的註解片段，供你複製到前端。
 */

const createVideoCore = require('./index.js');
const { createEmitter } = createVideoCore;

console.log('=== video-core-kit ===');
console.log('export typeof:', typeof createVideoCore, '(應為 function)');
console.log('');

// --- 1) 純 JS 驗證事件系統（無 DOM）---
const bus = createEmitter();
const off = bus.on('progress', (p) => console.log('[emitter demo] progress ->', JSON.stringify(p)));
bus.emit('progress', { currentTime: 12.5, duration: 100, percent: 0.125 });
off();
bus.emit('progress', { currentTime: 99 }); // 已 off，不會印
console.log('emitter on/off/emit: OK');
console.log('');

// --- 2) API surface ---
console.log('Methods:  play, pause, seek(t), skip(±s), setRate(r), setVolume(0..1), mute(bool),');
console.log('          getQualities(), setQuality(id), getSource(), getEngine(), isPreview(), destroy()');
console.log('Events:   ready | progress | statechange | qualitychange | error | ended');
console.log('Register: core.on(event, cb) / core.off / core.once');
console.log('');

// --- 3) 瀏覽器接線片段（註解，不執行）---
console.log([
  '// ---- 瀏覽器端接線範例（把 Hls / shaka / YT 用 engine 注入，核心零依賴）----',
  "// import Hls from 'hls.js';",
  "// const video = document.querySelector('#player');",
  '// const core = createVideoCore(video, {',
  '//   sources: [',
  "//     { type: 'hls', src: '/hls/master.m3u8?t=<media-gate-token>', fallbackSrc: '/v.mp4' },",
  "//     { type: 'mp4', src: '/v.mp4' },",
  '//   ],',
  "//   preview: { src: '/preview.mp4' },   // 預覽秒開 → 無縫切 HLS",
  "//   poster: '/thumb.webp', autoplay: true, startTime: 0,",
  '//   engine: { Hls },                    // 只注入你有的引擎',
  '//   healthCheck: (src) => fetch(src, { method: "HEAD" }).then(r => r.ok).catch(() => false),',
  '// });',
  "// core.on('ready',       (e) => console.log('ready', e.engine));",
  "// core.on('progress',    (p) => ui.setProgress(p.percent));   // ~300ms",
  "// core.on('statechange', (s) => ui.setPlaying(s.state === 'playing'));",
  "// core.on('qualitychange', (q) => ui.markQuality(q.id));",
  "// core.on('error',       (e) => console.warn('fatal?', e.fatal));",
  '// // 你自己畫控制列，呼叫 core.play() / core.skip(10) / core.setQuality(id) ...'
].join('\n'));

console.log('\n(example finished, no DOM/engine touched)');
