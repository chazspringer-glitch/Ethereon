/**
 * Ethereon - a tiny 2D RPG starter.
 *
 * Architecture:
 *   - Input:   tracks which keys are held and which were pressed this frame.
 *   - World:   tile-based map, larger than the viewport. Pluggable: swap
 *              `world.getTile` for a loader that reads a real tilemap.
 *   - Camera:  viewport into the world. Smoothly lerps toward the player
 *              and clamps to world bounds.
 *   - Player:  entity state (position, size, facing, stats).
 *   - Stats:   damagePlayer/healPlayer route through one place so future
 *              items and upgrades can apply modifiers in a single spot.
 *   - Attack:  self-contained combat module (state, timers, hitbox, draw).
 *   - Enemies: Enemy class + a flat array of instances.
 *   - Update:  advances game state based on time elapsed.
 *   - Draw:    renders world-space under a camera transform, then HUD.
 *   - Loop:    a requestAnimationFrame loop that calls update/draw every frame.
 *
 * Coordinate systems:
 *   - World space: where the player / enemies / tiles live (0..WORLD_W).
 *   - Screen space: canvas pixels (0..VIEW_W). HUD is drawn here.
 *
 * Everything is vanilla JS - no libraries.
 */

(() => {
    "use strict";

    // ---------------------------------------------------------------
    // Canvas / world dimensions
    //
    // VIEW_*  = size of the canvas (the camera's window on the world).
    // WORLD_* = size of the playable map (bigger than the viewport).
    // TILE    = size of a single world tile in pixels.
    // ---------------------------------------------------------------
    const canvas = document.getElementById("game");
    const ctx = canvas.getContext("2d");

    const VIEW_W = canvas.width;    // 800
    const VIEW_H = canvas.height;   // 600

    const TILE = 32;
    const WORLD_COLS = 75;          // 75 * 32 = 2400
    const WORLD_ROWS = 56;          // 56 * 32 = 1792
    const WORLD_W = TILE * WORLD_COLS;
    const WORLD_H = TILE * WORLD_ROWS;

    // ---------------------------------------------------------------
    // World - tile-based map, larger than the viewport.
    //
    // The map is stored in a flat Uint8Array (cols*rows tile IDs) for
    // fast access and cache-friendly iteration. `getTile` is the
    // extension seam: swap it for a JSON loader, a Tiled parser, or
    // anything else, and every other system keeps working.
    //
    // `draw(ctx, camera)` renders only tiles that intersect the
    // camera's view, so the world can grow without per-frame cost
    // scaling with total world size.
    // ---------------------------------------------------------------
    const TILE_GRASS = 0;
    const TILE_STONE = 1;
    const TILE_TREE = 2;
    const TILE_WATER = 3;
    const TILE_PATH = 4;

    // Cheap deterministic "hash" for procedural decoration. Stable
    // per (col, row) with no setup; replace with a real tilemap later.
    function hash2(x, y) {
        let h = (x * 374761393 + y * 668265263) | 0;
        h = (h ^ (h >>> 13)) * 1274126177;
        return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
    }

    const world = {
        cols: WORLD_COLS,
        rows: WORLD_ROWS,
        width: WORLD_W,
        height: WORLD_H,
        tileSize: TILE,
        data: new Uint8Array(WORLD_COLS * WORLD_ROWS),

        init() {
            for (let r = 0; r < WORLD_ROWS; r++) {
                for (let c = 0; c < WORLD_COLS; c++) {
                    const onBorder =
                        c === 0 || r === 0 ||
                        c === WORLD_COLS - 1 || r === WORLD_ROWS - 1;

                    let t = TILE_GRASS;
                    if (onBorder) {
                        t = TILE_STONE;
                    } else {
                        const h = hash2(c, r);
                        if (h < 0.035) t = TILE_TREE;
                        else if (h < 0.055) t = TILE_STONE;
                        else if (h > 0.975) t = TILE_PATH;
                    }
                    this.data[r * WORLD_COLS + c] = t;
                }
            }
        },

        getTile(col, row) {
            if (col < 0 || row < 0 || col >= WORLD_COLS || row >= WORLD_ROWS) {
                return TILE_STONE;
            }
            return this.data[row * WORLD_COLS + col];
        },

        // Extension point for per-tile collision. The world boundary
        // alone keeps the player on the map for now, but callers that
        // eventually want solid trees / water can rely on this API.
        isSolid(_col, _row) {
            return false;
        },

        draw(ctx, camera) {
            const startCol = Math.max(0, Math.floor(camera.x / TILE));
            const endCol = Math.min(
                WORLD_COLS - 1,
                Math.floor((camera.x + VIEW_W) / TILE)
            );
            const startRow = Math.max(0, Math.floor(camera.y / TILE));
            const endRow = Math.min(
                WORLD_ROWS - 1,
                Math.floor((camera.y + VIEW_H) / TILE)
            );

            for (let r = startRow; r <= endRow; r++) {
                for (let c = startCol; c <= endCol; c++) {
                    drawTile(
                        ctx,
                        this.data[r * WORLD_COLS + c],
                        c * TILE,
                        r * TILE
                    );
                }
            }
        },
    };

    // The one place that turns tile IDs into pixels. Replace the
    // fillRects here with drawImage(spriteSheet, ...) once art arrives.
    function drawTile(ctx, tile, x, y) {
        switch (tile) {
            case TILE_GRASS:
                ctx.fillStyle = "#3a5a3a";
                ctx.fillRect(x, y, TILE, TILE);
                ctx.fillStyle = "#456d44";
                ctx.fillRect(x + 3, y + TILE - 5, 3, 2);
                break;
            case TILE_PATH:
                ctx.fillStyle = "#8c7a55";
                ctx.fillRect(x, y, TILE, TILE);
                ctx.fillStyle = "#7a6846";
                ctx.fillRect(x + 6, y + 10, 4, 2);
                break;
            case TILE_STONE:
                ctx.fillStyle = "#5c5c6e";
                ctx.fillRect(x, y, TILE, TILE);
                ctx.fillStyle = "#6e6e82";
                ctx.fillRect(x + 4, y + 4, TILE - 8, TILE - 8);
                break;
            case TILE_WATER:
                ctx.fillStyle = "#3560a0";
                ctx.fillRect(x, y, TILE, TILE);
                break;
            case TILE_TREE:
                ctx.fillStyle = "#3a5a3a";
                ctx.fillRect(x, y, TILE, TILE);
                ctx.fillStyle = "#23422a";
                ctx.fillRect(x + 4, y + 2, TILE - 8, TILE - 8);
                ctx.fillStyle = "#5a3a22";
                ctx.fillRect(x + TILE / 2 - 2, y + TILE - 6, 4, 6);
                break;
            default:
                ctx.fillStyle = "#2a2a38";
                ctx.fillRect(x, y, TILE, TILE);
        }
    }

    world.init();

    // ---------------------------------------------------------------
    // Camera - viewport into the world.
    //
    // `follow` uses a frame-rate-independent exponential lerp so the
    // camera smoothly catches up to the player without the jitter you
    // get from naive `this.x += (target - this.x) * 0.1` per frame.
    // ---------------------------------------------------------------
    const camera = {
        x: 0,
        y: 0,
        sharpness: 8, // higher = snappier follow

        follow(target, dt) {
            const tx = target.x + target.width / 2 - VIEW_W / 2;
            const ty = target.y + target.height / 2 - VIEW_H / 2;

            const t = 1 - Math.exp(-this.sharpness * dt);
            this.x += (tx - this.x) * t;
            this.y += (ty - this.y) * t;

            this.clamp();
        },

        snap(target) {
            this.x = target.x + target.width / 2 - VIEW_W / 2;
            this.y = target.y + target.height / 2 - VIEW_H / 2;
            this.clamp();
        },

        clamp() {
            this.x = Math.max(0, Math.min(WORLD_W - VIEW_W, this.x));
            this.y = Math.max(0, Math.min(WORLD_H - VIEW_H, this.y));
        },
    };

    // ---------------------------------------------------------------
    // Sprite system
    //
    // Mirrors the shape of a real 2D engine without the framework:
    //
    //   SpriteSheet  - an image (real or offscreen canvas) sliced into
    //                  (col, row) frames of a fixed size.
    //   Animation    - an ordered list of column indices, a per-frame
    //                  duration, and a loop flag.
    //   Animator     - per-entity state: a dict of named Animations,
    //                  a current state ("idle" | "walk" | ...), and a
    //                  direction (row). Each entity owns its Animator
    //                  so frame timers don't collide.
    //
    // To add real art later, construct a SpriteSheet from an <img>
    // loaded via Image() - every other system keeps working.
    // ---------------------------------------------------------------
    const DIR_DOWN = 0;
    const DIR_UP = 1;
    const DIR_LEFT = 2;
    const DIR_RIGHT = 3;

    class SpriteSheet {
        constructor(image, frameW, frameH) {
            this.image = image;
            this.frameW = frameW;
            this.frameH = frameH;
        }

        draw(ctx, col, row, dx, dy) {
            ctx.drawImage(
                this.image,
                col * this.frameW, row * this.frameH,
                this.frameW, this.frameH,
                dx, dy,
                this.frameW, this.frameH
            );
        }
    }

    class Animation {
        constructor(frames, frameDuration = 0.12, loop = true) {
            this.frames = frames;           // column indices into a sheet row
            this.frameDuration = frameDuration;
            this.loop = loop;
            this.elapsed = 0;
            this.index = 0;
        }

        reset() {
            this.elapsed = 0;
            this.index = 0;
        }

        update(dt) {
            this.elapsed += dt;
            while (this.elapsed >= this.frameDuration) {
                this.elapsed -= this.frameDuration;
                this.index++;
                if (this.index >= this.frames.length) {
                    this.index = this.loop ? 0 : this.frames.length - 1;
                }
            }
        }

        currentFrame() {
            return this.frames[this.index];
        }
    }

    class Animator {
        constructor(clips, initialState = "idle") {
            this.clips = clips;         // { idle: Animation, walk: Animation, ... }
            this.state = initialState;
            this.dir = DIR_DOWN;
        }

        setState(state) {
            if (state === this.state) return;
            this.state = state;
            this.clips[state].reset();
        }

        setDir(dir) {
            this.dir = dir;
        }

        update(dt) {
            this.clips[this.state].update(dt);
        }

        get col() {
            return this.clips[this.state].currentFrame();
        }

        get row() {
            return this.dir;
        }
    }

    // Helper: pick a cardinal direction from a motion vector. Returns
    // null for (0, 0) so callers can keep the previous facing.
    function dirFromVector(dx, dy) {
        if (dx === 0 && dy === 0) return null;
        if (Math.abs(dx) > Math.abs(dy)) {
            return dx > 0 ? DIR_RIGHT : DIR_LEFT;
        }
        return dy > 0 ? DIR_DOWN : DIR_UP;
    }

    // ---------------------------------------------------------------
    // Sprite sheet generation (placeholder art)
    //
    // Real art would be loaded with `new Image()` and pointed at a
    // PNG. Until then, we draw a tiny "sprite sheet" onto an offscreen
    // canvas at boot. Layout is 4 columns x 4 rows:
    //
    //   row = direction  (down, up, left, right)
    //   col = frame      (0 = idle, 1..3 = walk cycle)
    // ---------------------------------------------------------------
    const FRAME_W = 32;
    const FRAME_H = 32;

    function makeSheetCanvas() {
        const c = document.createElement("canvas");
        c.width = FRAME_W * 4;
        c.height = FRAME_H * 4;
        return c;
    }

    function drawPlayerFrame(ctx, dir, frame, ox, oy) {
        // Shadow
        ctx.fillStyle = "rgba(0, 0, 0, 0.28)";
        ctx.beginPath();
        ctx.ellipse(ox + 16, oy + 29, 8, 3, 0, 0, Math.PI * 2);
        ctx.fill();

        // Vertical bob on the "up" steps of the walk cycle.
        const bob = frame === 1 ? -1 : frame === 3 ? -1 : 0;

        // Tunic / body
        ctx.fillStyle = "#3a7d3a";
        ctx.fillRect(ox + 10, oy + 14 + bob, 12, 10);
        ctx.fillStyle = "#2f5f2f";
        ctx.fillRect(ox + 10, oy + 22 + bob, 12, 2);

        // Head
        ctx.fillStyle = "#e8c096";
        ctx.fillRect(ox + 11, oy + 7 + bob, 10, 8);

        // Hair (direction-aware)
        ctx.fillStyle = "#ffd166";
        if (dir === DIR_DOWN) {
            ctx.fillRect(ox + 11, oy + 6 + bob, 10, 3);
            ctx.fillRect(ox + 10, oy + 8 + bob, 2, 3);
            ctx.fillRect(ox + 20, oy + 8 + bob, 2, 3);
        } else if (dir === DIR_UP) {
            ctx.fillRect(ox + 11, oy + 6 + bob, 10, 5);
        } else if (dir === DIR_LEFT) {
            ctx.fillRect(ox + 10, oy + 6 + bob, 9, 4);
            ctx.fillRect(ox + 10, oy + 9 + bob, 3, 3);
        } else { // DIR_RIGHT
            ctx.fillRect(ox + 13, oy + 6 + bob, 9, 4);
            ctx.fillRect(ox + 19, oy + 9 + bob, 3, 3);
        }

        // Eyes (hidden when facing away)
        if (dir !== DIR_UP) {
            ctx.fillStyle = "#1a1a24";
            const eyeY = oy + 11 + bob;
            if (dir === DIR_DOWN) {
                ctx.fillRect(ox + 13, eyeY, 2, 2);
                ctx.fillRect(ox + 17, eyeY, 2, 2);
            } else if (dir === DIR_LEFT) {
                ctx.fillRect(ox + 12, eyeY, 2, 2);
            } else {
                ctx.fillRect(ox + 18, eyeY, 2, 2);
            }
        }

        // Legs - swap which foot leads on each walk step
        ctx.fillStyle = "#2f5f2f";
        const legY = oy + 24;
        if (frame === 1) {
            ctx.fillRect(ox + 11, legY, 3, 4);
            ctx.fillRect(ox + 18, legY - 1, 3, 5);
        } else if (frame === 2) {
            ctx.fillRect(ox + 11, legY - 1, 3, 5);
            ctx.fillRect(ox + 18, legY, 3, 4);
        } else {
            ctx.fillRect(ox + 11, legY, 3, 4);
            ctx.fillRect(ox + 18, legY, 3, 4);
        }
    }

    function drawEnemyFrame(ctx, dir, frame, ox, oy) {
        // Shadow
        ctx.fillStyle = "rgba(0, 0, 0, 0.28)";
        ctx.beginPath();
        ctx.ellipse(ox + 16, oy + 29, 10, 3, 0, 0, Math.PI * 2);
        ctx.fill();

        // Gentle squash/stretch for a hopping slime feel.
        const squash = frame === 1 || frame === 3 ? 1 : 0;

        // Body
        ctx.fillStyle = "#c84a4a";
        ctx.fillRect(ox + 7, oy + 12 + squash, 18, 14 - squash);
        ctx.fillStyle = "#a03030";
        ctx.fillRect(ox + 7, oy + 24, 18, 2);

        // Highlights
        ctx.fillStyle = "#e06666";
        ctx.fillRect(ox + 10, oy + 14 + squash, 3, 2);

        // Eyes (direction-aware)
        ctx.fillStyle = "#ffffff";
        if (dir === DIR_DOWN) {
            ctx.fillRect(ox + 11, oy + 17 + squash, 3, 3);
            ctx.fillRect(ox + 18, oy + 17 + squash, 3, 3);
            ctx.fillStyle = "#1a1a24";
            ctx.fillRect(ox + 12, oy + 18 + squash, 1, 1);
            ctx.fillRect(ox + 19, oy + 18 + squash, 1, 1);
        } else if (dir === DIR_UP) {
            // facing away - no eyes
        } else if (dir === DIR_LEFT) {
            ctx.fillRect(ox + 9, oy + 17 + squash, 3, 3);
            ctx.fillStyle = "#1a1a24";
            ctx.fillRect(ox + 9, oy + 18 + squash, 1, 1);
        } else {
            ctx.fillRect(ox + 20, oy + 17 + squash, 3, 3);
            ctx.fillStyle = "#1a1a24";
            ctx.fillRect(ox + 22, oy + 18 + squash, 1, 1);
        }
    }

    function buildSheet(drawFrame) {
        const sheetCanvas = makeSheetCanvas();
        const sctx = sheetCanvas.getContext("2d");
        for (let dir = 0; dir < 4; dir++) {
            for (let frame = 0; frame < 4; frame++) {
                drawFrame(sctx, dir, frame, frame * FRAME_W, dir * FRAME_H);
            }
        }
        return new SpriteSheet(sheetCanvas, FRAME_W, FRAME_H);
    }

    const playerSheet = buildSheet(drawPlayerFrame);
    const enemySheet = buildSheet(drawEnemyFrame);

    // Convenience factories - each call returns a fresh Animator so
    // every entity has its own frame timer.
    function makePlayerAnimator() {
        return new Animator({
            idle: new Animation([0], 1.0, true),
            walk: new Animation([1, 0, 2, 0], 0.12, true),
        }, "idle");
    }

    function makeEnemyAnimator() {
        return new Animator({
            idle: new Animation([0], 1.0, true),
            walk: new Animation([1, 0, 2, 0], 0.18, true),
        }, "walk");
    }

    // ---------------------------------------------------------------
    // Input - tracks keys held down AND keys pressed this frame
    // (edge-triggered). `keysJustPressed` is cleared at the end of
    // each update so actions like "attack" only fire once per press.
    // ---------------------------------------------------------------
    const keys = Object.create(null);
    const keysJustPressed = Object.create(null);

    window.addEventListener("keydown", (e) => {
        if (!keys[e.key]) keysJustPressed[e.key] = true;
        keys[e.key] = true;
        // Stop the page from scrolling with arrow keys or space.
        if (e.key.startsWith("Arrow") || e.key === " ") e.preventDefault();
    });

    window.addEventListener("keyup", (e) => {
        keys[e.key] = false;
    });

    function clearJustPressed() {
        for (const k in keysJustPressed) delete keysJustPressed[k];
    }

    // ---------------------------------------------------------------
    // Player entity
    //   `facing` is a unit vector pointing in the direction the player
    //   last moved. It's used to position the attack hitbox.
    // ---------------------------------------------------------------
    const player = {
        x: WORLD_W / 2 - 16,
        y: WORLD_H / 2 - 16,
        width: 32,
        height: 32,
        speed: 220, // pixels per second
        color: "#ffd166", // kept as a fallback / tint hook for future use
        facing: { x: 0, y: 1 }, // unit vector used by the attack
        facingDir: DIR_DOWN,    // cardinal used by the animator

        // Sprite + animation
        sheet: playerSheet,
        animator: makePlayerAnimator(),

        // --- Stats (extend here for future items / upgrades) ---
        hp: 100,
        maxHp: 100,
        alive: true,

        // Invincibility frames after taking a hit.
        iframes: 0,
        iframeDuration: 0.8,

        // Hook point for future modifiers. Items or upgrades can push
        // functions here that take (amount) and return a modified amount
        // (e.g. armor reduction, damage resistance).
        damageModifiers: [],
    };

    // ---------------------------------------------------------------
    // Stats helpers - the single place damage / healing flows through.
    // Future items ("Leather Vest: -2 damage taken") plug in here
    // rather than scattering HP math around the codebase.
    // ---------------------------------------------------------------
    function damagePlayer(amount) {
        if (!player.alive || player.iframes > 0) return;

        let final = amount;
        for (const mod of player.damageModifiers) final = mod(final);
        final = Math.max(0, final);
        if (final === 0) return;

        player.hp = Math.max(0, player.hp - final);
        player.iframes = player.iframeDuration;

        if (player.hp <= 0) player.alive = false;
    }

    function healPlayer(amount) {
        if (!player.alive) return;
        player.hp = Math.min(player.maxHp, player.hp + amount);
    }

    // ---------------------------------------------------------------
    // Attack module
    //
    // A single, self-contained piece of state describing the player's
    // current attack. Designed so you can later swap the flat "hitbox
    // rectangle" for an animated sprite by reading `attack.progress`
    // (0 -> 1 over the life of the swing) to pick a frame.
    //
    // Tunables:
    //   duration  - how long the hitbox is active (seconds)
    //   cooldown  - time before the player can attack again (seconds)
    //   reach     - how far the hitbox extends in front of the player
    //   thickness - perpendicular size of the hitbox
    // ---------------------------------------------------------------
    const attack = {
        // Tunables
        duration: 0.18,
        cooldown: 0.35,
        reach: 36,
        thickness: 40,

        // Runtime state
        active: false,
        timer: 0,          // counts down while active
        cooldownTimer: 0,  // counts down after an attack
        progress: 0,       // 0 -> 1 over duration; useful for animations

        // Latched facing for the current swing so rotating the player
        // mid-swing doesn't teleport the hitbox.
        dirX: 1,
        dirY: 0,

        // Tracks which enemies the current swing has already hit, so
        // one swing can't damage the same enemy on multiple frames.
        hitEnemies: new Set(),

        tryStart(entity) {
            if (this.active || this.cooldownTimer > 0) return false;
            this.active = true;
            this.timer = this.duration;
            this.progress = 0;
            this.dirX = entity.facing.x;
            this.dirY = entity.facing.y;
            this.hitEnemies.clear();
            return true;
        },

        update(dt) {
            if (this.active) {
                this.timer -= dt;
                this.progress = 1 - Math.max(0, this.timer) / this.duration;
                if (this.timer <= 0) {
                    this.active = false;
                    this.timer = 0;
                    this.progress = 1;
                    this.cooldownTimer = this.cooldown;
                }
            } else if (this.cooldownTimer > 0) {
                this.cooldownTimer = Math.max(0, this.cooldownTimer - dt);
            }
        },

        // Returns the current hitbox as an axis-aligned rect, or null
        // if the attack isn't active. Other systems (enemy collision,
        // damage numbers, etc.) can consume this.
        getHitbox(entity) {
            if (!this.active) return null;

            // Horizontal vs. vertical swing based on latched facing.
            const horizontal = Math.abs(this.dirX) >= Math.abs(this.dirY);

            const w = horizontal ? this.reach : this.thickness;
            const h = horizontal ? this.thickness : this.reach;

            const cx = entity.x + entity.width / 2;
            const cy = entity.y + entity.height / 2;

            let x, y;
            if (horizontal) {
                const sign = Math.sign(this.dirX) || 1;
                x = sign > 0 ? entity.x + entity.width : entity.x - w;
                y = cy - h / 2;
            } else {
                const sign = Math.sign(this.dirY) || 1;
                x = cx - w / 2;
                y = sign > 0 ? entity.y + entity.height : entity.y - h;
            }

            return { x, y, w, h };
        },

        draw(ctx, entity) {
            const box = this.getHitbox(entity);
            if (!box) return;

            // Fade out over the life of the swing so it reads as a
            // quick slash. When you later add sprites, replace this
            // whole block with a frame lookup using `this.progress`.
            const alpha = 1 - this.progress;
            ctx.fillStyle = `rgba(255, 90, 90, ${0.35 + 0.35 * alpha})`;
            ctx.fillRect(box.x, box.y, box.w, box.h);

            ctx.strokeStyle = `rgba(255, 220, 220, ${0.6 + 0.4 * alpha})`;
            ctx.lineWidth = 2;
            ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1);
        },
    };

    // ---------------------------------------------------------------
    // Geometry helpers
    // ---------------------------------------------------------------
    // AABB overlap. Uses {x, y, w, h}. Cheap; safe to call per enemy.
    function rectsOverlap(a, b) {
        return (
            a.x < b.x + b.w &&
            a.x + a.w > b.x &&
            a.y < b.y + b.h &&
            a.y + a.h > b.y
        );
    }

    // ---------------------------------------------------------------
    // Enemy class
    //
    // Each enemy is a small stateful object that moves toward a
    // target (the player) each frame. Kept as a class so multiple
    // enemies - or later subclasses like RangedEnemy, BossEnemy -
    // can share this interface.
    //
    // `alive` acts as a tombstone; the enemies array is compacted
    // once per frame so dead enemies don't linger in memory.
    // ---------------------------------------------------------------
    class Enemy {
        constructor(x, y, opts = {}) {
            this.x = x;
            this.y = y;
            this.width = opts.width ?? 32;
            this.height = opts.height ?? 32;
            this.speed = opts.speed ?? 90;
            this.hp = opts.hp ?? 1;
            this.maxHp = this.hp;
            this.alive = true;

            // Sprite + animation (each enemy owns its own animator so
            // their walk cycles aren't locked in lockstep).
            this.sheet = opts.sheet ?? enemySheet;
            this.animator = opts.animator ?? makeEnemyAnimator();
        }

        update(dt, target) {
            if (!this.alive) return;

            // Steer toward the target's center using a unit vector,
            // so diagonal approach isn't faster than cardinal approach.
            const cx = this.x + this.width / 2;
            const cy = this.y + this.height / 2;
            const tx = target.x + target.width / 2;
            const ty = target.y + target.height / 2;

            const dx = tx - cx;
            const dy = ty - cy;
            const dist = Math.hypot(dx, dy);

            let moving = false;
            if (dist > 0.5) {
                const inv = 1 / dist;
                this.x += dx * inv * this.speed * dt;
                this.y += dy * inv * this.speed * dt;
                moving = true;

                const d = dirFromVector(dx, dy);
                if (d !== null) this.animator.setDir(d);
            }

            this.animator.setState(moving ? "walk" : "idle");
            this.animator.update(dt);
        }

        draw(ctx) {
            if (!this.alive) return;
            this.sheet.draw(
                ctx,
                this.animator.col,
                this.animator.row,
                Math.round(this.x),
                Math.round(this.y)
            );

            // Tiny HP pip so future multi-hit enemies are readable.
            if (this.maxHp > 1) {
                const frac = Math.max(0, this.hp / this.maxHp);
                ctx.fillStyle = "#1a1a24";
                ctx.fillRect(this.x, this.y - 6, this.width, 3);
                ctx.fillStyle = "#7ad17a";
                ctx.fillRect(this.x, this.y - 6, this.width * frac, 3);
            }
        }

        takeHit(damage = 1) {
            this.hp -= damage;
            if (this.hp <= 0) this.alive = false;
        }

        // Expose a rect in the shape used by rectsOverlap/getHitbox.
        bounds() {
            return { x: this.x, y: this.y, w: this.width, h: this.height };
        }
    }

    // ---------------------------------------------------------------
    // Enemy spawning
    // ---------------------------------------------------------------
    const enemies = [];

    function spawnEnemy(x, y, opts) {
        enemies.push(new Enemy(x, y, opts));
    }

    // Spawn a starting group in a ring around the player's spawn so
    // the player always has something on screen at the start.
    {
        const cx = WORLD_W / 2;
        const cy = WORLD_H / 2;
        spawnEnemy(cx - 220, cy - 160);
        spawnEnemy(cx + 200, cy - 160);
        spawnEnemy(cx - 220, cy + 140);
        spawnEnemy(cx + 200, cy + 140);
        spawnEnemy(cx + 360, cy);
        spawnEnemy(cx - 380, cy);
    }

    // Place the camera on the player before the first frame so we
    // don't see it lerp in from (0, 0).
    camera.snap(player);

    // ---------------------------------------------------------------
    // Enemy update + collision with the player's attack
    // ---------------------------------------------------------------
    function updateEnemies(dt) {
        // Reverse iteration lets us splice dead enemies cheaply.
        for (let i = enemies.length - 1; i >= 0; i--) {
            const e = enemies[i];
            e.update(dt, player);
            if (!e.alive) enemies.splice(i, 1);
        }
    }

    function updateAttackCollision() {
        if (!attack.active) return;
        const box = attack.getHitbox(player);
        if (!box) return;

        for (const e of enemies) {
            if (!e.alive || attack.hitEnemies.has(e)) continue;
            if (rectsOverlap(box, e.bounds())) {
                e.takeHit(1);
                attack.hitEnemies.add(e);
            }
        }
    }

    // Enemy bodies touching the player deal contact damage. `damagePlayer`
    // is a no-op while iframes are active, so one collision won't drain
    // the whole bar.
    function updateEnemyContact() {
        if (!player.alive) return;
        const playerBox = {
            x: player.x,
            y: player.y,
            w: player.width,
            h: player.height,
        };
        for (const e of enemies) {
            if (!e.alive) continue;
            if (rectsOverlap(playerBox, e.bounds())) {
                damagePlayer(10);
                break; // one damage event per frame is enough
            }
        }
    }

    // Ticks down the player's invincibility timer each frame.
    function updatePlayerStatus(dt) {
        if (player.iframes > 0) {
            player.iframes = Math.max(0, player.iframes - dt);
        }
    }

    // ---------------------------------------------------------------
    // Movement - reads input, moves the player, updates facing.
    // ---------------------------------------------------------------
    function updateMovement(dt) {
        if (!player.alive) return;

        let dx = 0;
        let dy = 0;

        if (keys["ArrowLeft"]) dx -= 1;
        if (keys["ArrowRight"]) dx += 1;
        if (keys["ArrowUp"]) dy -= 1;
        if (keys["ArrowDown"]) dy += 1;

        // Normalize diagonal movement so it isn't faster than cardinal movement.
        if (dx !== 0 && dy !== 0) {
            const inv = 1 / Math.SQRT2;
            dx *= inv;
            dy *= inv;
        }

        // Update facing (vector for attack, cardinal for animation).
        const moving = dx !== 0 || dy !== 0;
        if (moving) {
            player.facing.x = dx;
            player.facing.y = dy;

            const d = dirFromVector(dx, dy);
            if (d !== null) {
                player.facingDir = d;
                player.animator.setDir(d);
            }
        }

        player.animator.setState(moving ? "walk" : "idle");
        player.animator.update(dt);

        player.x += dx * player.speed * dt;
        player.y += dy * player.speed * dt;

        // Clamp the player inside the world, not the viewport.
        player.x = Math.max(0, Math.min(WORLD_W - player.width, player.x));
        player.y = Math.max(0, Math.min(WORLD_H - player.height, player.y));
    }

    // ---------------------------------------------------------------
    // Combat input - trigger attacks on SPACE, once per press.
    // ---------------------------------------------------------------
    function updateCombatInput() {
        if (!player.alive) return;
        if (keysJustPressed[" "] || keysJustPressed["Spacebar"]) {
            attack.tryStart(player);
        }
    }

    // ---------------------------------------------------------------
    // Update - top-level tick. Keeps sub-systems in a clear order.
    // ---------------------------------------------------------------
    function update(dt) {
        updateMovement(dt);
        updateCombatInput();
        attack.update(dt);
        updateEnemies(dt);
        updateAttackCollision();
        updateEnemyContact();
        updatePlayerStatus(dt);
        camera.follow(player, dt);
        clearJustPressed();
    }

    // ---------------------------------------------------------------
    // Draw - paint the current state. No logic lives here.
    // ---------------------------------------------------------------
    function draw() {
        // Screen-space safety fill (visible only if the camera ever
        // somehow leaves the world; clamping should prevent it).
        ctx.fillStyle = "#1a1a24";
        ctx.fillRect(0, 0, VIEW_W, VIEW_H);

        // --- World space ---
        // Round the translate to whole pixels to avoid tile-seam
        // shimmering when the camera is sub-pixel offset.
        ctx.save();
        ctx.translate(-Math.round(camera.x), -Math.round(camera.y));

        world.draw(ctx, camera);

        // Enemies beneath the player so the player always reads on top.
        for (const e of enemies) e.draw(ctx);

        // Player - skipped on alternating "blinks" while in iframes
        // to give a classic invulnerability flash.
        drawPlayer();

        // Attack hitbox on top of the player.
        attack.draw(ctx, player);

        ctx.restore();

        // --- Screen space (HUD) ---
        drawHealthBar();
        drawCooldownBar();
        drawEnemyCounter();

        if (!player.alive) drawGameOver();
    }

    function drawPlayer() {
        // Blink at ~10Hz while invulnerable.
        if (player.iframes > 0 && Math.floor(player.iframes * 20) % 2 === 0) {
            return;
        }
        player.sheet.draw(
            ctx,
            player.animator.col,
            player.animator.row,
            Math.round(player.x),
            Math.round(player.y)
        );
    }

    function drawHealthBar() {
        const barW = 180;
        const barH = 14;
        const x = 16;
        const y = 16;

        const frac = Math.max(0, player.hp / player.maxHp);

        // Background
        ctx.fillStyle = "#1a1a24";
        ctx.fillRect(x, y, barW, barH);
        // Fill (green -> orange -> red as it drops)
        ctx.fillStyle = frac > 0.5 ? "#7ad17a" : frac > 0.25 ? "#e0b066" : "#e06666";
        ctx.fillRect(x, y, barW * frac, barH);
        // Border
        ctx.strokeStyle = "#444458";
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, barW - 1, barH - 1);

        // Numeric readout
        ctx.fillStyle = "#e8e8f0";
        ctx.font = "12px system-ui, sans-serif";
        ctx.textBaseline = "middle";
        ctx.fillText(`HP  ${Math.ceil(player.hp)} / ${player.maxHp}`, x + barW + 10, y + barH / 2);
        ctx.textBaseline = "alphabetic"; // restore default for other text
    }

    function drawGameOver() {
        ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
        ctx.fillRect(0, 0, VIEW_W, VIEW_H);

        ctx.fillStyle = "#ffd166";
        ctx.font = "bold 48px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("GAME OVER", VIEW_W / 2, VIEW_H / 2);

        ctx.fillStyle = "#a0a0b8";
        ctx.font = "14px system-ui, sans-serif";
        ctx.fillText("Refresh the page to try again", VIEW_W / 2, VIEW_H / 2 + 32);
        ctx.textAlign = "start"; // restore default
    }

    function drawEnemyCounter() {
        ctx.fillStyle = "#a0a0b8";
        ctx.font = "12px system-ui, sans-serif";
        ctx.fillText(`Enemies: ${enemies.length}`, VIEW_W - 96, VIEW_H - 16);
    }

    function drawCooldownBar() {
        const barW = 120;
        const barH = 8;
        const x = 16;
        const y = VIEW_H - 24;

        const ready = !attack.active && attack.cooldownTimer <= 0;
        const fill = ready
            ? 1
            : attack.active
                ? 0
                : 1 - attack.cooldownTimer / attack.cooldown;

        ctx.fillStyle = "#1a1a24";
        ctx.fillRect(x, y, barW, barH);
        ctx.fillStyle = ready ? "#7ad17a" : "#d17a7a";
        ctx.fillRect(x, y, barW * fill, barH);
        ctx.strokeStyle = "#444458";
        ctx.strokeRect(x + 0.5, y + 0.5, barW - 1, barH - 1);

        ctx.fillStyle = "#a0a0b8";
        ctx.font = "12px system-ui, sans-serif";
        ctx.fillText("Attack (SPACE)", x, y - 4);
    }

    // ---------------------------------------------------------------
    // Main loop
    // ---------------------------------------------------------------
    let lastTime = performance.now();

    function frame(now) {
        // Convert ms -> s, cap dt to avoid huge jumps after a tab switch.
        const dt = Math.min((now - lastTime) / 1000, 1 / 30);
        lastTime = now;

        update(dt);
        draw();

        requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
})();
