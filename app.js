(() => {
  "use strict";

  const byId = (id) => document.getElementById(id);
  const canvas = byId("scene");
  const ctx = canvas.getContext("2d");
  const backdrop = document.createElement("canvas");
  const backdropCtx = backdrop.getContext("2d");
  const scrub = byId("scrub");
  const physics = globalThis.FerryPhysics;
  const sample = globalThis.FerrySample;
  const fileInput = byId("video-input");
  const tools = Object.fromEntries(
    ["select", "start", "finish", "static", "moving", "keyframe"].map((name) => [name, byId(name + "-tool")])
  );

  let video = byId("video-source");
  let clip = null;
  let level = { width: 960, height: 540, start: null, finish: null, platforms: [] };
  let run = null;
  let tool = "select";
  let selection = null;
  let drag = null;
  let frameTime = 0;
  let requestedTime = null;
  let pendingSeek = null;
  let hasFrame = false;
  let loadTicket = 0;
  let loadController = null;
  let nextId = 1;
  let previousTick = 0;
  let jump = false;
  let lastReadout = "";
  const keys = new Set();
  const touches = new Map();
  const limit = (number, min, max) => Math.min(max, Math.max(min, number));
  const selectedPlatform = () => level.platforms.find((platform) => platform.id === selection);
  const inPlay = () => run !== null;
  const playable = () => Boolean(level.start && level.finish && level.platforms.length);
  const currentTime = () => requestedTime ?? frameTime;
  const magic = new TextEncoder().encode("FERRY1\r\n");
  const headerLength = magic.length + 4;
  const maxMetadataSize = 2 * 1024 * 1024;
  const toolNotes = {
    select: "выбери платформу прямо на видео или в списке.",
    start: "ткни туда, где герой должен стоять в начале.",
    finish: "ткни туда, куда герой должен добраться.",
    static: "обведи поверхность, по которой можно ходить.",
    moving: "обведи предмет. потом мотни видео и отметь, куда он переехал.",
    keyframe: "обведи предмет на новом месте. если размер тот же, можно просто ткнуть в центр."
  };

  function status(message, tone = "") {
    const element = byId("status");
    element.textContent = message;
    element.dataset.tone = tone;
  }

  function formatTime(seconds) {
    const hundredths = Math.floor(Math.max(0, seconds) * 100);
    const minutes = String(Math.floor(hundredths / 6000)).padStart(2, "0");
    const remainder = String(Math.floor(hundredths / 100) % 60).padStart(2, "0");
    return minutes + ":" + remainder + "." + String(hundredths % 100).padStart(2, "0");
  }

  function renderTimeline() {
    if (!clip) return;
    const time = video.paused || requestedTime !== null ? currentTime() : video.currentTime;
    scrub.value = String(time);
    const readout = formatTime(time) + " / " + formatTime(clip.duration);
    if (readout !== lastReadout) {
      byId("timecode").textContent = readout;
      scrub.setAttribute("aria-valuetext", formatTime(time));
      lastReadout = readout;
    }
    const toggle = byId("toggle-video");
    const paused = video.paused;
    const label = paused ? "запустить видео" : "поставить видео на паузу";
    if (toggle.dataset.playing !== String(!paused)) {
      toggle.dataset.playing = String(!paused);
      toggle.setAttribute("aria-label", label);
      toggle.title = label;
      toggle.textContent = paused ? "▶" : "Ⅱ";
    }
  }

  function renderEditor() {
    const active = Boolean(clip);
    const platform = selectedPlatform();
    const mode = inPlay() ? "play" : "edit";
    document.body.dataset.mode = mode;
    canvas.dataset.tool = inPlay() ? "play" : tool;
    canvas.tabIndex = inPlay() ? 0 : -1;
    byId("stage-shell").dataset.tool = canvas.dataset.tool;
    byId("edit-mode").setAttribute("aria-pressed", String(!inPlay()));
    byId("play-mode").setAttribute("aria-pressed", String(inPlay()));
    byId("play-mode").disabled = !active;
    byId("draw-tools").hidden = inPlay();
    byId("game-controls").hidden = !inPlay();
    byId("restart-button").hidden = !inPlay();
    byId("export-button").disabled = !active;
    byId("delete-button").disabled = !platform && selection !== "start" && selection !== "finish";
    byId("clear-button").disabled = !level.start && !level.finish && !level.platforms.length;
    byId("toggle-video").disabled = !active;
    scrub.disabled = !active;
    for (const [name, button] of Object.entries(tools)) {
      if (!button) continue;
      button.disabled = !active || (name === "keyframe" && !platform?.moving);
      button.setAttribute("aria-pressed", String(name === tool));
    }
    if (byId("mode-label")) byId("mode-label").textContent = inPlay() ? "игра" : "монтаж";
    byId("stage-note").textContent = inPlay()
      ? "ходи на ← →, прыгай пробелом. мотай видео на Q / E или ползунком."
      : toolNotes[tool];
    renderObjects();
  }

  function renderObjects() {
    const list = byId("object-list");
    const markers = [];
    if (level.start) markers.push({ id: "start", name: "старт", kind: "точка" });
    if (level.finish) markers.push({ id: "finish", name: "финиш", kind: "точка" });
    const entries = markers.concat(level.platforms.map((platform) => ({
      id: platform.id,
      name: platform.name,
      kind: platform.moving ? "кадров: " + platform.frames.length : "на месте"
    })));
    list.replaceChildren();
    for (const entry of entries) {
      const button = document.createElement("button");
      button.className = "object-row";
      button.type = "button";
      button.dataset.objectId = entry.id;
      button.setAttribute("aria-pressed", String(selection === entry.id));
      const name = document.createElement("span");
      name.textContent = entry.name;
      const kind = document.createElement("span");
      kind.className = "object-kind";
      kind.textContent = entry.kind;
      button.append(name, kind);
      list.append(button);
    }
    if (!entries.length) {
      const empty = document.createElement("p");
      empty.className = "object-empty";
      empty.textContent = "тут пока пусто. начни с платформы.";
      list.append(empty);
    }
    const marks = byId("timeline-marks");
    if (!marks) return;
    marks.replaceChildren();
    const chosen = selectedPlatform();
    if (!chosen?.moving || !clip || inPlay()) return;
    for (const frame of chosen.frames) {
      const mark = document.createElement("button");
      mark.type = "button";
      mark.className = "timeline-marker";
      mark.style.left = limit(frame.time / clip.duration * 100, 0, 100) + "%";
      mark.setAttribute("aria-label", "ключевой кадр " + formatTime(frame.time));
      mark.title = formatTime(frame.time);
      mark.addEventListener("click", () => seek(frame.time));
      marks.append(mark);
    }
  }

  function select(id) {
    selection = id;
    tool = "select";
    renderEditor();
  }

  function readMetadata(candidate, signal) {
    return new Promise((resolve, reject) => {
      const handlers = new AbortController();
      const timeout = setTimeout(failure, 15000);
      function finish(error) {
        clearTimeout(timeout);
        handlers.abort();
        if (error) reject(error);
        else resolve();
      }
      function failure() {
        finish(new Error("блин, видео не открылось. попробуй MP4 (H.264) или WebM."));
      }
      const options = { signal: handlers.signal };
      signal.addEventListener("abort", () => finish(signal.reason), options);
      candidate.addEventListener("error", failure, options);
      candidate.addEventListener("loadedmetadata", () => {
        if (!Number.isFinite(candidate.duration) || candidate.duration <= 0 ||
            !candidate.videoWidth || !candidate.videoHeight) {
          finish(new Error("выбери записанный ролик, где есть картинка и известна длительность."));
          return;
        }
        finish();
      }, options);
      candidate.load();
    });
  }

  async function openClip(source, ticket, signal) {
    const candidate = document.createElement("video");
    candidate.id = "video-source";
    candidate.hidden = true;
    candidate.muted = true;
    candidate.playsInline = true;
    candidate.preload = "auto";
    const objectUrl = source.blob ? URL.createObjectURL(source.blob) : null;
    candidate.src = objectUrl || source.src;
    try {
      await readMetadata(candidate, signal);
      if (ticket !== loadTicket) return;

      video.pause();
      video.replaceWith(candidate);
      video.removeAttribute("src");
      video.load();
      if (clip?.objectUrl) URL.revokeObjectURL(clip.objectUrl);
      video = candidate;
      clip = { ...source, objectUrl, duration: video.duration };
      const ratio = video.videoWidth / video.videoHeight;
      const height = Math.max(1, Math.min(540, Math.round(4096 / ratio)));
      const width = Math.max(1, Math.round(height * ratio));
      canvas.width = backdrop.width = width;
      canvas.height = backdrop.height = height;
      level = {
        width, height,
        start: source.start ?? null,
        finish: source.finish ?? null,
        platforms: (source.platforms ?? []).map((platform) => ({
          ...platform, moving: platform.moving ?? platform.frames.length > 1,
          frames: platform.frames.map((frame) => ({ ...frame }))
        }))
      };
      nextId = 1;
      run = null;
      drag = null;
      tool = "select";
      selection = null;
      frameTime = 0;
      pendingSeek = requestedTime = null;
      hasFrame = false;
      resetInput();
      scrub.max = String(clip.duration);
      scrub.step = "any";
      byId("clip-name").textContent = source.name;
      byId("clip-info").textContent = video.videoWidth + " × " + video.videoHeight + " · " + formatTime(video.duration);
      renderEditor();
      renderTimeline();
      status(source.sample && playable()
        ? "смотри, тут уже есть уровень. нажми «играть» и прокатись на книге)"
        : level.platforms.length
          ? "уровень открыла. можно сразу играть или поправить разметку."
          : "видео открыла. теперь обведи платформы и поставь старт и финиш.", "success");
    } finally {
      if (video !== candidate) {
        candidate.removeAttribute("src");
        candidate.load();
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      }
    }
  }

  function loadSource(getSource) {
    const ticket = ++loadTicket;
    loadController?.abort();
    loadController = new AbortController();
    const signal = loadController.signal;
    status("щас открою видео…");
    return Promise.resolve().then(getSource).then((source) => {
      if (ticket === loadTicket) return openClip(source, ticket, signal);
    }).catch((error) => {
      if (ticket === loadTicket) status(error.message, "error");
    });
  }

  function loadDemo() {
    return loadSource(() => ({ ...sample, sample: true }));
  }

  async function readProject(file) {
    const invalid = () => new Error("этот .ferry не открылся. проверь, что это файл из «скачать уровень».");
    const header = new Uint8Array(await file.slice(0, headerLength).arrayBuffer());
    if (header.length !== headerLength || !magic.every((byte, i) => header[i] === byte)) throw invalid();
    const size = new DataView(header.buffer).getUint32(magic.length, true);
    const payloadOffset = headerLength + size;
    if (!size || size > maxMetadataSize || payloadOffset > file.size) throw invalid();
    let data;
    try {
      data = JSON.parse(await file.slice(headerLength, payloadOffset).text());
    } catch {
      throw invalid();
    }
    const fraction = (n) => Number.isFinite(n) && n >= 0 && n <= 1;
    const point = (p) => p === null || (p && fraction(p.x) && fraction(p.y));
    const frameValid = (f) => f && point(f) && fraction(f.w) && fraction(f.h) &&
      f.w > 0 && f.h > 0 && f.x + f.w <= 1.00001 && f.y + f.h <= 1.00001 &&
      Number.isFinite(f.time) && f.time >= 0;
    if (!data || typeof data.name !== "string" || !point(data.start) || !point(data.finish) ||
        !Array.isArray(data.platforms) || data.platforms.some((p) => !p || typeof p.name !== "string" ||
          !Array.isArray(p.frames) || !p.frames.length || !p.frames.every(frameValid))) throw invalid();
    const platforms = data.platforms.map((platform, i) => ({
      id: "loaded-" + i,
      name: platform.name.slice(0, 100),
      moving: platform.moving === true || platform.frames.length > 1,
      frames: platform.frames.map(({ time, x, y, w, h }) => ({ time, x, y, w, h }))
        .sort((a, b) => a.time - b.time)
    }));
    const source = { name: data.name.slice(0, 140), start: data.start, finish: data.finish, platforms };
    if (data.sample === true && payloadOffset === file.size) return { ...source, sample: true, src: sample.src };
    if (payloadOffset === file.size) throw invalid();
    const type = typeof data.mediaType === "string" && data.mediaType.startsWith("video/") ? data.mediaType : "";
    return { ...source, blob: file.slice(payloadOffset, file.size, type) };
  }

  function exportLevel() {
    if (!clip) return;
    const metadata = new TextEncoder().encode(JSON.stringify({
      name: clip.name, sample: clip.sample === true, mediaType: clip.blob?.type,
      start: level.start, finish: level.finish, platforms: level.platforms
    }));
    if (metadata.length > maxMetadataSize) {
      status("тут слишком много ключевых кадров для одного файла.", "error");
      return;
    }
    const header = new Uint8Array(headerLength);
    header.set(magic);
    new DataView(header.buffer).setUint32(magic.length, metadata.length, true);
    const parts = [header, metadata];
    if (clip.blob) parts.push(clip.blob);
    const url = URL.createObjectURL(new Blob(parts, { type: "application/octet-stream" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = (clip.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").replace(/\.[a-z0-9]{2,5}$/i, "") || "level") + ".ferry";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    status("воть, уровень сохранён. чтобы открыть .ferry, нажми «открыть видео».", "success");
  }

  function seek(time) {
    if (!clip) return;
    const target = limit(time, 0, clip.duration);
    video.pause();
    requestedTime = target;
    pendingSeek = target;
    renderTimeline();
  }

  async function toggleVideo() {
    if (!clip) return;
    if (inPlay()) canvas.focus();
    if (!video.paused) {
      video.pause();
      return;
    }
    const activeVideo = video;
    if (pendingSeek !== null) activeVideo.currentTime = pendingSeek;
    if (activeVideo.ended) activeVideo.currentTime = 0;
    pendingSeek = requestedTime = null;
    try {
      await activeVideo.play();
    } catch {
      if (activeVideo === video && !video.paused) return;
      if (activeVideo === video) status("видео не запустилось. попробуй открыть ролик ещё раз.", "error");
    }
  }

  function pointerPoint(event) {
    const box = canvas.getBoundingClientRect();
    return {
      x: limit((event.clientX - box.left) / box.width, 0, 1),
      y: limit((event.clientY - box.top) / box.height, 0, 1)
    };
  }

  function rectangle(a, b) {
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
  }

  function selectAt(point) {
    for (const name of ["start", "finish"]) {
      const marker = level[name];
      if (marker && Math.abs(marker.x - point.x) * level.width < 17 &&
          Math.abs(marker.y - point.y) * level.height < 20) {
        select(name);
        return;
      }
    }
    const hit = level.platforms.findLast((platform) => {
      const rect = physics.sampleRect(platform, frameTime);
      return point.x >= rect.x && point.x <= rect.x + rect.w &&
        point.y >= rect.y - 5 / level.height && point.y <= rect.y + rect.h;
    });
    select(hit?.id ?? null);
  }

  function down(event) {
    if (inPlay() || !clip || event.button !== 0) return;
    if (video.seeking || pendingSeek !== null || !hasFrame) {
      status("сек, кадр ещё грузится…");
      return;
    }
    const point = pointerPoint(event);
    if (tool === "select") {
      selectAt(point);
      return;
    }
    video.pause();
    if (tool === "start" || tool === "finish") {
      level[tool] = point;
      status(tool === "start" ? "старт на месте." : "финиш на месте.", "success");
      select(tool);
      return;
    }
    drag = { pointer: event.pointerId, from: point, to: point, time: frameTime };
    canvas.setPointerCapture(event.pointerId);
  }

  function addFrame(platform, frame) {
    const existing = platform.frames.findIndex((item) => Math.abs(item.time - frame.time) < 0.05);
    if (existing >= 0) platform.frames[existing] = frame;
    else platform.frames.push(frame);
    platform.frames.sort((a, b) => a.time - b.time);
  }

  function up(event) {
    if (drag?.pointer !== event.pointerId) return;
    const point = pointerPoint(event);
    let rect = rectangle(drag.from, point);
    const time = drag.time;
    drag = null;
    const platform = selectedPlatform();
    if (tool === "keyframe" && platform?.moving) {
      if (rect.w * level.width < 5 && rect.h * level.height < 5) {
        const original = physics.sampleRect(platform, time);
        rect = {
          ...original,
          x: limit(point.x - original.w / 2, 0, 1 - original.w),
          y: limit(point.y - original.h / 2, 0, 1 - original.h)
        };
      }
      if (rect.w * level.width < 5 || rect.h * level.height < 3) return;
      addFrame(platform, { ...rect, time });
      renderEditor();
      status("ключевой кадр на " + formatTime(time) + " готов.", "success");
      return;
    }
    if (rect.w * level.width < 5 || rect.h * level.height < 3) {
      status("потяни от одного угла платформы к другому.");
      return;
    }
    const moving = tool === "moving";
    const number = nextId++;
    const id = "platform-" + number;
    level.platforms.push({
      id, moving, name: (moving ? "движущаяся " : "платформа ") + number,
      frames: [{ ...rect, time: moving ? time : 0 }]
    });
    selection = id;
    if (moving) tool = "keyframe";
    renderEditor();
    status(moving
      ? "первый кадр есть. мотни видео и покажи, где платформа теперь."
      : "платформа на месте.", "success");
  }

  function drawRect(rect, tint, strong) {
    const { width, height } = level;
    ctx.save();
    ctx.strokeStyle = tint;
    ctx.fillStyle = tint;
    ctx.globalAlpha = strong ? 0.19 : 0.1;
    ctx.fillRect(rect.x * width, rect.y * height, rect.w * width, rect.h * height);
    ctx.globalAlpha = strong ? 1 : 0.73;
    ctx.lineWidth = strong ? 2.5 : 1.5;
    if (strong) ctx.setLineDash([7, 5]);
    ctx.strokeRect(rect.x * width, rect.y * height, rect.w * width, rect.h * height);
    ctx.restore();
  }

  function drawMarker(point, label, tint, flag) {
    if (!point) return;
    const x = point.x * level.width;
    const y = point.y * level.height;
    const scale = level.height / 540;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    ctx.strokeStyle = "#151221";
    ctx.fillStyle = tint;
    ctx.lineWidth = 3;
    if (flag) {
      ctx.beginPath();
      ctx.moveTo(-2, 0);
      ctx.lineTo(-2, -37);
      ctx.lineTo(23, -31);
      ctx.lineTo(-2, -22);
      ctx.closePath();
      ctx.stroke();
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.arc(0, -4, 7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fill();
    }
    if (label) {
      ctx.font = "bold 13px monospace";
      ctx.textAlign = "center";
      const labelWidth = ctx.measureText(label).width + 15;
      const labelX = limit(0, 5 - x / scale + labelWidth / 2, (level.width - x) / scale - labelWidth / 2 - 5);
      ctx.fillStyle = "#181420";
      ctx.fillRect(labelX - labelWidth / 2, -62, labelWidth, 23);
      ctx.fillStyle = tint;
      ctx.fillText(label, labelX, -46);
    }
    ctx.restore();
  }

  function drawPlayer(player) {
    const { x, y, w, h } = player;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(w / 12, h / 16);
    ctx.fillStyle = "#12101f";
    ctx.fillRect(1, 1, 10, 14);
    ctx.fillRect(2, 14, 3, 2);
    ctx.fillRect(7, 14, 3, 2);
    ctx.fillStyle = "#fff2d8";
    ctx.fillRect(2, 0, 8, 7);
    ctx.fillRect(1, 3, 10, 4);
    ctx.fillStyle = "#5de2c8";
    ctx.fillRect(5, 2, 5, 4);
    ctx.fillStyle = "#ffc27f";
    ctx.fillRect(3, 8, 6, 6);
    ctx.fillStyle = "#fff2d8";
    ctx.fillRect(4, 9, 4, 2);
    ctx.restore();
  }

  function renderScene() {
    if (hasFrame) ctx.drawImage(backdrop, 0, 0);
    else {
      ctx.fillStyle = "#171222";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return;
    }
    if (inPlay()) {
      drawMarker(level.finish, "", "#f8cc86", true);
      drawPlayer(run.player);
      return;
    }
    for (const platform of level.platforms) {
      drawRect(physics.sampleRect(platform, frameTime), platform.moving ? "#77f2d2" : "#ffd294",
        platform.id === selection);
    }
    drawMarker(level.start, "старт", "#87f7d9", false);
    drawMarker(level.finish, "финиш", "#ffd294", true);
    if (drag) drawRect(rectangle(drag.from, drag.to), "#f5e6ff", true);
  }

  function resetInput() {
    keys.clear();
    touches.clear();
    jump = false;
  }

  function enterGame() {
    if (!clip || inPlay()) return;
    if (!playable()) {
      status("чтобы сыграть, поставь старт, финиш и хотя бы одну платформу.", "error");
      return;
    }
    video.pause();
    drag = null;
    resetInput();
    run = physics.create(level, frameTime);
    renderEditor();
    canvas.focus();
    status(clip.sample
      ? "прыгни на синюю книгу. потом мотни видео вперёд и доедь до правой стопки."
      : "видео можно мотать прямо в игре. попробуй Q и E или ползунок.");
  }

  function exitGame() {
    if (!inPlay()) return;
    run = null;
    video.pause();
    resetInput();
    renderEditor();
    status("можно дальше править уровень.");
  }

  function restart() {
    if (!inPlay()) return;
    physics.reset(run, level, frameTime);
    resetInput();
    canvas.focus();
    status("герой снова на старте.");
  }

  function tick(timestamp) {
    requestAnimationFrame(tick);
    const dt = limit((timestamp - previousTick) / 1000, 0, 0.045);
    previousTick = timestamp;
    if (!clip) {
      if (!hasFrame) renderScene();
      return;
    }
    const direction = Number(keys.has("KeyE")) - Number(keys.has("KeyQ"));
    if (inPlay() && direction) seek(currentTime() + direction * dt * 1.85);
    const previousFrameTime = frameTime;
    // Пока грузится новый кадр, держим на экране старый вместе с его платформами.
    if (!video.seeking && video.readyState >= 2 &&
        (!hasFrame || Math.abs(video.currentTime - frameTime) > 0.0001)) {
      backdropCtx.drawImage(video, 0, 0, backdrop.width, backdrop.height);
      frameTime = video.currentTime;
      hasFrame = true;
    }
    if (!video.seeking && pendingSeek !== null) {
      const target = pendingSeek;
      pendingSeek = null;
      if (Math.abs(video.currentTime - target) > 0.0001) video.currentTime = target;
    }
    if (!video.seeking && pendingSeek === null) requestedTime = null;
    if (inPlay() && hasFrame && dt > 0 && !run.won) {
      const deaths = run.deaths;
      const moving = Array.from(touches.values());
      physics.step(run, level, previousFrameTime, frameTime, dt, {
        left: keys.has("ArrowLeft") || keys.has("KeyA") || moving.includes("left"),
        right: keys.has("ArrowRight") || keys.has("KeyD") || moving.includes("right"),
        jump
      });
      jump = false;
      if (run.won) {
        video.pause();
        status("воть, уровень пройден 💜", "success");
      } else if (run.deaths !== deaths) {
        status("упали. давай ещё раз, герой уже на старте.");
      }
    }
    renderScene();
    renderTimeline();
  }

  for (const [name, button] of Object.entries(tools)) {
    button?.addEventListener("click", () => {
      tool = name;
      renderEditor();
    });
  }
  byId("object-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-object-id]");
    if (!button) return;
    select(button.dataset.objectId);
    byId("object-list").querySelector('[aria-pressed="true"]')?.focus();
  });
  byId("delete-button").addEventListener("click", () => {
    if (selection === "start" || selection === "finish") level[selection] = null;
    else level.platforms = level.platforms.filter((p) => p.id !== selection);
    select(null);
    status("убрала с уровня.");
  });
  byId("clear-button").addEventListener("click", () => {
    if (!window.confirm("точно убрать всю разметку с этого видео?")) return;
    level.start = level.finish = null;
    level.platforms = [];
    select(null);
    status("разметку убрала. можно начать заново.");
  });
  fileInput.addEventListener("change", () => {
    const file = fileInput.files[0];
    fileInput.value = "";
    if (!file) return;
    loadSource(() => file.name.toLowerCase().endsWith(".ferry")
      ? readProject(file) : { name: file.name, blob: file });
  });
  byId("demo-button").addEventListener("click", loadDemo);
  byId("export-button").addEventListener("click", exportLevel);
  byId("toggle-video").addEventListener("click", toggleVideo);
  byId("edit-mode").addEventListener("click", exitGame);
  byId("play-mode").addEventListener("click", enterGame);
  byId("restart-button").addEventListener("click", restart);
  scrub.addEventListener("input", () => seek(Number(scrub.value)));
  scrub.addEventListener("pointerup", () => {
    if (inPlay()) canvas.focus();
  });
  canvas.addEventListener("pointerdown", down);
  canvas.addEventListener("pointermove", (event) => {
    if (drag?.pointer === event.pointerId) drag.to = pointerPoint(event);
  });
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", () => { drag = null; });

  const gameKeys = new Set(["ArrowLeft", "ArrowRight", "KeyA", "KeyD", "KeyW", "ArrowUp", "Space", "KeyQ", "KeyE", "KeyR"]);
  window.addEventListener("keydown", (event) => {
    if (!inPlay() || !gameKeys.has(event.code) || event.ctrlKey || event.altKey || event.metaKey) return;
    if (event.target.closest?.("input, button, select, textarea, [contenteditable]")) return;
    event.preventDefault();
    keys.add(event.code);
    if (event.repeat) return;
    if (["Space", "KeyW", "ArrowUp"].includes(event.code)) jump = true;
    if (event.code === "KeyR") restart();
  });
  window.addEventListener("keyup", (event) => keys.delete(event.code));
  window.addEventListener("blur", resetInput);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) resetInput();
  });
  for (const button of document.querySelectorAll("#game-controls [data-control]")) {
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      button.setPointerCapture(event.pointerId);
      const action = button.dataset.control;
      touches.set(event.pointerId, action);
      if (action === "jump") jump = true;
    });
    for (const eventName of ["pointerup", "pointercancel", "lostpointercapture"]) {
      button.addEventListener(eventName, (event) => touches.delete(event.pointerId));
    }
    button.addEventListener("click", (event) => {
      if (event.detail === 0 && button.dataset.control === "jump") jump = true;
    });
  }

  renderEditor();
  requestAnimationFrame(tick);
  loadDemo();
})();
