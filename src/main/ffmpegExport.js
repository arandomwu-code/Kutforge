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
const { spawn, execFile } = require('child_process');

const BG_COLOR = '0x2e2b25'; // matches the app's canvas background / letterbox color

const RESOLUTIONS = {
  '480p': [854, 480],
  '720p': [1280, 720],
  '1080p': [1920, 1080],
  '1440p': [2560, 1440],
  '4K': [3840, 2160],
};

const BITRATES = {
  '480p': 2_500_000,
  '720p': 5_000_000,
  '1080p': 8_000_000,
  '1440p': 16_000_000,
  '4K': 35_000_000,
};

const MAX_DURATION_SEC = 25200; // 7 hours, matches the editor's own export limit
const MAX_CLIPS = 5000; // sane upper bound so a pathological EDL can't blow up the filter graph

// Encode-speed tradeoff. Bitrate is fixed per resolution (see BITRATES)
// regardless of speed choice, so this doesn't change output file size -
// it trades encoding time against how much visual quality ffmpeg can
// squeeze out of that same bitrate. "balanced" matches the app's original,
// only-ever-tested behavior, so it stays the default.
const SPEED_PRESETS = {
  fast: { x264Preset: 'ultrafast', vp9CpuUsed: 8, vp9Deadline: 'realtime', nvencPreset: 'p1' },
  balanced: { x264Preset: 'veryfast', vp9CpuUsed: 2, vp9Deadline: 'good', nvencPreset: 'p4' },
  quality: { x264Preset: 'slow', vp9CpuUsed: 0, vp9Deadline: 'good', nvencPreset: 'p6' },
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
    }
    if (c.fadeIn != null && (!Number.isFinite(c.fadeIn) || c.fadeIn < 0)) fail('invalid clip fadeIn: ' + c.fadeIn);
    if (c.fadeOut != null && (!Number.isFinite(c.fadeOut) || c.fadeOut < 0)) fail('invalid clip fadeOut: ' + c.fadeOut);
  });

  return true;
}

function getExportDims(resolution, aspect) {
  const [w, h] = RESOLUTIONS[resolution] || RESOLUTIONS['1080p'];
  return aspect === '9:16' ? { w: h, h: w } : { w, h };
}

function getBitrate(resolution) {
  return BITRATES[resolution] || BITRATES['1080p'];
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
  // REEL_FFMPEG_PATH lets advanced users (or tests) point at a system
  // ffmpeg instead of the bundled binary.
  if (process.env.REEL_FFMPEG_PATH) return process.env.REEL_FFMPEG_PATH;
  return resolveBinaryPath(require('ffmpeg-static'));
}

function getFfprobePath() {
  if (process.env.REEL_FFPROBE_PATH) return process.env.REEL_FFPROBE_PATH;
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

// ---------- hardware-accelerated encoding (mp4/H.264 only) ----------
// NVENC (NVIDIA) and VideoToolbox (macOS) are both well-established, widely
// available, and predictable with standard yuv420p input - so those are
// what's attempted. Quick Sync (Intel) is deliberately left out: it more
// often needs a specific pixel format/driver combination to behave
// correctly, and getting that wrong silently produces broken video rather
// than a clean failure, which isn't a good trade for an automatic feature.
// The result of the (real, cheap) capability test is cached for the life of
// the process so repeat exports in one session don't re-probe every time.
let _hwEncoderCache; // undefined = not checked yet; null = checked, none found; string = encoder name

function hardwareCandidatesForPlatform() {
  if (process.env.REEL_DISABLE_HW_ENCODE) return [];
  if (process.env.REEL_FORCE_HW_ENCODER) return [process.env.REEL_FORCE_HW_ENCODER];
  if (process.platform === 'darwin') return ['h264_videotoolbox'];
  return ['h264_nvenc'];
}

function testEncoder(ffmpegPath, encoder) {
  return new Promise((resolve) => {
    const args = [
      '-y', '-f', 'lavfi', '-i', 'color=black:s=64x64:d=0.2',
      '-frames:v', '3', '-c:v', encoder, '-f', 'null', '-',
      '-loglevel', 'error',
    ];
    let done = false;
    const finish = (ok) => {
      if (done) return; done = true;
      try { child.kill('SIGKILL'); } catch (e) { /* already gone */ }
      resolve(ok);
    };
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0));
    setTimeout(() => finish(false), 4000);
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

    // Fade in/out - fades to the canvas background color, same as the
    // preview, not a cross-blend with another track (that's the standard
    // meaning of "fade in/out" as distinct from a true crossfade).
    let fadeIn = Math.max(0, clip.fadeIn || 0);
    let fadeOut = Math.max(0, clip.fadeOut || 0);
    if (fadeIn + fadeOut > dur) { const scale = dur / (fadeIn + fadeOut); fadeIn *= scale; fadeOut *= scale; }
    if (fadeIn > 0) chain += `,fade=t=in:st=0:d=${fadeIn.toFixed(3)}:color=${BG_COLOR}`;
    if (fadeOut > 0) chain += `,fade=t=out:st=${Math.max(0, dur - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}:color=${BG_COLOR}`;

    filterLines.push(`${chain}[${label}]`);
    return label;
  }

  function buildTrackFullVideo(track) {
    const clips = edl.clips
      .filter((c) => c.trackId === track.id)
      .sort((a, b) => a.start - b.start);

    const segLabels = [];
    let cursor = 0;
    clips.forEach((clip, i) => {
      const gap = clip.start - cursor;
      if (gap > 1 / fps / 2) segLabels.push(pushFiller(gap));
      segLabels.push(pushClipSegment(clip, i));
      cursor = clip.start + clip.duration;
    });
    const tailGap = duration - cursor;
    if (tailGap > 1 / fps / 2) segLabels.push(pushFiller(tailGap));
    if (segLabels.length === 0) segLabels.push(pushFiller(duration));

    const fullLabel = `trk_${track.id}_full`;
    if (segLabels.length === 1) {
      filterLines.push(`[${segLabels[0]}]null[${fullLabel}]`);
    } else {
      const refs = segLabels.map((l) => `[${l}]`).join('');
      filterLines.push(`${refs}concat=n=${segLabels.length}:v=1:a=0[${fullLabel}]`);
    }
    return fullLabel;
  }

  // ---- video: composite tracks, index 0 = topmost ----
  const videoTracks = edl.tracks.filter((t) => t.type === 'video');
  let videoOutLabel;
  if (videoTracks.length === 0) {
    videoOutLabel = pushFiller(duration);
  } else {
    let baseLabel = null;
    for (let i = videoTracks.length - 1; i >= 0; i--) {
      const track = videoTracks[i];
      const fullLabel = buildTrackFullVideo(track);
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
    filterLines.push(
      `[${inIdx}:a]atrim=start=${inPoint.toFixed(3)}:end=${(inPoint + dur).toFixed(3)},asetpts=PTS-STARTPTS,`
      + `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,volume=${vol},`
      + `adelay=delays=${delayMs}|${delayMs}[${label}]`
    );
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
  const hwEncoder = (opts && opts.hwEncoder) || null;
  const args = [];
  inputs.forEach((inp) => args.push(...inp.args));
  args.push('-filter_complex', filterComplex);
  args.push('-map', `[${videoOutLabel}]`);
  if (audioOutLabel) args.push('-map', `[${audioOutLabel}]`);
  args.push('-t', duration.toFixed(3));

  if (edl.format === 'mp4') {
    if (hwEncoder === 'h264_nvenc') {
      args.push(
        '-c:v', 'h264_nvenc', '-preset', speed.nvencPreset, '-rc', 'vbr', '-pix_fmt', 'yuv420p', '-profile:v', 'high',
        '-b:v', String(bitrate), '-maxrate', String(Math.round(bitrate * 1.5)), '-bufsize', String(bitrate * 2)
      );
    } else if (hwEncoder === 'h264_videotoolbox') {
      args.push(
        '-c:v', 'h264_videotoolbox', '-pix_fmt', 'yuv420p', '-profile:v', 'high',
        '-b:v', String(bitrate), '-maxrate', String(Math.round(bitrate * 1.5)), '-bufsize', String(bitrate * 2)
      );
    } else {
      args.push(
        '-c:v', 'libx264', '-preset', speed.x264Preset, '-pix_fmt', 'yuv420p', '-profile:v', 'high',
        '-b:v', String(bitrate), '-maxrate', String(Math.round(bitrate * 1.5)), '-bufsize', String(bitrate * 2)
      );
    }
    args.push('-movflags', '+faststart'); // container-level flag, applies regardless of which encoder produced the stream
    if (audioOutLabel) args.push('-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2');
    else args.push('-an');
  } else {
    args.push(
      '-c:v', 'libvpx-vp9', '-b:v', String(bitrate), '-pix_fmt', 'yuv420p',
      '-deadline', speed.vp9Deadline, '-cpu-used', String(speed.vp9CpuUsed), '-row-mt', '1'
    );
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

    const args = buildFfmpegArgs(plan, edl, outPath, { hwEncoder });
    const ffmpegPath = getFfmpegPath();

    onProgress({ percent: 0, phase: hwEncoder ? `Encoding (${hwEncoder})\u2026` : 'Encoding\u2026' });

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
  detectHardwareEncoder,
  getFfmpegPath,
  getFfprobePath,
  buildFfmpegPlan,
  buildFfmpegArgs,
  runExport,
};
