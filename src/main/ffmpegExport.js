'use strict';
// Turns the editor's timeline (an "EDL" - edit decision list, plain JSON
// describing tracks/clips/media) into a single ffmpeg filter_complex graph
// and runs it. This is the thing that replaces the browser build's
// WebCodecs + hand-rolled WebM/MP4 muxer: real ffmpeg does the decode,
// composite, and encode, so it doesn't care what OS or browser engine is
// involved and it's dramatically faster than a realtime capture.
//
// Compositing rule (matches the original canvas-based preview exactly):
// among the video tracks, whichever one is *first* in the tracks array is
// drawn last / on top. Tracks are otherwise independent lanes: clips on a
// track never overlap each other in time. Where a track has no clip active,
// the track below shows through; where every track is empty, the canvas
// background color shows.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');

const BG_COLOR = '0x2e2b25'; // matches the app's canvas background / letterbox color

const RESOLUTIONS = {
  '720p': [1280, 720],
  '1080p': [1920, 1080],
  '1440p': [2560, 1440],
  '4K': [3840, 2160],
};

const BITRATES = {
  '720p': 5_000_000,
  '1080p': 8_000_000,
  '1440p': 16_000_000,
  '4K': 35_000_000,
};

const MAX_DURATION_SEC = 25200; // 7 hours, matches the editor's own export limit
const MAX_CLIPS = 5000; // sane upper bound so a pathological EDL can't blow up the filter graph

// xfade's own built-in transition names - used directly as the ffmpeg
// `transition=` value, so this list doubles as the validation allow-list.
const TRANSITION_TYPES = new Set([
  'none', 'fade', 'wipeleft', 'wiperight', 'wipeup', 'wipedown',
  'slideleft', 'slideright', 'slideup', 'slidedown',
  'circleopen', 'circleclose', 'dissolve',
]);
const MAX_TRANSITION_DURATION = 3; // seconds - sane upper bound, also enforced client-side

// Encode-speed tradeoff. Bitrate is fixed per resolution (see BITRATES)
// regardless of speed choice, so this doesn't change output file size -
// it trades encoding time against how much visual quality ffmpeg can
// squeeze out of that same bitrate. "balanced" matches the app's original,
// only-ever-tested behavior, so it stays the default.
// amfQuality: AMD AMF's -quality takes the enum values themselves.
// vaapiQuality: most VAAPI drivers expose a driver-defined 1(best)-7(fastest)
// -quality scale; this mapping matches the convention other apps (OBS,
// Jellyfin, etc.) use for the same three-tier speed/quality tradeoff.
const SPEED_PRESETS = {
  fast: { x264Preset: 'ultrafast', vp9CpuUsed: 8, vp9Deadline: 'realtime', nvencPreset: 'p1', amfQuality: 'speed', vaapiQuality: 7 },
  balanced: { x264Preset: 'veryfast', vp9CpuUsed: 2, vp9Deadline: 'good', nvencPreset: 'p4', amfQuality: 'balanced', vaapiQuality: 4 },
  quality: { x264Preset: 'slow', vp9CpuUsed: 0, vp9Deadline: 'good', nvencPreset: 'p6', amfQuality: 'quality', vaapiQuality: 1 },
};
function getSpeedPreset(speed) { return SPEED_PRESETS[speed] || SPEED_PRESETS.balanced; }

// The EDL comes over IPC from the renderer. Even though this app only ever
// ships its own renderer (not remote/untrusted content), it's still cheap
// insurance to validate the shape and values before they end up inside an
// ffmpeg command line - malformed input should fail with a clear error here
// rather than produce a confusing ffmpeg crash or, worse, a filter/argument
// ffmpeg interprets in an unexpected way. Every media path in particular is
// checked to be an absolute, existing, real file - never a relative path or
// something that could be mistaken for a flag.
function validateEdl(edl) {
  const fail = (msg) => { throw new Error(msg); };
  if (!edl || typeof edl !== 'object') fail('missing EDL');

  if (!RESOLUTIONS[edl.resolution]) fail('invalid resolution: ' + edl.resolution);
  if (edl.aspect !== '16:9' && edl.aspect !== '9:16') fail('invalid aspect: ' + edl.aspect);
  if (edl.format !== 'mp4' && edl.format !== 'webm') fail('invalid format: ' + edl.format);
  if (!Number.isFinite(edl.fps) || edl.fps < 1 || edl.fps > 120) fail('invalid fps: ' + edl.fps);
  if (edl.speed != null && !SPEED_PRESETS[edl.speed]) fail('invalid speed: ' + edl.speed);
  if (edl.resourceCapped != null && typeof edl.resourceCapped !== 'boolean') fail('invalid resourceCapped: ' + edl.resourceCapped);
  if (!Number.isFinite(edl.duration) || edl.duration <= 0 || edl.duration > MAX_DURATION_SEC) {
    fail('invalid or out-of-range duration: ' + edl.duration);
  }

  if (!Array.isArray(edl.tracks)) fail('tracks must be an array');
  const trackIds = new Set();
  edl.tracks.forEach((t) => {
    if (!t || typeof t.id !== 'string' || !t.id) fail('track missing id');
    if (t.type !== 'video' && t.type !== 'audio') fail('invalid track type: ' + t.type);
    trackIds.add(t.id);
  });

  if (!Array.isArray(edl.media)) fail('media must be an array');
  const mediaIds = new Set();
  edl.media.forEach((m) => {
    if (!m || typeof m.id !== 'string' || !m.id) fail('media missing id');
    if (!['video', 'audio', 'image'].includes(m.type)) fail('invalid media type: ' + m.type);
    if (typeof m.path !== 'string' || !m.path) fail('media missing path');
    if (m.path.includes('\0')) fail('invalid media path');
    if (!path.isAbsolute(m.path)) fail('media path must be absolute: ' + m.path);
    let stat;
    try { stat = fs.statSync(m.path); } catch (e) { fail('media file not found: ' + m.path); }
    if (!stat.isFile()) fail('media path is not a regular file: ' + m.path);
    mediaIds.add(m.id);
  });

  if (!Array.isArray(edl.clips)) fail('clips must be an array');
  if (edl.clips.length > MAX_CLIPS) fail('too many clips');
  edl.clips.forEach((c) => {
    if (!c || typeof c.id !== 'string' || !c.id) fail('clip missing id');
    if (!trackIds.has(c.trackId)) fail('clip references unknown track: ' + c.trackId);
    if (!mediaIds.has(c.mediaId)) fail('clip references unknown media: ' + c.mediaId);
    if (!Number.isFinite(c.start) || c.start < 0) fail('invalid clip start: ' + c.start);
    if (!Number.isFinite(c.duration) || c.duration <= 0) fail('invalid clip duration: ' + c.duration);
    if (!Number.isFinite(c.inPoint) || c.inPoint < 0) fail('invalid clip inPoint: ' + c.inPoint);
    if (c.volume != null && (!Number.isFinite(c.volume) || c.volume < 0 || c.volume > 4)) {
      fail('invalid clip volume: ' + c.volume);
    }
    if (c.filters != null) {
      const filt = c.filters;
      if (typeof filt !== 'object') fail('invalid clip filters');
      for (const key of ['brightness', 'contrast', 'saturation']) {
        const v = filt[key];
        if (v != null && (!Number.isFinite(v) || v < 0 || v > 200)) fail(`invalid clip filters.${key}: ${v}`);
      }
      for (const key of ['blur', 'grayscale', 'sepia', 'vignette']) {
        const v = filt[key];
        const max = key === 'blur' ? 20 : 100;
        if (v != null && (!Number.isFinite(v) || v < 0 || v > max)) fail(`invalid clip filters.${key}: ${v}`);
      }
    }
    if (c.fadeIn != null && (!Number.isFinite(c.fadeIn) || c.fadeIn < 0)) fail('invalid clip fadeIn: ' + c.fadeIn);
    if (c.fadeOut != null && (!Number.isFinite(c.fadeOut) || c.fadeOut < 0)) fail('invalid clip fadeOut: ' + c.fadeOut);

    if (c.transitionIn != null) {
      const tr = c.transitionIn;
      if (typeof tr !== 'object') fail('invalid clip transitionIn');
      if (tr.type != null && !TRANSITION_TYPES.has(tr.type)) fail('invalid transitionIn.type: ' + tr.type);
      if (tr.duration != null && (!Number.isFinite(tr.duration) || tr.duration < 0 || tr.duration > MAX_TRANSITION_DURATION)) {
        fail('invalid transitionIn.duration: ' + tr.duration);
      }
      if (tr.fromClipId != null && typeof tr.fromClipId !== 'string') fail('invalid transitionIn.fromClipId');
    }
  });

  return true;
}

// ---------- transitions ----------
// A clip's transitionIn is only ever honored if it's *provably* adjacent to
// the clip it claims to transition from: same track, that clip immediately
// precedes it in start order, and its start lines up (within a couple
// frames) with "previous clip's end minus the transition duration" - i.e.
// exactly the overlap the editor creates when a transition is applied. Any
// mismatch (clips dragged apart after the fact, a deleted "from" clip, a
// stale reference) just silently falls back to a hard cut rather than
// erroring - the same forgiving behavior the editor's own preview uses.
function computeValidTransitions(edl) {
  const byToClipId = {}; // clipId -> { duration, type, fromClipId }
  const byFromClipId = {}; // clipId -> outgoing transition duration (max, if referenced more than once)
  const byTrack = {};
  edl.clips.forEach((c) => { (byTrack[c.trackId] = byTrack[c.trackId] || []).push(c); });
  Object.values(byTrack).forEach((list) => {
    list.sort((a, b) => a.start - b.start);
    for (let i = 1; i < list.length; i++) {
      const clip = list[i], prev = list[i - 1];
      const tr = clip.transitionIn;
      if (!tr || tr.type === 'none' || !tr.type || !(tr.duration > 0)) continue;
      if (tr.fromClipId !== prev.id) continue;
      const expectedStart = prev.start + prev.duration - tr.duration;
      if (Math.abs(expectedStart - clip.start) > 0.02) continue;
      const d = Math.min(tr.duration, prev.duration, clip.duration);
      if (d <= 0) continue;
      byToClipId[clip.id] = { duration: d, type: tr.type, fromClipId: prev.id };
      byFromClipId[prev.id] = Math.max(byFromClipId[prev.id] || 0, d);
    }
  });
  return { byToClipId, byFromClipId };
}

function getExportDims(resolution, aspect) {
  const [w, h] = RESOLUTIONS[resolution] || RESOLUTIONS['1080p'];
  return aspect === '9:16' ? { w: h, h: w } : { w, h };
}

function getBitrate(resolution) {
  return BITRATES[resolution] || BITRATES['1080p'];
}

// ---------- CPU thread count / resource cap ----------
// ffmpeg's own "auto" thread detection (what you get by simply omitting
// -threads / -filter_complex_threads) turned out, on real measurement, to
// not reliably track actual logical CPU count - on a constrained/low-core
// machine it can over-subscribe (spawning more threads than exist, adding
// pure scheduling overhead with no parallelism benefit), which is the
// opposite of what a low-power machine needs, and gives no guarantee it
// scales *up* to use everything available on a beefy one either. Querying
// the real count ourselves and passing it explicitly fixes both ends: small
// machines don't oversubscribe, and big machines actually get used.
//
// Separately: when the person has left "limit CPU, memory & GPU usage" on
// (the default - see resourceCapEnabled in settingsStore), threads are
// further capped to a fraction of that count rather than requesting
// everything - a long export shouldn't have to mean the rest of the machine
// grinds to a halt. There's no cross-platform way to put a hard ceiling on
// a spawned process's actual memory use without either a native OS API
// this app doesn't have, or shelling out to one (which this app
// deliberately never does - see SECURITY.md), so the "memory" side of the
// cap is a genuine but best-effort reduction: fewer threads means fewer
// concurrent frame buffers in flight, and the encoders' own lookahead
// buffers (the biggest single memory knob available) are explicitly capped
// too. It's a real reduction in practice, just not an OS-enforced
// guarantee. The "GPU" side is even more limited: ffmpeg doesn't expose a
// percentage-based throttle for any hardware encoder, so instead of
// pretending to hit an exact number, the B-frame count is dropped to 0 on
// hardware encoders when capped (see the hw-encoder branches below) - B-
// frames are genuinely one of the more GPU-compute-heavy features NVENC/
// AMF/VAAPI/VideoToolbox can use, so this is a real (if partial) reduction
// in GPU work, not a hard ceiling at 75%.
const RESOURCE_CAP_FRACTION = 0.75;

function getCpuThreadCount(capped) {
  const total = Math.max(1, os.cpus().length);
  if (!capped) return total;
  return Math.max(1, Math.round(total * RESOURCE_CAP_FRACTION));
}

// ---------- VP9 multi-threading ----------
// libvpx-vp9 defaults to a single tile column (`-tile-columns` defaults to
// -1, which libvpx treats as 0 => 1 column), and a single tile is the unit
// `-row-mt` parallelizes *within* - so without tile columns, encode-thread
// count is effectively capped well below what row-mt alone can use on a
// many-core machine, regardless of -threads. Wider frames can be split into
// more tile columns without hurting quality much, so this scales tile count
// with output width and gives ffmpeg enough threads to actually fill them.
function getVp9TileColumns(width) {
  if (width >= 3840) return 3; // 8 columns - 4K
  if (width >= 1920) return 2; // 4 columns - 1080p/1440p
  if (width >= 1280) return 1; // 2 columns - 720p
  return 0;
}
function getVp9ThreadCount(tileColumns, capped) {
  const cpuThreads = getCpuThreadCount(capped);
  // When capped, treat the cap as a real ceiling rather than a floor - even
  // if that means fewer threads than the tile-column count would ideally
  // want. Uncapped, keep the previous behavior of ensuring at least enough
  // threads to fill every tile column.
  if (capped) return cpuThreads;
  return Math.max(cpuThreads, 1 << tileColumns);
}

// ---------- locate bundled ffmpeg / ffprobe binaries ----------
// ffmpeg-static / ffprobe-static resolve to a path *inside* app.asar when
// the app is packaged, which isn't directly executable. electron-builder's
// asarUnpack (see package.json) puts a real copy next to the asar at the
// same relative path, under an ".unpacked" sibling directory - this swaps
// the path over to that copy when running from a packaged build.
function resolveBinaryPath(rawPath) {
  if (rawPath.includes('app.asar')) {
    return rawPath.replace('app.asar', 'app.asar.unpacked');
  }
  return rawPath;
}

function getFfmpegPath() {
  // KUTFORGE_FFMPEG_PATH lets advanced users (or tests) point at a system
  // ffmpeg instead of the bundled binary.
  if (process.env.KUTFORGE_FFMPEG_PATH) return process.env.KUTFORGE_FFMPEG_PATH;
  return resolveBinaryPath(require('ffmpeg-static'));
}

function getFfprobePath() {
  if (process.env.KUTFORGE_FFPROBE_PATH) return process.env.KUTFORGE_FFPROBE_PATH;
  const ffprobeStatic = require('ffprobe-static');
  return resolveBinaryPath(ffprobeStatic.path);
}

// ---------- probing ----------
// We already know width/height/duration/type for each media item (the
// renderer captured that from the HTML <video>/<audio>/<img> element at
// import time) so all we still need from ffprobe is: does this file
// actually carry an audio stream? Video files without one, or audio-less
// clips, must be left out of the audio mix rather than making ffmpeg fail
// on a missing stream selector.
function probeHasAudio(filePath) {
  return new Promise((resolve) => {
    const ffprobe = getFfprobePath();
    execFile(ffprobe, [
      '-v', 'error',
      '-select_streams', 'a',
      '-show_entries', 'stream=codec_type',
      '-of', 'csv=p=0',
      filePath,
    ], { timeout: 15000 }, (err, stdout) => {
      if (err) { resolve(false); return; }
      resolve(stdout.trim().length > 0);
    });
  });
}

// Used at *import* time (not export time), so a file can be added to a
// project reliably regardless of whether Chromium's own <video>/<audio>
// element happens to understand its particular container/codec. Chromium's
// native media pipeline only recognizes a fairly narrow set of formats
// (basically MP4/H.264 and WebM/VP8-VP9, plus whatever the OS layers in),
// while ffprobe understands essentially everything ffmpeg itself can
// decode - and since export already depends on ffmpeg being able to read a
// file regardless, using ffprobe here too means duration/dimensions are
// reliable for any format the export pipeline can actually handle, not
// just the subset Chromium's <video> tag happens to support.
function probeMediaInfo(filePath) {
  return new Promise((resolve, reject) => {
    const ffprobe = getFfprobePath();
    execFile(ffprobe, [
      '-v', 'error',
      '-show_entries', 'format=duration:stream=codec_type,width,height,duration',
      '-of', 'json',
      filePath,
    ], { timeout: 20000 }, (err, stdout) => {
      if (err) {
        reject(new Error('Could not read this file - it may be corrupt or in a format that can\u2019t be decoded.'));
        return;
      }
      let parsed;
      try { parsed = JSON.parse(stdout); } catch (e) {
        reject(new Error('Could not read this file - it may be corrupt or in a format that can\u2019t be decoded.'));
        return;
      }
      const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
      const videoStream = streams.find(s => s.codec_type === 'video');
      const hasAudio = streams.some(s => s.codec_type === 'audio');
      // Most containers carry an overall duration; a few (some raw/odd
      // muxes) only put it on an individual stream instead.
      let duration = parsed.format && Number(parsed.format.duration);
      if (!Number.isFinite(duration) || duration <= 0) {
        const withDuration = streams.find(s => Number.isFinite(Number(s.duration)) && Number(s.duration) > 0);
        duration = withDuration ? Number(withDuration.duration) : 0;
      }
      resolve({
        duration: duration > 0 ? duration : 0,
        width: videoStream ? (Number(videoStream.width) || 0) : 0,
        height: videoStream ? (Number(videoStream.height) || 0) : 0,
        hasVideo: !!videoStream,
        hasAudio,
      });
    });
  });
}

// ---------- hardware-accelerated encoding (mp4/H.264 only) ----------
// A candidate is { encoder, device }. `device` is only meaningful for VAAPI
// (a /dev/dri render-node path); every other encoder here ignores it.
//
// NVENC (NVIDIA), VideoToolbox (macOS), and AMF (AMD, Windows) all accept
// plain software frames straight out of the filter graph - ffmpeg's wrapper
// for each one does the GPU upload internally - so they're used exactly the
// same way. VAAPI (AMD and Intel GPUs, and Nvidia's open driver, on Linux)
// is the odd one out: it only encodes hardware surfaces, so a `format=nv12,
// hwupload` step has to be appended to the filter graph and a specific
// render-node device declared - see buildFfmpegArgs. Quick Sync (Intel) is
// deliberately left out on Windows/macOS: it more often needs a specific
// pixel format/driver combination to behave correctly, and getting that
// wrong silently produces broken video rather than a clean failure, which
// isn't a good trade for an automatic feature.
//
// Every candidate here is only ever *used* after it passes a real, live
// capability test (testEncoder, below) that actually spins up the encoder
// against the real device - so a machine without the matching GPU/driver
// just silently falls through to the next candidate, and eventually to
// plain libx264, exactly like today. Nothing here can make an export slower
// or less safe than the software path: detection runs once per app session
// (cached in _hwEncoderCache) with a hard 4-second timeout per candidate,
// entirely separate from - and before - the sandboxed renderer or the
// actual encode ever starts.
let _hwEncoderCache; // undefined = not checked yet; null = checked, none found; { encoder, device } otherwise

function vaapiRenderNodes() {
  // Only offer render nodes that actually exist on this machine - keeps the
  // capability probe from wasting time on devices that can't exist.
  try {
    return fs.readdirSync('/dev/dri')
      .filter((name) => name.startsWith('renderD'))
      .sort()
      .map((name) => path.join('/dev/dri', name));
  } catch (e) {
    return []; // no /dev/dri at all (no GPU, or a platform that doesn't use it)
  }
}

function hardwareCandidatesForPlatform() {
  if (process.env.KUTFORGE_DISABLE_HW_ENCODE) return [];
  if (process.env.KUTFORGE_FORCE_HW_ENCODER) {
    return [{ encoder: process.env.KUTFORGE_FORCE_HW_ENCODER, device: process.env.KUTFORGE_FORCE_HW_DEVICE || null }];
  }
  if (process.platform === 'darwin') return [{ encoder: 'h264_videotoolbox', device: null }];
  if (process.platform === 'win32') {
    // Try NVIDIA first (most mature / most common discrete GPU on Windows),
    // then AMD's AMF - whichever one actually initializes wins.
    return [
      { encoder: 'h264_nvenc', device: null },
      { encoder: 'h264_amf', device: null },
    ];
  }
  // Linux: NVENC if an NVIDIA proprietary driver is present, otherwise
  // VAAPI - which is how AMD and Intel GPUs (and Nvidia's open kernel
  // module) expose hardware encode on Linux - tried against every render
  // node that exists, in order, until one actually works.
  return [
    { encoder: 'h264_nvenc', device: null },
    ...vaapiRenderNodes().map((device) => ({ encoder: 'h264_vaapi', device })),
  ];
}

function friendlyHwEncoderLabel(hw) {
  if (!hw) return null;
  switch (hw.encoder) {
    case 'h264_nvenc': return 'NVIDIA NVENC';
    case 'h264_videotoolbox': return 'Apple VideoToolbox';
    case 'h264_amf': return 'AMD AMF';
    case 'h264_vaapi': return 'VAAPI';
    default: return hw.encoder;
  }
}

function testEncoderArgs(candidate) {
  const { encoder, device } = candidate;
  // 320x240 rather than something tiny: NVENC in particular enforces a
  // minimum encode resolution that varies by GPU generation, and a probe
  // frame smaller than that fails the *test* even though the real encoder
  // would work fine on real video - which silently disables hardware
  // encoding for the whole session (the result is cached). 320x240 is
  // comfortably above every documented minimum for NVENC/AMF/VideoToolbox/
  // VAAPI alike.
  if (encoder === 'h264_vaapi') {
    // Mirrors the real encode path below: upload a tiny software frame to
    // the named render node and encode a few frames through it for real,
    // not just check that the encoder name is known to this ffmpeg build.
    return [
      '-y', '-vaapi_device', device,
      '-f', 'lavfi', '-i', 'color=black:s=320x240:d=0.2',
      '-vf', 'format=nv12,hwupload',
      '-frames:v', '3', '-c:v', encoder, '-f', 'null', '-',
      '-loglevel', 'error',
    ];
  }
  return [
    '-y', '-f', 'lavfi', '-i', 'color=black:s=320x240:d=0.2',
    '-frames:v', '3', '-c:v', encoder, '-f', 'null', '-',
    '-loglevel', 'error',
  ];
}

function testEncoder(ffmpegPath, candidate) {
  return new Promise((resolve) => {
    const args = testEncoderArgs(candidate);
    let done = false;
    let stderr = '';
    const finish = (ok) => {
      if (done) return; done = true;
      try { child.kill('SIGKILL'); } catch (e) { /* already gone */ }
      // KUTFORGE_DEBUG_HW_ENCODE=1 prints exactly why a candidate was
      // accepted/rejected - the probe's own -loglevel error output was
      // previously discarded entirely, which made "hardware encoding never
      // turns on" impossible to diagnose from the outside.
      if (process.env.KUTFORGE_DEBUG_HW_ENCODE) {
        console.error(`[kutforge] hw encoder probe ${candidate.encoder}${candidate.device ? ' (' + candidate.device + ')' : ''}: ${ok ? 'OK' : 'FAILED'}${stderr ? '\n' + stderr.trim() : ''}`);
      }
      resolve(ok);
    };
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    if (child.stderr) child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0));
    setTimeout(() => finish(false), 6000); // a little more headroom than before for slower driver/session init on first use
  });
}

async function detectHardwareEncoder() {
  if (_hwEncoderCache !== undefined) return _hwEncoderCache;
  const ffmpegPath = getFfmpegPath();
  for (const candidate of hardwareCandidatesForPlatform()) {
    if (await testEncoder(ffmpegPath, candidate)) { _hwEncoderCache = candidate; return _hwEncoderCache; }
  }
  _hwEncoderCache = null;
  return null;
}

// ---------- filter graph construction ----------
// Builds the full `-filter_complex` string plus the ordered list of ffmpeg
// `-i` inputs it references. Kept as a pure function (no Electron/child
// process APIs) so it can be unit tested directly with plain Node + a real
// ffmpeg binary.
async function buildFfmpegPlan(edl) {
  validateEdl(edl);
  const dims = getExportDims(edl.resolution, edl.aspect);
  const { w, h } = dims;
  const fps = edl.fps || 30;
  const duration = Math.max(0.001, edl.duration);

  const mediaById = {};
  edl.media.forEach((m) => { mediaById[m.id] = m; });
  const trackById = {};
  edl.tracks.forEach((t) => { trackById[t.id] = t; });

  // Only reference media that's actually used by a clip.
  const usedMediaIds = Array.from(new Set(edl.clips.map((c) => c.mediaId))).filter((id) => mediaById[id]);

  const inputs = []; // { mediaId, args: [...] }
  const inputIndexByMediaId = {};
  usedMediaIds.forEach((mediaId) => {
    const media = mediaById[mediaId];
    const idx = inputs.length;
    inputIndexByMediaId[mediaId] = idx;
    if (media.type === 'image') {
      inputs.push({ mediaId, args: ['-loop', '1', '-framerate', String(fps), '-i', media.path] });
    } else {
      inputs.push({ mediaId, args: ['-i', media.path] });
    }
  });

  // Probe audio presence for non-image media in parallel.
  const audioProbeTargets = usedMediaIds.filter((id) => mediaById[id].type !== 'image');
  const audioProbeResults = await Promise.all(audioProbeTargets.map((id) => probeHasAudio(mediaById[id].path)));
  const mediaHasAudio = {};
  audioProbeTargets.forEach((id, i) => { mediaHasAudio[id] = audioProbeResults[i]; });

  const filterLines = [];
  let fillerCounter = 0;

  function pushFiller(dur) {
    const d = Math.max(1 / fps, dur);
    const label = `fill${fillerCounter++}`;
    filterLines.push(`color=c=${BG_COLOR}:s=${w}x${h}:r=${fps}:d=${d.toFixed(3)}[${label}]`);
    return label;
  }

  function pushClipSegment(clip, idx) {
    const media = mediaById[clip.mediaId];
    const inIdx = inputIndexByMediaId[clip.mediaId];
    const dur = Math.max(1 / fps, Math.min(clip.duration, media.duration ? Math.max(0.001, media.duration - clip.inPoint) : clip.duration));
    const label = `seg_${clip.id}_${idx}`;
    let chain;
    if (media.type === 'image') {
      chain = `[${inIdx}:v]trim=duration=${dur.toFixed(3)},setpts=PTS-STARTPTS`;
    } else {
      const inPoint = Math.max(0, clip.inPoint || 0);
      chain = `[${inIdx}:v]trim=start=${inPoint.toFixed(3)}:end=${(inPoint + dur).toFixed(3)},setpts=PTS-STARTPTS`;
    }
    chain += `,scale=w=${w}:h=${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=${BG_COLOR},setsar=1,fps=${fps}`;

    // Color filters. Canvas's live preview uses the CSS filter() functions
    // (brightness/contrast/saturate as multiplicative percentages) since
    // that's fast and native; ffmpeg's `eq` filter uses a different
    // underlying formula. Both are neutral at the same point (100% / no
    // adjustment) so an unedited clip always matches exactly; a clip with
    // filters applied will look close, but not pixel-identical, between
    // preview and the final export.
    const filt = clip.filters;
    if (filt && (filt.brightness !== 100 || filt.contrast !== 100 || filt.saturation !== 100)) {
      const b = ((filt.brightness != null ? filt.brightness : 100) - 100) / 100;
      const c = (filt.contrast != null ? filt.contrast : 100) / 100;
      const s = (filt.saturation != null ? filt.saturation : 100) / 100;
      chain += `,eq=brightness=${b.toFixed(3)}:contrast=${c.toFixed(3)}:saturation=${s.toFixed(3)}`;
    }

    // Grayscale - an independent "how much toward gray" blend layered on
    // top of the saturation slider above (100% grayscale always ends up
    // fully desaturated regardless of the saturation slider, same as the
    // canvas preview's `grayscale()` CSS filter stacked after `saturate()`).
    if (filt && filt.grayscale > 0) {
      const g = 1 - Math.min(100, filt.grayscale) / 100;
      chain += `,hue=s=${g.toFixed(3)}`;
    }

    // Sepia - linear blend between the identity matrix and the standard
    // sepia matrix by `amount`, via colorchannelmixer. Matches the canvas
    // preview's `sepia()` CSS filter, which is defined the same way.
    if (filt && filt.sepia > 0) {
      const a = Math.min(100, filt.sepia) / 100;
      const rr = (1 - 0.607 * a).toFixed(3), rg = (0.769 * a).toFixed(3), rb = (0.189 * a).toFixed(3);
      const gr = (0.349 * a).toFixed(3), gg = (1 - 0.314 * a).toFixed(3), gb = (0.168 * a).toFixed(3);
      const br = (0.272 * a).toFixed(3), bg = (0.534 * a).toFixed(3), bb = (1 - 0.869 * a).toFixed(3);
      chain += `,colorchannelmixer=rr=${rr}:rg=${rg}:rb=${rb}:gr=${gr}:gg=${gg}:gb=${gb}:br=${br}:bg=${bg}:bb=${bb}`;
    }

    // Blur - slider value is used directly as the gblur sigma (0-20),
    // close enough to the canvas preview's `blur(Npx)` for a live edit.
    if (filt && filt.blur > 0) {
      chain += `,gblur=sigma=${Math.min(20, filt.blur).toFixed(2)}`;
    }

    // Vignette - darkens the corners; intensity maps to xfade... no, to the
    // vignette filter's angle (smaller angle = stronger falloff).
    if (filt && filt.vignette > 0) {
      const v = Math.min(100, filt.vignette) / 100;
      const angle = (Math.PI / 2) - v * (Math.PI / 2 - Math.PI / 8);
      chain += `,vignette=angle=${angle.toFixed(4)}`;
    }

    // Fade in/out - fades to the canvas background color, same as the
    // preview, not a cross-blend with another track (that's the standard
    // meaning of "fade in/out" as distinct from a true crossfade - true
    // crossfades between adjacent clips are `transitionIn`, handled below).
    let fadeIn = Math.max(0, clip.fadeIn || 0);
    let fadeOut = Math.max(0, clip.fadeOut || 0);
    if (fadeIn + fadeOut > dur) { const scale = dur / (fadeIn + fadeOut); fadeIn *= scale; fadeOut *= scale; }
    if (fadeIn > 0) chain += `,fade=t=in:st=0:d=${fadeIn.toFixed(3)}:color=${BG_COLOR}`;
    if (fadeOut > 0) chain += `,fade=t=out:st=${Math.max(0, dur - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}:color=${BG_COLOR}`;

    filterLines.push(`${chain}[${label}]`);
    return { label, duration: dur };
  }

  // Builds one track's full-length video stream. Clips normally just concat
  // back to back with fillers for gaps, same as before. But when a clip's
  // transitionIn is valid (see computeValidTransitions) it's folded into the
  // preceding segment with ffmpeg's `xfade` instead of a hard concat cut -
  // xfade blends the last `duration` seconds of the previous segment with
  // the first `duration` seconds of this one, producing a stream that's
  // `duration` seconds shorter than the two put end to end, matching exactly
  // the overlap the editor creates on the timeline when a transition is set.
  // Chained transitions (A->B->C, both with a transition) fold the same way:
  // each new clip blends against whatever combined stream came before it.
  function buildTrackFullVideo(track, transitions) {
    const clips = edl.clips
      .filter((c) => c.trackId === track.id)
      .sort((a, b) => a.start - b.start);

    const segs = []; // { label, duration }
    let cursor = 0;
    clips.forEach((clip, i) => {
      const activeTransition = transitions.byToClipId[clip.id];
      if (activeTransition && segs.length > 0) {
        const prevSeg = segs.pop();
        const thisSeg = pushClipSegment(clip, i);
        const d = Math.min(activeTransition.duration, prevSeg.duration, thisSeg.duration);
        const offset = Math.max(0, prevSeg.duration - d);
        const xfLabel = `xf_${clip.id}`;
        const xfType = activeTransition.type === 'none' ? 'fade' : activeTransition.type;
        filterLines.push(`[${prevSeg.label}][${thisSeg.label}]xfade=transition=${xfType}:duration=${d.toFixed(3)}:offset=${offset.toFixed(3)}[${xfLabel}]`);
        segs.push({ label: xfLabel, duration: prevSeg.duration + thisSeg.duration - d });
      } else {
        const gap = clip.start - cursor;
        if (gap > 1 / fps / 2) segs.push({ label: pushFiller(gap), duration: gap });
        segs.push(pushClipSegment(clip, i));
      }
      cursor = clip.start + clip.duration;
    });
    const tailGap = duration - cursor;
    if (tailGap > 1 / fps / 2) segs.push({ label: pushFiller(tailGap), duration: tailGap });
    if (segs.length === 0) segs.push({ label: pushFiller(duration), duration });

    const fullLabel = `trk_${track.id}_full`;
    if (segs.length === 1) {
      filterLines.push(`[${segs[0].label}]null[${fullLabel}]`);
    } else {
      const refs = segs.map((s) => `[${s.label}]`).join('');
      filterLines.push(`${refs}concat=n=${segs.length}:v=1:a=0[${fullLabel}]`);
    }
    return fullLabel;
  }

  const transitions = computeValidTransitions(edl);

  // ---- video: composite tracks, index 0 = topmost ----
  const videoTracks = edl.tracks.filter((t) => t.type === 'video');
  let videoOutLabel;
  if (videoTracks.length === 0) {
    videoOutLabel = pushFiller(duration);
  } else {
    let baseLabel = null;
    for (let i = videoTracks.length - 1; i >= 0; i--) {
      const track = videoTracks[i];
      const fullLabel = buildTrackFullVideo(track, transitions);
      if (baseLabel === null) {
        baseLabel = fullLabel;
      } else {
        const clipsForTrack = edl.clips.filter((c) => c.trackId === track.id);
        const windows = clipsForTrack.map((c) => `between(t\\,${c.start.toFixed(3)}\\,${(c.start + c.duration).toFixed(3)})`).join('+');
        const overLabel = `ov_${track.id}`;
        const enablePart = windows ? `:enable='${windows}'` : ':enable=0';
        filterLines.push(`[${baseLabel}][${fullLabel}]overlay=x=0:y=0:eof_action=pass${enablePart}[${overLabel}]`);
        baseLabel = overLabel;
      }
    }
    videoOutLabel = baseLabel;
  }

  // ---- audio: trim + volume + position each audible clip, then mix ----
  const audioLabels = [];
  edl.clips.forEach((clip) => {
    const track = trackById[clip.trackId];
    const media = mediaById[clip.mediaId];
    if (!media || media.type === 'image') return;
    if (clip.muted || (track && track.muted)) return;
    if (!mediaHasAudio[clip.mediaId]) return;
    const inIdx = inputIndexByMediaId[clip.mediaId];
    const inPoint = Math.max(0, clip.inPoint || 0);
    const dur = Math.max(0.001, clip.duration);
    const vol = clip.volume == null ? 1 : clip.volume;
    const delayMs = Math.max(0, Math.round(clip.start * 1000));
    const label = `a_${clip.id}`;
    let chain = `[${inIdx}:a]atrim=start=${inPoint.toFixed(3)}:end=${(inPoint + dur).toFixed(3)},asetpts=PTS-STARTPTS,`
      + `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=${vol}`;
    // A clip on either side of a video transition gets a matching audio
    // crossfade - amix already sums the overlapping region, these afades
    // just turn that overlap into an actual fade rather than a hard mix.
    const incoming = transitions.byToClipId[clip.id];
    const outgoing = transitions.byFromClipId[clip.id];
    if (incoming) chain += `,afade=t=in:st=0:d=${incoming.duration.toFixed(3)}`;
    if (outgoing) chain += `,afade=t=out:st=${Math.max(0, dur - outgoing).toFixed(3)}:d=${outgoing.toFixed(3)}`;
    chain += `,adelay=delays=${delayMs}|${delayMs}[${label}]`;
    filterLines.push(chain);
    audioLabels.push(label);
  });

  let audioOutLabel = null;
  if (audioLabels.length > 0) {
    filterLines.push(`anullsrc=r=48000:cl=stereo:d=${duration.toFixed(3)}[silence]`);
    const allRefs = ['[silence]'].concat(audioLabels.map((l) => `[${l}]`)).join('');
    filterLines.push(`${allRefs}amix=inputs=${audioLabels.length + 1}:duration=longest:dropout_transition=0:normalize=0[aout]`);
    audioOutLabel = 'aout';
  }

  return {
    dims, fps, duration, inputs, filterComplex: filterLines.join(';'),
    videoOutLabel, audioOutLabel,
  };
}

function buildFfmpegArgs(plan, edl, outPath, opts) {
  const { duration, inputs, filterComplex, videoOutLabel, audioOutLabel } = plan;
  const bitrate = getBitrate(edl.resolution);
  const speed = getSpeedPreset(edl.speed);
  const hw = (opts && opts.hwEncoder) || null; // { encoder, device } | null
  const capped = !!(opts && opts.resourceCapped);
  const cpuThreads = getCpuThreadCount(capped);
  const args = [];

  // VAAPI's device has to be declared before anything in the command uses
  // it (the hwupload filter and the encoder both implicitly reference it).
  if (hw && hw.encoder === 'h264_vaapi' && hw.device) {
    args.push('-vaapi_device', hw.device);
  }

  // The composite filter graph (scale/pad/color filters/blur/vignette/
  // overlay/concat/xfade) always runs on the CPU, even when the video
  // itself is being hardware-encoded - it's frequently the actual
  // bottleneck on a multi-track or filter-heavy timeline. Pointing it at
  // the real logical CPU count (rather than leaving it to ffmpeg's default,
  // which measurement showed doesn't reliably track it) benefits every
  // export, regardless of format or which encoder ends up handling it.
  args.push('-filter_complex_threads', String(cpuThreads));

  inputs.forEach((inp) => args.push(...inp.args));

  // Every encoder here except VAAPI accepts the plain software frames the
  // filter graph already produces. VAAPI only encodes hardware surfaces, so
  // its filter graph gets one more step - upload the final composited frame
  // to the GPU - appended right before it's mapped to the encoder.
  let finalFilterComplex = filterComplex;
  let videoMapLabel = videoOutLabel;
  if (hw && hw.encoder === 'h264_vaapi') {
    videoMapLabel = `${videoOutLabel}_vaapi`;
    finalFilterComplex = `${filterComplex};[${videoOutLabel}]format=nv12,hwupload[${videoMapLabel}]`;
  }

  args.push('-filter_complex', finalFilterComplex);
  args.push('-map', `[${videoMapLabel}]`);
  if (audioOutLabel) args.push('-map', `[${audioOutLabel}]`);
  args.push('-t', duration.toFixed(3));

  if (edl.format === 'mp4') {
    if (hw && hw.encoder === 'h264_nvenc') {
      args.push(
        '-c:v', 'h264_nvenc', '-preset', speed.nvencPreset, '-rc', 'vbr', '-pix_fmt', 'yuv420p', '-profile:v', 'high',
        '-b:v', String(bitrate), '-maxrate', String(Math.round(bitrate * 1.5)), '-bufsize', String(bitrate * 2)
      );
      // -bf (max B-frames) is a standard option every one of these hardware
      // encoders honors, and B-frames are genuinely more GPU-compute-heavy
      // per frame (extra motion search/compensation directions) - dropping
      // them to 0 when capped is a real, safe reduction in GPU work.
      // ffmpeg doesn't expose an actual percentage-based GPU throttle for
      // any hardware encoder, so this is a partial mitigation, not a hard
      // ceiling at the cap fraction.
      if (capped) args.push('-bf', '0');
    } else if (hw && hw.encoder === 'h264_videotoolbox') {
      args.push(
        '-c:v', 'h264_videotoolbox', '-pix_fmt', 'yuv420p', '-profile:v', 'high',
        '-b:v', String(bitrate), '-maxrate', String(Math.round(bitrate * 1.5)), '-bufsize', String(bitrate * 2)
      );
      if (capped) args.push('-bf', '0');
    } else if (hw && hw.encoder === 'h264_amf') {
      // AMD AMF, like NVENC and VideoToolbox above, accepts plain software
      // frames directly - ffmpeg's AMF wrapper does the DirectX upload
      // internally, no filter-graph changes needed.
      args.push(
        '-c:v', 'h264_amf', '-quality', speed.amfQuality, '-rc', 'vbr_peak', '-pix_fmt', 'yuv420p', '-profile:v', 'high',
        '-b:v', String(bitrate), '-maxrate', String(Math.round(bitrate * 1.5)), '-bufsize', String(bitrate * 2)
      );
      if (capped) args.push('-bf', '0');
    } else if (hw && hw.encoder === 'h264_vaapi') {
      // No -pix_fmt/-profile here: the frame is already a hardware surface
      // by this point (see the hwupload step above), and VAAPI's profile
      // values aren't the same x264-style names, so default profile
      // selection is left to the driver rather than risk an unsupported
      // value on some driver stacks.
      args.push(
        '-c:v', 'h264_vaapi', '-quality', String(speed.vaapiQuality),
        '-b:v', String(bitrate), '-maxrate', String(Math.round(bitrate * 1.5)), '-bufsize', String(bitrate * 2)
      );
      if (capped) args.push('-bf', '0');
    } else {
      // Software x264 fallback. Measurement (not guesswork) showed ffmpeg's
      // own "auto" thread detection (i.e. simply not passing -threads)
      // doesn't reliably scale with the real logical CPU count - on a
      // constrained box it over-subscribes and is measurably *slower* than
      // just telling it the real count, and there's no guarantee it climbs
      // to use everything on a beefy one either. Setting it explicitly is
      // what actually makes better specs translate into a faster export.
      args.push(
        '-c:v', 'libx264', '-preset', speed.x264Preset, '-threads', String(cpuThreads), '-pix_fmt', 'yuv420p', '-profile:v', 'high',
        '-b:v', String(bitrate), '-maxrate', String(Math.round(bitrate * 1.5)), '-bufsize', String(bitrate * 2)
      );
      // rc-lookahead is x264's own frame-analysis buffer - it's the single
      // biggest memory knob available on the encoder side, and its default
      // (driven by preset) can run well past 40 frames on "quality". Only
      // constrained when the cap is on; otherwise leave preset defaults alone.
      if (capped) args.push('-rc-lookahead', '20');
    }
    args.push('-movflags', '+faststart'); // container-level flag, applies regardless of which encoder produced the stream
    if (audioOutLabel) args.push('-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2');
    else args.push('-an');
  } else {
    const tileColumns = getVp9TileColumns(plan.dims.w);
    const vp9Threads = getVp9ThreadCount(tileColumns, capped);
    args.push(
      '-c:v', 'libvpx-vp9', '-b:v', String(bitrate), '-pix_fmt', 'yuv420p',
      '-deadline', speed.vp9Deadline, '-cpu-used', String(speed.vp9CpuUsed), '-row-mt', '1',
      '-tile-columns', String(tileColumns), '-threads', String(vp9Threads)
    );
    // lag-in-frames is VP9's equivalent lookahead buffer - same idea as
    // x264's rc-lookahead above.
    if (capped) args.push('-lag-in-frames', '10');
    if (audioOutLabel) args.push('-c:a', 'libopus', '-b:a', '128k', '-ar', '48000', '-ac', '2');
    else args.push('-an');
  }

  args.push('-progress', 'pipe:1', '-nostats', '-loglevel', 'error', '-y', outPath);
  return args;
}

// ---------- run ----------
// Returns { promise, cancel }. onProgress receives { percent, phase }.
function runExport(edl, outPath, onProgress) {
  let cancelled = false;
  let child = null;

  const promise = (async () => {
    onProgress({ percent: 0, phase: 'Analyzing media\u2026' });
    const plan = await buildFfmpegPlan(edl);
    if (cancelled) throw new Error('__cancelled__');

    let hwEncoder = null;
    if (edl.format === 'mp4') {
      onProgress({ percent: 0, phase: 'Checking for hardware encoding\u2026' });
      hwEncoder = await detectHardwareEncoder();
    }
    if (cancelled) throw new Error('__cancelled__');

    // Off unless explicitly requested - matches the "not on by default"
    // product default (see resourceCapEnabled in settingsStore.js).
    const args = buildFfmpegArgs(plan, edl, outPath, { hwEncoder, resourceCapped: edl.resourceCapped === true });
    const ffmpegPath = getFfmpegPath();

    const hwLabel = friendlyHwEncoderLabel(hwEncoder);
    onProgress({ percent: 0, phase: hwLabel ? `Encoding (${hwLabel})\u2026` : 'Encoding\u2026' });

    return await new Promise((resolve, reject) => {
      child = spawn(ffmpegPath, args, { windowsHide: true });
      let stderrTail = '';
      let stdoutBuf = '';

      child.stdout.on('data', (buf) => {
        stdoutBuf += buf.toString('utf8');
        let idx;
        while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
          const line = stdoutBuf.slice(0, idx).trim();
          stdoutBuf = stdoutBuf.slice(idx + 1);
          const m = /^out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
          if (m) {
            const secs = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
            const percent = Math.max(0, Math.min(99, (secs / plan.duration) * 100));
            onProgress({ percent, phase: 'Encoding\u2026' });
          }
          if (line === 'progress=end') {
            onProgress({ percent: 100, phase: 'Done' });
          }
        }
      });

      child.stderr.on('data', (buf) => {
        stderrTail = (stderrTail + buf.toString('utf8')).slice(-4000);
      });

      child.on('error', (err) => reject(err));

      child.on('close', (code) => {
        child = null;
        if (cancelled) { reject(new Error('__cancelled__')); return; }
        if (code === 0) resolve({ outPath });
        else reject(new Error('ffmpeg exited with code ' + code + (stderrTail ? ':\n' + stderrTail : '')));
      });
    });
  })();

  return {
    promise,
    cancel() {
      cancelled = true;
      if (child) { try { child.kill('SIGKILL'); } catch (e) { /* already gone */ } }
    },
  };
}

module.exports = {
  validateEdl,
  getExportDims,
  getBitrate,
  getSpeedPreset,
  getCpuThreadCount,
  RESOURCE_CAP_FRACTION,
  getVp9TileColumns,
  getVp9ThreadCount,
  detectHardwareEncoder,
  hardwareCandidatesForPlatform,
  friendlyHwEncoderLabel,
  getFfmpegPath,
  getFfprobePath,
  buildFfmpegPlan,
  buildFfmpegArgs,
  runExport,
  probeMediaInfo,
};
