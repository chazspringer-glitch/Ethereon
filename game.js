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

    // Live viewport dimensions. Updated by `resizeDisplay()` whenever
    // the window changes size or rotates. HUD positions, button
    // layouts, camera clamping, and input coordinate math all read
    // these at access time, so they reflow automatically.
    let VIEW_W = canvas.width;    // overwritten on first resize
    let VIEW_H = canvas.height;

    // ---------------------------------------------------------------
    // Responsive display sizing
    //
    // The canvas's *internal* resolution now matches the viewport's
    // aspect ratio (anchored to a ~960px long side) so CSS can fill
    // the entire screen at 1:1 scale - no distortion, no letterbox
    // bars. Every piece of UI reads VIEW_W / VIEW_H so the HUD
    // reflows naturally across landscape desktop and portrait mobile.
    //
    // Things that care about layout register via `onLayout(fn)` and
    // get called on every resize (and once at boot). Buttons use
    // this to reposition against the new viewport edges.
    // ---------------------------------------------------------------
    const LONG_SIDE = 960;       // reference long-axis resolution
    const MIN_SHORT_SIDE = 480;  // don't render so thin that HUD overlaps

    const layoutCallbacks = [];
    function onLayout(fn) {
        layoutCallbacks.push(fn);
    }

    function resizeDisplay() {
        const ww = Math.max(1, window.innerWidth);
        const wh = Math.max(1, window.innerHeight);

        let w, h;
        if (ww >= wh) {
            // Landscape: long axis is width.
            w = LONG_SIDE;
            h = Math.round(LONG_SIDE * wh / ww);
        } else {
            // Portrait: long axis is height.
            h = LONG_SIDE;
            w = Math.round(LONG_SIDE * ww / wh);
        }

        // Clamp the short axis so extremely narrow viewports don't
        // crush the HUD beyond usability.
        if (w < MIN_SHORT_SIDE && h >= w) w = MIN_SHORT_SIDE;
        if (h < MIN_SHORT_SIDE && w >= h) h = MIN_SHORT_SIDE;

        // Assigning canvas.width/height resets the 2D context - that's
        // fine because we redraw every frame, but the next paint will
        // pick up whatever fillStyle etc. we set then.
        canvas.width = w;
        canvas.height = h;
        VIEW_W = w;
        VIEW_H = h;

        // Invalidate the cached bounding rect used by pointer events,
        // and re-run every layout-dependent module's callback.
        invalidateCanvasRect();
        for (const fn of layoutCallbacks) fn();
    }

    // Cached canvas bounding rect used by `pointerToCanvas`. Declared
    // up here so `resizeDisplay` can invalidate it; the pointer-math
    // block further down uses the same reference.
    let _canvasRect = null;
    function invalidateCanvasRect() { _canvasRect = null; }

    window.addEventListener("resize", resizeDisplay);
    window.addEventListener("orientationchange", resizeDisplay);
    resizeDisplay();

    const TILE = 32;
    // Default (outdoor) zone size. Interiors override via level.cols/rows.
    // These are `let` so `world.load` can resize the playable area
    // between zones - the tile buffer itself is allocated once at the
    // max dimensions below and only the first (cols * rows) entries
    // are touched for smaller levels.
    const MAX_WORLD_COLS = 75;          // 75 * 32 = 2400
    const MAX_WORLD_ROWS = 56;          // 56 * 32 = 1792
    let WORLD_COLS = MAX_WORLD_COLS;
    let WORLD_ROWS = MAX_WORLD_ROWS;
    let WORLD_W = TILE * WORLD_COLS;
    let WORLD_H = TILE * WORLD_ROWS;

    // ---------------------------------------------------------------
    // Game state machine
    //
    //   "intro"    - cinematic title screen, world frozen
    //   "playing"  - normal gameplay
    //   "gameover" - player dead, world frozen, restart button up
    //
    // One enum driving update + draw keeps the "what's running right
    // now?" decision in a single obvious place.
    // ---------------------------------------------------------------
    let gameState = "intro";
    const introStart = performance.now();

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

    // ---------------------------------------------------------------
    // LEVELS catalog
    //
    // Each level is a data-only description of a zone: how its tiles
    // are laid out, what enemies spawn in it, which sides have exits
    // to other levels, and whether the NPC shows up. Adding a zone is
    // one object in this catalog plus an `exits` link from a neighbor.
    //
    //   id           unique key
    //   name         display name (shown as a toast on entry)
    //   baseTile     dominant floor tile
    //   borderTile   tile used for the outer wall
    //   scatter      array of { tile, prob } for procedural decoration;
    //                evaluated in order, first match wins
    //   enemyCount   gameplay-tuned population target for this zone
    //   enemyOpts    passed through to each Enemy constructor
    //   exits        { north|south|east|west: "<levelId>" }
    //   hasNpc       whether the Village Elder stands here
    // ---------------------------------------------------------------
    // Populated after NPC_TEMPLATES below so grove can reference
    // concrete NPC instances. Exits, safety, and enemy config are
    // spelled out in one place per zone.
    const LEVELS = {
        grove: {
            id: "grove",
            name: "Sunlit Grove",
            safe: true,               // combat disabled; NPC city
            baseTile: TILE_GRASS,
            borderTile: TILE_STONE,
            // Scatter table is the fallback for any tile the tileFn
            // below doesn't handle - kept near-empty so the designed
            // layout reads clearly.
            scatter: [],
            // Designed town layout:
            //   main east-west stone path across the middle
            //   short path north to the shop door
            //   stone plaza south of center with a water fountain
            //   four dense tree groves in the corners
            //   a few scattered stones + rare flower-trees elsewhere
            tileFn(c, r, cols, rows) {
                const cx = Math.floor(cols / 2);      // 37
                const cy = Math.floor(rows / 2);      // 28
                const plazaR = cy + 4;                // plaza row center
                const shopDoorC = 31;                 // matches the shop door tile
                const shopDoorR = 27;

                // Fountain: water pool at plaza center
                if (c === cx && r === plazaR) return TILE_WATER;

                // Plaza: stone disc around (cx, plazaR), radius ~3
                const pdx = c - cx;
                const pdy = r - plazaR;
                if (pdx * pdx + pdy * pdy <= 9) return TILE_STONE;

                // Plaza entry path: one-tile column north from main
                // path to the plaza rim.
                if (c === cx && r >= cy + 1 && r < plazaR - 2) return TILE_PATH;

                // Shop approach path: two-tile column from main path
                // up to the shop's south wall.
                if ((c === shopDoorC || c === shopDoorC + 1) &&
                    r >= shopDoorR && r <= cy) return TILE_PATH;

                // Main east-west road across the middle (2 tiles tall).
                if (r === cy || r === cy - 1) return TILE_PATH;

                // Tree groves in each corner - bounded boxes with
                // hash-driven density so they feel organic.
                const h = hash2(c, r);
                const nwX = c >= 3 && c <= 20;
                const neX = c >= cols - 21 && c <= cols - 4;
                const topY = r >= 3 && r <= 12;
                const botY = r >= rows - 13 && r <= rows - 4;
                if ((nwX || neX) && topY && h < 0.42) return TILE_TREE;
                if ((nwX || neX) && botY && h < 0.38) return TILE_TREE;

                // Light decoration scattered across the rest: rare
                // trees and a sprinkle of stones for texture.
                if (h < 0.012) return TILE_STONE;
                if (h > 0.988) return TILE_TREE;

                return TILE_GRASS;
            },
            enemyCount: 0,
            enemyOpts: {},
            exits: { east: "caverns" },
            npcs: [],  // filled in after NPC_TEMPLATES
            // One visible building for now. Each entry is a flat rect
            // with a door sub-rect; walking into the door rect triggers
            // a level transition to `interior`. Add more shops / inn
            // / houses by pushing more objects here.
            buildings: [
                {
                    id: "shop",
                    label: "SHOP",
                    // Building body
                    x: 940, y: 756, w: 160, h: 130,
                    // Door (visible + trigger rect), bottom-center
                    doorX: 1004, doorY: 862, doorW: 32, doorH: 24,
                    // Visual tints
                    wall: "#8c5a3c",
                    roof: "#5a3a22",
                    // Which level opens when the player enters.
                    interior: "shop_interior",
                    // Where to drop the player inside the interior
                    // (near its south door so they can walk out again).
                    entry: { x: 224, y: 250 },
                },
            ],
        },
        caverns: {
            id: "caverns",
            name: "Echo Caverns",
            safe: false,
            baseTile: TILE_STONE,
            borderTile: TILE_STONE,
            scatter: [
                { tile: TILE_WATER, prob: 0.05 },
                { tile: TILE_PATH, prob: 0.04 },
            ],
            enemyCount: 7,
            enemyOpts: { hp: 4, speed: 100 },
            exits: { west: "grove", east: "shrine" },
            npcs: [],
        },
        shrine: {
            id: "shrine",
            name: "Ethereon Shrine",
            safe: false,
            baseTile: TILE_PATH,
            borderTile: TILE_STONE,
            scatter: [
                { tile: TILE_WATER, prob: 0.09 },
                { tile: TILE_STONE, prob: 0.03 },
            ],
            enemyCount: 6,
            enemyOpts: { hp: 5, speed: 110, reward: 25, xpReward: 18 },
            exits: { west: "caverns" },
            npcs: [],
        },

        // Interior of the grove shop. Much smaller than an outdoor
        // level - cols/rows override the defaults, and the camera
        // module auto-centers any level smaller than the viewport.
        // The south wall has a path gap that serves as the exit;
        // walking through it transitions back to the grove at a
        // spot just south of the shop building.
        shop_interior: {
            id: "shop_interior",
            name: "The Merchant's Shop",
            safe: true,
            cols: 15, rows: 10,        // 480 x 320 px
            baseTile: TILE_PATH,        // wood-like floor
            borderTile: TILE_STONE,
            scatter: [],
            enemyCount: 0,
            enemyOpts: {},
            exits: {
                south: {
                    level: "grove",
                    // Drop the player just below the shop building's door.
                    arriveAt: { x: 1004, y: 896 },
                },
            },
            npcs: [],  // merchant appended after dialogue is defined
            buildings: [],
            isInterior: true,
        },
    };

    // Zone = level.id. The current zone is used for high-level
    // "what rules apply?" decisions (combat on/off, NPC roster).
    function currentZone() { return currentLevel.id; }
    function isSafeZone() { return currentLevel.safe === true; }

    // Active level. Swapped by `transitionTo(id, fromSide)` whenever
    // the player walks into an exit; referenced by world.draw, the
    // spawner, the NPC, and the transition logic.
    let currentLevel = LEVELS.grove;

    // Width of the opening cut into the border at each exit (in
    // tiles). Kept generous so transitions feel generous on touch.
    const EXIT_GAP_TILES = 3;
    // Pixel radius around the exit-midpoint within which walking off
    // the edge triggers a transition.
    const EXIT_TRIGGER_PX = 96;

    // Computes the tile id for (col, row) in the given level. Handles
    // the outer wall, cuts openings in the wall where exits exist, and
    // scatters decoration through a hash-driven lookup.
    function tileAt(level, c, r) {
        const cols = level.cols ?? MAX_WORLD_COLS;
        const rows = level.rows ?? MAX_WORLD_ROWS;
        const onNorth = r === 0;
        const onSouth = r === rows - 1;
        const onWest = c === 0;
        const onEast = c === cols - 1;

        if (onNorth || onSouth || onWest || onEast) {
            const midR = Math.floor(rows / 2);
            const midC = Math.floor(cols / 2);
            if (onWest && level.exits.west && Math.abs(r - midR) <= EXIT_GAP_TILES) return TILE_PATH;
            if (onEast && level.exits.east && Math.abs(r - midR) <= EXIT_GAP_TILES) return TILE_PATH;
            if (onNorth && level.exits.north && Math.abs(c - midC) <= EXIT_GAP_TILES) return TILE_PATH;
            if (onSouth && level.exits.south && Math.abs(c - midC) <= EXIT_GAP_TILES) return TILE_PATH;
            return level.borderTile;
        }

        // Custom layout hook - a level can ship a tileFn to fully
        // control interior tiles (e.g. the grove uses this to carve
        // paths, a plaza, a fountain, and tree clusters). Returning
        // undefined falls through to the scatter table below.
        if (typeof level.tileFn === "function") {
            const t = level.tileFn(c, r, cols, rows);
            if (t !== undefined) return t;
        }

        const h = hash2(c, r);
        let acc = 0;
        for (const s of level.scatter) {
            acc += s.prob;
            if (h < acc) return s.tile;
        }
        return level.baseTile;
    }

    const world = {
        cols: WORLD_COLS,
        rows: WORLD_ROWS,
        width: WORLD_W,
        height: WORLD_H,
        tileSize: TILE,
        // Allocated at max dimensions once so interiors / zones of
        // any size up to MAX_WORLD_* fit without realloc.
        data: new Uint8Array(MAX_WORLD_COLS * MAX_WORLD_ROWS),

        // Regenerate tile data from a level definition. Used at boot
        // and on every room-to-room transition. Updates the global
        // WORLD_* dimensions so camera clamps, player clamps, and
        // every other client of those values follow the level.
        load(level) {
            const cols = level.cols ?? MAX_WORLD_COLS;
            const rows = level.rows ?? MAX_WORLD_ROWS;
            WORLD_COLS = cols;
            WORLD_ROWS = rows;
            WORLD_W = cols * TILE;
            WORLD_H = rows * TILE;
            this.cols = cols;
            this.rows = rows;
            this.width = WORLD_W;
            this.height = WORLD_H;

            for (let r = 0; r < rows; r++) {
                for (let c = 0; c < cols; c++) {
                    this.data[r * cols + c] = tileAt(level, c, r);
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

            // Fill the whole visible block with the current level's
            // base tile in one call, then iterate and draw only the
            // *non-base* tiles on top. Collapses hundreds of per-tile
            // fillStyle writes into one state change and works
            // regardless of which level is active (grass, stone, path).
            const baseX = startCol * TILE;
            const baseY = startRow * TILE;
            const baseW = (endCol - startCol + 1) * TILE;
            const baseH = (endRow - startRow + 1) * TILE;
            const baseTile = currentLevel.baseTile;
            ctx.fillStyle = baseFillFor(baseTile);
            ctx.fillRect(baseX, baseY, baseW, baseH);

            const cols = WORLD_COLS;
            const data = this.data;
            for (let r = startRow; r <= endRow; r++) {
                const rowBase = r * cols;
                for (let c = startCol; c <= endCol; c++) {
                    const t = data[rowBase + c];
                    if (t !== baseTile) {
                        drawTile(ctx, t, c * TILE, r * TILE);
                    }
                }
            }
        },
    };

    // Picks the fillStyle used for the big viewport-wide base fill
    // in world.draw, keyed by the level's baseTile. `grassPattern` is
    // built later in the file - reading at draw-time means we don't
    // need to worry about module ordering.
    function baseFillFor(tileId) {
        switch (tileId) {
            case TILE_GRASS: return grassPattern;
            case TILE_STONE: return "#5c5c6e";
            case TILE_PATH:  return "#8c7a55";
            case TILE_WATER: return "#3560a0";
            default:         return "#3a5a3a";
        }
    }

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
                // Grass base is already filled by world.draw; skip the
                // redundant rect and only draw the tree silhouette.
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

    world.load(currentLevel);

    // Grass background pattern. Built once onto a 2x2-tile offscreen
    // canvas and used as a repeating fillStyle in `world.draw`. One
    // GPU-tiled fill replaces a solid color fill with effectively the
    // same cost but gives the terrain subtle variation.
    const grassPattern = (() => {
        const p = document.createElement("canvas");
        p.width = TILE * 2;
        p.height = TILE * 2;
        const g = p.getContext("2d");

        g.fillStyle = "#3a5a3a";
        g.fillRect(0, 0, TILE * 2, TILE * 2);

        // Checker - slightly lighter on diagonal tiles.
        g.fillStyle = "#3f6340";
        g.fillRect(TILE, 0, TILE, TILE);
        g.fillRect(0, TILE, TILE, TILE);

        // Scattered blade flecks across the 2x2 block.
        g.fillStyle = "#4a7350";
        g.fillRect(6,  18, 2, 2);
        g.fillRect(22, 9,  2, 2);
        g.fillRect(TILE + 20, 26, 2, 2);
        g.fillRect(TILE + 7,  14, 2, 2);
        g.fillRect(14, TILE + 10, 2, 2);
        g.fillRect(28, TILE + 24, 2, 2);
        g.fillRect(TILE + 8,  TILE + 22, 2, 2);
        g.fillRect(TILE + 24, TILE + 6,  2, 2);

        return ctx.createPattern(p, "repeat");
    })();

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
            // When a level is smaller than the viewport (e.g. a shop
            // interior) center the world inside the screen instead of
            // pinning to the corner.
            if (WORLD_W <= VIEW_W) {
                this.x = (WORLD_W - VIEW_W) / 2;
            } else {
                this.x = Math.max(0, Math.min(WORLD_W - VIEW_W, this.x));
            }
            if (WORLD_H <= VIEW_H) {
                this.y = (WORLD_H - VIEW_H) / 2;
            } else {
                this.y = Math.max(0, Math.min(WORLD_H - VIEW_H, this.y));
            }
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
        // When the question input (or any future text field) has
        // focus, let the native element own the key event - no
        // game-input capture, no preventDefault.
        if (e.target && e.target.tagName === "INPUT") return;

        if (!keys[e.key]) keysJustPressed[e.key] = true;
        keys[e.key] = true;
        // Stop the page from scrolling with arrow keys or space.
        if (e.key.startsWith("Arrow") || e.key === " ") e.preventDefault();
        // First key press on mobile / post-reload unlocks audio.
        sound.resume();
    });

    window.addEventListener("keyup", (e) => {
        if (e.target && e.target.tagName === "INPUT") return;
        keys[e.key] = false;
    });

    function clearJustPressed() {
        for (const k in keysJustPressed) delete keysJustPressed[k];
    }

    // ---------------------------------------------------------------
    // Sound
    //
    // Uses the Web Audio API directly (no asset files, no library) to
    // synthesize short placeholder blips for attack, enemy hit, and
    // player damage. Each effect is one oscillator + one gain
    // envelope - cheap, latency-free, and auto-cleans up after
    // `stop()`.
    //
    // Spam protection: every named effect has a per-effect cooldown
    // (`cooldowns[name]`). `play(name)` no-ops if the last play was
    // within that window - so a single swing that hits two enemies
    // in the same frame plays only one hit sound, and rapid-fire
    // damage tickles can't drown the mix.
    //
    // Mobile autoplay: AudioContexts start suspended on iOS / Chrome
    // until a user gesture. `resume()` is called from the existing
    // keydown and pointerdown handlers so the first input unlocks
    // audio transparently.
    // ---------------------------------------------------------------
    const sound = {
        ctx: null,
        master: null,
        enabled: true,
        lastPlayed: Object.create(null),

        // Minimum seconds between successive plays of the same effect.
        cooldowns: {
            attack: 0.08,
            enemyHit: 0.05,
            playerHurt: 0.4,
            power: 0.1,
            levelUp: 1.5,
        },

        _init() {
            if (this.ctx || !this.enabled) return;
            const Ctor = window.AudioContext || window.webkitAudioContext;
            if (!Ctor) { this.enabled = false; return; }
            try {
                this.ctx = new Ctor();
                this.master = this.ctx.createGain();
                this.master.gain.value = 0.35;
                this.master.connect(this.ctx.destination);
            } catch (_e) {
                this.enabled = false;
            }
        },

        resume() {
            if (!this.enabled) return;
            this._init();
            if (this.ctx && this.ctx.state === "suspended") {
                this.ctx.resume();
            }
        },

        play(name) {
            if (!this.enabled) return;
            this._init();
            if (!this.ctx) return;

            const now = this.ctx.currentTime;
            const cd = this.cooldowns[name] ?? 0;
            if (now - (this.lastPlayed[name] ?? -Infinity) < cd) return;
            this.lastPlayed[name] = now;

            switch (name) {
                case "attack":     this._attack(now); break;
                case "enemyHit":   this._enemyHit(now); break;
                case "playerHurt": this._playerHurt(now); break;
                case "power":      this._power(now); break;
                case "levelUp":    this._levelUp(now); break;
            }
        },

        // Short rising square-wave blip - "swish".
        _attack(t) {
            const osc = this.ctx.createOscillator();
            const g = this.ctx.createGain();
            osc.type = "square";
            osc.frequency.setValueAtTime(220, t);
            osc.frequency.exponentialRampToValueAtTime(640, t + 0.07);
            g.gain.setValueAtTime(0.0001, t);
            g.gain.exponentialRampToValueAtTime(0.3, t + 0.01);
            g.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
            osc.connect(g).connect(this.master);
            osc.start(t);
            osc.stop(t + 0.12);
        },

        // Sharp descending square - "thwack".
        _enemyHit(t) {
            const osc = this.ctx.createOscillator();
            const g = this.ctx.createGain();
            osc.type = "square";
            osc.frequency.setValueAtTime(460, t);
            osc.frequency.exponentialRampToValueAtTime(140, t + 0.08);
            g.gain.setValueAtTime(0.0001, t);
            g.gain.exponentialRampToValueAtTime(0.35, t + 0.005);
            g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
            osc.connect(g).connect(this.master);
            osc.start(t);
            osc.stop(t + 0.1);
        },

        // Low buzzy sawtooth with a pitch drop - "hurt".
        _playerHurt(t) {
            const osc = this.ctx.createOscillator();
            const g = this.ctx.createGain();
            osc.type = "sawtooth";
            osc.frequency.setValueAtTime(180, t);
            osc.frequency.exponentialRampToValueAtTime(80, t + 0.2);
            g.gain.setValueAtTime(0.0001, t);
            g.gain.exponentialRampToValueAtTime(0.35, t + 0.01);
            g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
            osc.connect(g).connect(this.master);
            osc.start(t);
            osc.stop(t + 0.24);
        },

        // Rising major-triad arpeggio - "ding ding ding".
        _levelUp(t) {
            const notes = [523, 659, 784]; // C5 E5 G5
            for (let i = 0; i < notes.length; i++) {
                const start = t + i * 0.08;
                const osc = this.ctx.createOscillator();
                const g = this.ctx.createGain();
                osc.type = "triangle";
                osc.frequency.setValueAtTime(notes[i], start);
                g.gain.setValueAtTime(0.0001, start);
                g.gain.exponentialRampToValueAtTime(0.25, start + 0.01);
                g.gain.exponentialRampToValueAtTime(0.0001, start + 0.22);
                osc.connect(g).connect(this.master);
                osc.start(start);
                osc.stop(start + 0.24);
            }
        },

        // Dramatic two-oscillator descending blast - "boom".
        _power(t) {
            const osc1 = this.ctx.createOscillator();
            const osc2 = this.ctx.createOscillator();
            const g = this.ctx.createGain();
            osc1.type = "square";
            osc2.type = "triangle";
            osc1.frequency.setValueAtTime(180, t);
            osc1.frequency.exponentialRampToValueAtTime(70, t + 0.32);
            osc2.frequency.setValueAtTime(540, t);
            osc2.frequency.exponentialRampToValueAtTime(220, t + 0.32);
            g.gain.setValueAtTime(0.0001, t);
            g.gain.exponentialRampToValueAtTime(0.38, t + 0.01);
            g.gain.exponentialRampToValueAtTime(0.0001, t + 0.38);
            osc1.connect(g);
            osc2.connect(g);
            g.connect(this.master);
            osc1.start(t);
            osc2.start(t);
            osc1.stop(t + 0.4);
            osc2.stop(t + 0.4);
        },
    };

    // ---------------------------------------------------------------
    // Virtual joystick (touch / pointer)
    //
    // A floating joystick that spawns wherever the player first
    // presses on the left half of the canvas, lets them drag in any
    // direction, and releases on lift. It outputs an analog vector
    // `(dx, dy)` in [-1, 1] which is combined with keyboard input in
    // `updateMovement`, so keyboard and touch work simultaneously.
    //
    // Input is captured via Pointer Events (which abstract both mouse
    // and touch), and we track pointerId so multi-touch doesn't
    // confuse which pointer owns the joystick.
    // ---------------------------------------------------------------
    const joystick = {
        active: false,
        pointerId: null,
        baseX: 0, baseY: 0,     // where the press landed (center of ring)
        stickX: 0, stickY: 0,   // where the stick is being held
        radius: 60,             // max drag distance, in canvas pixels
        dx: 0, dy: 0,           // output vector, -1..1

        // Only spawn the joystick on the left half of the canvas so
        // future right-side buttons don't conflict with it.
        onDown(x, y, pointerId) {
            if (this.active) return false;
            if (x > VIEW_W / 2) return false;
            this.active = true;
            this.pointerId = pointerId;
            this.baseX = this.stickX = x;
            this.baseY = this.stickY = y;
            this.dx = 0;
            this.dy = 0;
            return true;
        },

        onMove(x, y, pointerId) {
            if (!this.active || this.pointerId !== pointerId) return;
            let ox = x - this.baseX;
            let oy = y - this.baseY;
            const dist = Math.hypot(ox, oy);
            if (dist > this.radius) {
                const inv = this.radius / dist;
                ox *= inv;
                oy *= inv;
            }
            this.stickX = this.baseX + ox;
            this.stickY = this.baseY + oy;
            this.dx = ox / this.radius;
            this.dy = oy / this.radius;
        },

        onUp(pointerId) {
            if (this.pointerId !== pointerId) return;
            this.active = false;
            this.pointerId = null;
            this.dx = 0;
            this.dy = 0;
        },

        draw(ctx) {
            if (!this.active) return;
            ctx.save();

            // Outer ring
            ctx.globalAlpha = 0.45;
            ctx.strokeStyle = "#ffffff";
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.arc(this.baseX, this.baseY, this.radius, 0, Math.PI * 2);
            ctx.stroke();

            // Inner fill (subtle)
            ctx.globalAlpha = 0.12;
            ctx.fillStyle = "#ffffff";
            ctx.beginPath();
            ctx.arc(this.baseX, this.baseY, this.radius, 0, Math.PI * 2);
            ctx.fill();

            // Stick
            ctx.globalAlpha = 0.85;
            ctx.fillStyle = "#ffd166";
            ctx.beginPath();
            ctx.arc(this.stickX, this.stickY, 26, 0, Math.PI * 2);
            ctx.fill();

            ctx.restore();
        },
    };

    // ---------------------------------------------------------------
    // Attack button (touch / pointer)
    //
    // A fixed circular button in the bottom-right corner that fires
    // an attack on press. Independent of the keyboard SPACE handler:
    // both sources call through `attack.tryStart(player)` via
    // `updateCombatInput`, so either one works and the attack cooldown
    // applies uniformly.
    //
    // Uses an edge-triggered `justPressed` flag consumed by the
    // update tick, which mirrors how we already handle keysJustPressed
    // - one tap = one attack attempt.
    // ---------------------------------------------------------------
    const attackButton = {
        x: 0, y: 0,
        radius: 54,

        // Pulled anchored to the bottom-right corner on every resize.
        layout() {
            this.x = VIEW_W - 80;
            this.y = VIEW_H - 80;
        },

        pressed: false,        // pointer still held on button - drives visual feedback
        pointerId: null,
        justPressed: false,    // set on down, cleared by consumeJustPressed()

        contains(x, y) {
            const dx = x - this.x;
            const dy = y - this.y;
            return dx * dx + dy * dy <= this.radius * this.radius;
        },

        onDown(x, y, pointerId) {
            if (this.pressed) return false;
            if (!this.contains(x, y)) return false;
            this.pressed = true;
            this.pointerId = pointerId;
            this.justPressed = true;
            return true;
        },

        onUp(pointerId) {
            if (this.pointerId !== pointerId) return;
            this.pressed = false;
            this.pointerId = null;
        },

        consumeJustPressed() {
            const v = this.justPressed;
            this.justPressed = false;
            return v;
        },

        draw(ctx) {
            ctx.save();

            // Subtle "depressed" shift when pressed for extra feedback.
            const cy = this.y + (this.pressed ? 2 : 0);

            // Base fill - brighter while pressed.
            ctx.globalAlpha = this.pressed ? 0.95 : 0.6;
            ctx.fillStyle = this.pressed ? "#ff8a6a" : "#c84a4a";
            ctx.beginPath();
            ctx.arc(this.x, cy, this.radius, 0, Math.PI * 2);
            ctx.fill();

            // Outer ring
            ctx.globalAlpha = 0.9;
            ctx.strokeStyle = "#ffffff";
            ctx.lineWidth = this.pressed ? 4 : 3;
            ctx.stroke();

            // Inner highlight when pressed
            if (this.pressed) {
                ctx.globalAlpha = 0.35;
                ctx.fillStyle = "#ffffff";
                ctx.beginPath();
                ctx.arc(this.x, cy, this.radius - 6, 0, Math.PI * 2);
                ctx.fill();
            }

            // Label
            ctx.globalAlpha = 1;
            ctx.fillStyle = "#ffffff";
            ctx.font = "bold 20px system-ui, sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText("ATK", this.x, cy);
            ctx.textAlign = "start";
            ctx.textBaseline = "alphabetic";

            ctx.restore();
        },
    };

    // ---------------------------------------------------------------
    // Weapon-swap button (touch / pointer)
    //
    // Sits beside the attack button so mobile users can cycle
    // weapons without a keyboard. Edge-triggered on tap (one press =
    // one cycle). Always visible and always labelled with the
    // currently-equipped weapon, so what's active is obvious even
    // while playing one-handed.
    //
    // Lives on the right half of the canvas alongside the attack
    // button, so the joystick (which only activates on the left
    // half) can never steal its touches.
    // ---------------------------------------------------------------
    const weaponSwapButton = {
        x: 0, y: 0,
        radius: 36,

        layout() {
            this.x = VIEW_W - 178;
            this.y = VIEW_H - 80;
        },

        pressed: false,
        pointerId: null,

        contains(x, y) {
            const dx = x - this.x;
            const dy = y - this.y;
            return dx * dx + dy * dy <= this.radius * this.radius;
        },

        onDown(x, y, pointerId) {
            if (this.pressed) return false;
            if (!this.contains(x, y)) return false;
            this.pressed = true;
            this.pointerId = pointerId;
            // Edge-triggered cycle: advance on press, not on release,
            // for responsive feel.
            player.weaponIndex = (player.weaponIndex + 1) % weapons.length;
            return true;
        },

        onUp(pointerId) {
            if (this.pointerId !== pointerId) return;
            this.pressed = false;
            this.pointerId = null;
        },

        draw(ctx) {
            const w = currentWeapon();
            const cy = this.y + (this.pressed ? 2 : 0);

            ctx.save();

            // Base fill - tinted by the current weapon so the active
            // loadout is obvious at a glance.
            ctx.globalAlpha = this.pressed ? 0.95 : 0.6;
            ctx.fillStyle = w.color;
            ctx.beginPath();
            ctx.arc(this.x, cy, this.radius, 0, Math.PI * 2);
            ctx.fill();

            // Rim
            ctx.globalAlpha = 0.9;
            ctx.strokeStyle = "#ffffff";
            ctx.lineWidth = this.pressed ? 4 : 3;
            ctx.stroke();

            if (this.pressed) {
                ctx.globalAlpha = 0.35;
                ctx.fillStyle = "#ffffff";
                ctx.beginPath();
                ctx.arc(this.x, cy, this.radius - 5, 0, Math.PI * 2);
                ctx.fill();
            }

            // Label: a small cycle glyph + current weapon's short name.
            ctx.globalAlpha = 1;
            ctx.fillStyle = "#1a1a24";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.font = "bold 12px system-ui, sans-serif";
            ctx.fillText("↻", this.x, cy - 10);
            ctx.font = "bold 11px system-ui, sans-serif";
            ctx.fillText(w.shortName, this.x, cy + 8);

            ctx.restore();
        },
    };

    // ---------------------------------------------------------------
    // Power button (touch / pointer)
    //
    // Sits above the attack button. Tapping triggers `powerMove.activate`
    // exactly like the Q key on keyboard. A cooldown ring inside the
    // button shows remaining charge at a glance - classic ability-
    // button idiom that reads even without any text.
    // ---------------------------------------------------------------
    const powerButton = {
        x: 0, y: 0,
        radius: 38,

        layout() {
            this.x = VIEW_W - 80;
            this.y = VIEW_H - 170;
        },

        pressed: false,
        pointerId: null,
        justPressed: false,

        contains(x, y) {
            const dx = x - this.x;
            const dy = y - this.y;
            return dx * dx + dy * dy <= this.radius * this.radius;
        },

        onDown(x, y, pointerId) {
            if (this.pressed) return false;
            if (!this.contains(x, y)) return false;
            this.pressed = true;
            this.pointerId = pointerId;
            this.justPressed = true;
            return true;
        },

        onUp(pointerId) {
            if (this.pointerId !== pointerId) return;
            this.pressed = false;
            this.pointerId = null;
        },

        consumeJustPressed() {
            const v = this.justPressed;
            this.justPressed = false;
            return v;
        },

        draw(ctx) {
            const cy = this.y + (this.pressed ? 2 : 0);
            const ready = powerMove.ready;
            const frac = powerMove.cooldownFrac();

            ctx.save();

            // Base circle - muted while charging, bright gold when ready.
            ctx.globalAlpha = this.pressed ? 0.95 : 0.6;
            ctx.fillStyle = ready ? "#ff8e3a" : "#5a3f2a";
            ctx.beginPath();
            ctx.arc(this.x, cy, this.radius, 0, Math.PI * 2);
            ctx.fill();

            // Cooldown ring - a pie slice that fills clockwise as the
            // ability recharges. Drawn with a gap so it doesn't cover
            // the label.
            if (!ready) {
                ctx.globalAlpha = 0.85;
                ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
                ctx.beginPath();
                ctx.moveTo(this.x, cy);
                ctx.arc(
                    this.x, cy, this.radius - 2,
                    -Math.PI / 2 + frac * Math.PI * 2,
                    Math.PI * 1.5
                );
                ctx.closePath();
                ctx.fill();
            }

            // Rim
            ctx.globalAlpha = 0.9;
            ctx.strokeStyle = ready ? "#fff6d6" : "#888";
            ctx.lineWidth = this.pressed ? 4 : 3;
            ctx.beginPath();
            ctx.arc(this.x, cy, this.radius, 0, Math.PI * 2);
            ctx.stroke();

            // Label
            ctx.globalAlpha = 1;
            ctx.fillStyle = "#1a1a24";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.font = "bold 15px system-ui, sans-serif";
            ctx.fillText("★", this.x, cy - 7);
            ctx.font = "bold 10px system-ui, sans-serif";
            ctx.fillText("POWER", this.x, cy + 8);

            ctx.restore();
        },
    };

    // ---------------------------------------------------------------
    // Interact button (touch / pointer)
    //
    // Appears bottom-center only when the player is standing near an
    // NPC and gameplay is active. Tapping runs the same `npc.interact`
    // path the E key uses, so keyboard and touch converge.
    // ---------------------------------------------------------------
    const interactButton = {
        x: 0, y: 0,
        radius: 34,

        layout() {
            this.x = VIEW_W / 2;
            this.y = VIEW_H - 84;
        },

        pressed: false,
        pointerId: null,
        justPressed: false,

        visible() {
            return gameState === "playing" && nearestNpc() !== null;
        },

        contains(x, y) {
            const dx = x - this.x;
            const dy = y - this.y;
            return dx * dx + dy * dy <= this.radius * this.radius;
        },

        onDown(x, y, pointerId) {
            if (!this.visible()) return false;
            if (this.pressed) return false;
            if (!this.contains(x, y)) return false;
            this.pressed = true;
            this.pointerId = pointerId;
            this.justPressed = true;
            return true;
        },

        onUp(pointerId) {
            if (this.pointerId !== pointerId) return;
            this.pressed = false;
            this.pointerId = null;
        },

        consumeJustPressed() {
            const v = this.justPressed;
            this.justPressed = false;
            return v;
        },

        draw(ctx) {
            if (!this.visible()) return;
            const cy = this.y + (this.pressed ? 2 : 0);

            ctx.save();
            ctx.globalAlpha = this.pressed ? 0.95 : 0.75;
            ctx.fillStyle = "#8ad9ff";
            ctx.beginPath();
            ctx.arc(this.x, cy, this.radius, 0, Math.PI * 2);
            ctx.fill();

            ctx.globalAlpha = 0.95;
            ctx.strokeStyle = "#ffffff";
            ctx.lineWidth = this.pressed ? 4 : 3;
            ctx.stroke();

            ctx.globalAlpha = 1;
            ctx.fillStyle = "#1a1a24";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.font = "bold 14px system-ui, sans-serif";
            ctx.fillText("TALK", this.x, cy);
            ctx.restore();
        },
    };

    // Register every button that pins itself to a viewport edge.
    // Called once at boot (the resize listener installed later is
    // what triggers the first run) and on every subsequent resize.
    onLayout(() => {
        attackButton.layout();
        weaponSwapButton.layout();
        powerButton.layout();
        interactButton.layout();
    });
    // Button layouts need to be valid before the first frame, but
    // resizeDisplay() runs before any of these objects exist. Kick
    // layouts once now that every button is defined.
    attackButton.layout();
    weaponSwapButton.layout();
    powerButton.layout();
    interactButton.layout();

    // ---------------------------------------------------------------
    // Restart button (game-over only)
    //
    // A clearly-tappable rectangle centered on the game-over screen.
    // Only active while `gameState === "gameover"`, so pointer events
    // during gameplay can't accidentally hit it. Tapping calls the
    // same `restartGame()` used by the R key, so both paths converge.
    // ---------------------------------------------------------------
    const restartButton = {
        w: 200,
        h: 48,
        pressed: false,
        pointerId: null,

        bounds() {
            return {
                x: (VIEW_W - this.w) / 2,
                y: VIEW_H / 2 + 98,
                w: this.w,
                h: this.h,
            };
        },

        contains(x, y) {
            const b = this.bounds();
            return x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
        },

        onDown(x, y, pointerId) {
            if (gameState !== "gameover") return false;
            if (!this.contains(x, y)) return false;
            this.pressed = true;
            this.pointerId = pointerId;
            return true;
        },

        onUp(pointerId) {
            if (this.pointerId !== pointerId) return;
            const wasPressed = this.pressed;
            this.pressed = false;
            this.pointerId = null;
            // Fire on release so a drag-off cancels the tap, which is
            // the standard button UX.
            if (wasPressed && gameState === "gameover") {
                restartGame();
            }
        },

        draw(ctx) {
            if (gameState !== "gameover") return;
            const b = this.bounds();

            ctx.save();
            roundRectPath(ctx, b.x, b.y, b.w, b.h, 10);
            ctx.fillStyle = this.pressed ? "#d9a73b" : "#ffd166";
            ctx.fill();
            ctx.strokeStyle = "rgba(255, 255, 255, 0.5)";
            ctx.lineWidth = 2;
            ctx.stroke();

            ctx.fillStyle = "#1a1a24";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.font = "bold 20px system-ui, sans-serif";
            ctx.fillText("RESTART", b.x + b.w / 2, b.y + b.h / 2 + (this.pressed ? 1 : 0));
            ctx.restore();
        },
    };

    // Convert a pointer event's clientX/Y into canvas-space coordinates
    // (the 960x540 internal grid). The canvas is CSS-scaled, so we
    // divide out that scale factor here.
    //
    // `getBoundingClientRect()` forces a synchronous layout, so on
    // mobile a pointermove fired at touch sample rate (~60-120Hz) can
    // stall rendering. Cache the rect and invalidate only when
    // layout-affecting things change. A shared scratch object avoids
    // per-event allocation in the hot drag path.
    //
    // `_canvasRect` and `invalidateCanvasRect()` are declared earlier
    // in the file so `resizeDisplay()` can trigger the invalidation.
    // This block just wires additional invalidation triggers.
    window.addEventListener("scroll", invalidateCanvasRect, { passive: true });

    const _pointerOut = { x: 0, y: 0 };
    function pointerToCanvas(e) {
        if (!_canvasRect) _canvasRect = canvas.getBoundingClientRect();
        const r = _canvasRect;
        _pointerOut.x = (e.clientX - r.left) * (VIEW_W / r.width);
        _pointerOut.y = (e.clientY - r.top) * (VIEW_H / r.height);
        return _pointerOut;
    }

    canvas.addEventListener("pointerdown", (e) => {
        // First touch / click on mobile unlocks audio.
        sound.resume();

        const { x, y } = pointerToCanvas(e);

        // Intro: any tap begins the game. Nothing else should react
        // until playing is active.
        if (gameState === "intro") {
            startGame();
            e.preventDefault();
            return;
        }

        // Shop is modal - taps only hit item rows or the close button.
        if (shop.isOpen()) {
            handleShopPointer(x, y);
            e.preventDefault();
            return;
        }

        // Dialogue is modal - taps only hit options or advance text.
        if (dialogue.isOpen()) {
            handleDialoguePointer(x, y);
            e.preventDefault();
            return;
        }

        // Game over: the only live control is the restart button.
        // Pointer capture keeps it responsive if the finger drifts.
        if (gameState === "gameover") {
            if (restartButton.onDown(x, y, e.pointerId)) {
                canvas.setPointerCapture(e.pointerId);
                e.preventDefault();
            }
            return;
        }

        // Try the fixed-rect right-side buttons first. They share the
        // right half of the canvas with nothing else (the joystick
        // only spawns on the left half), so this ordering can never
        // steal a joystick touch.
        if (attackButton.onDown(x, y, e.pointerId)) {
            canvas.setPointerCapture(e.pointerId);
            e.preventDefault();
            return;
        }
        if (weaponSwapButton.onDown(x, y, e.pointerId)) {
            canvas.setPointerCapture(e.pointerId);
            e.preventDefault();
            return;
        }
        if (powerButton.onDown(x, y, e.pointerId)) {
            canvas.setPointerCapture(e.pointerId);
            e.preventDefault();
            return;
        }
        if (interactButton.onDown(x, y, e.pointerId)) {
            canvas.setPointerCapture(e.pointerId);
            e.preventDefault();
            return;
        }

        if (joystick.onDown(x, y, e.pointerId)) {
            // Keep receiving move/up even if the pointer leaves the
            // canvas, which is especially important for touch drags.
            canvas.setPointerCapture(e.pointerId);
            e.preventDefault();
        }
    });

    canvas.addEventListener("pointermove", (e) => {
        if (joystick.pointerId === e.pointerId) {
            const { x, y } = pointerToCanvas(e);
            joystick.onMove(x, y, e.pointerId);
            e.preventDefault();
        }
    });

    function endPointer(e) {
        joystick.onUp(e.pointerId);
        attackButton.onUp(e.pointerId);
        weaponSwapButton.onUp(e.pointerId);
        powerButton.onUp(e.pointerId);
        interactButton.onUp(e.pointerId);
        restartButton.onUp(e.pointerId);
    }
    canvas.addEventListener("pointerup", endPointer);
    canvas.addEventListener("pointercancel", endPointer);
    canvas.addEventListener("pointerleave", endPointer);

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
        speed: 220,  // max velocity in pixels per second
        accel: 2200, // px/s^2 toward target velocity; ~0.1s to full speed
        vx: 0,
        vy: 0,
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

        // Collected items, flat array of ids from the ITEMS catalog.
        inventory: [],

        // Currently-equipped weapon index into `weapons[]`.
        // 0 = sword (melee), 1 = energy blast (projectile).
        weaponIndex: 0,
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
        sound.play("playerHurt");

        if (player.hp <= 0) {
            player.alive = false;
            gameState = "gameover";
        }
    }

    function healPlayer(amount) {
        if (!player.alive) return;
        player.hp = Math.min(player.maxHp, player.hp + amount);
    }

    // ---------------------------------------------------------------
    // Run stats
    //
    // The one place score / kills / (eventually) xp + level live.
    // Keeping it a tiny module with a single `addScore` chokepoint
    // means future rewards (pickups, combos, multipliers) and
    // leveling can plug in here without touching callers:
    //
    //   - score          current run total
    //   - kills          enemies defeated this run
    //   - scoreModifiers (amount) => amount  - combo/multiplier hook
    //   - onScoreChanged listeners - fire after score changes; a
    //                    future leveling system checks xp thresholds
    //                    here without needing to hard-wire into
    //                    combat code.
    // ---------------------------------------------------------------
    const stats = {
        score: 0,
        kills: 0,
        scoreModifiers: [],
        onScoreChanged: [],

        // Leveling
        level: 1,
        xp: 0,
        xpForNext: 30,
        onLevelChanged: [],

        // Brief "LEVEL UP!" toast countdown (seconds remaining visible)
        levelUpToast: 0,

        addScore(amount) {
            let final = amount;
            for (const mod of this.scoreModifiers) final = mod(final);
            if (final <= 0) return;
            this.score += final;
            for (const fn of this.onScoreChanged) fn(this.score, final);
        },

        addKill(enemy) {
            this.kills += 1;
            this.addScore(enemy?.reward ?? 10);
            this.addXp(enemy?.xpReward ?? 10);
            questLog.onKill();
        },

        // Grants XP and levels the player up as many times as the
        // batch allows (so a huge XP drop can carry through multiple
        // tiers cleanly).
        addXp(amount) {
            if (amount <= 0) return;
            this.xp += amount;
            while (this.xp >= this.xpForNext) {
                this.xp -= this.xpForNext;
                this._applyLevelUp();
                this.xpForNext = Math.floor(30 + (this.level - 1) * 20);
            }
            for (const fn of this.onLevelChanged) fn(this.level);
        },

        // Each level applies a fixed upgrade recipe, tiered so every
        // level meaningfully changes stats but the ramp stays bounded.
        //   always:           +8 max HP (and instant heal by +8)
        //   every 2 levels:   +1 sword damage
        //   every 3 levels:   +1 energy damage
        //   every 4 levels:   +1 power-move damage
        //   every 5 levels:   attack & energy cooldowns *= 0.85
        _applyLevelUp() {
            this.level += 1;
            this.levelUpToast = 1.8;

            player.maxHp += 8;
            player.hp = Math.min(player.maxHp, player.hp + 8);

            const lvl = this.level;
            if (lvl % 2 === 0) swordWeapon.damage += 1;
            if (lvl % 3 === 0) energyWeapon.damage += 1;
            if (lvl % 4 === 0) powerMove.damage += 1;
            if (lvl % 5 === 0) {
                attack.cooldown = Math.max(0.15, attack.cooldown * 0.85);
                energyWeapon.cooldownMax = Math.max(0.25, energyWeapon.cooldownMax * 0.85);
            }

            sound.play("levelUp");
        },

        reset() {
            this.score = 0;
            this.kills = 0;
            this.level = 1;
            this.xp = 0;
            this.xpForNext = 30;
            this.levelUpToast = 0;
        },
    };

    // ---------------------------------------------------------------
    // Quests
    //
    // QUESTS is a read-only catalog of quest templates keyed by id.
    // Each template carries display info and an objective:
    //
    //   id            unique key
    //   title         short HUD / toast name
    //   description   what the player is asked to do
    //   kind          "kill" today; extension point for "collect",
    //                 "reach", "escort" - onKill / onPickup / etc.
    //                 checks switch on this field.
    //   target        numeric goal (e.g. 3 kills)
    //   rewardXp      xp granted on completion
    //   rewardScore   score granted on completion
    //   next          chained quest id, or null for end of chain
    //
    // questLog holds the active instance and a set of completed ids.
    // Additions: just push another object into QUESTS and make sure
    // a quest earlier in the chain points at it via `next`.
    // ---------------------------------------------------------------
    const QUESTS = {
        slay3: {
            id: "slay3",
            title: "First Hunt",
            description: "Defeat 3 enemies.",
            kind: "kill",
            target: 3,
            rewardXp: 30,
            rewardScore: 50,
            next: "slay10",
        },
        slay10: {
            id: "slay10",
            title: "Experienced Hunter",
            description: "Defeat 10 more enemies.",
            kind: "kill",
            target: 10,
            rewardXp: 80,
            rewardScore: 150,
            next: null,
        },
    };

    const questLog = {
        active: null,              // { id, progress } or null
        completedIds: new Set(),
        toast: "",                 // text shown mid-screen
        toastTimer: 0,             // seconds remaining visible

        hasCompleted(id) {
            return this.completedIds.has(id);
        },

        // True if this id is already active or already finished.
        isKnown(id) {
            return (this.active && this.active.id === id) || this.hasCompleted(id);
        },

        accept(id) {
            const tmpl = QUESTS[id];
            if (!tmpl) return false;
            if (this.active || this.hasCompleted(id)) return false;
            this.active = { id, progress: 0 };
            this.showToast(`New quest: ${tmpl.title}`);
            return true;
        },

        // Call from stats.addKill. Advances any active "kill" quest
        // by one and triggers completion when the target is reached.
        onKill() {
            if (!this.active) return;
            const tmpl = QUESTS[this.active.id];
            if (tmpl.kind !== "kill") return;
            this.active.progress = Math.min(tmpl.target, this.active.progress + 1);
            if (this.active.progress >= tmpl.target) {
                this._complete();
            }
        },

        _complete() {
            const tmpl = QUESTS[this.active.id];
            this.completedIds.add(tmpl.id);
            stats.addXp(tmpl.rewardXp);
            stats.addScore(tmpl.rewardScore);
            sound.play("levelUp");
            this.showToast(`Quest complete: ${tmpl.title}!`);
            this.active = null;
        },

        showToast(msg, duration = 2.5) {
            this.toast = msg;
            this.toastTimer = duration;
        },

        update(dt) {
            if (this.toastTimer > 0) {
                this.toastTimer = Math.max(0, this.toastTimer - dt);
            }
        },

        reset() {
            this.active = null;
            this.completedIds = new Set();
            this.toast = "";
            this.toastTimer = 0;
        },
    };

    // ---------------------------------------------------------------
    // Items & inventory
    //
    // Design:
    //   ITEMS is a read-only catalog of item *templates* keyed by id.
    //   Each template carries display info (name, color) and a `use`
    //   function - the extension point for item effects. Potions,
    //   gold, weapons, keys, etc. all live here with no changes
    //   needed to pickup, drop, or rendering code.
    //
    //   `player.inventory` is a flat array of item ids. Counts are
    //   computed on demand at draw time, which keeps add/remove O(1)
    //   and the structure obvious. For a future 9-slot hotbar you'd
    //   either cap the array or split it into hotbar + backpack.
    //
    //   `drops` holds world-space item entities that exist until the
    //   player walks over them. A separate concern from inventory so
    //   either can evolve independently (timed despawn, magnet
    //   pickup radius, etc.).
    // ---------------------------------------------------------------
    const ITEMS = {
        potion: {
            id: "potion",
            name: "Health Potion",
            color: "#e06666",
            // Plugs into the existing healPlayer chokepoint. When a
            // "use" flow is wired in, this fires.
            use(_player) { healPlayer(30); },
        },
        coin: {
            id: "coin",
            name: "Gold Coin",
            color: "#ffd166",
            use(_player) { stats.addScore(20); },
        },
    };

    // Helpers on the player. Defined here (rather than as methods on
    // the object literal) so future effects can call back into the
    // game's systems without circular setup order.
    function addToInventory(itemId) {
        player.inventory.push(itemId);
    }

    // Removes the item at `index` and runs its use effect. Not wired
    // to a key yet - kept here as the single chokepoint for future
    // hotbar bindings.
    function useInventoryItem(index) {
        const id = player.inventory[index];
        if (!id) return;
        const tmpl = ITEMS[id];
        if (!tmpl) return;
        player.inventory.splice(index, 1);
        tmpl.use(player);
    }

    // World drops - stay in world space, picked up on overlap.
    const drops = [];

    function spawnDrop(x, y, itemId) {
        drops.push({ x, y, itemId, age: 0 });
    }

    // Rolls on enemy death. Tunable drop table in one place.
    function rollEnemyDrop(enemy) {
        const r = Math.random();
        const cx = enemy.x + enemy.width / 2;
        const cy = enemy.y + enemy.height / 2;
        if (r < 0.25)      spawnDrop(cx, cy, "potion");
        else if (r < 0.55) spawnDrop(cx, cy, "coin");
        // else nothing
    }

    function updateDrops(_dt) {
        if (!player.alive) return;
        const pxMin = player.x;
        const pyMin = player.y;
        const pxMax = player.x + player.width;
        const pyMax = player.y + player.height;

        for (let i = drops.length - 1; i >= 0; i--) {
            const d = drops[i];
            d.age += _dt;
            const dxMin = d.x - 8;
            const dyMin = d.y - 8;
            const dxMax = d.x + 8;
            const dyMax = d.y + 8;
            if (
                pxMin < dxMax && pxMax > dxMin &&
                pyMin < dyMax && pyMax > dyMin
            ) {
                addToInventory(d.itemId);
                drops.splice(i, 1);
            }
        }
    }

    function drawDrops(ctx) {
        for (const d of drops) {
            const tmpl = ITEMS[d.itemId];
            if (!tmpl) continue;
            const bob = Math.sin(d.age * 6) * 2;
            const cx = Math.round(d.x);
            const cy = Math.round(d.y + bob);

            // Shadow - always at the drop's baseline so bob reads.
            ctx.fillStyle = "rgba(0, 0, 0, 0.28)";
            ctx.beginPath();
            ctx.ellipse(cx, Math.round(d.y + 10), 7, 2.5, 0, 0, Math.PI * 2);
            ctx.fill();

            // Body
            ctx.fillStyle = tmpl.color;
            ctx.fillRect(cx - 5, cy - 5, 10, 10);
            // Tiny specular
            ctx.fillStyle = "rgba(255, 255, 255, 0.35)";
            ctx.fillRect(cx - 4, cy - 4, 3, 2);
        }
    }

    // Inventory UI toggle state. Set from the `I` key in update().
    let inventoryOpen = false;

    // ---------------------------------------------------------------
    // Weapons
    //
    // The player carries a small set of weapons and picks one at a
    // time via the `1` / `2` keys. Each weapon is an object with a
    // consistent shape so the combat-input path can stay agnostic:
    //
    //   id            unique key (matches a HUD label)
    //   name          display name
    //   color         HUD accent
    //   ready         bool - can it fire right now?
    //   cooldownFrac  0..1 for the HUD bar (0 = just fired, 1 = ready)
    //   fire(player)  triggers the weapon, self-gates on `ready`
    //   update(dt)    advances the weapon's internal timers
    //
    // The sword is a thin wrapper around the existing `attack` module
    // so behavior and state are byte-for-byte unchanged - scoring,
    // drops, and the enemy-hit flash all keep working without
    // modification. The energy weapon spawns projectiles and owns its
    // own cooldown.
    // ---------------------------------------------------------------

    // --- Projectiles ---
    const projectiles = [];

    function spawnProjectile(owner, opts = {}) {
        const cx = owner.x + owner.width / 2;
        const cy = owner.y + owner.height / 2;
        const fx = owner.facing.x;
        const fy = owner.facing.y;
        const mag = Math.hypot(fx, fy) || 1;
        const speed = opts.speed ?? 520;
        projectiles.push({
            x: cx - 6,
            y: cy - 6,
            w: 12,
            h: 12,
            vx: (fx / mag) * speed,
            vy: (fy / mag) * speed,
            life: opts.life ?? 0.6,
            damage: opts.damage ?? 1,
            color: opts.color ?? "#8ad9ff",
            age: 0,
            alive: true,
        });
    }

    function updateProjectiles(dt) {
        for (let i = projectiles.length - 1; i >= 0; i--) {
            const p = projectiles[i];
            p.age += dt;
            p.life -= dt;
            p.x += p.vx * dt;
            p.y += p.vy * dt;

            if (
                p.life <= 0 ||
                p.x < 0 || p.y < 0 ||
                p.x > WORLD_W || p.y > WORLD_H
            ) {
                p.alive = false;
            }

            // Hit test against live enemies. Uses the existing
            // `e.bounds()` scratch rect so no allocation per hit.
            if (p.alive) {
                for (const e of enemies) {
                    if (!e.alive) continue;
                    const b = e.bounds();
                    if (
                        p.x < b.x + b.w && p.x + p.w > b.x &&
                        p.y < b.y + b.h && p.y + p.h > b.y
                    ) {
                        e.takeHit(p.damage);
                        if (!e.alive) {
                            stats.addKill(e);
                            rollEnemyDrop(e);
                        }
                        p.alive = false;
                        break;
                    }
                }
            }

            if (!p.alive) projectiles.splice(i, 1);
        }
    }

    function drawProjectiles(ctx) {
        for (const p of projectiles) {
            const cx = Math.round(p.x + p.w / 2);
            const cy = Math.round(p.y + p.h / 2);
            const pulse = 0.8 + 0.2 * Math.sin(p.age * 30);

            ctx.save();
            ctx.globalAlpha = 0.5 * pulse;
            ctx.fillStyle = p.color;
            ctx.beginPath();
            ctx.arc(cx, cy, 10, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;
            ctx.fillStyle = "#eaf7ff";
            ctx.beginPath();
            ctx.arc(cx, cy, 4, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        }
    }

    // --- Weapons ---

    // Sword: delegates everything to the existing attack module, so
    // melee behavior is unchanged. Its "cooldown" and "ready" state
    // are computed views of the attack module's live state.
    const swordWeapon = {
        id: "sword",
        name: "Sword",
        shortName: "SWORD",   // compact label for the mobile swap button
        glyph: "⚔",      // crossed swords, used by the HUD icon
        color: "#ffd166",
        damage: 1,            // per-hit damage; bump for heavier melee variants
        get ready() {
            return !attack.active && attack.cooldownTimer <= 0;
        },
        cooldownFrac() {
            if (attack.active) return 0;
            if (attack.cooldownTimer <= 0) return 1;
            return 1 - attack.cooldownTimer / attack.cooldown;
        },
        fire(player) {
            // Latch this weapon's damage into the attack module so the
            // collision path picks it up. Melee variants only need to
            // ship a different `damage` value.
            attack.damage = this.damage;
            attack.tryStart(player);
        },
        update(_dt) { /* attack module ticks itself */ },
        reset() { /* attack state is reset elsewhere */ },
    };

    // Energy blast: owns its own cooldown and spawns a projectile on
    // fire. Uses the same `sound.play("attack")` cue for now so the
    // existing spam guard applies.
    const energyWeapon = {
        id: "energy",
        name: "Energy Blast",
        shortName: "ENERGY",
        glyph: "✦",
        color: "#8ad9ff",
        cooldownMax: 0.5,
        cooldownTimer: 0,
        get ready() { return this.cooldownTimer <= 0; },
        cooldownFrac() {
            if (this.cooldownTimer <= 0) return 1;
            return 1 - this.cooldownTimer / this.cooldownMax;
        },
        fire(player) {
            if (!this.ready) return;
            this.cooldownTimer = this.cooldownMax;
            spawnProjectile(player, { color: this.color });
            sound.play("attack");
        },
        update(dt) {
            if (this.cooldownTimer > 0) {
                this.cooldownTimer = Math.max(0, this.cooldownTimer - dt);
            }
        },
        reset() { this.cooldownTimer = 0; },
    };

    const weapons = [swordWeapon, energyWeapon];

    function currentWeapon() {
        return weapons[player.weaponIndex] ?? weapons[0];
    }

    // ---------------------------------------------------------------
    // Power move
    //
    // A radial AoE burst around the player - a counterweight to the
    // 3-HP enemy rebalance. High damage, long cooldown, short active
    // window. Independent of the weapon system so it's always
    // available no matter what's equipped.
    //
    // The activation window lasts a few frames and `hitEnemies`
    // guarantees each enemy is damaged exactly once per cast (same
    // pattern as the sword's per-swing hit set).
    //
    // Numbers are laid out at the top so balancing is one place.
    // ---------------------------------------------------------------
    const powerMove = {
        // Tunables
        cooldownMax: 3.5,
        activeDuration: 0.22,
        radius: 80,
        damage: 3,

        // Runtime
        cooldownTimer: 0,
        activeTimer: 0,
        hitEnemies: new Set(),

        get ready() {
            return this.cooldownTimer <= 0 && this.activeTimer <= 0;
        },

        cooldownFrac() {
            if (this.cooldownTimer <= 0) return 1;
            return 1 - this.cooldownTimer / this.cooldownMax;
        },

        activate(_entity) {
            if (!this.ready) return false;
            this.cooldownTimer = this.cooldownMax;
            this.activeTimer = this.activeDuration;
            this.hitEnemies.clear();
            sound.play("power");
            return true;
        },

        update(dt) {
            if (this.activeTimer > 0) {
                this.activeTimer = Math.max(0, this.activeTimer - dt);
            }
            if (this.cooldownTimer > 0) {
                this.cooldownTimer = Math.max(0, this.cooldownTimer - dt);
            }
        },

        reset() {
            this.cooldownTimer = 0;
            this.activeTimer = 0;
            this.hitEnemies.clear();
        },

        // Expanding ring + glow centered on the player. Drawn in
        // world space so it scrolls with the world correctly.
        draw(ctx, entity) {
            if (this.activeTimer <= 0) return;
            const t = 1 - this.activeTimer / this.activeDuration; // 0 -> 1
            const r = this.radius * (0.55 + 0.5 * t);
            const cx = Math.round(entity.x + entity.width / 2);
            const cy = Math.round(entity.y + entity.height / 2);
            const fade = 1 - t;

            ctx.save();

            // Inner bloom
            ctx.globalAlpha = fade * 0.28;
            ctx.fillStyle = "#ffd166";
            ctx.beginPath();
            ctx.arc(cx, cy, r * 0.9, 0, Math.PI * 2);
            ctx.fill();

            // Expanding rim
            ctx.globalAlpha = fade * 0.85;
            ctx.strokeStyle = "#ffd166";
            ctx.lineWidth = 6 * fade + 2;
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.stroke();

            // Bright core rim
            ctx.globalAlpha = fade;
            ctx.strokeStyle = "#fff6d6";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.stroke();

            ctx.restore();
        },
    };

    // Applies power-move damage to enemies inside the radius. Uses
    // squared-distance compare (no sqrt) and reuses the per-cast
    // `hitEnemies` set so each enemy takes damage at most once per
    // activation, even though the active window spans several frames.
    function updatePowerMoveCollision() {
        if (powerMove.activeTimer <= 0) return;
        const cx = player.x + player.width / 2;
        const cy = player.y + player.height / 2;
        const r2 = powerMove.radius * powerMove.radius;

        for (const e of enemies) {
            if (!e.alive || powerMove.hitEnemies.has(e)) continue;
            const ex = e.x + e.width / 2;
            const ey = e.y + e.height / 2;
            const dx = ex - cx;
            const dy = ey - cy;
            if (dx * dx + dy * dy <= r2) {
                e.takeHit(powerMove.damage);
                powerMove.hitEnemies.add(e);
                if (!e.alive) {
                    stats.addKill(e);
                    rollEnemyDrop(e);
                }
            }
        }
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

        // Damage dealt per hit. Latched by the active melee weapon on
        // `tryStart` so future weapon variants (broadsword, dagger,
        // boss sword) can ship their own damage value without
        // touching the collision code.
        damage: 1,

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
            sound.play("attack");
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

        // Scratch rect - mutated and returned by `getHitbox` so we
        // don't allocate a fresh object every frame during a swing.
        _hitbox: { x: 0, y: 0, w: 0, h: 0 },

        // Returns the current hitbox as an axis-aligned rect, or null
        // if the attack isn't active. The returned rect is owned by
        // the attack module - callers must not hold it across frames.
        getHitbox(entity) {
            if (!this.active) return null;

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

            const out = this._hitbox;
            out.x = x; out.y = y; out.w = w; out.h = h;
            return out;
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

            // Hit points. Basic enemies take multiple hits now so
            // combat has weight; the HP pip (rendered when maxHp > 1)
            // is what gives the player mid-fight feedback on how much
            // damage they've dealt.
            this.hp = opts.hp ?? 3;
            this.maxHp = this.hp;
            this.alive = true;

            // Contact damage dealt to the player on overlap. Exposed
            // on the instance so bosses / elites can hit harder via
            // opts.contactDamage without touching the collision code.
            this.contactDamage = opts.contactDamage ?? 10;

            // Points awarded on defeat. Variant enemies (elites,
            // bosses) can override via opts.reward.
            this.reward = opts.reward ?? 10;

            // XP granted on defeat. Independent from `reward` so
            // bosses can give fat XP without trivializing score.
            this.xpReward = opts.xpReward ?? 10;

            // Sprite + animation (each enemy owns its own animator so
            // their walk cycles aren't locked in lockstep).
            this.sheet = opts.sheet ?? enemySheet;
            this.animator = opts.animator ?? makeEnemyAnimator();

            // Hit flash - lit white for a brief window after being
            // struck. `hitFlashDuration` controls how long the flash
            // lasts; `hitFlash` counts down and drives opacity.
            this.hitFlashDuration = 0.14;
            this.hitFlash = 0;
        }

        update(dt, target) {
            if (!this.alive) return;

            if (this.hitFlash > 0) this.hitFlash = Math.max(0, this.hitFlash - dt);

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
            const x = Math.round(this.x);
            const y = Math.round(this.y);
            this.sheet.draw(ctx, this.animator.col, this.animator.row, x, y);

            // Hit flash - white tint composited only over the sprite's
            // opaque pixels via "source-atop". Cheap: one extra fillRect
            // per flashing enemy, and the window is ~0.14s so the total
            // active-flash overhead is negligible.
            if (this.hitFlash > 0) {
                const a = Math.min(1, this.hitFlash / this.hitFlashDuration);
                ctx.save();
                ctx.globalCompositeOperation = "source-atop";
                ctx.fillStyle = `rgba(255, 255, 255, ${a.toFixed(3)})`;
                ctx.fillRect(x, y, this.width, this.height);
                ctx.restore();
            }

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
            this.hitFlash = this.hitFlashDuration;
            sound.play("enemyHit");
            if (this.hp <= 0) this.alive = false;
        }

        // Expose a rect in the shape used by rectsOverlap / getHitbox.
        // Reuses a per-enemy scratch object so hot collision loops
        // don't allocate each frame. Mutate-and-return is safe because
        // the caller reads the rect immediately in the same tick.
        bounds() {
            if (!this._bounds) this._bounds = { x: 0, y: 0, w: 0, h: 0 };
            const b = this._bounds;
            b.x = this.x;
            b.y = this.y;
            b.w = this.width;
            b.h = this.height;
            return b;
        }
    }

    // ---------------------------------------------------------------
    // Enemy spawning
    // ---------------------------------------------------------------
    const enemies = [];

    // Hard safety cap on simultaneously-active enemies. The `spawner`
    // below owns the gameplay-tuned population target (which grows
    // with elapsed run time); MAX_ENEMIES is the ceiling that any
    // future system - bosses, events, scripted waves, the difficulty
    // ramp - must respect. Raise once a broadphase (spatial grid,
    // quadtree) is in place.
    const MAX_ENEMIES = 12;

    // `spawnEnemy` is the low-level primitive: add an enemy at the
    // given coords, or refuse if we're at the hard cap. Every higher-
    // level spawner in the game funnels through here so the cap is
    // the single source of truth.
    function spawnEnemy(x, y, opts) {
        if (enemies.length >= MAX_ENEMIES) return null;
        const e = new Enemy(x, y, opts);
        enemies.push(e);
        return e;
    }

    // ---------------------------------------------------------------
    // Spawner
    //
    // Picks random positions on the map that satisfy simple rules
    // (inside bounds with a margin, far enough from the player, not
    // on a solid tile) and trickles enemies in over time.
    //
    // Difficulty ramp
    //   The current `maxActive` and spawn `interval` are linearly
    //   interpolated from (startMaxActive, startInterval) to
    //   (endMaxActive, endInterval) over `rampSeconds` of elapsed
    //   run time. After that they plateau at the endpoint - a bounded
    //   curve, not runaway scaling. `reset()` puts the ramp back to
    //   its start on restart.
    //
    //   All the knobs sit at the top of the object so tuning is a
    //   single-line change.
    // ---------------------------------------------------------------
    const spawner = {
        // --- Difficulty ramp (tunable) ---
        startMaxActive: 5,           // opening population target
        endMaxActive: MAX_ENEMIES,   // fully-ramped target (hard cap)
        startInterval: 2.5,          // seconds between spawns at start
        endInterval: 0.6,            // seconds between spawns at peak
        rampSeconds: 120,            // time to reach full difficulty

        // --- Placement constraints ---
        minDistFromPlayer: 200,      // don't spawn right on top of the player
        margin: 64,                  // keep clear of the stone border

        // --- Runtime state ---
        maxActive: 5,
        interval: 2.5,
        timer: 0,
        elapsed: 0,

        // Per-level Enemy opts. Populated by `configure(level)` and
        // passed to every spawnEnemy call so each zone can ship its
        // own hp / speed / reward.
        enemyOpts: {},

        // Recompute maxActive / interval from the current `elapsed`.
        // Cheap (a few arithmetic ops), and once the ramp peaks we
        // pin the values and skip the math entirely each tick.
        refresh() {
            if (this.elapsed >= this.rampSeconds) {
                this.interval = this.endInterval;
                this.maxActive = this.endMaxActive;
                return;
            }
            const t = this.elapsed / this.rampSeconds;
            this.interval =
                this.startInterval + (this.endInterval - this.startInterval) * t;
            this.maxActive = Math.floor(
                this.startMaxActive +
                    (this.endMaxActive - this.startMaxActive) * t
            );
        },

        // Try random candidate positions until one meets our rules.
        // Caps attempts so a bad config (e.g. margins that leave no
        // valid area) can't freeze the frame.
        findSpot() {
            const minDistSq = this.minDistFromPlayer * this.minDistFromPlayer;
            const px = player.x + player.width / 2;
            const py = player.y + player.height / 2;

            for (let i = 0; i < 24; i++) {
                const x = this.margin + Math.random() * (WORLD_W - 2 * this.margin);
                const y = this.margin + Math.random() * (WORLD_H - 2 * this.margin);

                const dx = x - px;
                const dy = y - py;
                if (dx * dx + dy * dy < minDistSq) continue;

                // Reserved for when world.isSolid does something.
                const col = Math.floor(x / TILE);
                const row = Math.floor(y / TILE);
                if (world.isSolid(col, row)) continue;

                return { x, y };
            }
            return null;
        },

        // Populate the world at boot / on level entry. Seeds to the
        // *starting* cap so the opening reads as calm; the ramp grows
        // it from there. Each spawn uses the current level's
        // enemyOpts so caverns get tougher enemies than the grove.
        seed() {
            const n = this.maxActive;
            for (let i = 0; i < n; i++) {
                const spot = this.findSpot();
                if (spot) spawnEnemy(spot.x, spot.y, this.enemyOpts);
            }
        },

        // Point the spawner at a new level. Caller follows with
        // reset() + seed() when loading the room fresh.
        configure(level) {
            this.startMaxActive = level.enemyCount;
            this.enemyOpts = level.enemyOpts;
        },

        // Called each tick. Advances the difficulty clock, then
        // trickles new enemies in when the world drops below target.
        // Short-circuits in safe zones so the clock doesn't advance
        // while the player is wandering an NPC city.
        update(dt) {
            if (isSafeZone()) return;

            this.elapsed += dt;
            this.refresh();

            if (enemies.length >= this.maxActive) {
                this.timer = 0;
                return;
            }
            this.timer -= dt;
            if (this.timer > 0) return;
            this.timer = this.interval;

            const spot = this.findSpot();
            if (spot) spawnEnemy(spot.x, spot.y, this.enemyOpts);
        },

        // Rewind to the opening difficulty. Called by restartGame.
        reset() {
            this.elapsed = 0;
            this.timer = 0;
            this.refresh();
        },
    };

    // Initialize runtime values from the opening config before seeding.
    spawner.configure(currentLevel);
    spawner.reset();
    spawner.seed();

    // ---------------------------------------------------------------
    // NPCs - per-zone friendly characters.
    //
    // Each NPC is a data-only object spelled out in its home level's
    // `npcs` array. The fields are:
    //
    //   id             unique within the zone
    //   name           display name (used in dialogue)
    //   x, y           world-space position
    //   width, height  hitbox (32x32 by default)
    //   interactRange  px radius for the "E" prompt + interact
    //   colors         { robe, trim, sash, hat } for the sprite
    //   interact()     called when the player engages. No arg.
    //
    // A single `drawNpc(ctx, n)` helper renders any NPC using the
    // template + colors, so adding roles (Elder, Merchant, Villager,
    // Scout, Blacksmith...) is one more object in a level's list.
    //
    // Wander behavior
    //   Each Npc has a tiny state machine: `idle` (stand still for
    //   a random pause) → `walk` (move slowly toward a target point
    //   within `wanderRadius` of their home spawn) → `idle` when
    //   they arrive or the walk timer expires. Targets are re-rolled
    //   each walk, clamped to the world margin, and derived from
    //   the NPC's *home* position so they orbit their plaza instead
    //   of drifting across the map. Frame cost per NPC is a handful
    //   of arithmetic ops.
    // ---------------------------------------------------------------
    class Npc {
        constructor(config) {
            // Display + interaction fields from the caller's config.
            // `interact` is a function, preserved verbatim.
            Object.assign(this, config);

            // Lock "home" to the spawn position so wander always
            // orbits this spot regardless of current position.
            this.homeX = this.x;
            this.homeY = this.y;

            this.wanderRadius = config.wanderRadius ?? 90;
            this.speed = config.speed ?? 38;     // slow walk - npc pace
            this.margin = config.margin ?? 72;   // world-edge buffer

            this.state = "idle";
            this.stateTimer = 0.8 + Math.random() * 1.8;
            this.targetX = this.x;
            this.targetY = this.y;
            this.age = 0;
        }

        update(dt) {
            this.age += dt;
            this.stateTimer -= dt;

            if (this.state === "idle") {
                if (this.stateTimer <= 0) {
                    this._pickWanderTarget();
                    this.state = "walk";
                    // Walk-state timer is a safety net so an NPC who
                    // gets stuck (e.g. target clamped into them) can
                    // always fall back to idle.
                    this.stateTimer = 3 + Math.random() * 3;
                }
                return;
            }

            // Walking - step toward target, stop when close or when
            // the safety timer runs out.
            const dx = this.targetX - this.x;
            const dy = this.targetY - this.y;
            const dist = Math.hypot(dx, dy);
            if (dist < 2 || this.stateTimer <= 0) {
                this.state = "idle";
                this.stateTimer = 1.2 + Math.random() * 2.4;
                return;
            }
            const step = Math.min(dist, this.speed * dt);
            const inv = 1 / dist;
            this.x += dx * inv * step;
            this.y += dy * inv * step;
        }

        _pickWanderTarget() {
            const angle = Math.random() * Math.PI * 2;
            const r = 18 + Math.random() * this.wanderRadius;
            let tx = this.homeX + Math.cos(angle) * r;
            let ty = this.homeY + Math.sin(angle) * r;

            // Keep NPCs inside the city bounds. Margin mirrors the
            // spawner's world-edge margin so they stay well off the
            // outer stone wall.
            tx = Math.max(this.margin, Math.min(WORLD_W - this.margin - this.width, tx));
            ty = Math.max(this.margin, Math.min(WORLD_H - this.margin - this.height, ty));

            this.targetX = tx;
            this.targetY = ty;
        }

        // Small vertical bob only while walking. Called from drawNpc.
        bobOffset() {
            return this.state === "walk" ? Math.sin(this.age * 6) * 1 : 0;
        }
    }

    // Advances every NPC in the current level. Cheap: one state-
    // machine tick + a bounded-distance move per NPC. Safe to call
    // in both combat and safe zones; NPCs only live in the grove.
    function updateNpcs(dt) {
        for (const n of activeNpcs()) n.update(dt);
    }

    function activeNpcs() {
        return currentLevel.npcs || [];
    }

    function npcIsNear(n) {
        const cx = n.x + n.width / 2;
        const cy = n.y + n.height / 2;
        const px = player.x + player.width / 2;
        const py = player.y + player.height / 2;
        const dx = px - cx;
        const dy = py - cy;
        return dx * dx + dy * dy <= n.interactRange * n.interactRange;
    }

    // Closest NPC within their interactRange, or null.
    function nearestNpc() {
        let best = null;
        let bestD = Infinity;
        for (const n of activeNpcs()) {
            const cx = n.x + n.width / 2;
            const cy = n.y + n.height / 2;
            const px = player.x + player.width / 2;
            const py = player.y + player.height / 2;
            const dx = px - cx;
            const dy = py - cy;
            const d = dx * dx + dy * dy;
            if (d <= n.interactRange * n.interactRange && d < bestD) {
                best = n;
                bestD = d;
            }
        }
        return best;
    }

    // Simple world-space building sprite. Walls + overhanging roof +
    // a door with handle, plus a gold "SHOP" / similar label above
    // the roof. Keeps the city readable without needing real art.
    function drawBuilding(ctx, b) {
        const x = b.x;
        const y = b.y;

        // Walls
        ctx.fillStyle = b.wall ?? "#8c5a3c";
        ctx.fillRect(x, y, b.w, b.h);
        // Faint top highlight
        ctx.fillStyle = "rgba(255, 255, 255, 0.10)";
        ctx.fillRect(x, y, b.w, 5);
        // Vertical plank shading
        ctx.fillStyle = "rgba(0, 0, 0, 0.14)";
        for (let i = 20; i < b.w; i += 20) {
            ctx.fillRect(x + i, y + 6, 1, b.h - 6);
        }

        // Roof overhang (wraps past the walls)
        ctx.fillStyle = b.roof ?? "#5a3a22";
        ctx.fillRect(x - 6, y - 18, b.w + 12, 18);
        ctx.fillStyle = "#3c2818";
        ctx.fillRect(x - 6, y - 18, b.w + 12, 3);

        // Window panes flanking the door
        const windY = y + Math.floor(b.h * 0.35);
        ctx.fillStyle = "#3c2818";
        ctx.fillRect(x + 16, windY, 24, 20);
        ctx.fillRect(x + b.w - 40, windY, 24, 20);
        ctx.fillStyle = "#8ad9ff";
        ctx.fillRect(x + 18, windY + 2, 20, 16);
        ctx.fillRect(x + b.w - 38, windY + 2, 20, 16);
        ctx.fillStyle = "rgba(255, 255, 255, 0.35)";
        ctx.fillRect(x + 18, windY + 2, 20, 4);
        ctx.fillRect(x + b.w - 38, windY + 2, 20, 4);

        // Door frame + door
        ctx.fillStyle = "#3c2818";
        ctx.fillRect(b.doorX - 2, b.doorY - 2, b.doorW + 4, b.doorH + 2);
        ctx.fillStyle = "#d4a574";
        ctx.fillRect(b.doorX, b.doorY, b.doorW, b.doorH);
        // Door plank seam
        ctx.fillStyle = "rgba(0, 0, 0, 0.22)";
        ctx.fillRect(b.doorX + b.doorW / 2 - 0.5, b.doorY + 2, 1, b.doorH - 4);
        // Door handle
        ctx.fillStyle = "#ffd166";
        ctx.fillRect(b.doorX + b.doorW - 6, b.doorY + b.doorH / 2 - 1, 2, 2);

        // Label above the roof - shadow + gold
        if (b.label) {
            ctx.save();
            ctx.textAlign = "center";
            ctx.textBaseline = "bottom";
            ctx.font = "bold 13px system-ui, sans-serif";
            ctx.fillStyle = "rgba(0, 0, 0, 0.65)";
            ctx.fillText(b.label, x + b.w / 2 + 1, y - 22 + 1);
            ctx.fillStyle = "#ffd166";
            ctx.fillText(b.label, x + b.w / 2, y - 22);
            ctx.restore();
        }

        // Small "enter" hint when the player is right on the door.
        if (gameState === "playing" && buildingDoorOverlap(b, player)) {
            const bx = b.doorX + b.doorW / 2;
            const by = b.doorY - 12;
            ctx.save();
            ctx.fillStyle = "#1a1a24";
            ctx.beginPath();
            ctx.arc(bx, by, 11, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = "#ffd166";
            ctx.lineWidth = 1.5;
            ctx.stroke();
            ctx.fillStyle = "#ffd166";
            ctx.font = "bold 13px system-ui, sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText("E", bx, by + 1);
            ctx.restore();
        }
    }

    // AABB test between a player-sized rect and a building door.
    function buildingDoorOverlap(b, p) {
        return (
            p.x < b.doorX + b.doorW &&
            p.x + p.width > b.doorX &&
            p.y < b.doorY + b.doorH &&
            p.y + p.height > b.doorY
        );
    }

    function drawNpc(ctx, n) {
        const x = Math.round(n.x);
        const y = Math.round(n.y);
        // Walk bob rides on top of everything but the shadow, so
        // NPCs visibly "step" without their shadow moving off the
        // ground.
        const bob = n.bobOffset ? Math.round(n.bobOffset()) : 0;
        const c = n.colors;

        // Shadow (stays anchored to the ground)
        ctx.fillStyle = "rgba(0, 0, 0, 0.28)";
        ctx.beginPath();
        ctx.ellipse(x + 16, y + 29, 9, 3, 0, 0, Math.PI * 2);
        ctx.fill();

        // Robe
        ctx.fillStyle = c.robe;
        ctx.fillRect(x + 8, y + 12 + bob, 16, 16);
        ctx.fillStyle = c.trim;
        ctx.fillRect(x + 8, y + 25 + bob, 16, 3);
        // Sash
        ctx.fillStyle = c.sash;
        ctx.fillRect(x + 8, y + 19 + bob, 16, 2);

        // Head
        ctx.fillStyle = "#e8c096";
        ctx.fillRect(x + 10, y + 6 + bob, 12, 8);
        // Hat
        ctx.fillStyle = c.hat;
        ctx.fillRect(x + 9, y + 3 + bob, 14, 4);

        // Eyes
        ctx.fillStyle = "#1a1a24";
        ctx.fillRect(x + 13, y + 10 + bob, 2, 2);
        ctx.fillRect(x + 17, y + 10 + bob, 2, 2);

        // Interact hint when in range (world-space bubble with "E").
        if (gameState === "playing" && npcIsNear(n)) {
            const bx = x + 16;
            const by = y - 14;
            ctx.save();
            ctx.fillStyle = "#1a1a24";
            ctx.beginPath();
            ctx.arc(bx, by, 11, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = c.sash;
            ctx.lineWidth = 1.5;
            ctx.stroke();
            ctx.fillStyle = c.sash;
            ctx.font = "bold 13px system-ui, sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText("E", bx, by + 1);
            ctx.restore();
        }
    }

    // --- Interact behaviors (shared so multiple NPCs can reference) ---

    // The Elder's familiar quest-chain dialogue.
    function elderInteract() {
        if (questLog.active) {
            const tmpl = QUESTS[questLog.active.id];
            questLog.showToast(
                `Elder: "${tmpl.description}"  (${questLog.active.progress}/${tmpl.target})`
            );
            return;
        }

        let id = "slay3";
        while (id && questLog.hasCompleted(id)) id = QUESTS[id].next;
        if (!id) {
            questLog.showToast('Elder: "Safe travels, hero."');
            return;
        }
        questLog.accept(id);
    }

    // ---------------------------------------------------------------
    // Dialogue
    //
    // Modal conversation UI. `dialogue.open(npc)` reads the NPC's
    // declarative `dialogue` config:
    //
    //   dialogue: {
    //       greeting: "Hello.",
    //       options: [
    //           { label: "Who are you?", response: "..." },
    //           { label: "Any work?",    action() { elderInteract(); } },
    //           { label: "Goodbye",      close: true },
    //       ],
    //   }
    //
    // Two modes:
    //   "menu"     — greeting + numbered option list
    //   "response" — selected option's response text + continue hint
    //
    // An option with `response` flips to response mode (continue
    // returns to menu). An option with `action` runs the callback
    // and closes dialogue. An option with `close: true` closes.
    // Adding new option types - quests, trades, yes/no branches -
    // is a matter of handling more fields in `selectOption`.
    //
    // Gameplay input (movement, attack, weapon switch, inventory,
    // power) is gated on `dialogue.isOpen()` so the world pauses
    // while the box is up.
    // ---------------------------------------------------------------

    // ---------------------------------------------------------------
    // Shop
    //
    // Modal storefront UI opened from an NPC dialogue option
    // (merchant's "Browse wares"). Shows a scrollable list of
    // placeholder items with name / effect / price. No purchase
    // flow yet - items render as read-only rows with a note that
    // the shop is coming soon. Designed so adding a buy-on-tap
    // handler later is a one-liner inside selectItem().
    // ---------------------------------------------------------------
    const SHOP_ITEMS = [
        { id: "potion",     name: "Health Potion",   effect: "Restores 30 HP",    price: 15 },
        { id: "iron_sword", name: "Iron Sword",      effect: "+1 sword damage",   price: 60 },
        { id: "focus_gem",  name: "Focus Gem",       effect: "Faster cooldowns",  price: 80 },
        { id: "shield",     name: "Wooden Shield",   effect: "Reduces damage",    price: 120 },
        { id: "elixir",     name: "Ethereon Elixir", effect: "Unknown...",        price: 500 },
    ];

    const shop = {
        open_: false,
        itemRects: [],
        closeRect: null,

        open()  { this.open_ = true;  this.itemRects = []; this.closeRect = null; },
        close() { this.open_ = false; this.itemRects = []; this.closeRect = null; },
        isOpen() { return this.open_; },

        // Placeholder: wallet + inventory integration comes later.
        selectItem(index) {
            const item = SHOP_ITEMS[index];
            if (!item) return;
            questLog.showToast(`"${item.name}" - coming soon!`, 1.8);
        },
    };

    // ---------------------------------------------------------------
    // Ask-a-question: open-ended NPC responses
    //
    // Each NPC's `dialogue` config may carry a `knowledge` array of
    //   { keywords: [...], response: "..." }
    // entries plus a `fallback` string. `askNpc(npc, question)` walks
    // the knowledge list and returns the first matching response, or
    // the fallback if nothing matches.
    //
    // The function is async. Today it resolves synchronously with a
    // keyword hit, but shaping it as async means a future AI backend
    // can drop in via one of two seams:
    //
    //   1. Set `window.aiResponder = async (npc, q) => string` to
    //      override *every* NPC globally (e.g. OpenAI / a local
    //      model).
    //   2. Per-NPC: set `npc.dialogue.respond = async (q) => string`
    //      to override one character's answers.
    //
    // The keyword matcher stays as a zero-cost local fallback.
    // ---------------------------------------------------------------
    async function askNpc(npc, question) {
        // Global override (future AI backend drops in here).
        if (typeof window.aiResponder === "function") {
            try { return await window.aiResponder(npc, question); } catch { /* fall through */ }
        }

        const d = npc.dialogue;
        if (!d) return "...";

        // Per-NPC override.
        if (typeof d.respond === "function") {
            try { return await d.respond(question); } catch { /* fall through */ }
        }

        // Built-in keyword matcher.
        const q = (question || "").toLowerCase();
        for (const entry of d.knowledge || []) {
            for (const kw of entry.keywords) {
                if (q.includes(kw.toLowerCase())) return entry.response;
            }
        }
        return d.fallback ?? "Hmm - I don't know much about that, traveler.";
    }

    // ---------------------------------------------------------------
    // Question input (HTML overlay)
    //
    // A real `<input>` element floated over the canvas so the user
    // gets the native keyboard on mobile. Created on demand,
    // re-used across NPCs, hidden whenever dialogue closes or
    // switches modes.
    // ---------------------------------------------------------------
    let questionInputEl = null;

    function ensureQuestionInput() {
        if (questionInputEl) return questionInputEl;
        const el = document.createElement("input");
        el.id = "question-input";
        el.type = "text";
        el.maxLength = 140;
        el.autocomplete = "off";
        el.spellcheck = false;
        el.placeholder = "Type your question...";
        Object.assign(el.style, {
            position: "fixed",
            left: "50%",
            bottom: "30%",
            transform: "translateX(-50%)",
            width: "min(420px, 82vw)",
            padding: "14px 18px",
            fontSize: "16px",
            fontFamily: "system-ui, sans-serif",
            color: "#e8e8f0",
            background: "rgba(18, 18, 30, 0.97)",
            border: "2px solid #ffd166",
            borderRadius: "10px",
            outline: "none",
            zIndex: "1000",
            display: "none",
            boxShadow: "0 10px 28px rgba(0, 0, 0, 0.5)",
        });

        // Stop keys from leaking into the game loop.
        el.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
                e.preventDefault();
                submitQuestion();
            } else if (e.key === "Escape") {
                e.preventDefault();
                hideQuestionInput();
                // Back to the option menu, dialogue still open.
                if (dialogue.isOpen()) {
                    dialogue.active.mode = "menu";
                    dialogue.active.text = dialogue.active.greeting;
                }
            }
        });
        el.addEventListener("keyup", (e) => e.stopPropagation());

        document.body.appendChild(el);
        questionInputEl = el;
        return el;
    }

    function showQuestionInput() {
        const el = ensureQuestionInput();
        el.value = "";
        el.style.display = "block";
        // Focus must happen inside the user gesture (tap / keydown
        // that triggered this) for iOS to show the virtual keyboard.
        el.focus();
    }

    function hideQuestionInput() {
        if (!questionInputEl) return;
        questionInputEl.blur();
        questionInputEl.style.display = "none";
    }

    async function submitQuestion() {
        if (!questionInputEl) return;
        const raw = questionInputEl.value.trim();
        hideQuestionInput();
        if (!raw) {
            // Empty submit: go back to the menu.
            if (dialogue.isOpen()) {
                dialogue.active.mode = "menu";
                dialogue.active.text = dialogue.active.greeting;
            }
            return;
        }
        if (!dialogue.isOpen()) return;
        const npc = dialogue.active.npc;

        // Show a brief "thinking" state while the (async) responder
        // resolves - cheap placeholder today, meaningful once the
        // AI backend is wired.
        dialogue.active.mode = "response";
        dialogue.active.text = '...';

        try {
            const response = await askNpc(npc, raw);
            if (dialogue.isOpen()) {
                dialogue.active.text = `"${response}"`;
                dialogue.active.mode = "response";
            }
        } catch (err) {
            if (dialogue.isOpen()) {
                dialogue.active.text = "(They seem unsure how to answer.)";
                dialogue.active.mode = "response";
            }
        }
    }

    const dialogue = {
        active: null,              // { speaker, greeting, options, text, mode }
        optionRects: [],           // screen-space hitboxes for touch

        open(npc) {
            if (!npc || !npc.dialogue) {
                // Legacy fallback: NPCs without a dialogue config
                // still fire their old interact() directly.
                if (npc && typeof npc.interact === "function") npc.interact();
                return;
            }
            const d = npc.dialogue;
            this.active = {
                speaker: npc.name,
                npc,                   // kept so submitQuestion can call askNpc
                greeting: d.greeting,
                options: d.options,
                text: d.greeting,
                mode: "menu",
            };
            this.optionRects = [];
        },

        close() {
            this.active = null;
            this.optionRects = [];
            hideQuestionInput();
        },

        isOpen() {
            return this.active !== null;
        },

        // Picks an option by its zero-based index. No-op if the
        // dialogue isn't in menu mode or the index is out of range.
        selectOption(index) {
            if (!this.active || this.active.mode !== "menu") return;
            const opt = this.active.options[index];
            if (!opt) return;
            if (opt.close) { this.close(); return; }
            if (typeof opt.action === "function") {
                opt.action();
                this.close();
                return;
            }
            // Open-ended question: pop the input overlay. The
            // submit handler flips back to response mode with the
            // NPC's answer.
            if (opt.input) {
                this.active.mode = "input";
                this.active.text = "Ask your question below.";
                showQuestionInput();
                return;
            }
            if (typeof opt.response === "string") {
                this.active.text = opt.response;
                this.active.mode = "response";
                return;
            }
        },

        // In response mode, return to the menu. In menu mode, close.
        // Input mode is driven by the HTML field so this is a no-op
        // there (the field's own listeners handle Enter / Escape).
        advance() {
            if (!this.active) return;
            if (this.active.mode === "response") {
                this.active.text = this.active.greeting;
                this.active.mode = "menu";
            } else if (this.active.mode === "input") {
                // Fall through - input element owns the flow.
                return;
            } else {
                this.close();
            }
        },
    };

    // Populate the grove with four NPCs: Elder (quest), Merchant
    // (placeholder shop), Villager (flavor), Scout (lore hint).
    LEVELS.grove.npcs = [
        new Npc({
            id: "elder",
            name: "Village Elder",
            // On the stone plaza south of the main road, a few tiles
            // east of the fountain.
            x: 1232,
            y: 1024,
            width: 32, height: 32,
            interactRange: 60,
            // Slightly wider so the Elder paces the plaza instead of
            // pinning to one spot.
            wanderRadius: 60,
            speed: 24,
            colors: { robe: "#6b4e91", trim: "#503872", sash: "#ffd166", hat: "#4a2f70" },
            dialogue: {
                greeting: '"Greetings, traveler. The grove welcomes you."',
                options: [
                    {
                        label: "Who are you?",
                        response: "I am the Elder - keeper of these grounds since before the star-fall.",
                    },
                    {
                        label: "What is this place?",
                        response: "The Sunlit Grove. Last safe haven before the dark places east.",
                    },
                    {
                        label: "Any work for me?",
                        action: elderInteract,  // jumps into the quest chain
                    },
                    { label: "Ask a question...", input: true },
                    { label: "Goodbye.", close: true },
                ],
                knowledge: [
                    { keywords: ["name", "who are", "elder"], response: "I am the Elder - keeper of the grove." },
                    { keywords: ["grove", "place", "town", "city"], response: "The Sunlit Grove. The star-fall spared it for a reason." },
                    { keywords: ["shop", "merchant", "buy"], response: "Hemlen's shop lies west of the plaza. Tell them the Elder sent you." },
                    { keywords: ["quest", "work", "job", "help"], response: "Hunts, mostly. Select 'Any work?' and I'll set you a task." },
                    { keywords: ["east", "cavern", "dungeon", "danger"], response: "East lies the Echo Caverns, and beyond, the Shrine. Tread carefully." },
                    { keywords: ["shrine"], response: "The Shrine is old - older than the star-fall. Relics still stir there." },
                    { keywords: ["star", "fall", "sky"], response: "When the star fell, the world broke. We rebuilt here." },
                    { keywords: ["weapon", "sword", "energy"], response: "Begin with the sword. The energy blast is for those who prefer distance." },
                    { keywords: ["power", "ability"], response: "Your power move clears crowds - use it sparingly; it needs time to recharge." },
                    { keywords: ["potion", "heal", "health"], response: "Health potions sometimes drop from foes. The Merchant will sell proper ones soon." },
                ],
                fallback: "Hmm. I'm a keeper of grounds, not an oracle - try a simpler question.",
            },
        }),
        // Merchant moved indoors - see LEVELS.shop_interior.npcs below.
        new Npc({
            id: "villager",
            name: "Villager",
            // In the SW quarter between the tree grove and the main
            // road - tending the old gardens, as their dialogue says.
            x: 680,
            y: 1260,
            width: 32, height: 32,
            interactRange: 60,
            wanderRadius: 140,
            speed: 42,
            colors: { robe: "#4e915c", trim: "#356840", sash: "#a0d0a0", hat: "#2f5a3a" },
            dialogue: {
                greeting: '"Oh! A visitor. Good to see a new face."',
                options: [
                    {
                        label: "Who are you?",
                        response: "Just a resident - I tend the old gardens by the well.",
                    },
                    {
                        label: "What is this place?",
                        response: "The Sunlit Grove. The Elder knows its history better than I.",
                    },
                    {
                        label: "Any work for me?",
                        response: "You'll want the Elder for that. I'm just a gardener.",
                    },
                    { label: "Ask a question...", input: true },
                    { label: "Goodbye.", close: true },
                ],
                knowledge: [
                    { keywords: ["name", "who are"], response: "I'm no one special - just a gardener." },
                    { keywords: ["garden", "flower", "plant"], response: "The gardens by the west fence - they're my quiet corner." },
                    { keywords: ["grove", "place", "town"], response: "Lovely place, isn't it? Quiet, mostly." },
                    { keywords: ["elder"], response: "The Elder's on the plaza. Kind soul, but gruff about quests." },
                    { keywords: ["merchant", "shop"], response: "Hemlen keeps the shop - look for the building with the brown roof." },
                    { keywords: ["scout"], response: "Our Scout watches the east gate. Nothing gets past them." },
                    { keywords: ["weather", "day"], response: "Sunny today. But then, it's always sunny in the Grove." },
                    { keywords: ["danger", "enemy", "cavern"], response: "I don't go east myself. Too loud beyond the gate." },
                ],
                fallback: "I wouldn't know, honestly. You should ask the Elder.",
            },
        }),
        new Npc({
            id: "scout",
            name: "Scout",
            // Patrolling near the east gate (the exit to the caverns).
            x: 2100,
            y: 880,
            width: 32, height: 32,
            interactRange: 60,
            // Wider radius + faster pace - they're on watch.
            wanderRadius: 110,
            speed: 54,
            colors: { robe: "#3c5c8c", trim: "#223a5a", sash: "#8ad9ff", hat: "#1a2c46" },
            dialogue: {
                greeting: '"Stay alert out there. The watch is thin."',
                options: [
                    {
                        label: "Who are you?",
                        response: "A scout of the grove's watch. I patrol the gates.",
                    },
                    {
                        label: "What's east of here?",
                        response: "The Echo Caverns. Beyond, the Shrine. Ruin and relic both.",
                    },
                    {
                        label: "Any advice?",
                        response: "Keep a weapon ready and your health full. Retreat costs nothing.",
                    },
                    { label: "Ask a question...", input: true },
                    { label: "Goodbye.", close: true },
                ],
                knowledge: [
                    { keywords: ["name", "who"], response: "A scout. I watch the east gate." },
                    { keywords: ["east", "gate"], response: "East is the Echo Caverns. Don't go unprepared." },
                    { keywords: ["cavern"], response: "Enemies there hit harder than grove critters. Three blows each, at least." },
                    { keywords: ["shrine"], response: "Past the caverns. Deep trouble - relic-bearing beasts." },
                    { keywords: ["weapon", "sword", "energy"], response: "Sword for quick work, energy for range. Switch with 1 / 2 or the swap button." },
                    { keywords: ["power", "ability"], response: "The power burst hits everyone around you. Save it for crowds." },
                    { keywords: ["heal", "health", "potion"], response: "Potions drop sometimes. Don't waste them on scratches." },
                    { keywords: ["quest"], response: "The Elder assigns work. Finish theirs and we'll trust you with harder runs." },
                    { keywords: ["danger", "die", "death"], response: "Fall in combat and you'll respawn in the grove. Try not to make a habit of it." },
                    { keywords: ["tip", "advice", "help"], response: "Strafe around enemies. Let their AI chase while you hit and back off." },
                ],
                fallback: "Out of my depth. Try the Elder.",
            },
        }),
    ];

    // Shop interior roster - the Merchant lives inside the building.
    // Positions use interior coords (15x10 tile room = 480x320 px).
    LEVELS.shop_interior.npcs = [
        new Npc({
            id: "merchant",
            name: "Merchant",
            x: 240 - 16,     // room center-x
            y: 140,           // near the counter, away from the door
            width: 32, height: 32,
            interactRange: 60,
            wanderRadius: 24,  // barely moves - minding the counter
            speed: 18,
            colors: { robe: "#8c5a3c", trim: "#5f3c26", sash: "#e0b066", hat: "#3d2a18" },
            dialogue: {
                greeting: '"Welcome to my shop, traveler. Browse freely."',
                options: [
                    {
                        label: "Browse wares.",
                        action() { shop.open(); },
                    },
                    {
                        label: "Who are you?",
                        response: "Hemlen, trader of trinkets. My caravan is overdue.",
                    },
                    {
                        label: "Heard any news?",
                        response: "Strange lights from the shrine past the caverns. Locals don't go near.",
                    },
                    { label: "Ask a question...", input: true },
                    { label: "Goodbye.", close: true },
                ],
                knowledge: [
                    { keywords: ["name", "who", "hemlen"], response: "Hemlen - trader, at your service." },
                    { keywords: ["sell", "buy", "wares", "item", "shop"], response: "Browse the wares. No refunds... once the shelves are stocked, anyway." },
                    { keywords: ["potion", "heal", "health"], response: "Health potions will be first in stock when the caravan finally arrives." },
                    { keywords: ["sword", "weapon"], response: "I'll carry iron swords soon. For now, your starting blade serves." },
                    { keywords: ["caravan", "late", "overdue"], response: "Roads are rough east of here. I half suspect bandits - or worse." },
                    { keywords: ["shrine"], response: "Lights. Humming. Nobody comes back happy from the shrine." },
                    { keywords: ["elder", "village"], response: "The Elder keeps order. A good sort, even if they drive a hard bargain." },
                    { keywords: ["gold", "money", "coin", "price"], response: "Coins open doors, traveler. Slay beasts, gather coin, prosper." },
                ],
                fallback: "Trade's my business - I can't say I know much beyond it.",
            },
        }),
    ];

    // Place the camera on the player before the first frame so we
    // don't see it lerp in from (0, 0).
    camera.snap(player);

    // ---------------------------------------------------------------
    // Enemy update + collision with the player's attack
    // ---------------------------------------------------------------
    function updateEnemies(dt) {
        // Defense in depth: the main tick already gates this on
        // !isSafeZone, but leaving the check here means any future
        // caller (cutscene, debug tool) can't accidentally tick
        // enemy AI inside a safe zone.
        if (isSafeZone()) return;

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
                e.takeHit(attack.damage);
                attack.hitEnemies.add(e);
                // Only award once per enemy, right when the hit is
                // what killed them - multi-hit enemies (opts.hp > 1)
                // won't award until the final blow.
                if (!e.alive) {
                    stats.addKill(e);
                    rollEnemyDrop(e);
                }
            }
        }
    }

    // Reused scratch rect so updateEnemyContact doesn't allocate each frame.
    const _playerBox = { x: 0, y: 0, w: 0, h: 0 };

    // Enemy bodies touching the player deal contact damage. `damagePlayer`
    // is a no-op while iframes are active, so one collision won't drain
    // the whole bar.
    function updateEnemyContact() {
        if (!player.alive || isSafeZone()) return;
        _playerBox.x = player.x;
        _playerBox.y = player.y;
        _playerBox.w = player.width;
        _playerBox.h = player.height;
        for (const e of enemies) {
            if (!e.alive) continue;
            if (rectsOverlap(_playerBox, e.bounds())) {
                damagePlayer(e.contactDamage);
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

        // Fold in the virtual joystick. Its output is analog (length
        // 0..1) so a gentle tilt yields a slow walk, while a full
        // push matches a held arrow key.
        if (joystick.active) {
            dx += joystick.dx;
            dy += joystick.dy;
        }

        // Clamp the combined magnitude to 1 so pairing keyboard and
        // joystick (or pressing two arrow keys) never exceeds full
        // speed. This replaces the prior "normalize on diagonal"
        // special case and preserves analog magnitude when < 1.
        const mag = Math.hypot(dx, dy);
        if (mag > 1) {
            dx /= mag;
            dy /= mag;
        }

        // Update facing whenever there's fresh input (from key or
        // stick). Uses input rather than velocity so the character's
        // facing doesn't wobble while gliding to a stop.
        const inputActive = dx !== 0 || dy !== 0;
        if (inputActive) {
            player.facing.x = dx;
            player.facing.y = dy;

            const d = dirFromVector(dx, dy);
            if (d !== null) {
                player.facingDir = d;
                player.animator.setDir(d);
            }
        }

        // Smooth movement: input selects a *target* velocity, actual
        // velocity accelerates toward it. This gives the character a
        // touch of inertia - ~0.1s ramp in and ramp out - without
        // making it feel floaty. Frame-rate independent because we
        // cap the step by `accel * dt`.
        const targetVX = dx * player.speed;
        const targetVY = dy * player.speed;

        const dvx = targetVX - player.vx;
        const dvy = targetVY - player.vy;
        const step = player.accel * dt;
        const dvMag = Math.hypot(dvx, dvy);
        if (dvMag <= step || dvMag === 0) {
            player.vx = targetVX;
            player.vy = targetVY;
        } else {
            const k = step / dvMag;
            player.vx += dvx * k;
            player.vy += dvy * k;
        }

        // "Moving" for the animator is velocity-based so the walk
        // cycle keeps playing during the glide-to-stop deceleration.
        const moving = Math.abs(player.vx) + Math.abs(player.vy) > 5;
        player.animator.setState(moving ? "walk" : "idle");
        player.animator.update(dt);

        const nextX = player.x + player.vx * dt;
        const nextY = player.y + player.vy * dt;

        // Building entry: stepping onto a door rect transports the
        // player into the building's interior level.
        if (maybeEnterBuilding(nextX, nextY)) return;

        // Room-to-room transition: if the tentative step would carry
        // the player off the map, and the current level has an exit
        // on that side, and the player is aligned with the gap in
        // the border - hand off to the next level. Otherwise clamp.
        if (maybeTransitionOnEdge(nextX, nextY)) return;

        player.x = Math.max(0, Math.min(WORLD_W - player.width, nextX));
        player.y = Math.max(0, Math.min(WORLD_H - player.height, nextY));
    }

    // Returns true if the tentative step overlaps any building door
    // in the current level. Uses the tentative (pre-clamp) position
    // so the player enters cleanly the moment they walk into the
    // door rect - no need to stop moving first.
    function maybeEnterBuilding(nextX, nextY) {
        const buildings = currentLevel.buildings;
        if (!buildings || buildings.length === 0) return false;
        for (const b of buildings) {
            if (!b.interior) continue;
            if (
                nextX < b.doorX + b.doorW &&
                nextX + player.width > b.doorX &&
                nextY < b.doorY + b.doorH &&
                nextY + player.height > b.doorY
            ) {
                transitionTo(b.interior, null, b.entry);
                return true;
            }
        }
        return false;
    }

    // Returns true if a level transition was triggered (in which case
    // the caller should early-return - the new level's state is now
    // live). Only triggers when the player's center is within
    // EXIT_TRIGGER_PX of the midpoint of an edge that has an exit.
    // Exit values can be either a level id string (player arrives
    // at the default inset on the opposite side) or an object like
    // { level: "grove", arriveAt: { x, y } } for a specific warp
    // point - used by interiors that pop the player back to the
    // spot they entered from.
    function resolveExit(exit) {
        if (typeof exit === "string") return { level: exit, arriveAt: null };
        if (exit && typeof exit === "object") {
            return { level: exit.level, arriveAt: exit.arriveAt ?? null };
        }
        return null;
    }

    function maybeTransitionOnEdge(nextX, nextY) {
        const midX = WORLD_W / 2;
        const midY = WORLD_H / 2;
        const pcx = nextX + player.width / 2;
        const pcy = nextY + player.height / 2;

        const exits = currentLevel.exits;

        const west = resolveExit(exits.west);
        if (west && nextX < 0 &&
            Math.abs(pcy - midY) < EXIT_TRIGGER_PX) {
            transitionTo(west.level, "east", west.arriveAt);
            return true;
        }
        const east = resolveExit(exits.east);
        if (east && nextX + player.width > WORLD_W &&
            Math.abs(pcy - midY) < EXIT_TRIGGER_PX) {
            transitionTo(east.level, "west", east.arriveAt);
            return true;
        }
        const north = resolveExit(exits.north);
        if (north && nextY < 0 &&
            Math.abs(pcx - midX) < EXIT_TRIGGER_PX) {
            transitionTo(north.level, "south", north.arriveAt);
            return true;
        }
        const south = resolveExit(exits.south);
        if (south && nextY + player.height > WORLD_H &&
            Math.abs(pcx - midX) < EXIT_TRIGGER_PX) {
            transitionTo(south.level, "north", south.arriveAt);
            return true;
        }
        return false;
    }

    // ---------------------------------------------------------------
    // Combat input - trigger attacks on SPACE, once per press.
    // ---------------------------------------------------------------
    function updateCombatInput() {
        if (!player.alive) return;

        // Primary attack (weapon)
        const keyboardAttack = keysJustPressed[" "] || keysJustPressed["Spacebar"];
        const touchAttack = attackButton.consumeJustPressed();
        if (keyboardAttack || touchAttack) {
            // Fires whichever weapon is equipped. Each weapon self-
            // gates on its own `ready` check, so spam presses that
            // land on cooldown quietly no-op.
            currentWeapon().fire(player);
        }

        // Power move (shared across all weapons)
        const keyboardPower = keysJustPressed["q"] || keysJustPressed["Q"];
        const touchPower = powerButton.consumeJustPressed();
        if (keyboardPower || touchPower) {
            powerMove.activate(player);
        }
    }

    // ---------------------------------------------------------------
    // Update - top-level tick. Keeps sub-systems in a clear order.
    // ---------------------------------------------------------------
    function update(dt) {
        // Intro: any key press begins the game.
        if (gameState === "intro") {
            for (const k in keysJustPressed) {
                if (keysJustPressed[k]) { startGame(); break; }
            }
            clearJustPressed();
            return;
        }

        // Game over: frozen. The R key (and restart button, handled in
        // pointer events) are the only live inputs. The level-up
        // toast is left decaying so it can fade out gracefully.
        if (gameState === "gameover") {
            if (keysJustPressed["r"] || keysJustPressed["R"]) {
                restartGame();
            }
            if (stats.levelUpToast > 0) {
                stats.levelUpToast = Math.max(0, stats.levelUpToast - dt);
            }
            clearJustPressed();
            return;
        }

        // Shop is modal, same contract as dialogue: pick a row by
        // number, E / Escape closes.
        if (shop.isOpen()) {
            interactButton.consumeJustPressed();
            handleShopKeyInput();
            questLog.update(dt);
            if (stats.levelUpToast > 0) {
                stats.levelUpToast = Math.max(0, stats.levelUpToast - dt);
            }
            updateNpcs(dt);
            clearJustPressed();
            return;
        }

        // Dialogue is modal: while it's open, gameplay input is
        // suspended and the tick only routes keys to the dialogue
        // box. Number keys pick options; E / Space / Enter advance a
        // response back to the menu or close the menu; Escape closes
        // immediately. Consume the TALK button press so it doesn't
        // carry into gameplay when we close.
        if (dialogue.isOpen()) {
            interactButton.consumeJustPressed();
            handleDialogueKeyInput();
            questLog.update(dt);
            if (stats.levelUpToast > 0) {
                stats.levelUpToast = Math.max(0, stats.levelUpToast - dt);
            }
            updateNpcs(dt);   // NPCs keep wandering behind the dialogue
            clearJustPressed();
            return;
        }

        // Inventory toggle - edge-triggered, alive-only.
        if (keysJustPressed["i"] || keysJustPressed["I"]) {
            inventoryOpen = !inventoryOpen;
        }

        // Weapon switching - edge-triggered, alive-only.
        if (keysJustPressed["1"]) player.weaponIndex = 0;
        if (keysJustPressed["2"]) player.weaponIndex = 1;

        // NPC interact - E key or the mobile TALK button. Opens the
        // nearest NPC's dialogue box; a stray press with no NPC in
        // range is a no-op because nearestNpc returns null.
        const keyboardInteract = keysJustPressed["e"] || keysJustPressed["E"];
        const touchInteract = interactButton.consumeJustPressed();
        if (keyboardInteract || touchInteract) {
            const target = nearestNpc();
            if (target) dialogue.open(target);
        }

        // Tick transient UI state (quest + level toasts).
        questLog.update(dt);
        if (stats.levelUpToast > 0) {
            stats.levelUpToast = Math.max(0, stats.levelUpToast - dt);
        }

        updateMovement(dt);
        updateCombatInput();
        attack.update(dt);
        for (const w of weapons) w.update(dt);
        powerMove.update(dt);

        // Combat systems only tick in hostile zones. In safe zones
        // (NPC cities) enemy AI, spawning, and contact damage are all
        // disabled. Projectiles still tick so any in-flight shots
        // expire instead of freezing mid-air on a zone transition.
        if (!isSafeZone()) {
            updateEnemies(dt);
            updateAttackCollision();
            updatePowerMoveCollision();
            updateEnemyContact();
            spawner.update(dt);
        }
        updateProjectiles(dt);
        updatePlayerStatus(dt);
        updateDrops(dt);
        updateNpcs(dt);
        camera.follow(player, dt);
        clearJustPressed();
    }

    // ---------------------------------------------------------------
    // Base-stats snapshot. Captured at boot, after every module's
    // runtime values are at their "baseline" state - we use this to
    // restore level-up upgrades on restart. Keeps the reset story
    // declarative rather than re-typing constants.
    const baseStats = {
        playerMaxHp: player.maxHp,
        attackCooldown: attack.cooldown,
        swordDamage: swordWeapon.damage,
        energyDamage: energyWeapon.damage,
        energyCooldown: energyWeapon.cooldownMax,
        powerDamage: powerMove.damage,
    };

    // Transition out of the intro screen and into gameplay. Called
    // from the update tick (any key) and the pointerdown handler
    // (any tap). Resets the loop clock so the first live frame
    // doesn't get a huge dt from the intro's idle time.
    // Shop keyboard handling - mirror the dialogue model so the
    // muscle memory carries across modal panels.
    function handleShopKeyInput() {
        if (!shop.isOpen()) return;
        if (
            keysJustPressed["Escape"] ||
            keysJustPressed["e"] || keysJustPressed["E"]
        ) {
            shop.close();
            return;
        }
        for (let i = 1; i <= 9; i++) {
            if (keysJustPressed[String(i)]) {
                shop.selectItem(i - 1);
                return;
            }
        }
    }

    function handleShopPointer(x, y) {
        if (!shop.isOpen()) return;
        if (shop.closeRect) {
            const r = shop.closeRect;
            if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
                shop.close();
                return;
            }
        }
        const rects = shop.itemRects;
        for (let i = 0; i < rects.length; i++) {
            const r = rects[i];
            if (x >= r.x && x <= r.x + r.w &&
                y >= r.y && y <= r.y + r.h) {
                shop.selectItem(i);
                return;
            }
        }
    }

    // Pointer handling for the dialogue overlay. In response mode,
    // any tap advances back to the menu; in menu mode, taps test
    // against the option rects filled in by `drawDialogue`.
    function handleDialoguePointer(x, y) {
        if (!dialogue.isOpen()) return;
        if (dialogue.active.mode === "response") {
            dialogue.advance();
            return;
        }
        const rects = dialogue.optionRects;
        for (let i = 0; i < rects.length; i++) {
            const r = rects[i];
            if (x >= r.x && x <= r.x + r.w &&
                y >= r.y && y <= r.y + r.h) {
                dialogue.selectOption(i);
                return;
            }
        }
    }

    // Keyboard handling while a dialogue box is open. Separate
    // function so the normal-gameplay tick stays compact.
    function handleDialogueKeyInput() {
        if (!dialogue.isOpen()) return;

        if (keysJustPressed["Escape"]) {
            dialogue.close();
            return;
        }

        if (dialogue.active.mode === "response") {
            // Any "continue" key returns to the option menu.
            if (
                keysJustPressed["e"] || keysJustPressed["E"] ||
                keysJustPressed["Enter"] || keysJustPressed[" "]
            ) {
                dialogue.advance();
            }
            return;
        }

        // Menu mode: number keys pick options.
        for (let i = 1; i <= 9; i++) {
            if (keysJustPressed[String(i)]) {
                dialogue.selectOption(i - 1);
                return;
            }
        }
        // E closes the menu (same key that opened it).
        if (keysJustPressed["e"] || keysJustPressed["E"]) {
            dialogue.close();
        }
    }

    function startGame() {
        gameState = "playing";
        lastTime = performance.now();
        // Clear any held keys that might be stuck from the input
        // that dismissed the intro.
        for (const k in keys) keys[k] = false;
    }

    // ---------------------------------------------------------------
    // Level transitions
    //
    // Swaps the active LEVEL, regenerates world tiles, resets
    // transient combat state (enemies, projectiles, drops, attack),
    // warps the player to the arrival side, and reseeds the spawner.
    // Persistent player state (hp, xp, level, inventory, weapons,
    // quest progress, score) is preserved - only what belongs to
    // the room resets.
    //
    //   id         target level id from LEVELS catalog
    //   fromSide   which edge of the new level the player appears on
    //              ("north" | "south" | "east" | "west")
    // ---------------------------------------------------------------
    function transitionTo(id, fromSide, arriveAt) {
        const level = LEVELS[id];
        if (!level) return;

        currentLevel = level;
        world.load(level);

        // Explicit arrival point (used by interiors / building
        // entries) wins over side-based warp.
        if (arriveAt && typeof arriveAt.x === "number") {
            player.x = arriveAt.x;
            player.y = arriveAt.y;
        } else {
            // Warp to just inside the arrival edge, aligned with the
            // center of the perpendicular axis so the player enters
            // through the visible gap in the border.
            const inset = 56;
            if (fromSide === "west") {
                player.x = inset;
                player.y = WORLD_H / 2 - player.height / 2;
            } else if (fromSide === "east") {
                player.x = WORLD_W - player.width - inset;
                player.y = WORLD_H / 2 - player.height / 2;
            } else if (fromSide === "north") {
                player.x = WORLD_W / 2 - player.width / 2;
                player.y = inset;
            } else if (fromSide === "south") {
                player.x = WORLD_W / 2 - player.width / 2;
                player.y = WORLD_H - player.height - inset;
            }
        }
        player.vx = 0;
        player.vy = 0;

        // Transient combat state - belongs to the previous room.
        enemies.length = 0;
        projectiles.length = 0;
        drops.length = 0;
        attack.active = false;
        attack.timer = 0;
        attack.cooldownTimer = 0;
        attack.progress = 0;
        attack.hitEnemies.clear();
        powerMove.reset();

        // Reseed with the new level's enemy config.
        spawner.configure(level);
        spawner.reset();
        spawner.seed();

        // Snap the camera to prevent a visible pan from the old spot.
        camera.snap(player);

        // Level-name toast. Reuses the existing quest toast slot
        // since they're never active at the same moment in practice.
        questLog.showToast(`Entering: ${level.name}`, 2.0);
    }

    // Restart - resets every piece of run-scoped state back to its
    // boot values, including any level-up upgrades. New systems that
    // hold run state (pickups, xp, map seed) reset themselves here
    // so the reset story stays in one obvious place.
    // ---------------------------------------------------------------
    function restartGame() {
        gameState = "playing";

        // Stats (score, kills, level, xp)
        stats.reset();

        // Roll back any upgrades applied on previous level-ups.
        player.maxHp = baseStats.playerMaxHp;
        attack.cooldown = baseStats.attackCooldown;
        swordWeapon.damage = baseStats.swordDamage;
        energyWeapon.damage = baseStats.energyDamage;
        energyWeapon.cooldownMax = baseStats.energyCooldown;
        powerMove.damage = baseStats.powerDamage;

        // Player
        player.x = WORLD_W / 2 - 16;
        player.y = WORLD_H / 2 - 16;
        player.hp = player.maxHp;
        player.alive = true;
        player.iframes = 0;
        player.vx = 0;
        player.vy = 0;
        player.facing.x = 0;
        player.facing.y = 1;
        player.facingDir = DIR_DOWN;
        player.animator.setDir(DIR_DOWN);
        player.animator.setState("idle");

        // Attack
        attack.active = false;
        attack.timer = 0;
        attack.cooldownTimer = 0;
        attack.progress = 0;
        attack.hitEnemies.clear();

        // Enemies - wipe the array in place (preserves other refs),
        // rewind the difficulty ramp, and reseed from the spawner
        // using whatever level we're about to load (grove on restart).
        enemies.length = 0;
        currentLevel = LEVELS.grove;
        world.load(currentLevel);
        spawner.configure(currentLevel);
        spawner.reset();
        spawner.seed();

        // Inventory / drops / UI state - fresh run has no loot.
        player.inventory.length = 0;
        drops.length = 0;
        inventoryOpen = false;

        // Quests - fresh run resets the chain back to the start.
        questLog.reset();

        // Dialogue - close any open box, drop cached option rects.
        dialogue.close();

        // Shop - close any open shop window.
        shop.close();

        // Weapons - back to the starting loadout, clear any in-flight
        // projectiles, and reset each weapon's internal timers.
        player.weaponIndex = 0;
        projectiles.length = 0;
        for (const w of weapons) w.reset();

        // Power move - rewind cooldown and clear any active burst.
        powerMove.reset();

        // Camera - jump straight to the player so the world doesn't
        // pan in from wherever the death happened.
        camera.snap(player);

        // Touch inputs - make sure nothing is carrying over state
        // from the moment of death (e.g. finger still on the joystick
        // when HP hit zero).
        joystick.active = false;
        joystick.pointerId = null;
        joystick.dx = 0;
        joystick.dy = 0;
        attackButton.pressed = false;
        attackButton.pointerId = null;
        attackButton.justPressed = false;
        weaponSwapButton.pressed = false;
        weaponSwapButton.pointerId = null;
        powerButton.pressed = false;
        powerButton.pointerId = null;
        powerButton.justPressed = false;
        interactButton.pressed = false;
        interactButton.pointerId = null;
        interactButton.justPressed = false;
        restartButton.pressed = false;
        restartButton.pointerId = null;

        // Loop timing - prevent a huge dt spike on the first tick
        // after the restart keystroke.
        lastTime = performance.now();
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

        // Drops beneath enemies and player so they can't be obscured
        // by a live enemy standing over the same tile.
        drawDrops(ctx);

        // Buildings - simple world-space boxes with a door, label,
        // and roof. Drawn beneath NPCs and the player so characters
        // read on top when standing in front.
        for (const b of currentLevel.buildings || []) drawBuilding(ctx, b);

        // NPCs - one per entry in the current level's roster. Drawn
        // beneath the player so the player always reads on top. Each
        // draws its own "E" bubble when the player is in range.
        for (const n of activeNpcs()) drawNpc(ctx, n);

        // Enemies beneath the player so the player always reads on top.
        for (const e of enemies) e.draw(ctx);

        // Player - skipped on alternating "blinks" while in iframes
        // to give a classic invulnerability flash.
        drawPlayer();

        // Attack hitbox on top of the player.
        attack.draw(ctx, player);

        // Power move ring - big AoE, goes over the weapon hitbox.
        powerMove.draw(ctx, player);

        // Projectiles over everything else in the world layer.
        drawProjectiles(ctx);

        ctx.restore();

        // --- Screen space (HUD) ---
        drawStatsPanel();
        drawScore();
        drawHealthBar();
        drawXpBar();
        drawCooldownBar();
        drawEnemyCounter();
        joystick.draw(ctx);
        attackButton.draw(ctx);
        weaponSwapButton.draw(ctx);
        powerButton.draw(ctx);
        interactButton.draw(ctx);
        drawQuestPanel();

        if (stats.levelUpToast > 0) drawLevelUpToast();
        if (questLog.toastTimer > 0) drawQuestToast();
        if (inventoryOpen) drawInventory();
        if (dialogue.isOpen()) drawDialogue();
        if (shop.isOpen()) drawShop();

        // Overlays driven by the state machine.
        if (gameState === "gameover") {
            drawGameOver();
            restartButton.draw(ctx);
        }
        if (gameState === "intro") drawIntro();
    }

    // --- HUD helpers ---

    // Traces a rounded-rect path on the current context. Uses the
    // built-in Path2D method when available; falls back to arcTo.
    function roundRectPath(ctx, x, y, w, h, r) {
        if (ctx.roundRect) {
            ctx.beginPath();
            ctx.roundRect(x, y, w, h, r);
            return;
        }
        const rr = Math.min(r, w / 2, h / 2);
        ctx.beginPath();
        ctx.moveTo(x + rr, y);
        ctx.arcTo(x + w, y, x + w, y + h, rr);
        ctx.arcTo(x + w, y + h, x, y + h, rr);
        ctx.arcTo(x, y + h, x, y, rr);
        ctx.arcTo(x, y, x + w, y, rr);
        ctx.closePath();
    }

    // One-pixel dark offset + main color. Much cheaper than using
    // ctx.shadowBlur and reads cleanly over any terrain.
    function drawShadowedText(text, x, y, color, font) {
        ctx.font = font;
        ctx.fillStyle = "rgba(0, 0, 0, 0.75)";
        ctx.fillText(text, x + 1, y + 1);
        ctx.fillStyle = color;
        ctx.fillText(text, x, y);
    }

    // A subtle dark-glass panel behind the score / HP / XP stack so
    // the readouts don't compete with the terrain behind them.
    function drawStatsPanel() {
        ctx.save();
        roundRectPath(ctx, 8, 8, 280, 82, 8);
        ctx.fillStyle = "rgba(12, 12, 22, 0.62)";
        ctx.fill();
        ctx.strokeStyle = "rgba(255, 209, 102, 0.28)";
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();
    }

    // Score on the left, level badge on the right. Both line up on
    // the same row so the HUD reads left-to-right cleanly.
    function drawScore() {
        const x = 16;
        const y = 14;

        ctx.save();
        ctx.textBaseline = "top";
        drawShadowedText("SCORE", x, y, "#a0a0b8", "11px system-ui, sans-serif");
        drawShadowedText(
            String(stats.score).padStart(5, "0"),
            x + 46, y - 2,
            "#ffd166",
            "bold 20px system-ui, sans-serif"
        );

        // Level badge - lives in the right half of the panel.
        const lvlX = 228;
        drawShadowedText("LVL", lvlX, y, "#a0a0b8", "11px system-ui, sans-serif");
        drawShadowedText(
            String(stats.level),
            lvlX + 28, y - 2,
            "#8ad9ff",
            "bold 20px system-ui, sans-serif"
        );

        ctx.restore();
    }

    // XP progress bar directly below the HP bar. Cyan fill to echo
    // the level badge's color, and a small "XP" label on the left.
    function drawXpBar() {
        const barW = 252;
        const barH = 6;
        const x = 28;
        const y = 70;
        const r = 3;

        const frac = Math.max(0, Math.min(1, stats.xp / stats.xpForNext));

        ctx.save();

        // "XP" label left of the bar.
        ctx.textBaseline = "middle";
        drawShadowedText(
            "XP",
            12, y + barH / 2 + 1,
            "#a0a0b8",
            "bold 10px system-ui, sans-serif"
        );

        // Track
        roundRectPath(ctx, x, y, barW, barH, r);
        ctx.fillStyle = "#13131c";
        ctx.fill();

        // Fill
        if (frac > 0) {
            ctx.save();
            ctx.clip();
            ctx.fillStyle = "#8ad9ff";
            ctx.fillRect(x, y, barW * frac, barH);
            ctx.fillStyle = "rgba(255, 255, 255, 0.25)";
            ctx.fillRect(x, y + 1, barW * frac, 2);
            ctx.restore();
        }

        ctx.strokeStyle = "rgba(255, 255, 255, 0.18)";
        ctx.lineWidth = 1;
        roundRectPath(ctx, x + 0.5, y + 0.5, barW - 1, barH - 1, r);
        ctx.stroke();

        ctx.restore();
    }

    // Quest HUD - a compact panel that sits top-right on wide
    // viewports and drops below the stats panel on narrow (portrait)
    // viewports so the two never overlap. Uses the same dark-glass +
    // shadowed-text style as the rest of the HUD.
    function drawQuestPanel() {
        const w = 240;
        const h = 48;

        // Stats panel occupies x 8..288 at top. Give it 8px of gap
        // before placing the quest panel alongside.
        const canFitRight = VIEW_W >= 288 + w + 16;
        const x = canFitRight ? VIEW_W - w - 8 : 8;
        const y = canFitRight ? 8 : 98;

        ctx.save();
        roundRectPath(ctx, x, y, w, h, 8);
        ctx.fillStyle = "rgba(12, 12, 22, 0.62)";
        ctx.fill();
        ctx.strokeStyle = "rgba(138, 217, 255, 0.32)";
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.textBaseline = "top";
        drawShadowedText(
            "QUEST",
            x + 12, y + 8,
            "#a0a0b8",
            "11px system-ui, sans-serif"
        );

        if (!questLog.active) {
            drawShadowedText(
                "(none)  talk to the Elder",
                x + 58, y + 8,
                "#a0a0b8",
                "bold 12px system-ui, sans-serif"
            );
        } else {
            const tmpl = QUESTS[questLog.active.id];
            const prog = questLog.active.progress;
            const goal = tmpl.target;

            // Title
            drawShadowedText(
                tmpl.title,
                x + 58, y + 8,
                "#ffd166",
                "bold 13px system-ui, sans-serif"
            );

            // Progress bar below the title.
            const barX = x + 12;
            const barY = y + 28;
            const barW = w - 24;
            const barH = 8;
            const frac = Math.max(0, Math.min(1, prog / goal));

            roundRectPath(ctx, barX, barY, barW, barH, 4);
            ctx.fillStyle = "#13131c";
            ctx.fill();
            if (frac > 0) {
                ctx.save();
                ctx.clip();
                ctx.fillStyle = "#8ad9ff";
                ctx.fillRect(barX, barY, barW * frac, barH);
                ctx.fillStyle = "rgba(255, 255, 255, 0.22)";
                ctx.fillRect(barX, barY + 1, barW * frac, 2);
                ctx.restore();
            }
            ctx.strokeStyle = "rgba(255, 255, 255, 0.2)";
            ctx.lineWidth = 1;
            roundRectPath(ctx, barX + 0.5, barY + 0.5, barW - 1, barH - 1, 4);
            ctx.stroke();

            // Progress numbers aligned to the right of the bar.
            ctx.textAlign = "right";
            drawShadowedText(
                `${prog} / ${goal}`,
                x + w - 12, y + 9,
                "#8ad9ff",
                "bold 12px system-ui, sans-serif"
            );
            ctx.textAlign = "start";
        }

        ctx.restore();
    }

    // Center-screen toast for quest events (start / progress
    // reminder / completion). Fades out over its remaining time.
    function drawQuestToast() {
        const full = 2.5;
        const t = 1 - questLog.toastTimer / full;
        const alpha = Math.max(0, 1 - t);

        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        drawShadowedText(
            questLog.toast,
            VIEW_W / 2, VIEW_H / 2 - 40,
            "#e8e8f0",
            "bold 18px system-ui, sans-serif"
        );
        ctx.restore();
    }

    // Gold "LEVEL UP!" flash that fades out over ~1.8s.
    function drawLevelUpToast() {
        const duration = 1.8;
        const t = 1 - stats.levelUpToast / duration; // 0 -> 1
        const alpha = Math.max(0, 1 - t);
        const offset = -30 * t;

        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        drawShadowedText(
            `LEVEL UP!  ${stats.level}`,
            VIEW_W / 2, VIEW_H / 2 - 80 + offset,
            "#ffd166",
            "bold 36px system-ui, sans-serif"
        );
        ctx.restore();
    }

    // Cinematic intro screen. Fades in the title over ~2s, then
    // pulses a "press / tap to begin" prompt.
    function drawIntro() {
        const now = performance.now();
        const elapsed = (now - introStart) / 1000;
        const titleFade = Math.min(1, elapsed / 1.6);
        const showPrompt = elapsed >= 1.6;

        // Full-screen dim so the world reads as "not playing yet".
        ctx.fillStyle = "rgba(10, 10, 20, 0.88)";
        ctx.fillRect(0, 0, VIEW_W, VIEW_H);

        ctx.save();
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        // Title - slides up slightly as it fades in.
        const titleY = VIEW_H / 2 - 40 + (1 - titleFade) * 20;
        ctx.globalAlpha = titleFade;
        drawShadowedText(
            "ETHEREON",
            VIEW_W / 2, titleY,
            "#ffd166",
            "bold 68px system-ui, sans-serif"
        );

        // Tagline
        ctx.globalAlpha = titleFade * 0.85;
        drawShadowedText(
            "a small action-RPG",
            VIEW_W / 2, titleY + 54,
            "#a0a0b8",
            "15px system-ui, sans-serif"
        );

        // Press / tap prompt - pulses gently after title resolves.
        if (showPrompt) {
            const pulse = 0.55 + 0.45 * Math.abs(Math.sin(now * 0.004));
            ctx.globalAlpha = pulse;
            drawShadowedText(
                "Press any key  or  tap to begin",
                VIEW_W / 2, VIEW_H / 2 + 90,
                "#e8e8f0",
                "bold 16px system-ui, sans-serif"
            );

            // Small hint line with the controls.
            ctx.globalAlpha = pulse * 0.7;
            drawShadowedText(
                "Arrows / joystick to move  ·  SPACE / ATK to attack  ·  Q / ★ for power",
                VIEW_W / 2, VIEW_H / 2 + 120,
                "#a0a0b8",
                "11px system-ui, sans-serif"
            );
        }

        ctx.restore();
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
        const y = 40;  // sits beneath the score readout
        const r = 5;

        const frac = Math.max(0, player.hp / player.maxHp);

        ctx.save();

        // Track (rounded dark background)
        roundRectPath(ctx, x, y, barW, barH, r);
        ctx.fillStyle = "#13131c";
        ctx.fill();

        // Fill - clip to the rounded track so the fill follows the
        // corner radius. Green -> orange -> red as it drops.
        if (frac > 0) {
            ctx.save();
            ctx.clip();
            ctx.fillStyle =
                frac > 0.5 ? "#7ad17a" :
                frac > 0.25 ? "#e0b066" : "#e06666";
            ctx.fillRect(x, y, barW * frac, barH);

            // Thin specular highlight across the top of the fill.
            ctx.fillStyle = "rgba(255, 255, 255, 0.18)";
            ctx.fillRect(x, y + 2, barW * frac, 2);
            ctx.restore();
        }

        // Rim
        ctx.strokeStyle = "rgba(255, 255, 255, 0.22)";
        ctx.lineWidth = 1;
        roundRectPath(ctx, x + 0.5, y + 0.5, barW - 1, barH - 1, r);
        ctx.stroke();

        // Numeric readout with drop shadow.
        ctx.textBaseline = "middle";
        drawShadowedText(
            `HP  ${Math.ceil(player.hp)} / ${player.maxHp}`,
            x + barW + 10, y + barH / 2,
            "#e8e8f0",
            "12px system-ui, sans-serif"
        );

        ctx.restore();
    }

    // Inventory panel - centered on screen. Aggregates `player.inventory`
    // Shop storefront panel. A centered list of placeholder items
    // with name, effect, and price. Each row is tappable (stored in
    // `shop.itemRects`) and the panel header carries a close button
    // whose hitbox is stashed in `shop.closeRect`.
    function drawShop() {
        const w = Math.min(420, VIEW_W - 40);
        const h = Math.min(380, VIEW_H - 60);
        const x = Math.floor((VIEW_W - w) / 2);
        const y = Math.floor((VIEW_H - h) / 2);

        // Dim world
        ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
        ctx.fillRect(0, 0, VIEW_W, VIEW_H);

        // Panel
        ctx.save();
        roundRectPath(ctx, x, y, w, h, 12);
        ctx.fillStyle = "rgba(18, 18, 30, 0.95)";
        ctx.fill();
        ctx.strokeStyle = "rgba(255, 209, 102, 0.55)";
        ctx.lineWidth = 2;
        ctx.stroke();

        // Header
        ctx.textBaseline = "top";
        ctx.textAlign = "center";
        drawShadowedText(
            "MERCHANT'S WARES",
            x + w / 2, y + 12,
            "#ffd166",
            "bold 16px system-ui, sans-serif"
        );

        // Close button (top-right X)
        const closeSize = 28;
        const closeX = x + w - closeSize - 8;
        const closeY = y + 8;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        roundRectPath(ctx, closeX, closeY, closeSize, closeSize, 6);
        ctx.fillStyle = "rgba(255, 110, 110, 0.2)";
        ctx.fill();
        ctx.strokeStyle = "rgba(255, 110, 110, 0.5)";
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = "#e06666";
        ctx.font = "bold 16px system-ui, sans-serif";
        ctx.fillText("×", closeX + closeSize / 2, closeY + closeSize / 2);
        shop.closeRect = { x: closeX, y: closeY, w: closeSize, h: closeSize };

        // Divider
        ctx.strokeStyle = "rgba(255, 209, 102, 0.3)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x + 16, y + 44);
        ctx.lineTo(x + w - 16, y + 44);
        ctx.stroke();

        // Item rows
        shop.itemRects = [];
        const rowH = 44;
        const rowPad = 8;
        let ry = y + 54;
        for (let i = 0; i < SHOP_ITEMS.length; i++) {
            const item = SHOP_ITEMS[i];
            const rx = x + 16;
            const rw = w - 32;

            ctx.save();
            roundRectPath(ctx, rx, ry, rw, rowH, 8);
            ctx.fillStyle = "rgba(255, 209, 102, 0.08)";
            ctx.fill();
            ctx.strokeStyle = "rgba(255, 209, 102, 0.28)";
            ctx.lineWidth = 1;
            ctx.stroke();
            ctx.restore();

            // Number prefix
            ctx.textAlign = "left";
            ctx.textBaseline = "top";
            drawShadowedText(
                String(i + 1),
                rx + 10, ry + 6,
                "#ffd166",
                "bold 12px system-ui, sans-serif"
            );
            // Name
            drawShadowedText(
                item.name,
                rx + 26, ry + 6,
                "#e8e8f0",
                "bold 14px system-ui, sans-serif"
            );
            // Effect line
            drawShadowedText(
                item.effect,
                rx + 26, ry + 24,
                "#a0a0b8",
                "11px system-ui, sans-serif"
            );
            // Price pill (right)
            ctx.textAlign = "right";
            drawShadowedText(
                `${item.price}g`,
                rx + rw - 10, ry + 14,
                "#ffd166",
                "bold 13px system-ui, sans-serif"
            );
            ctx.textAlign = "left";

            shop.itemRects.push({ x: rx, y: ry, w: rw, h: rowH });
            ry += rowH + rowPad;
        }

        // Footer hint
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        drawShadowedText(
            "Shop coming soon  ·  press E or tap  ×  to close",
            x + w / 2, y + h - 12,
            "#a0a0b8",
            "11px system-ui, sans-serif"
        );

        ctx.restore();
    }

    // Modal dialogue box. Sits at the bottom of the screen like a
    // Zelda / JRPG text window. Menu mode draws the greeting + a
    // numbered option list whose hitboxes are cached on
    // `dialogue.optionRects` for touch. Response mode draws the
    // response text and a "tap to continue" hint. The world behind
    // it keeps rendering (NPCs even keep wandering) so it reads as
    // a dialogue, not a full-screen menu.
    function drawDialogue() {
        const d = dialogue.active;
        if (!d) return;

        // Scale the box to the viewport so it reads on any screen.
        // 16px side margin, 92% of width capped at 640, 44% of
        // height (or 220 min) anchored at the bottom with an 18px
        // safe-area gap.
        const boxW = Math.min(640, VIEW_W - 32);
        const boxH = Math.max(200, Math.min(260, Math.round(VIEW_H * 0.44)));
        const x = Math.floor((VIEW_W - boxW) / 2);
        const y = VIEW_H - boxH - 18;

        // Backdrop dim - subtle, so the world stays legible.
        ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
        ctx.fillRect(0, 0, VIEW_W, VIEW_H);

        // Panel
        ctx.save();
        roundRectPath(ctx, x, y, boxW, boxH, 12);
        ctx.fillStyle = "rgba(18, 18, 30, 0.95)";
        ctx.fill();
        ctx.strokeStyle = "rgba(255, 209, 102, 0.55)";
        ctx.lineWidth = 2;
        ctx.stroke();

        // Speaker name banner
        ctx.textBaseline = "top";
        ctx.textAlign = "left";
        drawShadowedText(
            d.speaker,
            x + 18, y + 12,
            "#ffd166",
            "bold 16px system-ui, sans-serif"
        );

        // Divider under the speaker name
        ctx.strokeStyle = "rgba(255, 209, 102, 0.3)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x + 16, y + 38);
        ctx.lineTo(x + boxW - 16, y + 38);
        ctx.stroke();

        // Body text (wrapped across lines)
        const textX = x + 18;
        const textY = y + 50;
        const textMaxW = boxW - 36;
        const wrapped = wrapText(d.text, textMaxW, "14px system-ui, sans-serif");
        let lineY = textY;
        for (const line of wrapped) {
            drawShadowedText(
                line,
                textX, lineY,
                "#e8e8f0",
                "14px system-ui, sans-serif"
            );
            lineY += 18;
        }

        // Options area or continue hint
        dialogue.optionRects = [];
        if (d.mode === "menu") {
            // Options start below the body text, each clickable.
            const optionsTop = Math.max(lineY + 10, y + boxH - 10 - d.options.length * 26);
            for (let i = 0; i < d.options.length; i++) {
                const opt = d.options[i];
                const oy = optionsTop + i * 26;
                const oh = 24;
                const ox = x + 16;
                const ow = boxW - 32;

                // Highlight "Goodbye" row with the close accent.
                const isClose = opt.close === true;
                ctx.fillStyle = isClose
                    ? "rgba(110, 110, 130, 0.18)"
                    : "rgba(255, 209, 102, 0.10)";
                roundRectPath(ctx, ox, oy, ow, oh, 6);
                ctx.fill();
                ctx.strokeStyle = isClose
                    ? "rgba(160, 160, 184, 0.35)"
                    : "rgba(255, 209, 102, 0.38)";
                ctx.lineWidth = 1;
                ctx.stroke();

                // Number prefix + label
                drawShadowedText(
                    String(i + 1),
                    ox + 10, oy + 4,
                    isClose ? "#a0a0b8" : "#ffd166",
                    "bold 13px system-ui, sans-serif"
                );
                drawShadowedText(
                    opt.label,
                    ox + 30, oy + 4,
                    "#e8e8f0",
                    "13px system-ui, sans-serif"
                );

                dialogue.optionRects.push({ x: ox, y: oy, w: ow, h: oh });
            }
        } else if (d.mode === "input") {
            // Input mode: the HTML field sits outside the canvas, so
            // the panel just shows the prompt + a submit hint. Using
            // a muted accent so it doesn't fight the input field.
            ctx.textAlign = "center";
            drawShadowedText(
                "Type your question in the field above.",
                x + boxW / 2, y + boxH - 44,
                "#a0a0b8",
                "12px system-ui, sans-serif"
            );
            drawShadowedText(
                "Press Enter to ask  ·  Esc to cancel",
                x + boxW / 2, y + boxH - 24,
                "#ffd166",
                "bold 11px system-ui, sans-serif"
            );
            ctx.textAlign = "left";
        } else {
            // Response mode: continue hint at the bottom.
            const pulse = 0.55 + 0.45 * Math.abs(Math.sin(performance.now() * 0.004));
            ctx.globalAlpha = pulse;
            ctx.textAlign = "right";
            drawShadowedText(
                "tap / E to continue",
                x + boxW - 16, y + boxH - 20,
                "#a0a0b8",
                "bold 11px system-ui, sans-serif"
            );
            ctx.textAlign = "left";
            ctx.globalAlpha = 1;
        }

        ctx.restore();
    }

    // Small word-wrap helper. Walks through words, keeping a
    // running line and breaking when `measureText` exceeds maxW.
    // Called only while dialogue is open, so per-frame cost is
    // small - one measurement per word.
    function wrapText(text, maxW, font) {
        ctx.font = font;
        const words = text.split(/\s+/);
        const lines = [];
        let line = "";
        for (const word of words) {
            const probe = line ? line + " " + word : word;
            if (ctx.measureText(probe).width > maxW && line) {
                lines.push(line);
                line = word;
            } else {
                line = probe;
            }
        }
        if (line) lines.push(line);
        return lines;
    }

    // into counts at draw time, so add/remove stays O(1) and the UI
    // stays accurate without a dedicated counts cache.
    function drawInventory() {
        const w = 340;
        const h = 260;
        const x = Math.floor((VIEW_W - w) / 2);
        const y = Math.floor((VIEW_H - h) / 2);

        // Dim the world behind the panel.
        ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
        ctx.fillRect(0, 0, VIEW_W, VIEW_H);

        // Panel (reuses the rounded-rect + shadow-text helpers).
        ctx.save();
        roundRectPath(ctx, x, y, w, h, 10);
        ctx.fillStyle = "rgba(18, 18, 30, 0.92)";
        ctx.fill();
        ctx.strokeStyle = "rgba(255, 209, 102, 0.45)";
        ctx.lineWidth = 1;
        ctx.stroke();

        // Title
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        drawShadowedText(
            "INVENTORY",
            x + w / 2, y + 14,
            "#ffd166",
            "bold 18px system-ui, sans-serif"
        );

        // Build counts from the flat id array.
        const counts = Object.create(null);
        for (const id of player.inventory) {
            counts[id] = (counts[id] ?? 0) + 1;
        }
        const ids = Object.keys(counts);

        if (ids.length === 0) {
            drawShadowedText(
                "( empty )",
                x + w / 2, y + 60,
                "#a0a0b8",
                "14px system-ui, sans-serif"
            );
        } else {
            ctx.textAlign = "left";
            let ly = y + 54;
            for (const id of ids) {
                const tmpl = ITEMS[id];
                if (!tmpl) continue;

                // Colored swatch
                ctx.fillStyle = tmpl.color;
                ctx.fillRect(x + 28, ly + 4, 12, 12);
                ctx.strokeStyle = "rgba(0, 0, 0, 0.6)";
                ctx.lineWidth = 1;
                ctx.strokeRect(x + 28.5, ly + 4.5, 11, 11);

                // Name + count
                drawShadowedText(
                    `${tmpl.name}  x${counts[id]}`,
                    x + 50, ly + 3,
                    "#e8e8f0",
                    "14px system-ui, sans-serif"
                );
                ly += 24;
            }
        }

        // Close hint
        ctx.textAlign = "center";
        drawShadowedText(
            "Press  I  to close",
            x + w / 2, y + h - 30,
            "#a0a0b8",
            "12px system-ui, sans-serif"
        );

        ctx.restore();
    }

    function drawGameOver() {
        const cx = VIEW_W / 2;
        const cy = VIEW_H / 2;

        // Dim the world behind the panel.
        ctx.fillStyle = "rgba(0, 0, 0, 0.65)";
        ctx.fillRect(0, 0, VIEW_W, VIEW_H);

        ctx.save();
        ctx.textAlign = "center";
        ctx.textBaseline = "alphabetic";

        // Title
        ctx.fillStyle = "#ffd166";
        ctx.font = "bold 52px system-ui, sans-serif";
        ctx.fillText("GAME OVER", cx, cy - 40);

        // Final score - the headline stat.
        ctx.fillStyle = "#a0a0b8";
        ctx.font = "14px system-ui, sans-serif";
        ctx.fillText("FINAL SCORE", cx, cy + 4);

        ctx.fillStyle = "#e8e8f0";
        ctx.font = "bold 40px system-ui, sans-serif";
        ctx.fillText(String(stats.score).padStart(5, "0"), cx, cy + 46);

        // Kill count + level reached.
        ctx.fillStyle = "#a0a0b8";
        ctx.font = "13px system-ui, sans-serif";
        ctx.fillText(`Enemies defeated: ${stats.kills}`, cx, cy + 70);
        ctx.fillStyle = "#8ad9ff";
        ctx.fillText(`Reached level ${stats.level}`, cx, cy + 88);

        // The big RESTART button renders right below (drawn by
        // `restartButton.draw`, called from the HUD pass). A small
        // keyboard hint sits underneath it for desktop players.
        ctx.fillStyle = "#a0a0b8";
        ctx.font = "11px system-ui, sans-serif";
        ctx.fillText("( or press  R  )", cx, cy + 170);

        ctx.restore();
    }

    function drawEnemyCounter() {
        ctx.fillStyle = "#a0a0b8";
        ctx.font = "12px system-ui, sans-serif";
        ctx.fillText(`Enemies: ${enemies.length}`, VIEW_W - 96, VIEW_H - 16);
    }

    function drawCooldownBar() {
        const w = currentWeapon();
        const barW = 156;
        const barH = 8;

        const panelX = 12;
        const panelBottom = VIEW_H - 12;
        const iconSize = 34;
        // Each stat row = one icon on the left, bar+label on the right.
        const rowH = iconSize;
        const gap = 6;

        const powerRowY = panelBottom - rowH;
        const weaponRowY = powerRowY - rowH - gap;

        // --- Weapon row ---
        drawWeaponIcon(panelX, weaponRowY, iconSize, w);
        const barX = panelX + iconSize + 8;
        drawShadowedText(
            w.name.toUpperCase(),
            barX, weaponRowY + 3,
            "#e8e8f0",
            "bold 11px system-ui, sans-serif"
        );
        drawMiniBar(
            barX, weaponRowY + iconSize - barH - 4,
            barW, barH,
            w.cooldownFrac(),
            w.ready ? w.color : "#d17a7a"
        );

        // --- Power row ---
        const powerReady = powerMove.ready;
        drawPowerIcon(panelX, powerRowY, iconSize, powerReady);
        drawShadowedText(
            powerReady ? "POWER  READY" : "POWER  charging...",
            barX, powerRowY + 3,
            "#e8e8f0",
            "bold 11px system-ui, sans-serif"
        );
        drawMiniBar(
            barX, powerRowY + iconSize - barH - 4,
            barW, barH,
            powerMove.cooldownFrac(),
            powerReady ? "#ff8e3a" : "#7a4030"
        );
    }

    // Small rounded square showing the current weapon's glyph. Tint
    // shifts when the weapon is ready so the indicator doubles as a
    // "can-fire" light.
    function drawWeaponIcon(x, y, size, weapon) {
        ctx.save();
        roundRectPath(ctx, x, y, size, size, 6);
        ctx.fillStyle = weapon.ready ? "rgba(18, 18, 30, 0.85)" : "rgba(18, 18, 30, 0.7)";
        ctx.fill();
        ctx.strokeStyle = weapon.ready ? weapon.color : "rgba(255, 255, 255, 0.25)";
        ctx.lineWidth = 1.5;
        ctx.stroke();

        ctx.fillStyle = weapon.ready ? weapon.color : "rgba(255, 255, 255, 0.45)";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = "bold 18px system-ui, sans-serif";
        ctx.fillText(weapon.glyph, x + size / 2, y + size / 2 + 1);
        ctx.restore();
    }

    function drawPowerIcon(x, y, size, ready) {
        ctx.save();
        roundRectPath(ctx, x, y, size, size, 6);
        ctx.fillStyle = ready ? "rgba(30, 18, 18, 0.85)" : "rgba(18, 18, 30, 0.7)";
        ctx.fill();
        ctx.strokeStyle = ready ? "#ff8e3a" : "rgba(255, 255, 255, 0.25)";
        ctx.lineWidth = 1.5;
        ctx.stroke();

        ctx.fillStyle = ready ? "#ff8e3a" : "rgba(255, 255, 255, 0.45)";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = "bold 18px system-ui, sans-serif";
        ctx.fillText("★", x + size / 2, y + size / 2 + 1);
        ctx.restore();
    }

    function drawMiniBar(x, y, w, h, frac, color) {
        ctx.save();
        roundRectPath(ctx, x, y, w, h, h / 2);
        ctx.fillStyle = "#1a1a24";
        ctx.fill();
        if (frac > 0) {
            ctx.save();
            ctx.clip();
            ctx.fillStyle = color;
            ctx.fillRect(x, y, w * frac, h);
            ctx.fillStyle = "rgba(255, 255, 255, 0.22)";
            ctx.fillRect(x, y + 1, w * frac, 2);
            ctx.restore();
        }
        ctx.strokeStyle = "rgba(255, 255, 255, 0.18)";
        ctx.lineWidth = 1;
        roundRectPath(ctx, x + 0.5, y + 0.5, w - 1, h - 1, h / 2);
        ctx.stroke();
        ctx.restore();
    }

    // ---------------------------------------------------------------
    // Main loop
    //
    // Pauses automatically while the tab is hidden. Browsers already
    // throttle requestAnimationFrame in background tabs, but skipping
    // the update/draw entirely saves battery on mobile and prevents
    // stray keys/touches from advancing a game the player can't see.
    // On resume, `lastTime` is reset so the first visible frame gets
    // a normal-sized dt instead of a huge catch-up step.
    // ---------------------------------------------------------------
    let lastTime = performance.now();
    let running = !document.hidden;

    document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
            running = false;
        } else {
            running = true;
            lastTime = performance.now();
            // Release any held keys; they're "lost" while we're backgrounded.
            for (const k in keys) keys[k] = false;
            for (const k in keysJustPressed) delete keysJustPressed[k];
        }
    });

    function frame(now) {
        if (!running) {
            requestAnimationFrame(frame);
            return;
        }

        // Convert ms -> s, cap dt so any unexpected gap (hitch, GC,
        // just-unthrottled frame) can't teleport the simulation.
        const dt = Math.min((now - lastTime) / 1000, 1 / 30);
        lastTime = now;

        update(dt);
        draw();

        requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
})();
