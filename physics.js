(() => {
  "use strict";

  const RUN_SPEED = 315;
  const JUMP_SPEED = 640;
  const GRAVITY = 1650;
  const MAX_TICK = 1 / 120;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function sampleRect(platform, time) {
    const frames = platform.frames;
    if (!frames?.length) return null;

    const first = frames[0];
    const last = frames[frames.length - 1];
    let before = first;
    let after = first;
    if (time >= last.time) {
      before = last;
      after = last;
    } else if (time > first.time) {
      let low = 0;
      let high = frames.length - 1;
      while (high - low > 1) {
        const middle = Math.floor((low + high) / 2);
        if (frames[middle].time <= time) low = middle;
        else high = middle;
      }
      before = frames[low];
      after = frames[high];
    }
    const ratio = before === after ? 0 : (time - before.time) / (after.time - before.time);
    return {
      x: before.x + (after.x - before.x) * ratio,
      y: before.y + (after.y - before.y) * ratio,
      w: before.w + (after.w - before.w) * ratio,
      h: before.h + (after.h - before.h) * ratio
    };
  }

  function worldRects(level, time) {
    const rects = [];
    for (const [index, platform] of level.platforms.entries()) {
      const rect = sampleRect(platform, time);
      if (!rect || rect.w <= 0 || rect.h <= 0) continue;
      rects.push({
        id: platform.id ?? index,
        x: rect.x * level.width,
        y: rect.y * level.height,
        w: rect.w * level.width,
        h: rect.h * level.height
      });
    }
    return rects;
  }

  function overlapsHorizontally(left, width, platform) {
    return left + width > platform.x && left < platform.x + platform.w;
  }

  function attach(state, platform) {
    state.grounded = platform !== null;
    state.groundedId = platform?.id ?? null;
    if (platform) {
      state.player.y = platform.y - state.player.h;
      state.vy = 0;
    }
  }

  function placeAtStart(state, level, platforms) {
    const { player } = state;
    const scale = level.height / 540;
    player.w = Math.min(26 * scale, level.width * 0.25);
    player.h = 36 * scale;
    player.x = clamp(level.start.x * level.width - player.w / 2, 0, level.width - player.w);
    player.y = level.start.y * level.height - player.h;
    state.vy = 0;
    state.facing = 1;
    state.jumpBuffer = 0;
    state.coyoteTime = 0;
    state.won = false;
    const feet = player.y + player.h;
    let support = null;
    let distance = 13 * scale;
    for (const platform of platforms) {
      const gap = Math.abs(platform.y - feet);
      if (overlapsHorizontally(player.x, player.w, platform) && gap <= distance) {
        support = platform;
        distance = gap;
      }
    }
    attach(state, support);
  }

  function reset(state, level, time = 0) {
    state.deaths = 0;
    placeAtStart(state, level, worldRects(level, time));
    return state;
  }

  function create(level, time = 0) {
    return reset({ player: {} }, level, time);
  }

  function carry(state, level, previous, current) {
    if (!state.grounded) return;
    const before = previous.find((rect) => rect.id === state.groundedId);
    const after = current.find((rect) => rect.id === state.groundedId);
    if (!before || !after) {
      attach(state, null);
      return;
    }
    const { player } = state;
    // Герой остаётся на том же месте на платформе, даже если она меняет размер.
    const offset = player.x + player.w / 2 - before.x;
    const center = after.x + offset * (after.w / before.w);
    player.x = clamp(center - player.w / 2, 0, level.width - player.w);
    attach(state, overlapsHorizontally(player.x, player.w, after) ? after : null);
  }

  function crossedPlatform(player, oldX, oldFeet, previous, current, standing, tolerance) {
    const newFeet = player.y + player.h;
    let landing = null;
    let earliest = Infinity;
    for (let index = 0; index < current.length; index++) {
      const platform = current[index];
      const oldPlatform = !standing && previous[index]?.id === platform.id ? previous[index] : platform;
      const from = oldFeet - oldPlatform.y;
      const to = newFeet - platform.y;
      if (from > tolerance || to < 0 || to <= from) continue;
      const fraction = clamp(-from / (to - from), 0, 1);
      if (standing && fraction === 0 && !overlapsHorizontally(player.x, player.w, platform)) continue;
      const x = oldX + (player.x - oldX) * fraction;
      const edge = oldPlatform.x + (platform.x - oldPlatform.x) * fraction;
      const width = oldPlatform.w + (platform.w - oldPlatform.w) * fraction;
      if (fraction < earliest && x + player.w > edge && x < edge + width) {
        earliest = fraction;
        landing = platform;
      }
    }
    return landing;
  }

  function reachesFinish(player, level) {
    if (!level.finish) return false;
    const scale = level.height / 540;
    const x = level.finish.x * level.width;
    const y = level.finish.y * level.height;
    return player.x < x + 12 * scale &&
      player.x + player.w > x - 12 * scale &&
      player.y < y + 8 * scale &&
      player.y + player.h > y - 40 * scale;
  }

  function advance(state, level, previous, current, dt, direction, scale) {
    carry(state, level, previous, current);
    const { player } = state;
    const oldX = player.x;
    const oldFeet = player.y + player.h;
    const standing = state.grounded;
    if (standing) state.coyoteTime = 0.09;
    if (state.jumpBuffer > 0 && state.coyoteTime > 0) {
      state.vy = -JUMP_SPEED * scale;
      state.jumpBuffer = 0;
      state.coyoteTime = 0;
      attach(state, null);
    }

    player.x = clamp(oldX + direction * RUN_SPEED * scale * dt, 0, level.width - player.w);
    if (direction !== 0) state.facing = direction;
    if (state.grounded) {
      const support = current.find((rect) => rect.id === state.groundedId);
      if (!overlapsHorizontally(player.x, player.w, support)) attach(state, null);
    }
    if (!state.grounded) {
      player.y += state.vy * dt + GRAVITY * scale * dt ** 2 / 2;
      state.vy += GRAVITY * scale * dt;
      const landing = crossedPlatform(player, oldX, oldFeet, previous, current, standing, scale);
      if (landing) attach(state, landing);
    }

    state.jumpBuffer = Math.max(0, state.jumpBuffer - dt);
    state.coyoteTime = Math.max(0, state.coyoteTime - dt);
    state.won = reachesFinish(player, level);
    if (!state.won && player.y > level.height + 48 * scale) {
      state.deaths++;
      placeAtStart(state, level, current);
    }
  }

  function step(state, level, previousVideoTime, videoTime, dt, input = {}) {
    if (state.won) return state;
    if (input.jump) state.jumpBuffer = 0.12;
    const direction = Number(Boolean(input.right)) - Number(Boolean(input.left));
    const duration = clamp(dt, 0, 0.08);
    const ticks = Math.max(1, Math.ceil(duration / MAX_TICK));
    const scale = level.height / 540;
    const videoDelta = videoTime - previousVideoTime;
    const continuous = Math.abs(videoDelta) <= Math.max(0.08, duration * 3);
    let previous = worldRects(level, previousVideoTime);
    let current = videoDelta === 0 ? previous : worldRects(level, videoTime);
    if (!continuous) {
      // При резкой перемотке платформы перескакивают на новый кадр. Герой едет только на той, на которой стоит.
      carry(state, level, previous, current);
      previous = current;
    }
    for (let tick = 1; tick <= ticks && !state.won; tick++) {
      const intermediate = continuous && videoDelta !== 0 && tick < ticks;
      const targetTime = previousVideoTime + videoDelta * tick / ticks;
      const next = intermediate ? worldRects(level, targetTime) : current;
      advance(state, level, previous, next, duration / ticks, direction, scale);
      previous = next;
    }
    return state;
  }

  globalThis.FerryPhysics = { sampleRect, create, reset, step };
})();
