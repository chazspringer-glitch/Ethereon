/**
 * Ethereon - a tiny 2D RPG starter.
 *
 * Architecture:
 *   - Input:  keeps track of which keys are currently pressed.
 *   - Update: advances game state based on time elapsed.
 *   - Draw:   renders the current game state to the canvas.
 *   - Loop:   a requestAnimationFrame loop that calls update/draw every frame.
 *
 * Everything is vanilla JS - no libraries. Expand by adding new entities,
 * collision, maps, enemies, etc. in their own clearly-named sections.
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
    // Input - tracks which keys are held down this frame
    // ---------------------------------------------------------------
    const keys = Object.create(null);

    window.addEventListener("keydown", (e) => {
        keys[e.key] = true;
        // Stop the page from scrolling when arrow keys are used.
        if (e.key.startsWith("Arrow")) e.preventDefault();
    });

    window.addEventListener("keyup", (e) => {
        keys[e.key] = false;
    });

    // ---------------------------------------------------------------
    // Player entity
    // ---------------------------------------------------------------
    const player = {
        x: WIDTH / 2 - 16,
        y: HEIGHT / 2 - 16,
        width: 32,
        height: 32,
        speed: 220, // pixels per second
        color: "#ffd166",
    };

    // ---------------------------------------------------------------
    // Update - pure game-state changes. `dt` is delta time in seconds.
    // ---------------------------------------------------------------
    function update(dt) {
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

        player.x += dx * player.speed * dt;
        player.y += dy * player.speed * dt;

        // Clamp the player inside the canvas.
        player.x = Math.max(0, Math.min(WIDTH - player.width, player.x));
        player.y = Math.max(0, Math.min(HEIGHT - player.height, player.y));
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

        // Player
        ctx.fillStyle = player.color;
        ctx.fillRect(player.x, player.y, player.width, player.height);
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
