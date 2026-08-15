const html = htm.bind(preact.h);

class VideoEditor extends preact.Component {
  state = {
    // Gate shown on every launch, before anything else in the app runs -
    // see componentDidMount/agreeToDisclaimer. Not persisted anywhere on
    // purpose: it's meant to appear every time, not just on first run.
    disclaimerAgreed: false,
    disclaimerChecked: false,
    projectName: 'My Video',
    aspect: (this.props && this.props.defaultAspect) || '16:9',
    media: [],
    tracks: [
      { id: 'v2', type: 'video', name: 'Video 2', muted: false },
      { id: 'v1', type: 'video', name: 'Video 1', muted: false },
      { id: 'a1', type: 'audio', name: 'Audio 1', muted: false },
    ],
    clips: [],
    selectedClipId: null,
    playhead: 0,
    isPlaying: false,
    zoom: 50,
    showExport: false,
    showHelp: false,
    exportRunning: false,
    exportDone: false,
    exportError: null,
    exportSavedNote: '',
    exportProgress: 0,
    exportResolution: '1080p',
    exportFormat: 'mp4',
    exportSpeed: 'balanced',
    // Empty until the export dialog is first opened, at which point it's
    // seeded from the project name - but once the person types their own
    // value, it's never silently overwritten again (see openExport).
    exportFileName: '',
    exportFps: parseInt((this.props && this.props.defaultExportFps) || '30', 10),
    exportPhase: '',
    canUndo: false,
    canRedo: false,
    toast: null,
    contextMenu: null,
    theme: 'cream',
    defaultTheme: 'cream',
    trackColorTint: true,
    resourceCapEnabled: false,
    appVersion: '',
    showThemeMenu: false,
    showAdjustMenu: false,
  };

  currentTime = 0;
  mediaElsByClip = {};
  imageEls = {};
  trackLaneEls = {};
  undoStack = [];
  redoStack = [];
  dragCtx = null;
  scrubbing = false;
  _idCounter = 0;
  _uiSyncCounter = 0;
  _saveTimer = null;
  _toastTimer = null;
  timelineContentEl = null;
  previewCanvasEl = null;
  currentProjectPath = null;

  uid = () => 'id' + (++this._idCounter) + Math.random().toString(36).slice(2, 7);

  fmtTime = (seconds) => {
    if (!isFinite(seconds) || seconds < 0) seconds = 0;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    return m + ':' + String(s).padStart(2, '0');
  };

  fmtBytes = (bytes) => {
    if (bytes > 1e9) return (bytes / 1e9).toFixed(1) + ' GB';
    if (bytes > 1e6) return (bytes / 1e6).toFixed(0) + ' MB';
    return Math.max(1, Math.round(bytes / 1e3)) + ' KB';
  };

  totalDuration = () => {
    let max = 0;
    this.state.clips.forEach(c => { max = Math.max(max, c.start + c.duration); });
    return max;
  };

  // ---------- lifecycle ----------
  componentDidMount() {
    // Project/settings loading (and everything else that makes this a
    // working editor rather than an empty shell) only starts once the
    // disclaimer/license gate has been agreed to - see agreeToDisclaimer().
    window.addEventListener('mousemove', this.handleWindowMouseMove);
    window.addEventListener('mouseup', this.handleWindowMouseUp);
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('click', this.handleGlobalClick);
    window.kutforgeAPI.onMenuAction(this.handleMenuAction);
    window.kutforgeAPI.onExportProgress(this.handleExportProgress);
    window.kutforgeAPI.getAppVersion().then(v => this.setState({ appVersion: v })).catch(() => {});
  }

  // ---------- disclaimer / license gate ----------
  toggleDisclaimerChecked = () => this.setState(s => ({ disclaimerChecked: !s.disclaimerChecked }));

  agreeToDisclaimer = () => {
    if (!this.state.disclaimerChecked) return;
    this.setState({ disclaimerAgreed: true });
    this.initAsync();
    this.drawOnce();
  };

  declineDisclaimer = () => {
    if (window.kutforgeAPI.quitApp) window.kutforgeAPI.quitApp();
  };

  handleMenuAction = (action) => {
    if (!this.state.disclaimerAgreed) return; // gate not yet agreed to - ignore native menu actions too
    if (action === 'undo') this.undo();
    else if (action === 'redo') this.redo();
    else if (action === 'import-media') this.triggerFileInput();
    else if (action === 'export') this.openExport();
    else if (action === 'new-project') this.newProject();
    else if (action === 'open-project') this.openProjectFromDisk();
    else if (action === 'save-project-as') this.saveProjectAs();
    else if (action === 'help') this.setState(s => ({ showHelp: !s.showHelp }));
  };

  componentWillUnmount() {
    window.removeEventListener('mousemove', this.handleWindowMouseMove);
    window.removeEventListener('mouseup', this.handleWindowMouseUp);
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('click', this.handleGlobalClick);
    if (this.timelineScrollEl && this._wheelHandler) this.timelineScrollEl.removeEventListener('wheel', this._wheelHandler);
    if (this.tracksAreaEl && this._tracksAreaScrollHandler) this.tracksAreaEl.removeEventListener('scroll', this._tracksAreaScrollHandler);
    cancelAnimationFrame(this.rafId);
    if (this._fadeRafId != null) cancelAnimationFrame(this._fadeRafId);
  }

  handleGlobalClick = () => { if (this.state.contextMenu || this.state.showThemeMenu) this.setState({ contextMenu: null, showThemeMenu: false }); };

  componentDidUpdate(prevProps, prevState) {
    const changed = prevState.clips !== this.state.clips || prevState.tracks !== this.state.tracks ||
      prevState.media !== this.state.media || prevState.aspect !== this.state.aspect;
    if (changed || prevState.projectName !== this.state.projectName) this.saveProjectDebounced();
    if (changed && !this._loopActive) this.drawOnce();
  }

  initAsync = async () => {
    await this.loadSettings();
    await this.loadProject();
  };

  // ---------- app-wide settings ----------
  loadSettings = async () => {
    try {
      const settings = await window.kutforgeAPI.loadSettings();
      this.setState({
        defaultTheme: (settings && settings.defaultTheme) || 'cream',
        trackColorTint: settings && typeof settings.trackColorTint === 'boolean' ? settings.trackColorTint : true,
        resourceCapEnabled: settings && typeof settings.resourceCapEnabled === 'boolean' ? settings.resourceCapEnabled : false,
      });
    } catch (e) { /* keep the built-in defaults */ }
  };

  setDefaultTheme = (key) => {
    this.setState({ defaultTheme: key });
    window.kutforgeAPI.saveSettings({ defaultTheme: key }).catch(() => {});
    this.showToast('"' + (this.themes[key] ? this.themes[key].label : key) + '" set as default theme');
  };

  toggleTrackColorTint = (e) => {
    e.stopPropagation();
    const value = !this.state.trackColorTint;
    this.setState({ trackColorTint: value });
    window.kutforgeAPI.saveSettings({ trackColorTint: value }).catch(() => {});
  };

  // Whatever the person leaves this set to before starting an export becomes
  // the new default for next time too - same "sticky toggle" pattern as
  // trackColorTint above.
  toggleResourceCap = () => {
    const value = !this.state.resourceCapEnabled;
    this.setState({ resourceCapEnabled: value });
    window.kutforgeAPI.saveSettings({ resourceCapEnabled: value }).catch(() => {});
  };

  // ---------- persistence ----------
  // Media is referenced by its real path on disk (no browser sandbox to
  // work around), so a project is just a small JSON document - no blob
  // store needed. componentDidUpdate() below autosaves it to a file in the
  // app's userData folder on every change, and it's reloaded on startup.
  // "Open Project..." / "Save Project As..." (File menu) work the same way
  // but let the person pick where the .kutforgeproj.json file lives.
  hydrateMediaFromSaved = (savedMedia) => {
    // savedMedia is expected to be an array of { id, path, ... } - but a
    // project file is just JSON on disk, so nothing guarantees that: it
    // could be hand-edited, come from a future/older version of the app, or
    // (via File > Open Project, which accepts any .json) not be a Kutforge
    // project at all. Silently drop anything that isn't array-shaped or
    // that's missing the fields the rest of the app assumes exist, rather
    // than letting a malformed file throw here - a throw this early runs
    // before any state is touched, so it would otherwise make "Open
    // Project..." fail with no explanation and no recovery.
    const list = Array.isArray(savedMedia) ? savedMedia : [];
    const media = list
      .filter(m => m && typeof m === 'object' && typeof m.id === 'string' && typeof m.path === 'string')
      .map(m => ({ ...m, url: window.kutforgeAPI.pathToFileUrl(m.path) }));
    // This wholesale-replaces the project's media list (this is only ever
    // called from applyLoadedProject - opening a project or reloading the
    // autosave), so the previous project's decoded Image objects are about
    // to become unreachable from state.media. But imageEls is a plain
    // instance dict, not React state, so nothing else clears it - without
    // resetting it here, every image from every project ever opened in this
    // running app session stays referenced (and un-garbage-collectable)
    // forever, growing the longer the app is used. Resetting it here, right
    // before repopulating with the new project's own images, is what
    // actually lets the old ones go.
    this.imageEls = {};
    media.forEach(m => {
      if (m.type === 'image') {
        const img = new Image();
        img.src = m.url;
        this.imageEls[m.id] = img;
      }
    });
    return media;
  };

  // Defensive validation for anything that ends up here from disk (an
  // autosave that predates a field, a hand-edited or corrupted project
  // file, or a completely unrelated .json someone picked in the Open
  // Project dialog). Every field is individually checked and coerced to a
  // safe default rather than trusting the saved shape - the goal is that a
  // bad project file can only ever fail to load cleanly, never throw
  // partway through and leave the editor in a broken, half-applied state.
  sanitizeLoadedProject = (saved) => {
    if (!saved || typeof saved !== 'object') throw new Error('not a project file');
    const media = this.hydrateMediaFromSaved(saved.media);
    const validMediaIds = new Set(media.map(m => m.id));
    const tracksIn = Array.isArray(saved.tracks) ? saved.tracks : null;
    const tracks = (tracksIn || [])
      .filter(t => t && typeof t === 'object' && typeof t.id === 'string' && (t.type === 'video' || t.type === 'audio'))
      .map(t => ({ id: t.id, type: t.type, name: typeof t.name === 'string' ? t.name : (t.type === 'video' ? 'Video' : 'Audio'), muted: !!t.muted }));
    const validTrackIds = new Set(tracks.map(t => t.id));
    const clipsIn = Array.isArray(saved.clips) ? saved.clips : [];
    const clips = clipsIn.filter(c => c && typeof c === 'object' && typeof c.id === 'string'
      && validMediaIds.has(c.mediaId) && validTrackIds.has(c.trackId)
      && Number.isFinite(c.start) && Number.isFinite(c.duration));
    return {
      projectName: typeof saved.projectName === 'string' && saved.projectName.trim() ? saved.projectName : 'My Video',
      theme: typeof saved.theme === 'string' ? saved.theme : this.state.defaultTheme,
      aspect: saved.aspect === '9:16' ? '9:16' : '16:9',
      // Falls back to the built-in starter tracks (rather than an empty
      // array) if the file had none valid - every project needs at least
      // one video and one audio track for clips to live on.
      tracks: tracks.length ? tracks : [
        { id: 'v2', type: 'video', name: 'Video 2', muted: false },
        { id: 'v1', type: 'video', name: 'Video 1', muted: false },
        { id: 'a1', type: 'audio', name: 'Audio 1', muted: false },
      ],
      media, clips,
    };
  };

  applyLoadedProject = (saved) => {
    if (!saved) return;
    const clean = this.sanitizeLoadedProject(saved);
    this.undoStack = []; this.redoStack = [];
    this.setState({
      projectName: clean.projectName, theme: clean.theme, aspect: clean.aspect,
      tracks: clean.tracks, media: clean.media, clips: clean.clips,
      selectedClipId: null, canUndo: false, canRedo: false,
    });
    this.seek(0);
  };

  loadProject = async () => {
    try {
      const saved = await window.kutforgeAPI.loadAutosavedProject();
      if (saved) this.applyLoadedProject(saved);
      else this.setState({ theme: this.state.defaultTheme }); // first launch, no project yet
    } catch (e) { /* ignore corrupt/missing save */ }
  };

  currentProjectSnapshot = () => {
    const { projectName, aspect, tracks, clips, media, theme } = this.state;
    const mediaMeta = media.map(({ url, ...rest }) => rest);
    return { projectName, aspect, tracks, clips, media: mediaMeta, theme };
  };

  saveProjectDebounced = () => {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      window.kutforgeAPI.saveAutosavedProject(this.currentProjectSnapshot()).catch(() => {});
    }, 600);
  };

  newProject = () => {
    if (!confirm('Start a new project? Unsaved changes to the current one will be lost.')) return;
    this.undoStack = []; this.redoStack = [];
    this.currentProjectPath = null;
    // Same leak this is fixing in hydrateMediaFromSaved: imageEls is a
    // plain instance dict, not React state, so clearing state.media below
    // doesn't release the Image objects it held on its own - without this,
    // every image from every project worked on in this session stays
    // referenced forever. mediaElsByClip is reset too, defensively - Preact
    // already cleans that one up itself as the old clips' <video>/<audio>
    // elements unmount, but there's no downside to being explicit here
    // rather than relying on that timing.
    this.imageEls = {};
    this.mediaElsByClip = {};
    this.setState({
      projectName: 'My Video', media: [], clips: [], selectedClipId: null,
      theme: this.state.defaultTheme,
      tracks: [
        { id: 'v2', type: 'video', name: 'Video 2', muted: false },
        { id: 'v1', type: 'video', name: 'Video 1', muted: false },
        { id: 'a1', type: 'audio', name: 'Audio 1', muted: false },
      ],
      canUndo: false, canRedo: false,
    });
    this.seek(0);
  };

  openProjectFromDisk = async () => {
    const res = await window.kutforgeAPI.openProjectDialog();
    if (!res) return;
    if (res.error) { this.showToast(res.error); return; }
    // res.data is only guaranteed to be valid JSON (see projectStore.js) -
    // not a valid Kutforge project. applyLoadedProject/sanitizeLoadedProject
    // validate the shape defensively, but this catch is the backstop: it's
    // what turns "picked the wrong .json file" into a clear toast instead
    // of the Open action silently doing nothing.
    try {
      this.applyLoadedProject(res.data);
      this.currentProjectPath = res.filePath;
    } catch (e) {
      this.showToast('That file doesn\u2019t look like a valid Kutforge project.');
    }
  };

  saveProjectAs = async () => {
    const savedPath = await window.kutforgeAPI.saveProjectAsDialog(this.currentProjectSnapshot());
    if (savedPath) { this.currentProjectPath = savedPath; this.showToast('Project saved'); }
  };

  // ---------- media import ----------
  handleNameChange = (e) => this.setState({ projectName: e.target.value });
  // If they clear the name entirely and click away, fall back to a sensible
  // default rather than leaving the project visibly nameless - matches the
  // same "never leaves a name field blank" behavior as the export dialog's
  // file-name field below.
  handleNameBlur = () => {
    if (!this.state.projectName.trim()) this.setState({ projectName: 'My Video' });
  };

  triggerFileInput = async () => {
    const paths = await window.kutforgeAPI.openMediaDialog();
    if (paths && paths.length) this.addFiles(paths);
  };
  handleSidebarDrop = (e) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files || []);
    const paths = files.map(f => window.kutforgeAPI.getPathForFile(f)).filter(Boolean);
    if (paths.length) this.addFiles(paths);
  };
  handleSidebarDragOver = (e) => e.preventDefault();

  addFiles = async (paths) => {
    for (const p of paths) {
      try {
        const item = await this.buildMediaItem(p);
        this.setState(s => ({ media: [...s.media, item] }));
      } catch (e) {
        this.showToast('Could not import ' + this.basename(p));
      }
    }
  };

  basename = (p) => (p || '').split(/[\\/]/).pop();

  classifyMediaType = (p) => {
    const ext = this.basename(p).split('.').pop().toLowerCase();
    if (['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi'].includes(ext)) return 'video';
    if (['mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg'].includes(ext)) return 'audio';
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) return 'image';
    return null;
  };

  // Media is referenced by its path on disk - the file is never copied.
  // Metadata (duration/dimensions) and the sidebar thumbnail are still
  // grabbed the same way as before, just from a file:// URL instead of a
  // blob: URL.
  buildMediaItem = (filePath) => new Promise((resolve, reject) => {
    const id = this.uid();
    const name = this.basename(filePath);
    const url = window.kutforgeAPI.pathToFileUrl(filePath);
    const type = this.classifyMediaType(filePath);
    if (type === 'video') {
      const v = document.createElement('video');
      v.preload = 'metadata'; v.muted = true; v.src = url;
      let done = false;
      const finish = (thumb, duration, width, height) => { if (done) return; done = true; resolve({ id, name, type: 'video', path: filePath, url, duration, width, height, thumb }); };
      v.onloadedmetadata = () => {
        const duration = v.duration || 5;
        const width = v.videoWidth || 1920;
        const height = v.videoHeight || 1080;
        let fallbackTimer = null;
        const grab = () => {
          // Both the onseeked handler and the setTimeout fallback below call
          // grab() - normally only one of them needs to actually do
          // anything (whichever wins the race), but this guard used to live
          // only inside finish(), *after* the expensive work. That meant
          // the common case (seek finishes well under 500ms, which is
          // virtually always true for local files) still paid for a full
          // canvas draw + JPEG encode (toDataURL, synchronous and
          // main-thread-blocking) a second time, 500ms later, purely to
          // have its result thrown away - doubling the real cost of
          // importing every single video for no benefit. Checking here,
          // before doing any of that work, is what actually skips it.
          if (done) return;
          if (fallbackTimer != null) { clearTimeout(fallbackTimer); fallbackTimer = null; }
          try {
            const cvs = document.createElement('canvas');
            const scale = Math.min(160 / width, 1);
            cvs.width = Math.max(1, Math.round(width * scale));
            cvs.height = Math.max(1, Math.round(height * scale));
            const cx = cvs.getContext('2d');
            cx.drawImage(v, 0, 0, cvs.width, cvs.height);
            finish(cvs.toDataURL('image/jpeg', 0.7), duration, width, height);
          } catch (e) { finish(null, duration, width, height); }
        };
        try { v.currentTime = Math.min(1, duration / 2); v.onseeked = grab; } catch (e) { grab(); }
        fallbackTimer = setTimeout(grab, 500);
      };
      v.onerror = () => reject(new Error('video load error'));
    } else if (type === 'audio') {
      const a = document.createElement('audio');
      a.preload = 'metadata'; a.src = url;
      a.onloadedmetadata = () => resolve({ id, name, type: 'audio', path: filePath, url, duration: a.duration || 5, width: 0, height: 0, thumb: null });
      a.onerror = () => reject(new Error('audio load error'));
    } else if (type === 'image') {
      const img = new Image();
      img.onload = () => { this.imageEls[id] = img; resolve({ id, name, type: 'image', path: filePath, url, duration: 5, width: img.naturalWidth, height: img.naturalHeight, thumb: url }); };
      img.onerror = () => reject(new Error('image load error'));
      img.src = url;
    } else {
      reject(new Error('unsupported type'));
    }
  });

  appendMediaAuto = (media) => {
    const wantsAudio = media.type === 'audio';
    const track = this.state.tracks.find(t => (t.type === 'audio') === wantsAudio);
    if (!track) { this.showToast('No ' + (wantsAudio ? 'audio' : 'video') + ' track available'); return; }
    this.appendMediaToTrack(media, track.id);
  };

  // Fields every clip carries beyond the basics (start/duration/inPoint/volume/muted):
  // color filters (neutral = no visible change), fade in/out durations (0 =
  // no fade), and an optional transitionIn (a crossfade/wipe/slide blended
  // with whichever clip immediately precedes this one on the same track).
  // Kept as a small helper so every place a clip gets created stays consistent.
  defaultClipExtras = () => ({
    filters: { brightness: 100, contrast: 100, saturation: 100, blur: 0, grayscale: 0, sepia: 0, vignette: 0 },
    fadeIn: 0, fadeOut: 0,
    transitionIn: { type: 'none', duration: 0, fromClipId: null },
  });

  transitionTypes = [
    { key: 'none', label: 'None' },
    { key: 'fade', label: 'Crossfade' },
    { key: 'wipeleft', label: 'Wipe left' },
    { key: 'wiperight', label: 'Wipe right' },
    { key: 'slideleft', label: 'Slide left' },
    { key: 'slideright', label: 'Slide right' },
    { key: 'circleopen', label: 'Circle' },
  ];
  MAX_TRANSITION_DURATION = 3;

  // Keeps fadeIn + fadeOut from exceeding a clip's (possibly just-shortened)
  // duration - scales both down proportionally rather than just clipping
  // one, so a symmetric fade in/out stays symmetric.
  clampClipFades = (clip) => {
    const dur = Math.max(0.01, clip.duration);
    let fadeIn = Math.max(0, clip.fadeIn || 0);
    let fadeOut = Math.max(0, clip.fadeOut || 0);
    if (fadeIn + fadeOut > dur) {
      const scale = dur / (fadeIn + fadeOut);
      fadeIn *= scale; fadeOut *= scale;
    }
    return { ...clip, fadeIn, fadeOut };
  };

  appendMediaToTrack = (media, trackId) => {
    this.pushHistory();
    const trackClips = this.state.clips.filter(c => c.trackId === trackId);
    let end = 0; trackClips.forEach(c => { end = Math.max(end, c.start + c.duration); });
    const clip = { id: this.uid(), trackId, mediaId: media.id, start: end, duration: media.duration || 5, inPoint: 0, volume: 1, muted: false, ...this.defaultClipExtras() };
    this.setState({ clips: [...this.state.clips, clip], selectedClipId: clip.id });
  };

  handleMediaDragStart = (e, media) => { e.dataTransfer.setData('text/plain', media.id); this.dragMediaId = media.id; };

  handleDropOnTrack = (e, track) => {
    e.preventDefault();
    const mediaId = this.dragMediaId;
    this.dragMediaId = null;
    if (!mediaId) return;
    const media = this.state.media.find(m => m.id === mediaId);
    if (!media) return;
    const wantsAudioTrack = track.type === 'audio';
    if ((media.type === 'audio') !== wantsAudioTrack) {
      this.showToast(wantsAudioTrack ? 'Only audio clips go on the audio track' : 'Drop audio clips on the audio track');
      return;
    }
    const laneEl = this.trackLaneEls[track.id];
    if (!laneEl) return;
    const rect = laneEl.getBoundingClientRect();
    let start = Math.max(0, (e.clientX - rect.left) / this.state.zoom);
    const dur = media.duration || 5;
    const existing = this.state.clips.filter(c => c.trackId === track.id).sort((a, b) => a.start - b.start);
    for (const c of existing) {
      if (start < c.start + c.duration && start + dur > c.start) start = c.start + c.duration;
    }
    this.pushHistory();
    const clip = { id: this.uid(), trackId: track.id, mediaId: media.id, start, duration: dur, inPoint: 0, volume: 1, muted: false, ...this.defaultClipExtras() };
    this.setState({ clips: [...this.state.clips, clip], selectedClipId: clip.id });
  };

  // ---------- history ----------
  pushHistory = () => {
    this.undoStack.push(JSON.stringify({ tracks: this.state.tracks, clips: this.state.clips }));
    if (this.undoStack.length > 60) this.undoStack.shift();
    this.redoStack = [];
    this.setState({ canUndo: true, canRedo: false });
  };

  undo = () => {
    if (!this.undoStack.length) return;
    const cur = JSON.stringify({ tracks: this.state.tracks, clips: this.state.clips });
    this.redoStack.push(cur);
    const prev = JSON.parse(this.undoStack.pop());
    this.setState({ tracks: prev.tracks, clips: prev.clips, selectedClipId: null, canUndo: this.undoStack.length > 0, canRedo: true });
  };

  redo = () => {
    if (!this.redoStack.length) return;
    const cur = JSON.stringify({ tracks: this.state.tracks, clips: this.state.clips });
    this.undoStack.push(cur);
    const next = JSON.parse(this.redoStack.pop());
    this.setState({ tracks: next.tracks, clips: next.clips, selectedClipId: null, canRedo: this.redoStack.length > 0, canUndo: true });
  };

  // ---------- clip editing ----------
  handleClipMouseDown = (e, clip, mode) => {
    e.stopPropagation();
    this.pushHistory();
    const siblings = this.state.clips.filter(c => c.trackId === clip.trackId && c.id !== clip.id);
    // A clip mid-transition intentionally overlaps its transition partner -
    // that partner shouldn't act as a drag/trim collision boundary (it'd
    // silently ignore it anyway, since its end falls past this clip's
    // start, but being explicit here means the drag range falls through to
    // whatever's beyond the partner instead of an unconstrained gap).
    const incoming = this.activeTransitionFor(clip);
    const outgoingPartnerClip = this.state.clips.find(c => {
      const act = this.activeTransitionFor(c);
      return act && act.prev.id === clip.id;
    });
    const excludeIds = new Set([incoming ? incoming.prev.id : null, outgoingPartnerClip ? outgoingPartnerClip.id : null].filter(Boolean));
    const collisionSiblings = siblings.filter(c => !excludeIds.has(c.id));
    let prevEnd = 0;
    collisionSiblings.forEach(c => { const end = c.start + c.duration; if (end <= clip.start + 0.001 && end > prevEnd) prevEnd = end; });
    let nextStart = null;
    collisionSiblings.forEach(c => { if (c.start >= clip.start + clip.duration - 0.001) { if (nextStart === null || c.start < nextStart) nextStart = c.start; } });
    const media = this.state.media.find(m => m.id === clip.mediaId);
    this.dragCtx = { clip: { ...clip }, mode, startX: e.clientX, prevEnd, nextStart, media };
    this.setState({ selectedClipId: clip.id });
  };

  updateDragFromEvent = (e) => {
    const { clip, mode, startX, prevEnd, nextStart, media } = this.dragCtx;
    const dt = (e.clientX - startX) / this.state.zoom;
    const idx = this.state.clips.findIndex(c => c.id === clip.id);
    if (idx < 0) return;
    let updated = { ...clip };
    if (mode === 'move') {
      const lower = Math.max(0, prevEnd);
      const upper = nextStart == null ? Infinity : nextStart - clip.duration;
      updated.start = Math.max(lower, Math.min(clip.start + dt, upper));
    } else if (mode === 'trim-left') {
      const lower = Math.max(prevEnd, 0, clip.start - clip.inPoint);
      const upper = clip.start + clip.duration - 0.1;
      const newStart = Math.min(Math.max(clip.start + dt, lower), upper);
      updated.start = newStart;
      updated.duration = clip.duration - (newStart - clip.start);
      updated.inPoint = clip.inPoint + (newStart - clip.start);
    } else if (mode === 'trim-right') {
      const maxDur = media && media.type !== 'image' ? (media.duration - clip.inPoint) : 1e9;
      const upper = Math.min(nextStart == null ? Infinity : nextStart, clip.start + (isFinite(maxDur) ? maxDur : 1e9));
      const newEnd = Math.max(clip.start + 0.2, Math.min(clip.start + clip.duration + dt, upper));
      updated.duration = newEnd - clip.start;
    }
    const clips = this.state.clips.slice();
    clips[idx] = this.clampClipFades(updated);
    this.setState({ clips });
  };

  handleWindowMouseMove = (e) => {
    if (this.dragCtx) this.updateDragFromEvent(e);
    if (this.scrubbing) this.updateScrubFromEvent(e);
  };
  handleWindowMouseUp = () => { this.dragCtx = null; this.scrubbing = false; };

  toggleClipMute = (clip) => {
    this.pushHistory();
    this.setState({ clips: this.state.clips.map(c => c.id === clip.id ? { ...c, muted: !c.muted } : c) });
  };

  handleVolumeChange = (e) => {
    if (!this.state.selectedClipId) return;
    const v = parseFloat(e.target.value) / 100;
    this.setState({ clips: this.state.clips.map(c => c.id === this.state.selectedClipId ? { ...c, volume: v } : c) });
  };

  toggleAdjustMenu = (e) => { e.stopPropagation(); this.setState(s => ({ showAdjustMenu: !s.showAdjustMenu })); };

  handleFilterChange = (key, value) => {
    if (!this.state.selectedClipId) return;
    const defaultFilters = { brightness: 100, contrast: 100, saturation: 100, blur: 0, grayscale: 0, sepia: 0, vignette: 0 };
    this.setState({
      clips: this.state.clips.map(c => c.id === this.state.selectedClipId
        ? { ...c, filters: { ...defaultFilters, ...(c.filters || {}), [key]: value } }
        : c),
    });
  };

  resetFilters = () => {
    if (!this.state.selectedClipId) return;
    this.pushHistory();
    this.setState({ clips: this.state.clips.map(c => c.id === this.state.selectedClipId ? { ...c, filters: { brightness: 100, contrast: 100, saturation: 100, blur: 0, grayscale: 0, sepia: 0, vignette: 0 } } : c) });
  };

  // Continuous sliders (fade seconds, like brightness/contrast/saturation
  // above) don't push a history entry per tick - only on more discrete
  // actions - so dragging one doesn't fill the undo stack with every
  // intermediate value.
  //
  // A fast drag can fire many more native 'input' events than there's time
  // to fully re-render for (renderVals() rebuilds the whole timeline/track
  // view model on every commit) - if that work falls behind the pointer,
  // the browser's own native slider-drag tracking can get confused mid-drag.
  // scheduleFadeCommit() coalesces however many ticks arrive in a frame
  // into a single state update per animation frame, so the app never has
  // more pending re-renders queued up than it can actually paint.
  _pendingFade = null; // { clipId, fadeIn?, fadeOut? }
  _fadeRafId = null;

  handleFadeInChange = (e) => {
    if (!this.state.selectedClipId) return;
    const value = Math.max(0, parseFloat(e.target.value));
    this.scheduleFadeCommit(this.state.selectedClipId, 'fadeIn', value);
  };

  handleFadeOutChange = (e) => {
    if (!this.state.selectedClipId) return;
    const value = Math.max(0, parseFloat(e.target.value));
    this.scheduleFadeCommit(this.state.selectedClipId, 'fadeOut', value);
  };

  scheduleFadeCommit = (clipId, field, value) => {
    if (!this._pendingFade || this._pendingFade.clipId !== clipId) this._pendingFade = { clipId };
    this._pendingFade[field] = value;
    if (this._fadeRafId != null) return;
    this._fadeRafId = requestAnimationFrame(this.commitPendingFade);
  };

  commitPendingFade = () => {
    this._fadeRafId = null;
    const pending = this._pendingFade;
    this._pendingFade = null;
    if (!pending) return;
    this.setState({
      clips: this.state.clips.map(c => {
        if (c.id !== pending.clipId) return c;
        const next = { ...c };
        if (pending.fadeIn != null) next.fadeIn = pending.fadeIn;
        if (pending.fadeOut != null) next.fadeOut = pending.fadeOut;
        return this.clampClipFades(next);
      }),
    });
  };

  // ---------- transitions ----------
  // A transition always applies between the selected clip and whichever
  // clip immediately precedes it (by start time) on the same track. Setting
  // one repositions the selected clip to start exactly `duration` seconds
  // before the previous clip ends (creating the overlap the crossfade/wipe
  // blends across) and ripples every later clip on that track by the same
  // amount, the same way ripple-delete already shifts clips - so gaps
  // between later clips are preserved, just shifted.

  // ---------- per-frame lookup caches ----------
  // drawFrame/syncMediaElements run on every animation frame during
  // playback and scrubbing (up to 60x/sec), and renderVals() rebuilds the
  // timeline view-model on every render (including every single mousemove
  // while dragging a clip). All of them previously re-derived the same
  // things from scratch every single call: which clips belong to which
  // track (filter + sort), which clip's transitionIn is actually live right
  // now (its own filter + sort, done once *per clip*), and which media/
  // track object a clip's id points to (a linear .find() per clip). For a
  // timeline with N clips that's O(N) or worse work repeated at up to 60fps
  // even though, during steady playback, none of clips/media/tracks are
  // actually changing frame to frame - only the playhead is.
  //
  // These caches key off the *array reference* of state.clips/state.media
  // (every real edit replaces that array - see the rest of this file, every
  // clip/media mutation goes through setState with a new array, never an
  // in-place push/splice/sort), so a cache is valid exactly as long as nothing
  // real changed, and gets rebuilt automatically the instant something does.
  // During playback, where the array references stay stable frame to frame,
  // this turns the O(N) rebuild into a one-time cost and every subsequent
  // frame's lookups into O(1) map reads.
  _clipsByTrackCache = null; // { clipsRef, map: Map<trackId, clip[] sorted by start> }
  getSortedClipsByTrack = () => {
    if (this._clipsByTrackCache && this._clipsByTrackCache.clipsRef === this.state.clips) {
      return this._clipsByTrackCache.map;
    }
    const map = new Map();
    this.state.clips.forEach(c => {
      let list = map.get(c.trackId);
      if (!list) { list = []; map.set(c.trackId, list); }
      list.push(c);
    });
    map.forEach(list => list.sort((a, b) => a.start - b.start));
    this._clipsByTrackCache = { clipsRef: this.state.clips, map };
    return map;
  };

  _mediaByIdCache = null; // { mediaRef, map }
  getMediaById = () => {
    if (this._mediaByIdCache && this._mediaByIdCache.mediaRef === this.state.media) {
      return this._mediaByIdCache.map;
    }
    const map = {};
    this.state.media.forEach(m => { map[m.id] = m; });
    this._mediaByIdCache = { mediaRef: this.state.media, map };
    return map;
  };

  _trackByIdCache = null; // { tracksRef, map }
  getTrackById = () => {
    if (this._trackByIdCache && this._trackByIdCache.tracksRef === this.state.tracks) {
      return this._trackByIdCache.map;
    }
    const map = {};
    this.state.tracks.forEach(t => { map[t.id] = t; });
    this._trackByIdCache = { tracksRef: this.state.tracks, map };
    return map;
  };

  // Same one-pass idea as ffmpegExport.js's computeValidTransitions (which
  // this now matches exactly, closing a subtle inconsistency where the live
  // preview and the actual export used two slightly different ways of
  // deciding "is this transition live"): walk each track once, sorted by
  // start, and record every clip whose transitionIn is actually live. This
  // replaces activeTransitionFor's old per-call filter+sort of the whole
  // track (previously called once per clip from several hot paths below -
  // O(N) calls each doing O(N log N) work) with a single O(N log N) pass,
  // cached the same way as the lookups above.
  _transitionCache = null; // { clipsRef, byClipId: Map<clipId, {type,duration,prev}> }
  computeTransitionsByClipId = () => {
    if (this._transitionCache && this._transitionCache.clipsRef === this.state.clips) {
      return this._transitionCache.byClipId;
    }
    const byClipId = new Map();
    this.getSortedClipsByTrack().forEach(list => {
      for (let i = 1; i < list.length; i++) {
        const clip = list[i], prev = list[i - 1];
        const tr = clip.transitionIn;
        if (!tr || tr.type === 'none' || !(tr.duration > 0)) continue;
        if (tr.fromClipId !== prev.id) continue;
        const expectedStart = prev.start + prev.duration - tr.duration;
        if (Math.abs(expectedStart - clip.start) > 0.02) continue;
        const duration = Math.min(tr.duration, prev.duration, clip.duration);
        if (duration <= 0) continue;
        byClipId.set(clip.id, { type: tr.type, duration, prev });
      }
    });
    this._transitionCache = { clipsRef: this.state.clips, byClipId };
    return byClipId;
  };

  findPrevClipOnTrack = (clip) => {
    if (!clip) return null;
    const list = this.getSortedClipsByTrack().get(clip.trackId) || [];
    let prev = null;
    for (const c of list) { if (c.start < clip.start - 0.0005) prev = c; else break; }
    return prev;
  };

  // The single source of truth for "is this clip's transitionIn actually
  // live right now" - requires the stored fromClipId to still be the clip
  // immediately before it AND the positions to still line up. If a clip
  // got dragged, trimmed, or its partner deleted after a transition was
  // set, this just quietly reports no active transition rather than
  // crashing or showing stale state - export falls back the same way.
  activeTransitionFor = (clip) => {
    if (!clip) return null;
    return this.computeTransitionsByClipId().get(clip.id) || null;
  };

  rippleApplyTransition = (clip, prev, type, wantDuration) => {
    const maxD = Math.max(0, Math.min(prev.duration, clip.duration, this.MAX_TRANSITION_DURATION));
    const d = Math.max(0, Math.min(wantDuration, maxD));
    const finalType = d > 0 ? type : 'none';
    const newStart = prev.start + prev.duration - d;
    const delta = newStart - clip.start;
    const oldStart = clip.start;
    const clips = this.state.clips.map(c => {
      if (c.id === clip.id) {
        return { ...c, start: newStart, transitionIn: { type: finalType, duration: d, fromClipId: finalType === 'none' ? null : prev.id } };
      }
      if (c.trackId === clip.trackId && c.start >= oldStart - 0.0005) {
        return { ...c, start: c.start + delta };
      }
      return c;
    });
    this.setState({ clips });
  };

  setClipTransitionType = (type) => {
    if (!this.state.selectedClipId) return;
    const clip = this.state.clips.find(c => c.id === this.state.selectedClipId);
    if (!clip) return;
    const prev = this.findPrevClipOnTrack(clip);
    if (!prev) { this.showToast('Select a clip that has another clip right before it on the same track'); return; }
    this.pushHistory();
    const current = this.activeTransitionFor(clip);
    const wantDuration = type === 'none' ? 0 : (current ? current.duration : 0.5);
    this.rippleApplyTransition(clip, prev, type, wantDuration);
  };

  // Continuous slider - like the fade sliders, no history push per tick.
  changeTransitionDuration = (e) => {
    if (!this.state.selectedClipId) return;
    const clip = this.state.clips.find(c => c.id === this.state.selectedClipId);
    if (!clip) return;
    const prev = this.findPrevClipOnTrack(clip);
    if (!prev) return;
    const current = this.activeTransitionFor(clip);
    const type = (clip.transitionIn && clip.transitionIn.type !== 'none') ? clip.transitionIn.type : (current ? current.type : 'fade');
    this.rippleApplyTransition(clip, prev, type, Math.max(0, parseFloat(e.target.value)));
  };

  doSplit = () => this.splitAtPlayhead();

  splitAtPlayhead = () => {
    this.pushHistory();
    const t = this.currentTime;
    let did = false;
    const newClips = [];
    let repoint = null; // { fromId: original clip id, toId: new right-piece id }
    this.state.clips.forEach(c => {
      const inRange = t > c.start + 0.03 && t < c.start + c.duration - 0.03;
      const targeted = !this.state.selectedClipId || c.id === this.state.selectedClipId;
      if (inRange && targeted) {
        const leftDur = t - c.start;
        const rightDur = c.duration - leftDur;
        const rightId = this.uid();
        newClips.push(this.clampClipFades({ ...c, duration: leftDur, fadeOut: 0 }));
        newClips.push(this.clampClipFades({ ...c, id: rightId, start: t, duration: rightDur, inPoint: c.inPoint + leftDur, fadeIn: 0, transitionIn: { type: 'none', duration: 0, fromClipId: null } }));
        // The right-hand piece is the one that keeps the original clip's
        // end boundary, so anything transitioning in from the *original*
        // clip's tail now needs to reference the right piece, not the left
        // (which kept the original id but no longer reaches that far).
        repoint = { fromId: c.id, toId: rightId };
        did = true;
      } else newClips.push(c);
    });
    const finalClips = repoint
      ? newClips.map(c => (c.transitionIn && c.transitionIn.fromClipId === repoint.fromId) ? { ...c, transitionIn: { ...c.transitionIn, fromClipId: repoint.toId } } : c)
      : newClips;
    if (did) this.setState({ clips: finalClips });
    else this.undoStack.pop();
  };

  doDeleteNormal = () => this.deleteSelected(false);
  doDeleteRipple = () => this.deleteSelected(true);

  deleteSelected = (ripple) => {
    const id = this.state.selectedClipId;
    if (!id) return;
    const clip = this.state.clips.find(c => c.id === id);
    if (!clip) return;
    this.pushHistory();
    let clips = this.state.clips.filter(c => c.id !== id);
    // Anything transitioning in from the clip we're deleting loses its
    // source - clear the stale reference rather than leaving it dangling
    // (activeTransitionFor already treats it as inactive either way, but a
    // dangling fromClipId is bad hygiene and could confuse future logic).
    clips = clips.map(c => (c.transitionIn && c.transitionIn.fromClipId === id)
      ? { ...c, transitionIn: { type: 'none', duration: 0, fromClipId: null } } : c);
    // Clamped to 0: a clip that was transitioning in from the deleted clip
    // sat *inside* its span (the overlap), so a naive "subtract the full
    // deleted duration" can push it negative - clamping is the safe,
    // general fix regardless of why a clip's start was less than the
    // deleted clip's full extent.
    if (ripple) clips = clips.map(c => (c.trackId === clip.trackId && c.start > clip.start) ? { ...c, start: Math.max(0, c.start - clip.duration) } : c);
    delete this.mediaElsByClip[id];
    this.setState({ clips, selectedClipId: null });
  };

  openClipMenu = (e, clip) => {
    e.preventDefault(); e.stopPropagation();
    const estWidth = 190, estHeight = 250, margin = 8;
    const x = Math.max(margin, Math.min(e.clientX, window.innerWidth - estWidth - margin));
    const y = Math.max(margin, Math.min(e.clientY, window.innerHeight - estHeight - margin));
    this.setState({ selectedClipId: clip.id, contextMenu: { x, y, clipId: clip.id } });
  };

  splitClipAt = (clipId) => {
    const t = this.currentTime;
    this.pushHistory();
    let did = false;
    const newClips = [];
    let repoint = null;
    this.state.clips.forEach(c => {
      if (c.id === clipId && t > c.start + 0.03 && t < c.start + c.duration - 0.03) {
        const leftDur = t - c.start;
        const rightDur = c.duration - leftDur;
        const rightId = this.uid();
        newClips.push(this.clampClipFades({ ...c, duration: leftDur, fadeOut: 0 }));
        newClips.push(this.clampClipFades({ ...c, id: rightId, start: t, duration: rightDur, inPoint: c.inPoint + leftDur, fadeIn: 0, transitionIn: { type: 'none', duration: 0, fromClipId: null } }));
        repoint = { fromId: c.id, toId: rightId };
        did = true;
      } else newClips.push(c);
    });
    const finalClips = repoint
      ? newClips.map(c => (c.transitionIn && c.transitionIn.fromClipId === repoint.fromId) ? { ...c, transitionIn: { ...c.transitionIn, fromClipId: repoint.toId } } : c)
      : newClips;
    if (did) this.setState({ clips: finalClips, contextMenu: null });
    else { this.undoStack.pop(); this.setState({ contextMenu: null }); this.showToast('Move the playhead inside the clip to split'); }
  };

  findFreeStart = (trackId, start, duration, excludeId) => {
    const existing = this.state.clips.filter(c => c.trackId === trackId && c.id !== excludeId).sort((a, b) => a.start - b.start);
    let s = start;
    for (const c of existing) { if (s < c.start + c.duration && s + duration > c.start) s = c.start + c.duration; }
    return s;
  };

  detachAudio = (clipId) => {
    const clip = this.state.clips.find(c => c.id === clipId);
    if (!clip) return;
    const media = this.state.media.find(m => m.id === clip.mediaId);
    const audioTrack = this.state.tracks.find(t => t.type === 'audio');
    if (!clip || !media || media.type !== 'video' || !audioTrack) return;
    this.pushHistory();
    const start = this.findFreeStart(audioTrack.id, clip.start, clip.duration, null);
    const newClip = { id: this.uid(), trackId: audioTrack.id, mediaId: clip.mediaId, start, duration: clip.duration, inPoint: clip.inPoint, volume: clip.volume == null ? 1 : clip.volume, muted: false, ...this.defaultClipExtras() };
    const clips = this.state.clips.map(c => c.id === clipId ? { ...c, muted: true } : c).concat([newClip]);
    this.setState({ clips, contextMenu: null, selectedClipId: newClip.id });
    this.showToast('Audio detached to ' + audioTrack.name + ' \u2014 original video muted');
  };

  duplicateClip = (clipId) => {
    const clip = this.state.clips.find(c => c.id === clipId);
    if (!clip) return;
    this.pushHistory();
    const start = this.findFreeStart(clip.trackId, clip.start + clip.duration, clip.duration, clip.id);
    const newClip = { ...clip, id: this.uid(), start, transitionIn: { type: 'none', duration: 0, fromClipId: null } };
    this.setState({ clips: [...this.state.clips, newClip], contextMenu: null, selectedClipId: newClip.id });
  };

  toggleMuteById = (clipId) => {
    this.pushHistory();
    this.setState({ clips: this.state.clips.map(c => c.id === clipId ? { ...c, muted: !c.muted } : c), contextMenu: null });
  };

  deleteClipById = (clipId, ripple) => {
    const clip = this.state.clips.find(c => c.id === clipId);
    if (!clip) return;
    this.pushHistory();
    let clips = this.state.clips.filter(c => c.id !== clipId);
    clips = clips.map(c => (c.transitionIn && c.transitionIn.fromClipId === clipId)
      ? { ...c, transitionIn: { type: 'none', duration: 0, fromClipId: null } } : c);
    if (ripple) clips = clips.map(c => (c.trackId === clip.trackId && c.start > clip.start) ? { ...c, start: Math.max(0, c.start - clip.duration) } : c);
    delete this.mediaElsByClip[clipId];
    this.setState({ clips, selectedClipId: null, contextMenu: null });
  };

  closeGaps = (trackId) => {
    this.pushHistory();
    const trackClips = this.state.clips.filter(c => c.trackId === trackId).sort((a, b) => a.start - b.start);
    let cursor = 0;
    const updates = {};
    trackClips.forEach(c => { updates[c.id] = cursor; cursor += c.duration; });
    this.setState({ clips: this.state.clips.map(c => (c.id in updates) ? { ...c, start: updates[c.id] } : c) });
  };

  // ---------- tracks ----------
  MAX_TRACKS_PER_TYPE = 10;

  // Every video track shared one identical background and every audio
  // track shared another - fine for the old fixed 2+1 tracks, but with up
  // to 10 of each it became impossible to tell tracks apart. Each track
  // now gets its own subtle color tint, picked deterministically from its
  // id (so a track keeps "its" color even as siblings are added/removed)
  // and blended into the current theme's base lane color rather than a
  // hardcoded palette, so it stays legible and on-theme in dark mode too.
  TRACK_TINT_HUES = [355, 25, 145, 195, 265, 325, 55, 205];

  hashTrackId = (id) => {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
    return Math.abs(h);
  };

  hexToRgb = (hex) => {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : { r: 0, g: 0, b: 0 };
  };

  hslToRgb = (h, s, l) => {
    s /= 100; l /= 100;
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return { r: Math.round(f(0) * 255), g: Math.round(f(8) * 255), b: Math.round(f(4) * 255) };
  };

  rgbToHsl = (rgb) => {
    const r = rgb.r / 255, g = rgb.g / 255, b = rgb.b / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l: l * 100 };
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
    return { h, s: s * 100, l: l * 100 };
  };

  // Mixes a vivid hue tint into a base theme color at low opacity, so the
  // result stays close to the theme's own brightness (works for light and
  // dark themes alike) while still reading as a distinct, colored lane.
  trackTint = (baseHex, track, amount) => {
    const idx = this.hashTrackId(track.id) % this.TRACK_TINT_HUES.length;
    const tint = this.hslToRgb(this.TRACK_TINT_HUES[idx], 65, 55);
    const base = this.hexToRgb(baseHex);
    const mix = (a, b) => Math.round(a * (1 - amount) + b * amount);
    return `rgb(${mix(base.r, tint.r)},${mix(base.g, tint.g)},${mix(base.b, tint.b)})`;
  };

  // Pure - takes a tracks array explicitly rather than reading this.state,
  // so it gives the right answer even when called from inside a functional
  // setState updater against a not-yet-committed pending state.
  nextTrackNumberFrom = (tracks, type) => {
    const used = new Set(tracks.filter(t => t.type === type).map(t => {
      const m = /(\d+)\s*$/.exec(t.name || ''); return m ? parseInt(m[1], 10) : null;
    }).filter(n => n != null));
    let n = 1;
    while (used.has(n)) n++;
    return n;
  };

  // Both the cap check and the mutation happen inside the functional
  // setState updater, against `s` (Preact's own pending state), not
  // `this.state` - `this.state` doesn't reflect a setState call until the
  // next render actually commits, so reading it right after calling
  // setState (or across several setState calls fired back to back) can see
  // stale data. Doing both steps against `s` keeps this correct no matter
  // how it's called.
  addVideoTrack = () => {
    this.pushHistory();
    let blocked = false;
    this.setState(s => {
      const count = s.tracks.filter(t => t.type === 'video').length;
      if (count >= this.MAX_TRACKS_PER_TYPE) { blocked = true; return { tracks: s.tracks }; }
      const track = { id: this.uid(), type: 'video', name: 'Video ' + this.nextTrackNumberFrom(s.tracks, 'video'), muted: false };
      // New video tracks join at the top of the stack (index 0 = topmost in
      // compositing), matching how most editors add a new track "above"
      // what's already there.
      return { tracks: [track, ...s.tracks] };
    }, () => { if (blocked) { this.undoStack.pop(); this.showToast('Maximum of ' + this.MAX_TRACKS_PER_TYPE + ' video tracks'); } });
  };

  addAudioTrack = () => {
    this.pushHistory();
    let blocked = false;
    this.setState(s => {
      const count = s.tracks.filter(t => t.type === 'audio').length;
      if (count >= this.MAX_TRACKS_PER_TYPE) { blocked = true; return { tracks: s.tracks }; }
      const track = { id: this.uid(), type: 'audio', name: 'Audio ' + this.nextTrackNumberFrom(s.tracks, 'audio'), muted: false };
      return { tracks: [...s.tracks, track] };
    }, () => { if (blocked) { this.undoStack.pop(); this.showToast('Maximum of ' + this.MAX_TRACKS_PER_TYPE + ' audio tracks'); } });
  };

  removeTrack = (trackId) => {
    const track = this.state.tracks.find(t => t.id === trackId);
    if (!track) return;
    const sameType = this.state.tracks.filter(t => t.type === track.type);
    if (sameType.length <= 1) { this.showToast('Keep at least one ' + track.type + ' track'); return; }
    const clipsOnTrack = this.state.clips.filter(c => c.trackId === trackId);
    if (clipsOnTrack.length > 0 && !confirm(`Remove "${track.name}"? This deletes ${clipsOnTrack.length} clip(s) on it.`)) return;
    this.pushHistory();
    this.setState(s => {
      const removedClipIds = new Set(s.clips.filter(c => c.trackId === trackId).map(c => c.id));
      return {
        tracks: s.tracks.filter(t => t.id !== trackId),
        clips: s.clips.filter(c => c.trackId !== trackId),
        selectedClipId: removedClipIds.has(s.selectedClipId) ? null : s.selectedClipId,
      };
    });
  };

  // ---------- transport ----------
  seek = (t) => {
    this.currentTime = Math.max(0, Math.min(t, Math.max(this.totalDuration(), 0)));
    this.setState({ playhead: this.currentTime });
    if (!this._loopActive) this.drawOnce();
  };

  stepFrame = (n) => { const frame = 1 / 30; this.seek(this.currentTime + n * frame); };
  stepPrev = () => this.stepFrame(-1);
  stepNext = () => this.stepFrame(1);

  jump = (seconds) => { this.seek(this.currentTime + seconds); };
  skipBack1 = () => this.jump(-1);
  skipFwd1 = () => this.jump(1);
  skipBack5 = () => this.jump(-5);
  skipFwd5 = () => this.jump(5);

  play = () => {
    if (this.totalDuration() <= 0) return;
    if (this.currentTime >= this.totalDuration()) this.currentTime = 0;
    this.setState({ isPlaying: true });
    this.startLoop();
  };
  pause = () => {
    this.setState({ isPlaying: false });
    Object.values(this.mediaElsByClip).forEach(el => { if (el && !el.paused) el.pause(); });
  };
  togglePlay = () => { this.state.isPlaying ? this.pause() : this.play(); };

  handleRulerMouseDown = (e) => { this.scrubbing = true; this.startLoop(); this.updateScrubFromEvent(e); };
  updateScrubFromEvent = (e) => {
    if (!this.timelineContentEl) return;
    const rect = this.timelineContentEl.getBoundingClientRect();
    this.seek((e.clientX - rect.left) / this.state.zoom);
  };

  // The floor for zooming out - tied to whatever "fit" would compute for
  // the current project, with a bit of extra room beyond it, rather than a
  // fixed number. A fixed floor is wrong in both directions: too high and
  // a long project can never be zoomed out far enough to fit (the button
  // hits bottom before "fit" does); too low and a short project can be
  // zoomed out to a near-invisible sliver.
  minZoom = () => {
    const total = this.totalDuration();
    const availPx = (this.timelineScrollEl ? this.timelineScrollEl.clientWidth : 900) - 24;
    const fitZoom = total > 0 ? Math.max(0.02, availPx / total) : 6;
    return Math.max(0.02, fitZoom * 0.7);
  };

  zoomIn = () => this.setState(s => ({ zoom: Math.min(300, s.zoom * 1.25) }));
  zoomOut = () => this.setState(s => ({ zoom: Math.max(this.minZoom(), s.zoom / 1.25) }), this.snapScrollIfAtFloor);
  // Zooming out shrinks the content, but a scroll position from before the
  // zoom (e.g. scrolled right to look at a later part of the video) doesn't
  // get reset - the browser keeps it "valid" by clamping to the new max,
  // but that clamp can still land on a nonzero offset, leaving the view
  // showing a cut-off, shifted timeline instead of the full thing starting
  // at 0:00. Once zoom has actually hit the floor - there's nowhere further
  // out to go - there's no reason to still be scrolled, so snap to the
  // start. (Checking "has the whole thing fit" instead would never fire:
  // timelineWidth has a 900px floor of its own, so it's rarely exactly
  // as narrow as the viewport even at minimum zoom.)
  snapScrollIfAtFloor = () => {
    const el = this.timelineScrollEl;
    if (el && Math.abs(this.state.zoom - this.minZoom()) < 0.001) el.scrollLeft = 0;
  };
  zoomToFit = () => {
    const total = this.totalDuration();
    const availPx = (this.timelineScrollEl ? this.timelineScrollEl.clientWidth : 900) - 24;
    const fitZoom = total > 0 ? Math.max(0.02, availPx / total) : 6;
    this.setState({ zoom: Math.min(300, fitZoom) });
    if (this.timelineScrollEl) this.timelineScrollEl.scrollLeft = 0;
  };

  // ---------- keyboard ----------
  handleKeyDown = (e) => {
    if (!this.state.disclaimerAgreed) return;
    const tag = (e.target && e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    if (e.key === ' ') { e.preventDefault(); this.togglePlay(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); this.deleteSelected(e.shiftKey); }
    else if (e.key === 's' || e.key === 'S') { this.splitAtPlayhead(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); if (e.ctrlKey || e.metaKey) this.jump(-5); else if (e.shiftKey) this.jump(-1); else this.stepFrame(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); if (e.ctrlKey || e.metaKey) this.jump(5); else if (e.shiftKey) this.jump(1); else this.stepFrame(1); }
    else if (e.key === 'Home') { this.seek(0); }
    else if (e.key === 'End') { this.seek(this.totalDuration()); }
    else if (e.key === '+' || e.key === '=') { this.zoomIn(); }
    else if (e.key === '-' || e.key === '_') { this.zoomOut(); }
    else if (e.key === '?') { this.setState(s => ({ showHelp: !s.showHelp })); }
    else if (e.key === 'Escape') { this.setState({ showHelp: false, showExport: false, contextMenu: null }); }
    else if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); }
    else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); this.redo(); }
  };

  // ---------- rendering / compositing ----------
  setPreviewCanvas = (el) => { this.previewCanvasEl = el; };
  setTimelineScroll = (el) => {
    if (this.timelineScrollEl && this._wheelHandler) this.timelineScrollEl.removeEventListener('wheel', this._wheelHandler);
    this.timelineScrollEl = el;
    if (el) {
      this._wheelHandler = (e) => this.handleTimelineWheel(e);
      el.addEventListener('wheel', this._wheelHandler, { passive: false });
    }
  };
  setTimelineContent = (el) => { this.timelineContentEl = el; };
  setRulerEl = (el) => { this.rulerEl = el; };
  // The ruler needs to stay visually pinned to the top as the tracks area
  // scrolls vertically, but CSS position:sticky can't reference that outer
  // scrolling ancestor here - timelineScrollEl sits between them and needs
  // its own non-visible overflow-x for horizontal zoom-scrolling, which
  // stops sticky's ancestor search before it ever reaches the real
  // scrolling container. Tracking scrollTop directly and applying it as a
  // transform (like the fade-slider commit, updating the DOM directly
  // rather than through a Preact re-render per scroll tick) sidesteps that
  // entirely.
  setTracksArea = (el) => {
    if (this.tracksAreaEl && this._tracksAreaScrollHandler) this.tracksAreaEl.removeEventListener('scroll', this._tracksAreaScrollHandler);
    this.tracksAreaEl = el;
    if (el) {
      this._tracksAreaScrollHandler = () => { if (this.rulerEl) this.rulerEl.style.transform = `translateY(${el.scrollTop}px)`; };
      el.addEventListener('scroll', this._tracksAreaScrollHandler, { passive: true });
    }
  };

  handleTimelineWheel = (e) => {
    // Plain wheel now scrolls vertically through tracks (there can be up to
    // 20 of them) using the browser's native scroll - zoom needs a
    // modifier so the two don't fight over the same gesture.
    if (!(e.ctrlKey || e.metaKey)) return;
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    // Same fit-based floor as the zoomOut button - one consistent cap for
    // every way of zooming.
    this.setState(
      s => ({ zoom: Math.min(300, Math.max(this.minZoom(), s.zoom * factor)) }),
      factor < 1 ? this.snapScrollIfAtFloor : undefined,
    );
  };

  BG_COLOR = '#2e2b25'; // must match ffmpegExport.js's BG_COLOR - keeps preview and export fades identical

  // 0 = clip fully visible, 1 = fully covered by the background color.
  // Matches ffmpeg's `fade` filter (fades to a solid color, not a
  // cross-blend with whatever's underneath) so preview and export agree.
  computeFadeAlpha = (clip, t) => {
    const fadeIn = clip.fadeIn || 0, fadeOut = clip.fadeOut || 0;
    let alpha = 0;
    const intoClip = t - clip.start;
    const toEnd = (clip.start + clip.duration) - t;
    if (fadeIn > 0 && intoClip < fadeIn) alpha = Math.max(alpha, 1 - intoClip / fadeIn);
    if (fadeOut > 0 && toEnd < fadeOut) alpha = Math.max(alpha, 1 - toEnd / fadeOut);
    return Math.max(0, Math.min(1, alpha));
  };

  // CSS filter() string for a clip's color adjustments. Canvas2D supports
  // the same filter functions as CSS, chained in one string, which is what
  // keeps this cheap - blur/grayscale/sepia stack for free alongside the
  // existing brightness/contrast/saturate. Vignette has no CSS filter
  // equivalent so it's drawn separately, after the image, in drawClipInto.
  cssFilterFor = (f) => {
    if (!f) return 'none';
    const parts = [
      `brightness(${f.brightness}%)`, `contrast(${f.contrast}%)`, `saturate(${f.saturation}%)`,
    ];
    if (f.grayscale > 0) parts.push(`grayscale(${Math.min(100, f.grayscale)}%)`);
    if (f.sepia > 0) parts.push(`sepia(${Math.min(100, f.sepia)}%)`);
    if (f.blur > 0) parts.push(`blur(${Math.min(20, f.blur)}px)`);
    return parts.join(' ');
  };

  // For every clip with a *live* incoming transition (see
  // activeTransitionFor), record how long its predecessor's tail is being
  // consumed by that transition. Used to (a) keep the outgoing clip's
  // <video> element seeking correctly through the overlap in
  // syncMediaElements, and (b) find transition windows in drawFrame.
  computeOutgoingTransitionMap = () => {
    const map = {};
    this.state.clips.forEach(c => {
      const active = this.activeTransitionFor(c);
      if (active) map[active.prev.id] = Math.max(map[active.prev.id] || 0, active.duration);
    });
    return map;
  };

  // Draws one clip's frame (filters, vignette, fade-to-bg) into the given
  // rect, optionally at a reduced opacity - the shared piece used both for
  // a normal single-clip draw and for each half of a transition blend.
  drawClipInto = (ctx, clip, media, t, dx, dy, dw, dh, opacity) => {
    let src = null;
    if (media.type === 'video') src = this.mediaElsByClip[clip.id];
    else if (media.type === 'image') src = this.imageEls[media.id];
    if (!src) return;
    const f = clip.filters;
    ctx.save();
    ctx.globalAlpha = opacity == null ? 1 : opacity;
    ctx.filter = this.cssFilterFor(f);
    ctx.drawImage(src, dx, dy, dw, dh);
    ctx.filter = 'none';
    if (f && f.vignette > 0) {
      const cx = dx + dw / 2, cy = dy + dh / 2, r = Math.max(dw, dh) * 0.72;
      const grad = ctx.createRadialGradient(cx, cy, r * 0.25, cx, cy, r);
      grad.addColorStop(0, 'rgba(0,0,0,0)');
      grad.addColorStop(1, `rgba(0,0,0,${(Math.min(100, f.vignette) / 100 * 0.85).toFixed(3)})`);
      ctx.fillStyle = grad;
      ctx.fillRect(dx, dy, dw, dh);
    }
    const fadeAlpha = this.computeFadeAlpha(clip, t);
    if (fadeAlpha > 0) {
      ctx.globalAlpha = (opacity == null ? 1 : opacity) * fadeAlpha;
      ctx.fillStyle = this.BG_COLOR;
      ctx.fillRect(dx, dy, dw, dh);
    }
    ctx.restore();
  };

  // Approximates the ffmpeg xfade transition types for the live preview.
  // "fade" is an exact match (plain alpha cross-dissolve, same as export).
  // The directional wipe/slide/circle types are a reasonable best-effort
  // stand-in, not a pixel-accurate replica of ffmpeg's geometry - the
  // exported video (real ffmpeg xfade) is the authoritative result.
  drawTransitionInto = (ctx, type, fromClip, fromMedia, toClip, toMedia, t, dx, dy, dw, dh, progress) => {
    this.drawClipInto(ctx, fromClip, fromMedia, t, dx, dy, dw, dh, 1);
    if (type === 'fade' || type === 'dissolve') {
      this.drawClipInto(ctx, toClip, toMedia, t, dx, dy, dw, dh, progress);
      return;
    }
    ctx.save();
    ctx.beginPath();
    if (type === 'wipeleft' || type === 'wiperight' || type === 'slideleft' || type === 'slideright') {
      const revealW = dw * progress;
      const rectX = type === 'wipeleft' || type === 'slideleft' ? dx + dw - revealW : dx;
      ctx.rect(rectX, dy, revealW, dh);
    } else if (type === 'wipeup' || type === 'wipedown' || type === 'slideup' || type === 'slidedown') {
      const revealH = dh * progress;
      const rectY = type === 'wipeup' || type === 'slideup' ? dy + dh - revealH : dy;
      ctx.rect(dx, rectY, dw, revealH);
    } else if (type === 'circleopen') {
      const cx = dx + dw / 2, cy = dy + dh / 2;
      const r = Math.hypot(dw, dh) / 2 * progress;
      ctx.arc(cx, cy, Math.max(0.001, r), 0, Math.PI * 2);
    } else if (type === 'circleclose') {
      const cx = dx + dw / 2, cy = dy + dh / 2;
      const r = Math.hypot(dw, dh) / 2 * (1 - progress);
      ctx.rect(dx, dy, dw, dh);
      ctx.arc(cx, cy, Math.max(0.001, r), 0, Math.PI * 2);
    } else {
      // Unknown/future type - fall back to a plain crossfade.
      ctx.rect(dx, dy, dw, dh);
    }
    ctx.clip('evenodd');
    this.drawClipInto(ctx, toClip, toMedia, t, dx, dy, dw, dh, 1);
    ctx.restore();
  };

  drawFrame = (ctx, w, h, t) => {
    ctx.fillStyle = this.BG_COLOR;
    ctx.fillRect(0, 0, w, h);
    const mediaById = this.getMediaById();
    const clipsByTrack = this.getSortedClipsByTrack();
    const order = this.state.tracks.slice().reverse();
    order.forEach(track => {
      if (track.type === 'audio') return;
      const trackClips = clipsByTrack.get(track.id) || [];
      // During a transition overlap, two clips' ranges both contain t - the
      // later one (which carries the transitionIn back to the earlier one)
      // has to win here, not just whichever sorts first, or the preview
      // would silently show the outgoing clip with no blend at all.
      let idx = -1;
      for (let i = trackClips.length - 1; i >= 0; i--) {
        const c = trackClips[i];
        if (t >= c.start - 0.0001 && t < c.start + c.duration + 0.0001) { idx = i; break; }
      }
      if (idx < 0) return;
      const clip = trackClips[idx];
      const media = mediaById[clip.mediaId];
      if (!media) return;
      const mw = media.width || w, mh = media.height || h;
      const scale = Math.min(w / mw, h / mh);
      const dw = mw * scale, dh = mh * scale;
      const dx = (w - dw) / 2, dy = (h - dh) / 2;

      const active = this.activeTransitionFor(clip);
      try {
        if (active && t < clip.start + active.duration) {
          const prevMedia = mediaById[active.prev.mediaId];
          if (prevMedia) {
            const progress = Math.max(0, Math.min(1, (t - clip.start) / active.duration));
            this.drawTransitionInto(ctx, active.type, active.prev, prevMedia, clip, media, t, dx, dy, dw, dh, progress);
            return;
          }
        }
        this.drawClipInto(ctx, clip, media, t, dx, dy, dw, dh, 1);
      } catch (e) {
        // A single bad frame shouldn't crash playback, but silently eating
        // every draw error made a real bug (transition compositing picking
        // the wrong clip) invisible during testing - so this logs once per
        // distinct message instead of just swallowing it.
        const msg = 'drawFrame: ' + (e && e.message);
        if (this._lastDrawError !== msg) { this._lastDrawError = msg; console.error(msg, e); }
      }
    });
  };

  syncMediaElements = (playing) => {
    const outgoing = this.computeOutgoingTransitionMap();
    const mediaById = this.getMediaById();
    const trackById = this.getTrackById();
    this.state.clips.forEach(c => {
      const media = mediaById[c.mediaId];
      if (!media || media.type === 'image') return;
      const el = this.mediaElsByClip[c.id];
      if (!el) return;
      // A clip mid-transition-out stays "active" a little past its own
      // nominal end, through the overlap window, so its element keeps
      // seeking to the right frame while it's still visible blended in.
      const extendedEnd = c.start + c.duration + (outgoing[c.id] || 0);
      const active = this.currentTime >= c.start && this.currentTime < extendedEnd;
      if (active) {
        // muted/volume only need to be current on the element that's
        // actually about to make sound - writing them here, right as a
        // clip becomes active, instead of unconditionally on every clip
        // every frame, is unobservably identical (a paused, inactive
        // element makes no sound regardless of these values) and skips a
        // DOM property write per clip per frame for everything that isn't
        // near the playhead.
        const track = trackById[c.trackId];
        el.muted = !!(c.muted || (track && track.muted));
        el.volume = c.volume == null ? 1 : c.volume;
        const target = c.inPoint + (this.currentTime - c.start);
        if (playing) {
          if (Math.abs(el.currentTime - target) > 0.25) { try { el.currentTime = target; } catch (e) {} }
          if (el.paused) el.play().catch(() => {});
        } else {
          if (Math.abs(el.currentTime - target) > 0.03) { try { el.currentTime = target; } catch (e) {} }
          if (!el.paused) el.pause();
        }
      } else if (!el.paused) el.pause();
    });
  };

  drawOnce = () => {
    this.syncMediaElements(false);
    if (this.previewCanvasEl) {
      this.drawFrame(this.previewCanvasEl.getContext('2d'), this.previewCanvasEl.width, this.previewCanvasEl.height, this.currentTime);
    }
  };

  startLoop = () => {
    if (this._loopActive) return;
    this._loopActive = true;
    this._lastTs = null;
    this.scheduleTick();
  };

  // requestAnimationFrame is fully paused by browsers on backgrounded/hidden
  // windows, which is harmless here since export no longer runs through this
  // loop at all (ffmpeg does it out-of-process) - this only drives playback
  // and scrubbing now.
  scheduleTick = () => {
    this.rafId = requestAnimationFrame(this.tick);
  };

  // Runs only while playing or scrubbing; stops itself otherwise so the
  // page settles (no perpetual DOM mutation) when idle.
  tick = (ts) => {
    if (!this._lastTs) this._lastTs = ts;
    const dt = (ts - this._lastTs) / 1000;
    this._lastTs = ts;
    const playing = this.state.isPlaying;
    if (playing) this.currentTime = Math.min(this.currentTime + dt, this.totalDuration());

    this.syncMediaElements(playing);

    if (this.previewCanvasEl) {
      this.drawFrame(this.previewCanvasEl.getContext('2d'), this.previewCanvasEl.width, this.previewCanvasEl.height, this.currentTime);
    }

    this._uiSyncCounter++;
    if (this._uiSyncCounter % 3 === 0) {
      this.setState({ playhead: this.currentTime });
    }
    if (this.state.isPlaying && this.currentTime >= this.totalDuration()) this.pause();

    if (this.state.isPlaying || this.scrubbing) {
      this.scheduleTick();
    } else {
      this._loopActive = false;
      this._lastTs = null;
    }
  };

  // ---------- export ----------
  // The renderer's job is just to describe the timeline (an "EDL" - edit
  // decision list) and hand it to the main process, which runs it through
  // ffmpeg. See src/main/ffmpegExport.js for the actual encode; this side
  // just packages state and reflects progress back into the dialog.
  getExportDims = (res, aspect) => {
    const table = { '720p': [1280, 720], '1080p': [1920, 1080], '1440p': [2560, 1440], '4K': [3840, 2160] };
    const [w, h] = table[res] || table['1080p'];
    return aspect === '9:16' ? { w: h, h: w } : { w, h };
  };
  getBitrate = (res) => ({ '720p': 5000000, '1080p': 8000000, '1440p': 16000000, '4K': 35000000 }[res] || 8000000);

  openExport = () => this.setState((s) => ({
    showExport: true, exportDone: false, exportError: null, exportRunning: false,
    // Seed the file-name field from the project name only the first time -
    // never clobber something the person already typed in here themselves.
    exportFileName: s.exportFileName || s.projectName,
  }));
  handleExportFileNameChange = (e) => this.setState({ exportFileName: e.target.value });
  // Same "never leaves it blank" behavior as the project-name field above -
  // if they clear it and click away, fall back to the project name (or
  // "My Video" if that's somehow blank too) instead of leaving it empty.
  handleExportFileNameBlur = () => {
    if (!this.state.exportFileName.trim()) this.setState({ exportFileName: this.state.projectName.trim() || 'My Video' });
  };
  closeExportDialog = () => { if (!this.state.exportRunning) this.setState({ showExport: false }); };
  closeExportIfNotRunning = () => { if (!this.state.exportRunning) this.setState({ showExport: false }); };
  stopPropagation = (e) => e.stopPropagation();

  projectHasAudibleContent = () => this.state.clips.some(c => {
    const media = this.state.media.find(m => m.id === c.mediaId);
    if (!media || media.type === 'image') return false;
    const track = this.state.tracks.find(t => t.id === c.trackId);
    return !(c.muted || (track && track.muted));
  });

  buildEdl = () => {
    const s = this.state;
    const defaultFilters = { brightness: 100, contrast: 100, saturation: 100, blur: 0, grayscale: 0, sepia: 0, vignette: 0 };
    return {
      aspect: s.aspect,
      resolution: s.exportResolution,
      format: s.exportFormat,
      speed: s.exportSpeed,
      resourceCapped: s.resourceCapEnabled,
      fps: s.exportFps,
      duration: this.totalDuration(),
      tracks: s.tracks.map(t => ({ id: t.id, type: t.type, muted: !!t.muted })),
      clips: s.clips.map(c => ({
        id: c.id, trackId: c.trackId, mediaId: c.mediaId, start: c.start, duration: c.duration,
        inPoint: c.inPoint || 0, volume: c.volume == null ? 1 : c.volume, muted: !!c.muted,
        filters: { ...defaultFilters, ...(c.filters || {}) },
        fadeIn: c.fadeIn || 0, fadeOut: c.fadeOut || 0,
        transitionIn: c.transitionIn && c.transitionIn.type !== 'none'
          ? { type: c.transitionIn.type, duration: c.transitionIn.duration || 0, fromClipId: c.transitionIn.fromClipId || null }
          : { type: 'none', duration: 0, fromClipId: null },
      })),
      media: s.media.map(m => ({ id: m.id, type: m.type, path: m.path, duration: m.duration, width: m.width, height: m.height })),
    };
  };

  handleExportProgress = (progress) => {
    if (!this._exporting) return;
    this.setState({ exportProgress: Math.round(progress.percent), exportPhase: progress.phase || '' });
  };

  startExport = async () => {
    // The "Start export" button is only hidden once exportRunning flips to
    // true, which happens *after* the save dialog below resolves - so
    // without this guard, a fast double-click (or double-tap on a laptop
    // trackpad) could fire this twice and open two concurrent native save
    // dialogs, or an outPath from one click overwriting approvedExportPath
    // for the other. This flag closes that window; it's cleared as soon as
    // the first call either bails out or actually kicks off an export.
    if (this._exporting) return;

    const total = this.totalDuration();
    if (total <= 0) { this.showToast('Nothing to export yet'); return; }
    if (total > 25200) { this.showToast('Trim below 7 hours to export'); return; }

    this._exporting = true;
    let outPath;
    try {
      outPath = await window.kutforgeAPI.chooseExportPath(this.state.exportFileName || this.state.projectName, this.state.exportFormat);
    } catch (e) {
      this._exporting = false;
      return;
    }
    if (!outPath) { this._exporting = false; return; } // person cancelled the save dialog

    this._exportOutPath = outPath;
    this.setState({ exportRunning: true, exportProgress: 0, exportPhase: 'Starting\u2026', exportDone: false, exportError: null });

    try {
      const edl = this.buildEdl();
      await window.kutforgeAPI.startExport(edl, outPath);
      this._exporting = false;
      this.setState({
        exportRunning: false, exportDone: true, exportProgress: 100,
        exportSavedNote: 'Saved to ' + outPath,
      });
    } catch (e) {
      this._exporting = false;
      const cancelled = e && /__cancelled__/.test(e.message || '');
      if (cancelled) {
        this.setState({ exportRunning: false, showExport: false });
      } else {
        this.setState({ exportRunning: false, exportError: (e && e.message) || 'Export failed.' });
      }
    }
  };

  cancelExport = () => { window.kutforgeAPI.cancelExport(); };

  revealExportedFile = () => { if (this._exportOutPath) window.kutforgeAPI.showItemInFolder(this._exportOutPath); };


  // ---------- misc ----------
  showToast = (msg) => {
    clearTimeout(this._toastTimer);
    this.setState({ toast: { msg } });
    this._toastTimer = setTimeout(() => this.setState({ toast: null }), 2800);
  };
  toggleHelp = () => this.setState(s => ({ showHelp: !s.showHelp }));
  closeHelp = () => this.setState({ showHelp: false });

  themes = {
    cream: { label: 'Default (Cream)', bg: '#f5ead8', panel: '#f9f4ed', panel2: '#ebddc5', text: '#201e1d', ink: '32,30,29', accent: '#c67139', accentText: '#f5ead8', brand: '#8c491a' },
    dark: { label: 'Dark', bg: '#201e1d', panel: '#2b2724', panel2: '#171513', text: '#f5ead8', ink: '245,234,216', accent: '#c67139', accentText: '#201e1d', brand: '#e2985f' },
    sage: { label: 'Sage', bg: '#eef1e6', panel: '#f6f8f0', panel2: '#dfe6cd', text: '#201e1d', ink: '32,30,29', accent: '#7a8a5e', accentText: '#f5ead8', brand: '#5f6f45' },
    blue: { label: 'Blue', bg: '#e9eef5', panel: '#f3f6fa', panel2: '#d7e2ee', text: '#201e1d', ink: '32,30,29', accent: '#4a6fa5', accentText: '#f5ead8', brand: '#33547a' },
    red: { label: 'Red', bg: '#f5e9e6', panel: '#faf1ef', panel2: '#ecd5d0', text: '#201e1d', ink: '32,30,29', accent: '#b5473a', accentText: '#f5ead8', brand: '#7a2e24' },
    purple: { label: 'Purple', bg: '#eee8f2', panel: '#f6f2f8', panel2: '#ddd0e6', text: '#201e1d', ink: '32,30,29', accent: '#7a5a9e', accentText: '#f5ead8', brand: '#513a6b' },
  };

  setTheme = (name) => this.setState({ theme: name, showThemeMenu: false });
  toggleThemeMenu = (e) => { e.stopPropagation(); this.setState(s => ({ showThemeMenu: !s.showThemeMenu })); };

  renderVals() {
    const s = this.state;
    const t = this.themes[s.theme] || this.themes.cream;
    const accent = t.accent, accentDark = t.brand, bg = t.accentText;
    const themeVarsStyle = '--bg:' + t.bg + ';--panel:' + t.panel + ';--panel2:' + t.panel2 + ';--text:' + t.text + ';--ink-rgb:' + t.ink + ';--accent:' + t.accent + ';--brand:' + t.brand + ';';
    const themeOptions = Object.keys(this.themes).map(key => {
      const th = this.themes[key];
      const active = s.theme === key;
      const isDefault = s.defaultTheme === key;
      return {
        key, label: th.label, swatchBg: th.bg, swatchAccent: th.accent, active,
        rowBg: active ? 'rgba(' + t.ink + ',0.08)' : 'transparent',
        onClick: () => this.setTheme(key),
        isDefault,
        defaultTitle: isDefault ? 'This is the default theme for new projects' : 'Set as default theme for new projects',
        onSetDefaultClick: (e) => { e.stopPropagation(); this.setDefaultTheme(key); },
      };
    });
    const total = this.totalDuration();

    const media = s.media.map(m => ({
      ...m,
      onDragStart: (e) => this.handleMediaDragStart(e, m),
      onClick: () => this.appendMediaAuto(m),
      durationLabel: this.fmtTime(m.duration),
      hasThumb: !!m.thumb,
      noThumb: !m.thumb,
      isAudio: m.type === 'audio',
      isVideo: m.type === 'video',
      placeholderBg: m.type === 'audio' ? '#e1eecc' : '#dcd3c4',
      placeholderFg: m.type === 'audio' ? '#56633f' : '#645c50',
    }));

    const aspectOptions = ['16:9', '9:16'].map(key => ({
      key, label: key, active: s.aspect === key,
      bg: s.aspect === key ? accent : 'transparent',
      color: s.aspect === key ? bg : t.text,
      onClick: () => this.setState({ aspect: key }),
    }));

    const previewW = s.aspect === '16:9' ? 960 : 540;
    const previewH = s.aspect === '16:9' ? 540 : 960;

    const selectedClipData = s.clips.find(c => c.id === s.selectedClipId) || null;
    let selectedClip = null;
    if (selectedClipData) {
      const m = s.media.find(mm => mm.id === selectedClipData.mediaId);
      const vol = selectedClipData.volume == null ? 1 : selectedClipData.volume;
      const defaultFilters = { brightness: 100, contrast: 100, saturation: 100, blur: 0, grayscale: 0, sepia: 0, vignette: 0 };
      const filt = { ...defaultFilters, ...(selectedClipData.filters || {}) };
      const fadeIn = selectedClipData.fadeIn || 0, fadeOut = selectedClipData.fadeOut || 0;
      const fadeMax = Math.max(0.1, Math.min(5, selectedClipData.duration / 2));

      const prevClip = this.findPrevClipOnTrack(selectedClipData);
      const activeTransition = this.activeTransitionFor(selectedClipData);
      const curTransitionType = activeTransition ? activeTransition.type : 'none';
      const transitionMax = prevClip ? Math.max(0.1, Math.min(this.MAX_TRANSITION_DURATION, prevClip.duration, selectedClipData.duration)) : 0;
      const transitionOptions = this.transitionTypes.map(opt => ({
        key: opt.key, label: opt.label, active: opt.key === curTransitionType,
        disabled: !prevClip,
        onClick: () => this.setClipTransitionType(opt.key),
      }));

      selectedClip = {
        name: m ? m.name : 'Missing media',
        muted: !!selectedClipData.muted,
        unmuted: !selectedClipData.muted,
        volumePercent: Math.round(vol * 100),
        volumeLabel: Math.round(vol * 100) + '%',
        onVolumeChange: this.handleVolumeChange,
        onToggleMuteMouseDown: (e) => { e.stopPropagation(); e.preventDefault(); this.toggleClipMute(selectedClipData); },
        isVisual: m && (m.type === 'video' || m.type === 'image'),
        showAdjustMenu: s.showAdjustMenu,
        toggleAdjustMenu: this.toggleAdjustMenu,

        brightness: filt.brightness, contrast: filt.contrast, saturation: filt.saturation,
        blur: filt.blur, grayscale: filt.grayscale, sepia: filt.sepia, vignette: filt.vignette,
        filtersActive: filt.brightness !== 100 || filt.contrast !== 100 || filt.saturation !== 100
          || filt.blur > 0 || filt.grayscale > 0 || filt.sepia > 0 || filt.vignette > 0,
        onBrightnessChange: (e) => this.handleFilterChange('brightness', parseFloat(e.target.value)),
        onContrastChange: (e) => this.handleFilterChange('contrast', parseFloat(e.target.value)),
        onSaturationChange: (e) => this.handleFilterChange('saturation', parseFloat(e.target.value)),
        onBlurChange: (e) => this.handleFilterChange('blur', parseFloat(e.target.value)),
        onGrayscaleChange: (e) => this.handleFilterChange('grayscale', parseFloat(e.target.value)),
        onSepiaChange: (e) => this.handleFilterChange('sepia', parseFloat(e.target.value)),
        onVignetteChange: (e) => this.handleFilterChange('vignette', parseFloat(e.target.value)),
        resetFilters: this.resetFilters,

        fadeInActive: fadeIn > 0, fadeOutActive: fadeOut > 0,
        fadeIn, fadeOut, fadeMax,
        fadeInLabel: fadeIn > 0 ? `${fadeIn.toFixed(2)}s` : 'Off',
        fadeOutLabel: fadeOut > 0 ? `${fadeOut.toFixed(2)}s` : 'Off',
        onFadeInChange: this.handleFadeInChange,
        onFadeOutChange: this.handleFadeOutChange,

        transitionAvailable: !!prevClip,
        transitionUnavailableHint: 'Select a clip with another clip right before it on the same track.',
        transitionOptions,
        transitionActive: curTransitionType !== 'none',
        transitionDuration: activeTransition ? activeTransition.duration : 0,
        transitionDurationLabel: activeTransition ? activeTransition.duration.toFixed(2) + 's' : '',
        transitionMax,
        onTransitionDurationChange: this.changeTransitionDuration,
      };
    }

    // Docked side panels (Filters on the left of the preview, Fade +
    // Transition on the right) only make sense once there's a visual clip
    // selected to adjust - same gating the old popover used.
    const showSidePanels = !!(s.showAdjustMenu && selectedClip && selectedClip.isVisual);

    const HANDLE_W = 9;
    // All clips - video or audio - use the same theme-derived color, built
    // directly in HSL from the theme's own brand hue rather than mixed as
    // RGB into the lane (RGB-mixing dilutes the tint unpredictably
    // depending on the lane's own saturation, and a separate rotated hue
    // for audio ended up looking arbitrary rather than "part of the theme").
    const brandHsl = this.rgbToHsl(this.hexToRgb(t.brand));
    const CLIP_SAT = 32;
    const clipHue = brandHsl.h;
    const clipsByTrack = this.getSortedClipsByTrack();
    const mediaById = this.getMediaById();
    const tracksVM = s.tracks.map(track => {
      const clipsRaw = clipsByTrack.get(track.id) || [];
      const laneL = this.rgbToHsl(this.hexToRgb(t.panel)).l;
      // Push lightness toward the midtones from wherever the lane already
      // sits - away from white on a light theme, away from black on a dark
      // one - so the clip reads as distinct from its lane either way.
      const lFor = (delta) => laneL > 50 ? Math.max(20, laneL - delta) : Math.min(80, laneL + delta);
      const clipBorderRgb = this.hslToRgb(clipHue, CLIP_SAT + 15, lFor(38));
      const clipBorder = `rgb(${clipBorderRgb.r},${clipBorderRgb.g},${clipBorderRgb.b})`;
      const clips = clipsRaw.map(c => {
        const m = mediaById[c.mediaId];
        const left = c.start * s.zoom;
        const width = Math.max(6, c.duration * s.zoom);
        const selected = c.id === s.selectedClipId;
        const bg2Rgb = this.hslToRgb(clipHue, CLIP_SAT, lFor(selected ? 16 : 8));
        const bg2 = `rgb(${bg2Rgb.r},${bg2Rgb.g},${bg2Rgb.b})`;
        const hasTransition = !!this.activeTransitionFor(c);
        return {
          id: c.id, left, width,
          rightHandleLeft: left + width - HANDLE_W,
          muteIconLeft: Math.max(left + width - 24, left + 4),
          bg: bg2,
          borderColor: selected ? accent : clipBorder,
          textColor: t.text,
          ringShadow: selected ? '0 0 0 2px rgba(198,113,57,0.35)' : 'none',
          name: m ? m.name : 'Missing media',
          muted: !!c.muted,
          hasTransition,
          onMouseDownMove: (e) => this.handleClipMouseDown(e, c, 'move'),
          onMouseDownLeft: (e) => this.handleClipMouseDown(e, c, 'trim-left'),
          onMouseDownRight: (e) => this.handleClipMouseDown(e, c, 'trim-right'),
          onToggleMuteMouseDown: (e) => { e.stopPropagation(); e.preventDefault(); this.toggleClipMute(c); },
          onContextMenu: (e) => this.openClipMenu(e, c),
        };
      });
      return {
        ...track,
        clips,
        hasClips: clips.length > 0,
        laneBg: t.panel,
        headerBg: s.trackColorTint ? this.trackTint(t.panel2, track, 0.14) : t.panel2,
        muteIconColor: track.muted ? accentDark : 'rgba(' + t.ink + ',0.55)',
        unmuted: !track.muted,
        setRef: (el) => { this.trackLaneEls[track.id] = el; },
        onDrop: (e) => this.handleDropOnTrack(e, track),
        onDragOver: (e) => e.preventDefault(),
        onLaneMouseDown: () => this.setState({ selectedClipId: null }),
        onCloseGaps: () => this.closeGaps(track.id),
        onToggleTrackMute: () => { this.pushHistory(); this.setState({ tracks: this.state.tracks.map(t => t.id === track.id ? { ...t, muted: !t.muted } : t) }); },
        onRemoveTrack: (e) => { e.stopPropagation(); this.removeTrack(track.id); },
      };
    });

    const videoTrackCount = s.tracks.filter(t => t.type === 'video').length;
    const audioTrackCount = s.tracks.filter(t => t.type === 'audio').length;
    const canAddVideoTrack = videoTrackCount < this.MAX_TRACKS_PER_TYPE;
    const canAddAudioTrack = audioTrackCount < this.MAX_TRACKS_PER_TYPE;

    // Never narrower than the actual visible width - the new zoom floor
    // deliberately allows going a bit past exact "fit" (so users aren't
    // stuck right at the edge), and when it does, content alone can end up
    // narrower than the viewport, leaving a strip of the outer container's
    // background exposed past the last lane/tick instead of the lane color
    // continuing to fill the view.
    const clientWidth = this.timelineScrollEl ? this.timelineScrollEl.clientWidth : 900;
    const timelineWidth = Math.max(900, clientWidth, total * s.zoom + 300);
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
    let step = steps[steps.length - 1];
    for (const st of steps) { if (st * s.zoom >= 80) { step = st; break; } }
    const tickMax = Math.max(total, 20) + step;
    const ticks = [];
    for (let t = 0; t <= tickMax; t += step) ticks.push({ t, x: t * s.zoom, label: this.fmtTime(t) });

    const mediaClipsForEls = s.clips.map(c => {
      const m = mediaById[c.mediaId];
      if (!m || (m.type !== 'video' && m.type !== 'audio')) return null;
      return {
        id: c.id, url: m.url, isVideo: m.type === 'video', isAudio: m.type === 'audio',
        previewMuted: false,
        setRef: (el) => { if (el) this.mediaElsByClip[c.id] = el; else delete this.mediaElsByClip[c.id]; },
      };
    }).filter(Boolean);

    const resolutionOptions = ['720p', '1080p', '1440p', '4K'].map(r => ({
      key: r, label: r, bg: s.exportResolution === r ? accent : 'transparent', color: s.exportResolution === r ? bg : t.text,
      onClick: () => this.setState({ exportResolution: r }),
    }));
    const formatOptions = [{ key: 'mp4', label: 'MP4' }, { key: 'webm', label: 'WebM' }].map(o => ({
      ...o, bg: s.exportFormat === o.key ? accent : 'transparent', color: s.exportFormat === o.key ? bg : t.text,
      onClick: () => this.setState({ exportFormat: o.key }),
    }));
    const fpsOptions = [24, 30, 60, 120].map(f => ({
      key: f, label: f + ' fps', bg: s.exportFps === f ? accent : 'transparent', color: s.exportFps === f ? bg : t.text,
      onClick: () => this.setState({ exportFps: f }),
    }));
    const speedOptions = [
      { key: 'fast', label: 'Fast' },
      { key: 'balanced', label: 'Balanced' },
      { key: 'quality', label: 'Best quality' },
    ].map(o => ({
      ...o, bg: s.exportSpeed === o.key ? accent : 'transparent', color: s.exportSpeed === o.key ? bg : t.text,
      onClick: () => this.setState({ exportSpeed: o.key }),
    }));

    const dims = this.getExportDims(s.exportResolution, s.aspect);
    const bitrate = this.getBitrate(s.exportResolution);
    const sizeLabel = this.fmtBytes((bitrate / 8) * total);
    const overLimit = total > 25200;
    const silentExport = total > 0 && !this.projectHasAudibleContent();

    let contextMenuItems = [];
    if (s.contextMenu) {
      const clip = s.clips.find(c => c.id === s.contextMenu.clipId);
      if (clip) {
        const clipMedia = s.media.find(m => m.id === clip.mediaId);
        const clipTrack = s.tracks.find(tr => tr.id === clip.trackId);
        const playheadInside = this.currentTime > clip.start + 0.03 && this.currentTime < clip.start + clip.duration - 0.03;
        const normal = t.text, danger = t.brand;
        contextMenuItems.push({ key: 'split', label: 'Split at playhead', disabled: !playheadInside, color: normal, onClick: () => this.splitClipAt(clip.id) });
        if (clipMedia && clipMedia.type === 'video' && clipTrack && clipTrack.type === 'video') {
          contextMenuItems.push({ key: 'detach', label: 'Detach audio', disabled: false, color: normal, onClick: () => this.detachAudio(clip.id) });
        }
        contextMenuItems.push({ key: 'dup', label: 'Duplicate', disabled: false, color: normal, onClick: () => this.duplicateClip(clip.id) });
        contextMenuItems.push({ key: 'mute', label: clip.muted ? 'Unmute' : 'Mute', disabled: false, color: normal, onClick: () => this.toggleMuteById(clip.id) });
        contextMenuItems.push({ key: 'del', label: 'Delete', disabled: false, color: danger, onClick: () => this.deleteClipById(clip.id, false) });
        contextMenuItems.push({ key: 'rdel', label: 'Ripple delete', disabled: false, color: danger, onClick: () => this.deleteClipById(clip.id, true) });
      }
    }

    const shortcuts = [
      { label: 'Right-click a clip', key: 'Split / Detach audio / Duplicate / \u2026' },
      { label: 'Play / Pause', key: 'Space' },
      { label: 'Split at playhead', key: 'S' },
      { label: 'Delete selected clip', key: 'Delete' },
      { label: 'Ripple delete (closes gap)', key: 'Shift+Delete' },
      { label: 'Step one frame', key: '← / →' },
      { label: 'Jump 1 second', key: 'Shift+← / →' },
      { label: 'Jump 5 seconds', key: 'Ctrl+← / →' },
      { label: 'Go to start / end', key: 'Home / End' },
      { label: 'Zoom timeline', key: '+ / - or Ctrl+scroll' },
      { label: 'Scroll through tracks', key: 'Mouse wheel' },
      { label: 'Undo / Redo', key: 'Ctrl+Z / Ctrl+Shift+Z' },
      { label: 'Import media', key: 'Ctrl+I' },
      { label: 'Export', key: 'Ctrl+E' },
      { label: 'New / Open project', key: 'Ctrl+N / Ctrl+O' },
      { label: 'Save project as', key: 'Ctrl+Shift+S' },
      { label: 'Filters, fades, transitions (select a clip first)', key: 'Adjustments button' },
      { label: 'Add/remove video or audio track (max 10 each)', key: '+ / \u00d7 in track list' },
      { label: 'Toggle this panel', key: '?' },
    ];

    return {
      projectName: s.projectName, handleNameChange: this.handleNameChange, handleNameBlur: this.handleNameBlur,
      undo: this.undo, redo: this.redo, undoDisabled: !s.canUndo, redoDisabled: !s.canRedo,
      aspectOptions,
      themeVarsStyle, showThemeMenu: s.showThemeMenu, toggleThemeMenu: this.toggleThemeMenu, themeOptions,
      trackColorTint: s.trackColorTint, toggleTrackColorTint: this.toggleTrackColorTint,
      toggleHelp: this.toggleHelp,
      triggerFileInput: this.triggerFileInput,
      openExport: this.openExport,
      media, noMedia: media.length === 0,
      handleSidebarDrop: this.handleSidebarDrop, handleSidebarDragOver: this.handleSidebarDragOver,
      previewW, previewH, setPreviewCanvas: this.setPreviewCanvas,
      showEmptyStageHint: total === 0,
      isPlaying: s.isPlaying, isPaused: !s.isPlaying,
      togglePlay: this.togglePlay, stepPrev: this.stepPrev, stepNext: this.stepNext,
      skipBack1: this.skipBack1, skipFwd1: this.skipFwd1, skipBack5: this.skipBack5, skipFwd5: this.skipFwd5,
      timeDisplay: this.fmtTime(this.currentTime) + ' / ' + this.fmtTime(total),
      doSplit: this.doSplit, doDeleteNormal: this.doDeleteNormal, doDeleteRipple: this.doDeleteRipple,
      noSelection: !s.selectedClipId, hasSelection: !!s.selectedClipId, selectedClip, showSidePanels,
      videoTrackCount, audioTrackCount, canAddVideoTrack, canAddAudioTrack,
      addVideoTrack: this.addVideoTrack, addAudioTrack: this.addAudioTrack,
      videoTrackCountLabel: `${videoTrackCount}/${this.MAX_TRACKS_PER_TYPE}`,
      audioTrackCountLabel: `${audioTrackCount}/${this.MAX_TRACKS_PER_TYPE}`,
      zoomPercentLabel: Math.round(s.zoom) + 'px/s', zoomIn: this.zoomIn, zoomOut: this.zoomOut, zoomToFit: this.zoomToFit,
      tracksVM, timelineWidth, ticks,
      playheadX: this.currentTime * s.zoom,
      setTimelineScroll: this.setTimelineScroll, setTimelineContent: this.setTimelineContent, handleRulerMouseDown: this.handleRulerMouseDown,
      setTracksArea: this.setTracksArea, setRulerEl: this.setRulerEl,
      showExport: s.showExport, showExportForm: !s.exportRunning && !s.exportDone && !s.exportError,
      exportRunning: s.exportRunning, exportDone: s.exportDone, exportError: s.exportError, exportSavedNote: s.exportSavedNote,
      resolutionOptions, formatOptions, fpsOptions, speedOptions,
      speedHint: s.exportSpeed === 'fast' ? 'Quickest encode, same file size, slightly softer detail.'
        : s.exportSpeed === 'quality' ? 'Slower encode, same file size, crisper detail \u2014 worth it for footage with lots of motion or fine texture.'
        : 'Good middle ground for most exports.',
      resourceCapEnabled: s.resourceCapEnabled, toggleResourceCap: this.toggleResourceCap,
      exportFileName: s.exportFileName, handleExportFileNameChange: this.handleExportFileNameChange, handleExportFileNameBlur: this.handleExportFileNameBlur,
      durationLabel: this.fmtTime(total), sizeLabel, overLimit, silentExport,
      startExportDisabled: overLimit || total === 0,
      exportProgress: Math.round(s.exportProgress),
      elapsedLabel: this.fmtTime(this.currentTime), remainingLabel: this.fmtTime(Math.max(0, total - this.currentTime)),
      exportPhase: s.exportPhase,
      runningStatusLabel: (s.exportPhase || 'Working\u2026') + ' \u00b7 ' + Math.round(s.exportProgress) + '%',
      startExport: this.startExport, cancelExport: this.cancelExport, closeExportDialog: this.closeExportDialog, closeExportIfNotRunning: this.closeExportIfNotRunning,
      revealExportedFile: this.revealExportedFile,
      stopPropagation: this.stopPropagation,
      showHelp: s.showHelp, closeHelp: this.closeHelp, shortcuts, appVersion: s.appVersion,
      toast: s.toast, toastMsg: s.toast ? s.toast.msg : '',
      mediaClipsForEls,
      showContextMenu: !!s.contextMenu, contextMenuX: s.contextMenu ? s.contextMenu.x : 0, contextMenuY: s.contextMenu ? s.contextMenu.y : 0,
      contextMenuItems,
    };
  }

  // ---------- rendering (rebuilt as real markup, consuming renderVals()) ----------
  renderHeader(vm) {
    return html`
      <div style="flex:none;display:flex;align-items:center;gap:14px;padding:10px 16px;background:var(--panel2);border-bottom:1px solid rgba(var(--ink-rgb),0.14);">
        <div style="font-family:'Caprasimo',system-ui,sans-serif;font-size:19px;color:var(--brand);">Kutforge</div>
        <input value=${vm.projectName} onChange=${vm.handleNameChange} onBlur=${vm.handleNameBlur} maxLength="100" style="background:var(--panel);border:1px solid rgba(var(--ink-rgb),0.18);font-family:'Caprasimo',system-ui,sans-serif;font-size:15px;color:var(--text);outline:none;max-width:220px;padding:6px 10px;border-radius:8px;" />
        <div style="display:flex;gap:6px;">
          <button onClick=${vm.undo} disabled=${vm.undoDisabled} title="Undo (Ctrl+Z)" style="width:32px;height:32px;border-radius:999px;border:1px solid rgba(var(--ink-rgb),0.16);background:transparent;display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--text);">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7L3 11l4 4"></path><path d="M3 11h12a6 6 0 0 1 0 12h-2"></path></svg>
          </button>
          <button onClick=${vm.redo} disabled=${vm.redoDisabled} title="Redo (Ctrl+Shift+Z)" style="width:32px;height:32px;border-radius:999px;border:1px solid rgba(var(--ink-rgb),0.16);background:transparent;display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--text);">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 7l4 4-4 4"></path><path d="M21 11H9a6 6 0 0 0 0 12h2"></path></svg>
          </button>
        </div>

        <div style="display:flex;border:1px solid rgba(var(--ink-rgb),0.16);border-radius:999px;overflow:hidden;">
          ${vm.aspectOptions.map(opt => html`<button key=${opt.key} onClick=${opt.onClick} style="padding:6px 12px;font-size:12px;border:none;cursor:pointer;background:${opt.bg};color:${opt.color};">${opt.label}</button>`)}
        </div>

        <div style="flex:1;"></div>
        <div style="position:relative;">
          <button onClick=${vm.toggleThemeMenu} title="Theme" style="display:flex;align-items:center;gap:6px;padding:7px 14px;font-size:13px;border-radius:999px;border:1px solid rgba(var(--ink-rgb),0.16);background:transparent;cursor:pointer;color:var(--text);">
            <svg viewBox="0 0 24 24" width="15" height="15"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"></circle><path d="M12 3a9 9 0 000 18V3z" fill="currentColor"></path></svg>
            Theme
          </button>
          ${vm.showThemeMenu ? html`
            <div onMouseDown=${vm.stopPropagation} style="position:absolute;top:calc(100% + 8px);right:0;background:var(--panel);border-radius:14px;box-shadow:0 8px 24px rgba(46,43,37,0.28);padding:6px;min-width:210px;max-height:300px;overflow-y:auto;z-index:60;display:flex;flex-direction:column;gap:2px;">
              ${vm.themeOptions.map(opt => html`
                <div key=${opt.key} style="display:flex;align-items:center;gap:2px;border-radius:9px;background:${opt.rowBg};">
                  <button onClick=${opt.onClick} style="flex:1;display:flex;align-items:center;gap:8px;padding:8px 6px 8px 10px;border:none;background:transparent;cursor:pointer;color:var(--text);font-size:13px;min-width:0;">
                    <span style="width:16px;height:16px;border-radius:999px;background:${opt.swatchBg};border:2px solid ${opt.swatchAccent};flex:none;"></span>
                    <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${opt.label}</span>
                    ${opt.active ? html`<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-left:auto;flex:none;"><path d="M4 12l5 5L20 6"></path></svg>` : null}
                  </button>
                  <button onClick=${opt.onSetDefaultClick} title=${opt.defaultTitle} style="flex:none;width:26px;height:26px;margin-right:2px;border:none;background:transparent;cursor:pointer;display:flex;align-items:center;justify-content:center;color:${opt.isDefault ? 'var(--accent)' : 'rgba(var(--ink-rgb),0.35)'};">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill=${opt.isDefault ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="2"><path d="M12 2l2.9 6.26L21.8 9l-5.4 4.73L17.8 21 12 17.3 6.2 21l1.4-7.27L2.2 9l6.9-.74L12 2z"></path></svg>
                  </button>
                </div>
              `)}
              <div style="height:1px;background:rgba(var(--ink-rgb),0.12);margin:4px 6px;"></div>
              <button onClick=${vm.toggleTrackColorTint} style="display:flex;align-items:center;gap:8px;padding:8px 10px;border:none;border-radius:9px;background:transparent;cursor:pointer;color:var(--text);font-size:12.5px;text-align:left;">
                <span style="flex:none;width:30px;height:17px;border-radius:999px;background:${vm.trackColorTint ? 'var(--accent)' : 'rgba(var(--ink-rgb),0.2)'};position:relative;transition:background 0.15s;">
                  <span style="position:absolute;top:2px;left:${vm.trackColorTint ? '15px' : '2px'};width:13px;height:13px;border-radius:999px;background:#fff;transition:left 0.15s;"></span>
                </span>
                <span>Color-code tracks in the track list</span>
              </button>
            </div>
          ` : null}
        </div>
        <button onClick=${vm.toggleHelp} title="Keyboard shortcuts (?)" style="padding:7px 14px;font-size:13px;border-radius:999px;border:1px solid rgba(var(--ink-rgb),0.16);background:transparent;cursor:pointer;color:var(--text);">Shortcuts</button>
        <button onClick=${vm.triggerFileInput} style="display:flex;align-items:center;gap:6px;padding:7px 16px;font-size:13px;border-radius:999px;border:1px solid rgba(var(--ink-rgb),0.16);background:transparent;cursor:pointer;color:var(--text);">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4"></path><path d="M6 9l6-6 6 6"></path><path d="M4 20h16"></path></svg>
          Import media
        </button>
        <button onClick=${vm.openExport} style="padding:8px 18px;font-size:13px;font-family:'Caprasimo',system-ui,sans-serif;border-radius:999px;border:none;background:var(--accent);color:#f5ead8;cursor:pointer;">Export</button>
      </div>
    `;
  }

  renderSidebar(vm) {
    return html`
      <div onDrop=${vm.handleSidebarDrop} onDragOver=${vm.handleSidebarDragOver} style="width:250px;flex:none;background:var(--panel2);border-right:1px solid rgba(var(--ink-rgb),0.14);padding:14px;overflow-y:auto;display:flex;flex-direction:column;gap:10px;">
        <div style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:rgba(var(--ink-rgb),0.55);">Media</div>
        ${vm.noMedia ? html`
          <div style="border:2px dashed rgba(var(--ink-rgb),0.22);border-radius:16px;padding:22px 14px;text-align:center;font-size:13px;color:rgba(var(--ink-rgb),0.6);">
            Drop video, audio or image files here, or use Import media above.
          </div>
        ` : null}
        <button onClick=${vm.triggerFileInput} style="display:flex;align-items:center;justify-content:center;gap:6px;padding:9px 16px;font-size:13px;border-radius:999px;border:1px solid rgba(var(--ink-rgb),0.16);background:transparent;cursor:pointer;color:var(--text);">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4"></path><path d="M6 9l6-6 6 6"></path><path d="M4 20h16"></path></svg>
          Import media
        </button>
        ${vm.media.map(m => html`
          <div key=${m.id} draggable="true" onDragStart=${m.onDragStart} onClick=${m.onClick} title="Click to add to timeline, or drag onto a track" style="border-radius:14px;background:var(--panel);padding:8px;cursor:grab;box-shadow:0 1px 2px rgba(46,43,37,0.14);">
            ${m.hasThumb ? html`<div style="width:100%;height:84px;border-radius:10px;background-image:url(${m.thumb});background-size:cover;background-position:center;background-color:#2e2b25;"></div>` : null}
            ${m.noThumb ? html`
              <div style="width:100%;height:84px;border-radius:10px;background:${m.placeholderBg};display:flex;align-items:center;justify-content:center;color:${m.placeholderFg};">
                ${m.isAudio ? html`<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2"><circle cx="7" cy="17" r="3"></circle><path d="M10 17V5l9-2v12"></path><circle cx="16" cy="15" r="3"></circle></svg>` : null}
                ${m.isVideo ? html`<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="6" width="14" height="12" rx="2"></rect><path d="M17 10l4-3v10l-4-3"></path></svg>` : null}
              </div>
            ` : null}
            <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px;">
              <span style="font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:140px;">${m.name}</span>
              <span style="font-size:10px;color:rgba(var(--ink-rgb),0.55);">${m.durationLabel}</span>
            </div>
          </div>
        `)}
      </div>
    `;
  }

  renderFiltersPanel(vm) {
    const sc = vm.selectedClip;
    return html`
      <div onMouseDown=${vm.stopPropagation} style="width:232px;flex:none;background:var(--panel);border-right:1px solid rgba(var(--ink-rgb),0.14);overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;">
        <div style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:rgba(var(--ink-rgb),0.55);">Filters</div>
        <div>
          <div style="display:flex;justify-content:space-between;font-size:11px;color:rgba(var(--ink-rgb),0.6);margin-bottom:3px;"><span>Brightness</span><span>${Math.round(sc.brightness)}%</span></div>
          <input type="range" min="0" max="200" value=${sc.brightness} onInput=${sc.onBrightnessChange} style="width:100%;" />
        </div>
        <div>
          <div style="display:flex;justify-content:space-between;font-size:11px;color:rgba(var(--ink-rgb),0.6);margin-bottom:3px;"><span>Contrast</span><span>${Math.round(sc.contrast)}%</span></div>
          <input type="range" min="0" max="200" value=${sc.contrast} onInput=${sc.onContrastChange} style="width:100%;" />
        </div>
        <div>
          <div style="display:flex;justify-content:space-between;font-size:11px;color:rgba(var(--ink-rgb),0.6);margin-bottom:3px;"><span>Saturation</span><span>${Math.round(sc.saturation)}%</span></div>
          <input type="range" min="0" max="200" value=${sc.saturation} onInput=${sc.onSaturationChange} style="width:100%;" />
        </div>
        <div style="height:1px;background:rgba(var(--ink-rgb),0.12);"></div>
        <div>
          <div style="display:flex;justify-content:space-between;font-size:11px;color:rgba(var(--ink-rgb),0.6);margin-bottom:3px;"><span>Blur</span><span>${Math.round(sc.blur)}</span></div>
          <input type="range" min="0" max="20" value=${sc.blur} onInput=${sc.onBlurChange} style="width:100%;" />
        </div>
        <div>
          <div style="display:flex;justify-content:space-between;font-size:11px;color:rgba(var(--ink-rgb),0.6);margin-bottom:3px;"><span>Grayscale</span><span>${Math.round(sc.grayscale)}%</span></div>
          <input type="range" min="0" max="100" value=${sc.grayscale} onInput=${sc.onGrayscaleChange} style="width:100%;" />
        </div>
        <div>
          <div style="display:flex;justify-content:space-between;font-size:11px;color:rgba(var(--ink-rgb),0.6);margin-bottom:3px;"><span>Sepia</span><span>${Math.round(sc.sepia)}%</span></div>
          <input type="range" min="0" max="100" value=${sc.sepia} onInput=${sc.onSepiaChange} style="width:100%;" />
        </div>
        <div>
          <div style="display:flex;justify-content:space-between;font-size:11px;color:rgba(var(--ink-rgb),0.6);margin-bottom:3px;"><span>Vignette</span><span>${Math.round(sc.vignette)}%</span></div>
          <input type="range" min="0" max="100" value=${sc.vignette} onInput=${sc.onVignetteChange} style="width:100%;" />
        </div>
        <button onClick=${sc.resetFilters} disabled=${!sc.filtersActive} style="align-self:flex-start;padding:4px 10px;font-size:11px;border-radius:999px;border:1px solid rgba(var(--ink-rgb),0.16);background:transparent;cursor:pointer;color:var(--text);">Reset filters</button>
      </div>
    `;
  }

  renderFadePanel(vm) {
    const sc = vm.selectedClip;
    return html`
      <div onMouseDown=${vm.stopPropagation} style="width:232px;flex:none;background:var(--panel);border-left:1px solid rgba(var(--ink-rgb),0.14);overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:12px;">
        <div style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:rgba(var(--ink-rgb),0.55);">Fade</div>
        <div>
          <div style="display:flex;justify-content:space-between;font-size:11px;color:rgba(var(--ink-rgb),0.6);margin-bottom:3px;"><span>Fade in</span><span>${sc.fadeInLabel}</span></div>
          <input type="range" min="0" max=${sc.fadeMax} step="0.05" value=${sc.fadeIn} onInput=${sc.onFadeInChange} style="width:100%;" />
        </div>
        <div>
          <div style="display:flex;justify-content:space-between;font-size:11px;color:rgba(var(--ink-rgb),0.6);margin-bottom:3px;"><span>Fade out</span><span>${sc.fadeOutLabel}</span></div>
          <input type="range" min="0" max=${sc.fadeMax} step="0.05" value=${sc.fadeOut} onInput=${sc.onFadeOutChange} style="width:100%;" />
        </div>
        <div style="font-size:10.5px;color:rgba(var(--ink-rgb),0.5);line-height:1.5;">Fades to the background color at the start/end of this clip.</div>

        <div style="height:1px;background:rgba(var(--ink-rgb),0.12);margin:2px 0;"></div>

        <div style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:rgba(var(--ink-rgb),0.55);">Transition</div>
        ${!sc.transitionAvailable ? html`
          <div style="font-size:11.5px;color:rgba(var(--ink-rgb),0.6);line-height:1.5;">${sc.transitionUnavailableHint}</div>
        ` : html`
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
            ${sc.transitionOptions.map(opt => html`
              <button key=${opt.key} onClick=${opt.onClick} style="padding:7px 6px;font-size:11px;font-weight:600;border-radius:10px;border:1px solid rgba(var(--ink-rgb),0.16);cursor:pointer;background:${opt.active ? 'var(--accent)' : 'transparent'};color:${opt.active ? '#f5ead8' : 'var(--text)'};">${opt.label}</button>
            `)}
          </div>
          ${sc.transitionActive ? html`
            <div>
              <div style="display:flex;justify-content:space-between;font-size:11px;color:rgba(var(--ink-rgb),0.6);margin-bottom:3px;"><span>Duration</span><span>${sc.transitionDurationLabel}</span></div>
              <input type="range" min="0.1" max=${sc.transitionMax} step="0.05" value=${sc.transitionDuration} onInput=${sc.onTransitionDurationChange} style="width:100%;" />
            </div>
            <div style="font-size:10.5px;color:rgba(var(--ink-rgb),0.5);line-height:1.5;">Blends with the clip right before this one \u2014 they'll overlap by the duration above.</div>
          ` : null}
        `}
      </div>
    `;
  }

  renderStage(vm) {
    return html`
      <div style="flex:1;display:flex;flex-direction:column;min-width:0;">
        <div style="flex:1;display:flex;flex-direction:row;background:#2e2b25;position:relative;min-height:0;">
          ${vm.showSidePanels ? this.renderFiltersPanel(vm) : null}
          <div style="flex:1;display:flex;align-items:center;justify-content:center;position:relative;min-width:0;">
            <canvas ref=${vm.setPreviewCanvas} width=${vm.previewW} height=${vm.previewH} style="max-width:92%;max-height:92%;width:auto;height:auto;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,0.35);"></canvas>
            ${vm.showEmptyStageHint ? html`<div style="position:absolute;color:rgba(245,234,216,0.7);font-size:14px;pointer-events:none;">Import media and add it to a track to start editing</div>` : null}
          </div>
          ${vm.showSidePanels ? this.renderFadePanel(vm) : null}
        </div>

        <div style="flex:none;display:flex;align-items:center;justify-content:center;gap:8px;padding:10px 16px;background:var(--panel);border-top:1px solid rgba(var(--ink-rgb),0.1);">
          <button onClick=${vm.skipBack5} title="Back 5 seconds (Ctrl+Left)" style="min-width:40px;height:30px;padding:0 10px;border-radius:999px;border:1px solid rgba(var(--ink-rgb),0.16);background:transparent;display:flex;align-items:center;justify-content:center;gap:2px;cursor:pointer;color:var(--text);font-size:11px;font-weight:600;">
            <svg viewBox="0 0 24 24" width="13" height="13"><path d="M11 5l-7 7 7 7V5z" fill="currentColor"></path><path d="M20 5l-7 7 7 7V5z" fill="currentColor"></path></svg>5s
          </button>
          <button onClick=${vm.skipBack1} title="Back 1 second (Shift+Left)" style="min-width:40px;height:30px;padding:0 10px;border-radius:999px;border:1px solid rgba(var(--ink-rgb),0.16);background:transparent;display:flex;align-items:center;justify-content:center;gap:2px;cursor:pointer;color:var(--text);font-size:11px;font-weight:600;">
            <svg viewBox="0 0 24 24" width="13" height="13"><path d="M16 5l-7 7 7 7V5z" fill="currentColor"></path></svg>1s
          </button>
          <button onClick=${vm.stepPrev} title="Previous frame (Left arrow)" style="width:34px;height:34px;border-radius:999px;border:1px solid rgba(var(--ink-rgb),0.16);background:transparent;display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--text);">
            <svg viewBox="0 0 24 24" width="16" height="16"><rect x="5" y="5" width="2" height="14" fill="currentColor"></rect><path d="M19 5l-10 7 10 7V5z" fill="currentColor"></path></svg>
          </button>
          <button onClick=${vm.togglePlay} title="Play / Pause (Space)" style="width:44px;height:44px;border-radius:999px;border:none;background:var(--accent);color:#f5ead8;display:flex;align-items:center;justify-content:center;cursor:pointer;">
            ${vm.isPlaying ? html`<svg viewBox="0 0 24 24" width="18" height="18"><rect x="6" y="5" width="4" height="14" fill="currentColor"></rect><rect x="14" y="5" width="4" height="14" fill="currentColor"></rect></svg>` : null}
            ${vm.isPaused ? html`<svg viewBox="0 0 24 24" width="18" height="18"><path d="M7 5l12 7-12 7V5z" fill="currentColor"></path></svg>` : null}
          </button>
          <button onClick=${vm.stepNext} title="Next frame (Right arrow)" style="width:34px;height:34px;border-radius:999px;border:1px solid rgba(var(--ink-rgb),0.16);background:transparent;display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--text);">
            <svg viewBox="0 0 24 24" width="16" height="16"><rect x="17" y="5" width="2" height="14" fill="currentColor"></rect><path d="M5 5l10 7-10 7V5z" fill="currentColor"></path></svg>
          </button>
          <button onClick=${vm.skipFwd1} title="Forward 1 second (Shift+Right)" style="min-width:40px;height:30px;padding:0 10px;border-radius:999px;border:1px solid rgba(var(--ink-rgb),0.16);background:transparent;display:flex;align-items:center;justify-content:center;gap:2px;cursor:pointer;color:var(--text);font-size:11px;font-weight:600;">
            1s<svg viewBox="0 0 24 24" width="13" height="13"><path d="M8 5l7 7-7 7V5z" fill="currentColor"></path></svg>
          </button>
          <button onClick=${vm.skipFwd5} title="Forward 5 seconds (Ctrl+Right)" style="min-width:40px;height:30px;padding:0 10px;border-radius:999px;border:1px solid rgba(var(--ink-rgb),0.16);background:transparent;display:flex;align-items:center;justify-content:center;gap:2px;cursor:pointer;color:var(--text);font-size:11px;font-weight:600;">
            5s<svg viewBox="0 0 24 24" width="13" height="13"><path d="M4 5l7 7-7 7V5z" fill="currentColor"></path><path d="M13 5l7 7-7 7V5z" fill="currentColor"></path></svg>
          </button>
          <div style="font-size:12px;font-variant-numeric:tabular-nums;color:rgba(var(--ink-rgb),0.7);min-width:120px;margin-left:8px;">${vm.timeDisplay}</div>
        </div>

        ${this.renderTimelinePanel(vm)}
      </div>
    `;
  }

  renderTimelinePanel(vm) {
    return html`
      <div style="flex:none;height:262px;display:flex;flex-direction:column;background:var(--panel);border-top:1px solid rgba(var(--ink-rgb),0.14);">
        <div style="flex:none;height:44px;display:flex;align-items:center;gap:8px;padding:0 12px;border-bottom:1px solid rgba(var(--ink-rgb),0.1);overflow-x:auto;overflow-y:hidden;">
          <button onClick=${vm.doSplit} title="Split at playhead (S)" style="display:flex;align-items:center;gap:6px;padding:6px 12px;font-size:12px;border-radius:999px;border:1px solid rgba(var(--ink-rgb),0.16);background:transparent;cursor:pointer;color:var(--text);">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><line x1="8.5" y1="8" x2="19" y2="18"></line><line x1="8.5" y1="16" x2="19" y2="6"></line></svg>
            Split
          </button>
          <button onClick=${vm.doDeleteNormal} disabled=${vm.noSelection} title="Delete selected (Del)" style="display:flex;align-items:center;gap:6px;padding:6px 12px;font-size:12px;border-radius:999px;border:1px solid rgba(var(--ink-rgb),0.16);background:transparent;cursor:pointer;color:var(--text);">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16"></path><path d="M9 7V4h6v3"></path><path d="M6 7l1 13h10l1-13"></path></svg>
            Delete
          </button>
          <button onClick=${vm.doDeleteRipple} disabled=${vm.noSelection} title="Ripple delete, closes the gap (Shift+Del)" style="display:flex;align-items:center;gap:6px;padding:6px 12px;font-size:12px;border-radius:999px;border:1px solid rgba(var(--ink-rgb),0.16);background:transparent;cursor:pointer;color:var(--text);">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16"></path><path d="M9 7V4h6v3"></path><path d="M6 7l1 13h10l1-13"></path></svg>
            Ripple delete
          </button>

          ${vm.hasSelection ? html`
            <div style="display:flex;align-items:center;gap:8px;padding-left:8px;border-left:1px solid rgba(var(--ink-rgb),0.14);margin-left:2px;">
              <span style="font-size:12px;font-weight:600;max-width:110px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${vm.selectedClip.name}</span>
              <button onMouseDown=${vm.selectedClip.onToggleMuteMouseDown} style="width:26px;height:26px;border-radius:999px;border:1px solid rgba(var(--ink-rgb),0.16);background:transparent;display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--text);">
                ${vm.selectedClip.muted ? html`<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M4 9v6h4l5 4V5L8 9H4z"></path><line x1="16" y1="9" x2="21" y2="14" stroke="currentColor" stroke-width="2"></line><line x1="21" y1="9" x2="16" y2="14" stroke="currentColor" stroke-width="2"></line></svg>` : null}
                ${vm.selectedClip.unmuted ? html`<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M4 9v6h4l5 4V5L8 9H4z"></path></svg>` : null}
              </button>
              <input type="range" min="0" max="100" value=${vm.selectedClip.volumePercent} onChange=${vm.selectedClip.onVolumeChange} style="width:80px;" />
              <span style="font-size:11px;color:rgba(var(--ink-rgb),0.55);min-width:30px;">${vm.selectedClip.volumeLabel}</span>
              ${vm.selectedClip.isVisual ? html`
                <button onClick=${vm.selectedClip.toggleAdjustMenu} title="Adjustments: filters, fade, and transitions" style="display:flex;align-items:center;gap:5px;height:26px;padding:0 10px;border-radius:999px;border:1px solid rgba(var(--ink-rgb),0.16);background:${vm.showSidePanels ? 'var(--accent)' : (vm.selectedClip.filtersActive || vm.selectedClip.fadeInActive || vm.selectedClip.fadeOutActive || vm.selectedClip.transitionActive ? 'rgba(198,113,57,0.14)' : 'transparent')};cursor:pointer;color:${vm.showSidePanels ? '#f5ead8' : 'var(--text)'};font-size:11px;font-weight:600;">
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r=".5" fill="currentColor"></circle><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"></circle><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"></circle><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"></circle><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"></path></svg>
                  Adjustments
                </button>
              ` : null}
            </div>
          ` : null}

          <div style="flex:1;"></div>
          <button onClick=${vm.zoomToFit} title="Zoom to fit whole timeline" style="display:flex;align-items:center;gap:5px;height:26px;padding:0 10px;border-radius:999px;border:1px solid rgba(var(--ink-rgb),0.16);background:transparent;cursor:pointer;color:var(--text);font-size:11px;font-weight:600;">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"></path><path d="M16 3h3a2 2 0 0 1 2 2v3"></path><path d="M8 21H5a2 2 0 0 1-2-2v-3"></path><path d="M16 21h3a2 2 0 0 0 2-2v-3"></path></svg>
            Fit
          </button>
          <button onClick=${vm.zoomOut} title="Zoom out (-)" style="width:26px;height:26px;border-radius:999px;border:1px solid rgba(var(--ink-rgb),0.16);background:transparent;cursor:pointer;color:var(--text);">-</button>
          <span style="font-size:11px;color:rgba(var(--ink-rgb),0.55);min-width:38px;text-align:center;">${vm.zoomPercentLabel}</span>
          <button onClick=${vm.zoomIn} title="Zoom in (+)" style="width:26px;height:26px;border-radius:999px;border:1px solid rgba(var(--ink-rgb),0.16);background:transparent;cursor:pointer;color:var(--text);">+</button>
        </div>

        <div ref=${vm.setTracksArea} style="flex:1;display:flex;min-height:0;overflow-y:auto;align-items:flex-start;">
          <div style="width:150px;flex:none;display:flex;flex-direction:column;background:var(--panel2);">
            <div style="height:26px;flex:none;position:sticky;top:0;z-index:6;background:var(--panel2);"></div>
            ${vm.tracksVM.map(track => html`
              <div key=${track.id} style="height:60px;flex:none;display:flex;flex-direction:column;justify-content:center;gap:6px;padding:0 10px;background:${track.headerBg};border-bottom:1px solid rgba(var(--ink-rgb),0.12);border-top:1px solid rgba(var(--ink-rgb),0.12);">
                <span style="font-size:11.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${track.name}</span>
                <div style="display:flex;align-items:center;gap:4px;">
                  <button onClick=${track.onToggleTrackMute} title=${track.muted ? 'Unmute track' : 'Mute track'} style="width:22px;height:22px;flex:none;border-radius:7px;border:none;background:${track.muted ? 'rgba(198,113,57,0.16)' : 'rgba(var(--ink-rgb),0.06)'};cursor:pointer;color:${track.muteIconColor};display:flex;align-items:center;justify-content:center;">
                    ${track.muted ? html`<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M4 9v6h4l5 4V5L8 9H4z"></path><line x1="16" y1="9" x2="21" y2="14" stroke="currentColor" stroke-width="2"></line><line x1="21" y1="9" x2="16" y2="14" stroke="currentColor" stroke-width="2"></line></svg>` : null}
                    ${track.unmuted ? html`<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M4 9v6h4l5 4V5L8 9H4z"></path></svg>` : null}
                  </button>
                  ${track.hasClips ? html`
                    <button onClick=${track.onCloseGaps} title="Close gaps on this track" style="width:22px;height:22px;flex:none;border-radius:7px;border:none;background:rgba(var(--ink-rgb),0.06);cursor:pointer;color:rgba(var(--ink-rgb),0.6);display:flex;align-items:center;justify-content:center;">
                      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4v16"></path><path d="M11 8l4 4-4 4"></path><path d="M18 4v16"></path></svg>
                    </button>
                  ` : null}
                  <div style="flex:1;"></div>
                  <button onClick=${track.onRemoveTrack} title="Remove track" style="width:22px;height:22px;flex:none;border-radius:7px;border:none;background:rgba(var(--ink-rgb),0.06);cursor:pointer;color:rgba(var(--ink-rgb),0.5);display:flex;align-items:center;justify-content:center;">
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16"></path><path d="M8 6V4h8v2"></path><path d="M6 6l1 14h10l1-14"></path></svg>
                  </button>
                </div>
              </div>
            `)}
          </div>

          <div ref=${vm.setTimelineScroll} style="flex:1;overflow-x:auto;overflow-y:hidden;position:relative;">
            <div ref=${vm.setTimelineContent} style="position:relative;width:${vm.timelineWidth}px;min-height:100%;">
              <div ref=${vm.setRulerEl} onMouseDown=${vm.handleRulerMouseDown} style="height:26px;position:relative;z-index:6;background:var(--panel2);border-bottom:1px solid rgba(var(--ink-rgb),0.12);cursor:pointer;">
                ${vm.ticks.map(tick => html`<div key=${tick.t} style="position:absolute;left:${tick.x}px;top:0;bottom:0;border-left:1px solid rgba(var(--ink-rgb),0.25);padding-left:3px;font-size:10px;color:rgba(var(--ink-rgb),0.75);">${tick.label}</div>`)}
              </div>

              ${vm.tracksVM.map(track => html`
                <div key=${track.id} ref=${track.setRef} onDrop=${track.onDrop} onDragOver=${track.onDragOver} onMouseDown=${track.onLaneMouseDown} style="height:60px;position:relative;background:${track.laneBg};border-bottom:1px solid rgba(var(--ink-rgb),0.1);border-top:1px solid rgba(var(--ink-rgb),0.1);">
                  ${track.clips.map(clip => html`
                    <${preact.Fragment} key=${clip.id}>
                      <div onMouseDown=${clip.onMouseDownMove} onContextMenu=${clip.onContextMenu} style="position:absolute;top:6px;bottom:6px;left:${clip.left}px;width:${clip.width}px;background:${clip.bg};border:2px solid ${clip.borderColor};border-radius:10px;box-shadow:${clip.ringShadow};overflow:hidden;cursor:grab;display:flex;align-items:center;padding:0 18px;">
                        <span style="font-size:11px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:${clip.textColor};">${clip.name}</span>
                      </div>
                      <div onMouseDown=${clip.onMouseDownLeft} style="position:absolute;top:6px;bottom:6px;left:${clip.left}px;width:9px;cursor:ew-resize;"></div>
                      <div onMouseDown=${clip.onMouseDownRight} style="position:absolute;top:6px;bottom:6px;left:${clip.rightHandleLeft}px;width:9px;cursor:ew-resize;"></div>
                      ${clip.hasTransition ? html`
                        <div title="Has a transition in from the previous clip" style="position:absolute;top:8px;left:${clip.left + 4}px;width:16px;height:16px;color:var(--accent);pointer-events:none;">
                          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3l4 4-4 4"></path><path d="M21 7H9a5 5 0 0 0 0 10h1"></path></svg>
                        </div>
                      ` : null}
                      ${clip.muted ? html`
                        <div onMouseDown=${clip.onToggleMuteMouseDown} style="position:absolute;top:8px;left:${clip.muteIconLeft}px;width:16px;height:16px;cursor:pointer;color:${clip.textColor};">
                          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M4 9v6h4l5 4V5L8 9H4z"></path><line x1="16" y1="9" x2="21" y2="14" stroke="currentColor" stroke-width="2"></line><line x1="21" y1="9" x2="16" y2="14" stroke="currentColor" stroke-width="2"></line></svg>
                        </div>
                      ` : null}
                    <//>
                  `)}
                </div>
              `)}

              <div style="position:absolute;top:0;bottom:0;left:${vm.playheadX}px;width:2px;background:var(--accent);pointer-events:none;z-index:5;">
                <div style="position:absolute;top:0;left:-6px;width:14px;height:9px;background:var(--accent);border-radius:3px;"></div>
              </div>
            </div>
          </div>
        </div>

        <div style="flex:none;display:flex;">
          <div style="width:150px;flex:none;display:flex;gap:6px;padding:8px 10px;background:var(--panel2);border-top:1px solid rgba(var(--ink-rgb),0.14);">
            <button onClick=${vm.addVideoTrack} disabled=${!vm.canAddVideoTrack} title="Add a video track (${vm.videoTrackCountLabel})" style="flex:1;height:28px;border-radius:8px;border:1px solid rgba(var(--ink-rgb),0.14);background:${vm.canAddVideoTrack ? 'var(--panel)' : 'transparent'};cursor:${vm.canAddVideoTrack ? 'pointer' : 'default'};color:var(--text);font-size:10px;font-weight:600;opacity:${vm.canAddVideoTrack ? 1 : 0.4};display:flex;align-items:center;justify-content:center;gap:3px;">
              <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14"></path><path d="M5 12h14"></path></svg>
              Video
            </button>
            <button onClick=${vm.addAudioTrack} disabled=${!vm.canAddAudioTrack} title="Add an audio track (${vm.audioTrackCountLabel})" style="flex:1;height:28px;border-radius:8px;border:1px solid rgba(var(--ink-rgb),0.14);background:${vm.canAddAudioTrack ? 'var(--panel)' : 'transparent'};cursor:${vm.canAddAudioTrack ? 'pointer' : 'default'};color:var(--text);font-size:10px;font-weight:600;opacity:${vm.canAddAudioTrack ? 1 : 0.4};display:flex;align-items:center;justify-content:center;gap:3px;">
              <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14"></path><path d="M5 12h14"></path></svg>
              Audio
            </button>
          </div>
          <div style="flex:1;display:flex;align-items:center;justify-content:flex-end;gap:10px;padding:0 12px;background:var(--panel);border-top:1px solid rgba(var(--ink-rgb),0.14);font-size:10px;color:rgba(var(--ink-rgb),0.5);">
            <span>${vm.videoTrackCountLabel} video</span>
            <span>${vm.audioTrackCountLabel} audio</span>
          </div>
        </div>
      </div>
    `;
  }

  renderContextMenu(vm) {
    return html`
      <div onMouseDown=${vm.stopPropagation} style="position:fixed;left:${vm.contextMenuX}px;top:${vm.contextMenuY}px;background:var(--panel);border-radius:12px;box-shadow:0 8px 24px rgba(46,43,37,0.28);padding:6px;min-width:180px;z-index:70;">
        ${vm.contextMenuItems.map(item => html`<button key=${item.key} onClick=${item.onClick} disabled=${item.disabled} style="display:block;width:100%;text-align:left;padding:8px 12px;font-size:13px;border:none;background:transparent;border-radius:8px;cursor:pointer;color:${item.color};">${item.label}</button>`)}
      </div>
    `;
  }

  renderExportDialog(vm) {
    return html`
      <div onMouseDown=${vm.closeExportIfNotRunning} style="position:fixed;inset:0;display:grid;place-items:center;padding:24px;background:rgba(46,43,37,0.5);z-index:50;">
        <div onMouseDown=${vm.stopPropagation} style="width:min(460px,100%);display:flex;flex-direction:column;gap:14px;padding:26px;border-radius:28px;background:var(--panel2);box-shadow:0 12px 32px rgba(46,43,37,0.22);">
          <div style="font-family:'Caprasimo',system-ui,sans-serif;font-size:19px;">Export video</div>

          ${vm.showExportForm ? html`
            <div>
              <div style="font-size:11px;color:rgba(var(--ink-rgb),0.6);margin-bottom:6px;">File name</div>
              <input value=${vm.exportFileName} onChange=${vm.handleExportFileNameChange} onInput=${vm.handleExportFileNameChange} onBlur=${vm.handleExportFileNameBlur} maxLength="100" placeholder="My Video" style="width:100%;box-sizing:border-box;padding:8px 12px;font-size:13px;border:1px solid rgba(var(--ink-rgb),0.16);border-radius:10px;background:var(--panel);color:var(--text);outline:none;" />
            </div>
            <div>
              <div style="font-size:11px;color:rgba(var(--ink-rgb),0.6);margin-bottom:6px;">Resolution</div>
              <div style="display:flex;border:1px solid rgba(var(--ink-rgb),0.16);border-radius:999px;overflow:hidden;">
                ${vm.resolutionOptions.map(opt => html`<button key=${opt.key} onClick=${opt.onClick} style="flex:1;padding:7px 4px;font-size:12px;border:none;cursor:pointer;background:${opt.bg};color:${opt.color};">${opt.label}</button>`)}
              </div>
            </div>
            <div style="display:flex;gap:16px;">
              <div style="flex:1;">
                <div style="font-size:11px;color:rgba(var(--ink-rgb),0.6);margin-bottom:6px;">Format</div>
                <div style="display:flex;border:1px solid rgba(var(--ink-rgb),0.16);border-radius:999px;overflow:hidden;">
                  ${vm.formatOptions.map(opt => html`<button key=${opt.key} onClick=${opt.onClick} style="flex:1;padding:7px 4px;font-size:12px;border:none;cursor:pointer;background:${opt.bg};color:${opt.color};">${opt.label}</button>`)}
                </div>
              </div>
              <div style="flex:1;">
                <div style="font-size:11px;color:rgba(var(--ink-rgb),0.6);margin-bottom:6px;">Frame rate</div>
                <div style="display:flex;border:1px solid rgba(var(--ink-rgb),0.16);border-radius:999px;overflow:hidden;">
                  ${vm.fpsOptions.map(opt => html`<button key=${opt.key} onClick=${opt.onClick} style="flex:1;padding:7px 4px;font-size:12px;border:none;cursor:pointer;background:${opt.bg};color:${opt.color};">${opt.label}</button>`)}
                </div>
              </div>
            </div>
            <div>
              <div style="font-size:11px;color:rgba(var(--ink-rgb),0.6);margin-bottom:6px;">Speed</div>
              <div style="display:flex;border:1px solid rgba(var(--ink-rgb),0.16);border-radius:999px;overflow:hidden;">
                ${vm.speedOptions.map(opt => html`<button key=${opt.key} onClick=${opt.onClick} style="flex:1;padding:7px 4px;font-size:12px;border:none;cursor:pointer;background:${opt.bg};color:${opt.color};">${opt.label}</button>`)}
              </div>
              <div style="font-size:11px;color:rgba(var(--ink-rgb),0.55);margin-top:6px;">${vm.speedHint}</div>
            </div>
            <label style="display:flex;align-items:center;justify-content:space-between;gap:12px;background:var(--panel);border-radius:14px;padding:10px 14px;cursor:pointer;" onClick=${vm.toggleResourceCap}>
              <span style="font-size:12px;color:rgba(var(--ink-rgb),0.75);line-height:1.5;">
                Limit CPU, memory & GPU use while exporting<br />
                <span style="font-size:11px;color:rgba(var(--ink-rgb),0.55);">Off by default (fastest export). Turn on to keep roughly 25% in reserve for the rest of your machine.</span>
              </span>
              <input type="checkbox" checked=${vm.resourceCapEnabled} onClick=${vm.stopPropagation} onChange=${vm.toggleResourceCap} style="flex-shrink:0;accent-color:var(--accent);" />
            </label>
            <div style="font-size:12px;color:rgba(var(--ink-rgb),0.65);line-height:1.6;background:var(--panel);border-radius:14px;padding:10px 14px;">
              Duration ${vm.durationLabel} · Estimated file size ${vm.sizeLabel}<br />
              Encoded with ffmpeg, right on this machine \u2014 usually much faster than playing the timeline through once, and not limited by what your browser or OS can decode.
            </div>
            ${vm.overLimit ? html`<div style="font-size:12px;color:var(--brand);background:#fff2eb;border-radius:14px;padding:10px 14px;">This timeline is over the 7-hour export limit. Trim it down before exporting.</div>` : null}
            ${!vm.overLimit && vm.silentExport ? html`<div style="font-size:12px;color:rgba(var(--ink-rgb),0.6);background:var(--panel);border-radius:14px;padding:10px 14px;">Heads up: every clip is muted or there's no audio in this project, so the export will be silent.</div>` : null}
            <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:4px;">
              <button onClick=${vm.closeExportDialog} style="padding:9px 18px;font-size:13px;border-radius:999px;border:1px solid rgba(var(--ink-rgb),0.16);background:transparent;color:var(--text);cursor:pointer;">Cancel</button>
              <button onClick=${vm.startExport} disabled=${vm.startExportDisabled} style="padding:9px 20px;font-size:13px;font-family:'Caprasimo',system-ui,sans-serif;border-radius:999px;border:none;background:var(--accent);color:#f5ead8;cursor:pointer;">Start export</button>
            </div>
          ` : null}

          ${vm.exportRunning ? html`
            <div style="height:10px;border-radius:999px;background:#dcd3c4;overflow:hidden;">
              <div style="height:100%;background:var(--accent);border-radius:999px;width:${vm.exportProgress}%;"></div>
            </div>
            <div style="font-size:12px;color:rgba(var(--ink-rgb),0.7);">${vm.runningStatusLabel}</div>
            <div style="display:flex;justify-content:flex-end;">
              <button onClick=${vm.cancelExport} style="padding:9px 18px;font-size:13px;border-radius:999px;border:1px solid rgba(var(--ink-rgb),0.16);background:transparent;color:var(--text);cursor:pointer;">Cancel export</button>
            </div>
          ` : null}

          ${vm.exportDone ? html`
            <div style="font-size:14px;">Export finished.</div>
            <div style="font-size:12px;color:rgba(var(--ink-rgb),0.65);">${vm.exportSavedNote}</div>
            <div style="display:flex;justify-content:flex-end;gap:8px;">
              <button onClick=${vm.revealExportedFile} style="padding:9px 18px;font-size:13px;border-radius:999px;border:1px solid rgba(var(--ink-rgb),0.16);background:transparent;color:var(--text);cursor:pointer;">Show in folder</button>
              <button onClick=${vm.closeExportDialog} style="padding:9px 18px;font-size:13px;border-radius:999px;border:none;background:var(--accent);color:#f5ead8;cursor:pointer;">Close</button>
            </div>
          ` : null}

          ${vm.exportError ? html`
            <div style="font-size:13px;color:var(--brand);">${vm.exportError}</div>
            <div style="display:flex;justify-content:flex-end;">
              <button onClick=${vm.closeExportDialog} style="padding:9px 18px;font-size:13px;border-radius:999px;border:none;background:var(--accent);color:#f5ead8;cursor:pointer;">Close</button>
            </div>
          ` : null}
        </div>
      </div>
    `;
  }

  renderHelpDialog(vm) {
    return html`
      <div onMouseDown=${vm.closeHelp} style="position:fixed;inset:0;display:grid;place-items:center;padding:24px;background:rgba(46,43,37,0.5);z-index:50;">
        <div onMouseDown=${vm.stopPropagation} style="width:min(420px,100%);display:flex;flex-direction:column;gap:10px;padding:26px;border-radius:28px;background:var(--panel2);box-shadow:0 12px 32px rgba(46,43,37,0.22);">
          <div style="font-family:'Caprasimo',system-ui,sans-serif;font-size:19px;margin-bottom:4px;">Keyboard shortcuts</div>
          ${vm.shortcuts.map((sc, i) => html`
            <div key=${i} style="display:flex;justify-content:space-between;font-size:13px;padding:4px 0;border-bottom:1px solid rgba(var(--ink-rgb),0.08);">
              <span style="color:rgba(var(--ink-rgb),0.7);">${sc.label}</span>
              <span style="font-weight:600;">${sc.key}</span>
            </div>
          `)}
          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px;">
            <span style="font-size:11px;color:rgba(var(--ink-rgb),0.4);">${vm.appVersion ? 'Kutforge v' + vm.appVersion : ''}</span>
            <button onClick=${vm.closeHelp} style="padding:9px 18px;font-size:13px;border-radius:999px;border:none;background:var(--accent);color:#f5ead8;cursor:pointer;">Close</button>
          </div>
        </div>
      </div>
    `;
  }

  renderToast(vm) {
    return html`<div style="position:fixed;bottom:20px;right:20px;background:#2e2b25;color:#f9f4ed;padding:10px 16px;border-radius:12px;font-size:13px;box-shadow:0 8px 20px rgba(0,0,0,0.3);z-index:60;">${vm.toastMsg}</div>`;
  }

  renderHiddenMedia(vm) {
    return html`
      <div style="position:absolute;width:0;height:0;overflow:hidden;">
        ${vm.mediaClipsForEls.map(mc => mc.isVideo
          ? html`<video key=${mc.id} ref=${mc.setRef} src=${mc.url} preload="auto" playsInline muted=${mc.previewMuted}></video>`
          : html`<audio key=${mc.id} ref=${mc.setRef} src=${mc.url} preload="auto"></audio>`
        )}
      </div>
    `;
  }

  // Shown before anything else, on every launch.
  renderDisclaimerGate() {
    const s = this.state;
    const repoUrl = 'https://github.com/arandomwu-code/Kutforge';
    return html`
      <div style="position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;background:#1c1a16;padding:24px;">
        <div style="background:#f6efe2;color:#2e2b25;max-width:500px;width:100%;border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,0.45);padding:26px;">
          <h2 style="margin:0 0 4px;font-size:19px;font-family:'Caprasimo',system-ui,sans-serif;">Before you continue</h2>
          <p style="margin:0 0 18px;font-size:13px;color:rgba(46,43,37,0.65);line-height:1.55;">
            Kutforge's disclaimer, terms and conditions, and license are written out in full on GitHub \u2014 please open and read them before continuing.
          </p>
          <label style="display:flex;align-items:flex-start;gap:8px;font-size:12.5px;line-height:1.55;cursor:pointer;margin-bottom:18px;">
            <input type="checkbox" checked=${s.disclaimerChecked} onChange=${this.toggleDisclaimerChecked} style="margin-top:2px;flex-shrink:0;accent-color:#c67139;" />
            <span>I agree \u2014 I have read the <a href=${repoUrl} target="_blank" onClick=${this.stopPropagation} style="color:#2e2b25;text-decoration:underline;">Disclaimer, Terms and Conditions and License</a> (opens in your browser).</span>
          </label>
          <div style="display:flex;justify-content:flex-end;gap:10px;">
            <button onClick=${this.declineDisclaimer} style="padding:9px 16px;font-size:13px;border-radius:999px;border:1px solid rgba(46,43,37,0.25);background:transparent;color:#2e2b25;cursor:pointer;">Decline & quit</button>
            <button disabled=${!s.disclaimerChecked} onClick=${this.agreeToDisclaimer} style="padding:9px 20px;font-size:13px;border-radius:999px;border:none;background:${s.disclaimerChecked ? '#2e2b25' : 'rgba(46,43,37,0.35)'};color:#f6efe2;cursor:${s.disclaimerChecked ? 'pointer' : 'not-allowed'};">I Agree \u2014 Continue</button>
          </div>
        </div>
      </div>
    `;
  }

  render() {
    if (!this.state.disclaimerAgreed) return this.renderDisclaimerGate();
    const vm = this.renderVals();
    return html`
      <div style="position:fixed;inset:0;display:flex;flex-direction:column;background:var(--bg);color:var(--text);overflow:hidden;${vm.themeVarsStyle}">
        ${this.renderHeader(vm)}
        <div style="flex:1;display:flex;min-height:0;">
          ${this.renderSidebar(vm)}
          ${this.renderStage(vm)}
        </div>
        ${vm.showContextMenu ? this.renderContextMenu(vm) : null}
        ${vm.showExport ? this.renderExportDialog(vm) : null}
        ${vm.showHelp ? this.renderHelpDialog(vm) : null}
        ${vm.toast ? this.renderToast(vm) : null}
        ${this.renderHiddenMedia(vm)}
      </div>
    `;
  }
}

preact.render(preact.h(VideoEditor, { defaultAspect: '16:9', defaultExportFps: '30' }), document.getElementById('app'));
