/**
 * Ethereon - a tiny 2D RPG starter.
 *
 * Architecture:
 *   - Input:   tracks which keys are held and which were pressed this frame.
 *   - Player:  entity state (position, size, facing direction).
 *   - Attack:  self-contained combat module (state, timers, hitbox, draw).
 *   - Enemies: Enemy class + a flat array of instances.
 *   - Update:  advances game state based on time elapsed.
 *   - Draw:    renders the current game state to the canvas.
 *   - Loop:    a requestAnimationFrame loop that calls update/draw every frame.
 *
 * Everything is vanilla JS - no libraries. Expand by adding new entities,
 * collision, maps, etc. in their own clearly-named sections.
 */

(() => {
    "use strict";

    // ---------------------------------------------------------------
    // Canvas setup
    // ---------------------------------------------------------------
    const canvas = document.getElementById("game");
    const ctx = canvas.getContext("2d");

    const WIDTH = canvas.width;   // 800
    const HEIGHT = canvas.height; // 600

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
        x: WIDTH / 2 - 16,
        y: HEIGHT / 2 - 16,
        width: 32,
        height: 32,
        speed: 220, // pixels per second
        color: "#ffd166",
        facing: { x: 1, y: 0 }, // default: facing right
    };

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
            this.width = opts.width ?? 28;
            this.height = opts.height ?? 28;
            this.speed = opts.speed ?? 90;
            this.color = opts.color ?? "#e06666";
            this.hp = opts.hp ?? 1;
            this.maxHp = this.hp;
            this.alive = true;
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

            if (dist > 0.5) {
                const inv = 1 / dist;
                this.x += dx * inv * this.speed * dt;
                this.y += dy * inv * this.speed * dt;
            }
        }

        draw(ctx) {
            if (!this.alive) return;
            ctx.fillStyle = this.color;
            ctx.fillRect(this.x, this.y, this.width, this.height);

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

    // Spawn a starting group at the four corners of the arena.
    spawnEnemy(60, 60);
    spawnEnemy(WIDTH - 90, 60);
    spawnEnemy(60, HEIGHT - 90);
    spawnEnemy(WIDTH - 90, HEIGHT - 90);

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

    // ---------------------------------------------------------------
    // Movement - reads input, moves the player, updates facing.
    // ---------------------------------------------------------------
    function updateMovement(dt) {
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

        // Update facing to the most recent movement direction.
        if (dx !== 0 || dy !== 0) {
            player.facing.x = dx;
            player.facing.y = dy;
        }

        player.x += dx * player.speed * dt;
        player.y += dy * player.speed * dt;

        // Clamp the player inside the canvas.
        player.x = Math.max(0, Math.min(WIDTH - player.width, player.x));
        player.y = Math.max(0, Math.min(HEIGHT - player.height, player.y));
    }

    // ---------------------------------------------------------------
    // Combat input - trigger attacks on SPACE, once per press.
    // ---------------------------------------------------------------
    function updateCombatInput() {
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
        clearJustPressed();
    }

    // ---------------------------------------------------------------
    // Draw - paint the current state. No logic lives here.
    // ---------------------------------------------------------------
    function draw() {
        // Background
        ctx.fillStyle = "#2a2a38";
        ctx.fillRect(0, 0, WIDTH, HEIGHT);

        // A simple grid to give a sense of movement.
        drawGrid(32, "#33334a");

        // Enemies beneath the player so the player always reads on top.
        for (const e of enemies) e.draw(ctx);

        // Player
        ctx.fillStyle = player.color;
        ctx.fillRect(player.x, player.y, player.width, player.height);

        // Attack hitbox on top of the player.
        attack.draw(ctx, player);

        // HUD
        drawCooldownBar();
        drawEnemyCounter();
    }

    function drawEnemyCounter() {
        ctx.fillStyle = "#a0a0b8";
        ctx.font = "12px system-ui, sans-serif";
        ctx.fillText(`Enemies: ${enemies.length}`, WIDTH - 96, HEIGHT - 16);
    }

    function drawGrid(cellSize, color) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let x = 0; x <= WIDTH; x += cellSize) {
            ctx.moveTo(x + 0.5, 0);
            ctx.lineTo(x + 0.5, HEIGHT);
        }
        for (let y = 0; y <= HEIGHT; y += cellSize) {
            ctx.moveTo(0, y + 0.5);
            ctx.lineTo(WIDTH, y + 0.5);
        }
        ctx.stroke();
    }

    function drawCooldownBar() {
        const barW = 120;
        const barH = 8;
        const x = 16;
        const y = HEIGHT - 24;

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
