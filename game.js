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

    // Start-screen "Tap to Start" button. Rect is recomputed every
    // frame drawIntro() runs (so resize follows automatically) and
    // read by the pointerdown handler for precise hit-testing.
    const startButton = {
        rect: { x: 0, y: 0, w: 0, h: 0 },
        contains(x, y) {
            const r = this.rect;
            return x >= r.x && x <= r.x + r.w &&
                   y >= r.y && y <= r.y + r.h;
        },
    };

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
    // Darker-than-stone floor for the post-boss "abyss" zone. Deep
    // purple-black obsidian with a faint cracked-stone fleck so it
    // reads as ancient ruin, not as a flat hole.
    const TILE_VOID = 5;

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
            // Expanded grove: 100 x 72 tiles = 3200 x 2304 px, so
            // the city can host three distinct districts plus roads
            // without feeling cramped. Other levels stay at default
            // dimensions.
            cols: 100,
            rows: 72,
            baseTile: TILE_GRASS,
            borderTile: TILE_STONE,
            scatter: [],
            // Designed town layout, zoned around a central plaza:
            //
            //   - Central hub: stone plaza with a fountain at the
            //     exact world center, anchored by the Elder.
            //   - Market district (NE): secondary stone plaza with
            //     a shop and a branch road connecting it to the hub.
            //   - Residential district (SW): path-tiled courtyard
            //     fronting three small houses with a branch road
            //     from the hub.
            //   - Trees: dense clusters in NW and SE corners so the
            //     outskirts read as wild woods, not empty grass.
            //   - Main cross: horizontal + vertical roads bisect the
            //     map, with branch roads off to each district. Walking
            //     from district to district always follows tile path.
            tileFn(c, r, cols, rows) {
                const cx = Math.floor(cols / 2);   // 50
                const cy = Math.floor(rows / 2);   // 36

                // Market and residential anchors.
                const mC = 75, mR = 18;
                const rC = 25, rR = 54;

                // Central plaza: stone disc around (cx, cy), r ~4.
                const pdx = c - cx;
                const pdy = r - cy;
                if (pdx * pdx + pdy * pdy <= 16) {
                    if (c === cx && r === cy) return TILE_WATER; // fountain
                    return TILE_STONE;
                }

                // Market plaza: smaller stone disc in the NE.
                const mdx = c - mC;
                const mdy = r - mR;
                if (mdx * mdx + mdy * mdy <= 20) return TILE_STONE;

                // Residential courtyard: path-tile disc in the SW.
                const rdx = c - rC;
                const rdy = r - rR;
                if (rdx * rdx + rdy * rdy <= 25) return TILE_PATH;

                // Main east-west road (2 tiles tall).
                if (r === cy || r === cy - 1) return TILE_PATH;

                // Main north-south road (2 tiles wide).
                if (c === cx || c === cx - 1) return TILE_PATH;

                // Market branch: from the hub north to the market.
                if (c === mC && r >= mR && r <= cy) return TILE_PATH;

                // Residential branch: from the hub south to the
                // residential courtyard.
                if (c === rC && r >= cy && r <= rR) return TILE_PATH;

                // Tree groves in NW + SE corners only - keep the
                // inhabited quarters visually clear.
                const h = hash2(c, r);
                const nwBox =
                    c >= 3 && c <= 22 && r >= 3 && r <= 16;
                const seBox =
                    c >= cols - 23 && c <= cols - 4 &&
                    r >= rows - 17 && r <= rows - 4;
                if (nwBox && h < 0.44) return TILE_TREE;
                if (seBox && h < 0.40) return TILE_TREE;

                // Sparse scatter everywhere else for texture.
                if (h < 0.012) return TILE_STONE;
                if (h > 0.988) return TILE_TREE;

                return TILE_GRASS;
            },
            enemyCount: 0,
            enemyOpts: {},
            exits: {
                east:  "caverns",
                // Sister-city links - arriveAt lands the player
                // just inside each destination's matching edge.
                south: { level: "port_halen", arriveAt: { x: 940,  y: 96 } },
                west:  { level: "emberhold",  arriveAt: { x: 1620, y: 696 } },
            },
            npcs: [],  // filled in after NPC_TEMPLATES
            // City buildings. The shop sits in the market district
            // (NE) and opens into an interior. The three houses are
            // visual-only (no `interior` set) so `maybeEnterBuilding`
            // skips them - plenty of room to add interiors later.
            buildings: [
                {
                    id: "shop",
                    label: "SHOP",
                    // Market district, north face of the plaza so its
                    // door opens south onto the stone square.
                    x: 2240, y: 480, w: 160, h: 130,
                    doorX: 2304, doorY: 588, doorW: 32, doorH: 22,
                    wall: "#8c5a3c",
                    roof: "#5a3a22",
                    interior: "shop_interior",
                    entry: { x: 224, y: 250 },
                },
                // Guild hall: west flank of the central hub, just
                // north of the plaza. Weathered blue-grey stones.
                {
                    id: "guild",
                    label: "GUILD",
                    x: 1280, y: 800, w: 170, h: 130,
                    doorX: 1334, doorY: 908, doorW: 32, doorH: 22,
                    wall: "#5a6e88",
                    roof: "#2c3a52",
                    interior: "guild_interior",
                    // Slightly south of center-bottom so the player
                    // arrives facing the Captain at the counter.
                    entry: { x: 256, y: 288 },
                },
                // Tavern: east flank of the central hub, mirrored
                // across the main road from the guild. Amber walls.
                {
                    id: "tavern",
                    label: "TAVERN",
                    x: 1680, y: 800, w: 170, h: 130,
                    doorX: 1734, doorY: 908, doorW: 32, doorH: 22,
                    wall: "#b08038",
                    roof: "#6a4a1a",
                    interior: "tavern_interior",
                    entry: { x: 256, y: 288 },
                },
                // Residential district (SW). Three houses flank the
                // path courtyard. All visual-only for now.
                {
                    id: "house_1",
                    label: "",
                    x: 560, y: 1600, w: 128, h: 100,
                    doorX: 612, doorY: 1678, doorW: 24, doorH: 22,
                    wall: "#a08060", roof: "#6a4a2a",
                },
                {
                    id: "house_2",
                    label: "",
                    x: 740, y: 1680, w: 128, h: 96,
                    doorX: 792, doorY: 1754, doorW: 24, doorH: 22,
                    wall: "#96765a", roof: "#603c22",
                },
                {
                    id: "house_3",
                    label: "",
                    x: 720, y: 1500, w: 120, h: 90,
                    doorX: 770, doorY: 1570, doorW: 24, doorH: 20,
                    wall: "#a88a6a", roof: "#744830",
                },
                // Two more residences tightening up the SW quarter -
                // visual only, now collision-solid via the new rule.
                {
                    id: "house_4",
                    label: "",
                    x: 380, y: 1580, w: 118, h: 92,
                    doorX: 428, doorY: 1652, doorW: 24, doorH: 20,
                    wall: "#927860", roof: "#5c3826",
                },
                {
                    id: "house_5",
                    label: "",
                    x: 880, y: 1620, w: 126, h: 96,
                    doorX: 934, doorY: 1696, doorW: 24, doorH: 20,
                    wall: "#b09580", roof: "#6e4838",
                },
                // Market stalls around the NE plaza - small wooden
                // stands with a striped awning, no interior. Serve
                // as ambient city clutter + soft-cover for combat
                // pathing if any spills over from the east gate.
                {
                    id: "stall_1", label: "", stall: true,
                    x: 2110, y: 650, w: 48, h: 38,
                    wall: "#b8823a", roof: "#d1a34a",
                },
                {
                    id: "stall_2", label: "", stall: true,
                    x: 2490, y: 650, w: 48, h: 38,
                    wall: "#a66c3a", roof: "#c8913a",
                },
                {
                    id: "stall_3", label: "", stall: true,
                    x: 2300, y: 720, w: 54, h: 40,
                    wall: "#8c5a3c", roof: "#c48a5c",
                },
                // One more stall on the main plaza side so the
                // central hub reads as lived-in, not empty.
                {
                    id: "stall_4", label: "", stall: true,
                    x: 1420, y: 1300, w: 52, h: 38,
                    wall: "#996836", roof: "#c7953b",
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
            exits: {
                west: "grove",
                // Shrine gate is sealed. The Elder's second quest
                // hands out the golden key that opens it.
                east: {
                    level: "shrine",
                    keyId: "gold_key",
                    lockedMessage: 'The shrine gate is sealed. You need a Golden Key.',
                },
            },
            // Chapter-3 mid-boss: Throne Warden. The three-phase AI
            // is gated by `multiPhase: true` so the Boss class's
            // phase logic fires only for this boss. Spawns only
            // once the player has actually reached chapter 3 (via
            // spawnBoss's chapterGate check) so early cavern runs
            // aren't blocked by a boss the player isn't ready for.
            boss: {
                name: "Throne Warden",
                // South-center of the caverns so the player meets
                // it mid-zone, not at the entrance.
                x: 2400 / 2 - 32,
                y: 1792 / 2 - 32,
                hp: 60,
                speed: 58,
                reward: 400,
                xpReward: 120,
                contactDamage: 22,
                multiPhase: true,
                chapterGate: "chapter3",
            },
            npcs: [],
            // Lore discoveries scattered along the cavern path.
            // Each piece reveals a sliver of pre-fall history so
            // reading them all paints a coherent world arc.
            lore: [
                {
                    id: "cavern_1",
                    name: "Weathered Marker",
                    kind: "statue",
                    x: 400, y: 880,
                    text: '"Before the star-fall, these tunnels were trade roads between seven cities. Now, echoes serve as coin."',
                },
                {
                    id: "cavern_2",
                    name: "Broken Relic",
                    kind: "relic",
                    x: 1200, y: 480,
                    text: '"The relic hummed once, I am told. Now it only watches. Whatever it awaits, it has waited long."',
                },
                {
                    id: "cavern_3",
                    name: "Traveler\'s Pack",
                    kind: "book",
                    x: 1420, y: 1360,
                    text: '"Their notes are dated three days before the fall. The last line reads: \'Grove is quiet. I\'ll return soon.\' They did not."',
                },
                {
                    id: "cavern_4",
                    name: "Warden\'s Mark",
                    kind: "statue",
                    x: 2040, y: 900,
                    text: '"A sigil of the Shrine Wardens. Their order collapsed a century before the star-fall; the mark endures - so, somewhere, does the duty."',
                },
            ],
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
            exits: {
                west: "caverns",
                // Sealed stair into the Abyss. Opens only after the
                // Shrine Keeper falls - the boss IS the lock.
                east: {
                    level: "abyss",
                    requiresBoss: "shrine",
                    lockedMessage:
                        "A seam in the shrine's east wall. Sealed. Something here must fall before it opens.",
                },
            },
            npcs: [],
            // Boss of the shrine. Appears once per visit, tracked in
            // `defeatedBosses` so finishing it sticks for the rest of
            // the run.
            boss: {
                name: "Shrine Keeper",
                // World-center spawn so the player sees it immediately
                // on entering from the west gate.
                x: 2400 / 2 - 32,
                y: 1792 / 2 - 32,
                hp: 30,
                speed: 72,
                reward: 500,
                xpReward: 120,
                contactDamage: 25,
            },
            lore: [
                {
                    id: "shrine_1",
                    name: "Shrine Tablet",
                    kind: "statue",
                    x: 860, y: 1100,
                    text: '"The Shrine was built around a wound in the world. The Keeper was built around the Shrine."',
                },
                {
                    id: "shrine_2",
                    name: "Keeper\'s Journal",
                    kind: "book",
                    x: 1180, y: 480,
                    text: '"\'I remember being a man. I remember a name. I remember less of it every dawn. Soon I will be the shrine itself.\'"',
                },
                {
                    id: "shrine_3",
                    name: "Ethereon Heart",
                    kind: "relic",
                    x: 1820, y: 1300,
                    text: '"A stone that beats when the shrine sleeps. They say when it stops, the world does too. Thus the Keeper. Thus the fall."',
                },
            ],
        },

        // The Abyss - post-boss dungeon. Unlocks only after the
        // Shrine Keeper falls (see shrine.exits.east.requiresBoss).
        // Obsidian floor, stronger foes, no NPCs. The sense of
        // descent is carried by the chapter6 cinematic played on
        // entry and by the tile palette; there's no boss here - the
        // zone itself is the reward for finishing the campaign.
        abyss: {
            id: "abyss",
            name: "The Abyss",
            safe: false,
            // Corrupting zone - the corruption module ticks upward
            // while the player is here, decays in safe zones.
            corrupting: true,
            baseTile: TILE_VOID,
            borderTile: TILE_STONE,
            scatter: [
                // Jagged stone pillars and dark rift pools break up
                // the obsidian floor without hiding the palette shift.
                { tile: TILE_STONE, prob: 0.08 },
                { tile: TILE_WATER, prob: 0.04 },
            ],
            // Crowded with stronger foes than caverns (4hp) or
            // shrine (5hp). Players reach this zone post-boss, usually
            // with several level-ups + shop upgrades, so the bump
            // keeps combat meaningful without being a wall.
            enemyCount: 9,
            enemyOpts: {
                hp: 10,
                speed: 140,
                contactDamage: 18,
                reward: 40,
                xpReward: 30,
            },
            exits: { west: "shrine" },
            npcs: [],
            lore: [
                {
                    id: "abyss_1",
                    name: "Collapsed Obelisk",
                    kind: "statue",
                    x: 500, y: 700,
                    text: '"The obelisk is older than the shrine that stood on it. Older than the language carved into its base. Older, perhaps, than the word for old."',
                },
                {
                    id: "abyss_2",
                    name: "Bound Pages",
                    kind: "book",
                    x: 1400, y: 1100,
                    text: '"\'They told us the Heart was placed here to be kept. I think now it was placed here to be forgotten.\'"',
                },
            ],
        },

        // Port Halen - coastal sister-city south of the grove. Sand
        // tiles under a stone plaza in the north, a wide harbor of
        // water tiles in the south with a wooden dock reaching out.
        // Safe zone (no combat), compact city feel with its own NPC
        // roster (sailors, fishmongers) and a small side quest chain.
        port_halen: {
            id: "port_halen",
            name: "Port Halen",
            safe: true,
            cols: 60, rows: 50,
            baseTile: TILE_PATH,
            borderTile: TILE_STONE,
            scatter: [],
            tileFn(c, r, cols, rows) {
                const cx = Math.floor(cols / 2);
                const plazaY = 14;
                // Harbor - lower third is water with a central dock.
                if (r >= rows - 14) {
                    // Wooden dock (2 tiles wide) extending south
                    // from the plaza.
                    if (c >= cx - 1 && c <= cx && r < rows - 2) return TILE_PATH;
                    return TILE_WATER;
                }
                // Central stone plaza.
                const pdx = c - cx;
                const pdy = r - plazaY;
                if (pdx * pdx + pdy * pdy <= 20) return TILE_STONE;
                // Main N-S road aligned with the dock.
                if (c === cx || c === cx - 1) return TILE_PATH;
                // E-W cross road through the plaza line.
                if (r === plazaY) return TILE_PATH;
                return TILE_PATH;
            },
            enemyCount: 0,
            enemyOpts: {},
            exits: {
                north: { level: "grove", arriveAt: { x: 1600, y: 2200 } },
            },
            npcs: [],
            buildings: [
                {
                    id: "harbor_office",
                    label: "HARBOR",
                    x: 820, y: 560, w: 150, h: 110,
                    doorX: 884, doorY: 660, doorW: 32, doorH: 22,
                    wall: "#4a7088", roof: "#24384c",
                },
                {
                    id: "fishmarket",
                    label: "MARKET",
                    x: 1100, y: 620, w: 140, h: 100,
                    doorX: 1158, doorY: 710, doorW: 32, doorH: 22,
                    wall: "#8c6a3c", roof: "#5a3a1e",
                },
                {
                    id: "lighthouse",
                    label: "LIGHT",
                    x: 1500, y: 450, w: 96, h: 160,
                    doorX: 1536, doorY: 598, doorW: 24, doorH: 22,
                    wall: "#d4d4de", roof: "#a03a3a",
                },
                // Three small cottages along the west road.
                { id: "cot_1", label: "",
                  x: 440, y: 700, w: 120, h: 92,
                  doorX: 488, doorY: 772, doorW: 24, doorH: 20,
                  wall: "#8ea4b8", roof: "#3c5066" },
                { id: "cot_2", label: "",
                  x: 440, y: 860, w: 120, h: 92,
                  doorX: 488, doorY: 932, doorW: 24, doorH: 20,
                  wall: "#9aa8bc", roof: "#455a70" },
                // Awning-style dock stalls on the plaza.
                { id: "halen_stall_1", label: "", stall: true,
                  x: 860, y: 820, w: 50, h: 38,
                  wall: "#5a8aa8", roof: "#8cc0d8" },
                { id: "halen_stall_2", label: "", stall: true,
                  x: 1060, y: 820, w: 50, h: 38,
                  wall: "#8c6a3c", roof: "#c89858" },
            ],
        },

        // Emberhold - mountain forge city west of the grove. Stone
        // floor throughout, roads of path tiles, clusters of trees
        // at the north / south ridges. Smith / miner / artisan NPCs.
        emberhold: {
            id: "emberhold",
            name: "Emberhold",
            safe: true,
            cols: 55, rows: 44,
            baseTile: TILE_STONE,
            borderTile: TILE_STONE,
            scatter: [],
            tileFn(c, r, cols, rows) {
                const cx = Math.floor(cols / 2);
                const cy = Math.floor(rows / 2);
                // Central forge plaza - path tiles in a ring around a
                // stone hearth (kept as stone) at the center.
                const pdx = c - cx;
                const pdy = r - cy;
                if (pdx * pdx + pdy * pdy <= 22 &&
                    pdx * pdx + pdy * pdy >= 6) return TILE_PATH;
                // Main cross roads.
                if (c === cx || c === cx - 1) return TILE_PATH;
                if (r === cy || r === cy - 1) return TILE_PATH;
                // Trees at the north / south ridges suggesting the
                // surrounding mountainside.
                if ((r < 4 || r > rows - 4) && Math.random() < 0.4) {
                    return TILE_TREE;
                }
                return TILE_STONE;
            },
            enemyCount: 0,
            enemyOpts: {},
            exits: {
                east: { level: "grove", arriveAt: { x: 96, y: 1152 } },
            },
            npcs: [],
            buildings: [
                {
                    id: "forge",
                    label: "FORGE",
                    x: 920, y: 560, w: 180, h: 140,
                    doorX: 1000, doorY: 690, doorW: 36, doorH: 22,
                    wall: "#8c3a2a", roof: "#52201a",
                },
                {
                    id: "miner_hall",
                    label: "MINERS",
                    x: 560, y: 580, w: 150, h: 110,
                    doorX: 620, doorY: 680, doorW: 32, doorH: 22,
                    wall: "#6a5a4c", roof: "#382a20",
                },
                {
                    id: "stonework",
                    label: "CARVER",
                    x: 1200, y: 640, w: 140, h: 100,
                    doorX: 1258, doorY: 730, doorW: 32, doorH: 22,
                    wall: "#8a8492", roof: "#4a4656",
                },
                { id: "forge_stall_1", label: "", stall: true,
                  x: 860, y: 780, w: 50, h: 38,
                  wall: "#6a4a2a", roof: "#c25a3a" },
                { id: "forge_stall_2", label: "", stall: true,
                  x: 1020, y: 780, w: 50, h: 38,
                  wall: "#5a4030", roof: "#a85238" },
            ],
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
                    // Drop the player just below the shop's door in
                    // the market district (matches the grove shop
                    // building's doorX / doorY + h below).
                    arriveAt: { x: 2304, y: 630 },
                },
            },
            npcs: [],  // merchant appended after dialogue is defined
            buildings: [],
            isInterior: true,
        },

        // Tavern interior - social hub. Keeper stands at the counter;
        // resting heals the player to full HP.
        tavern_interior: {
            id: "tavern_interior",
            name: "The Travellers' Rest",
            safe: true,
            cols: 17, rows: 11,        // 544 x 352 px
            baseTile: TILE_PATH,
            borderTile: TILE_STONE,
            scatter: [],
            enemyCount: 0,
            enemyOpts: {},
            exits: {
                south: {
                    level: "grove",
                    // Below the tavern building's door.
                    arriveAt: { x: 1750, y: 950 },
                },
            },
            npcs: [],
            buildings: [],
            isInterior: true,
        },

        // Guild hall interior - quest board + Captain. Future side
        // quests plug in here via dialogue options.
        guild_interior: {
            id: "guild_interior",
            name: "Adventurers' Guild",
            safe: true,
            cols: 17, rows: 11,
            baseTile: TILE_PATH,
            borderTile: TILE_STONE,
            scatter: [],
            enemyCount: 0,
            enemyOpts: {},
            exits: {
                south: {
                    level: "grove",
                    arriveAt: { x: 1350, y: 950 },
                },
            },
            npcs: [],
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
        // Initial allocation sized to the MAX_ constants; grows on
        // demand in `load` if a level exceeds it. Uint8Array
        // semantics silently drop out-of-bounds writes, so a too-
        // small buffer previously painted undefined tiles as the
        // drawTile "default" (dark grey) instead of the level's
        // tiles - visible as grey blocks over parts of the grove.
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

            // Grow the tile buffer if the level is bigger than the
            // current allocation. Kept as a live `this.data` swap so
            // any references to the world module see the new buffer.
            const needed = cols * rows;
            if (this.data.length < needed) {
                this.data = new Uint8Array(needed);
            }

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
            case TILE_VOID:  return "#181424";
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
            case TILE_VOID:
                // Deep obsidian floor with a slightly lighter fleck
                // and a thin darker seam so the tile reads as cracked
                // ancient stone, not as flat black.
                ctx.fillStyle = "#181424";
                ctx.fillRect(x, y, TILE, TILE);
                ctx.fillStyle = "#2a2238";
                ctx.fillRect(x + 5, y + 9, 3, 2);
                ctx.fillStyle = "#07050c";
                ctx.fillRect(x + 16, y + 4, 1, TILE - 10);
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

        // Composite zoom: final `scale` = pulseScale * userScale *
        // battleScale. Each layer eases toward its own target so
        // short pulses don't fight manual zoom or auto-battle zoom
        // - they just multiply cleanly.
        //
        //   pulseScale   - short camera punches from big attacks.
        //   userScale    - player's manual zoom level (wheel / pinch
        //                  / buttons). Lerps to userScaleTarget.
        //   battleScale  - auto zoom-out when the enemy crowd is
        //                  large, so big fights read clearly.
        scale: 1,
        pulseScale: 1,
        userScale: 1,
        userScaleTarget: 1,
        battleScale: 1,

        _zoomTarget: 1,
        _zoomSharpness: 8,
        _pulseHold: 0,

        // Manual zoom bounds and step sizes. userMin is set below
        // 1 so players can see more of the battlefield; userMax
        // sits just above 1 so "close" feels a little more punchy
        // without pushing the sprite past the pixelated limit.
        userMin: 0.65,
        userMax: 1.20,
        zoomStep: 0.12,

        zoomPulse(peak, hold) {
            this._zoomTarget = peak;
            this._pulseHold = hold;
        },

        // Manual zoom controls (wheel / pinch / buttons). Target
        // snaps, actual `userScale` lerps toward it in follow().
        zoomIn() {
            this.userScaleTarget = Math.min(
                this.userMax, this.userScaleTarget + this.zoomStep
            );
        },
        zoomOut() {
            this.userScaleTarget = Math.max(
                this.userMin, this.userScaleTarget - this.zoomStep
            );
        },
        // Absolute zoom for pinch: directly set the target within
        // bounds. Used by the pinch handler below.
        setZoomTarget(v) {
            this.userScaleTarget = Math.max(
                this.userMin, Math.min(this.userMax, v)
            );
        },

        resetZoom() {
            this.scale = 1;
            this.pulseScale = 1;
            this.userScale = 1;
            this.userScaleTarget = 1;
            this.battleScale = 1;
            this._zoomTarget = 1;
            this._pulseHold = 0;
        },

        follow(target, dt) {
            const tx = target.x + target.width / 2 - VIEW_W / 2;
            const ty = target.y + target.height / 2 - VIEW_H / 2;

            const t = 1 - Math.exp(-this.sharpness * dt);
            this.x += (tx - this.x) * t;
            this.y += (ty - this.y) * t;

            this.clamp();

            // --- Zoom easing ---
            // Pulse layer: decay hold, then flip target back to 1.
            if (this._pulseHold > 0) {
                this._pulseHold = Math.max(0, this._pulseHold - dt);
                if (this._pulseHold === 0) this._zoomTarget = 1;
            }
            const zt = 1 - Math.exp(-this._zoomSharpness * dt);
            this.pulseScale += (this._zoomTarget - this.pulseScale) * zt;

            // User layer: slow-ish ease so pinch / wheel feels
            // smooth, not jitter-snappy.
            const uzt = 1 - Math.exp(-5 * dt);
            this.userScale += (this.userScaleTarget - this.userScale) * uzt;

            // Battle layer: auto-zoom out on crowded fights. Only
            // pulls downward (toward wider view); never zooms in
            // over the player's manual target. Lerps slowly so a
            // sudden horde doesn't whiplash the camera.
            const n = enemies ? enemies.length : 0;
            const battleTarget = n > 18 ? 0.82
                               : n > 10 ? 0.90
                               : 1.0;
            const bzt = 1 - Math.exp(-2.5 * dt);
            this.battleScale += (battleTarget - this.battleScale) * bzt;

            // Composite. World transform reads `scale`.
            this.scale = this.pulseScale * this.userScale * this.battleScale;
        },

        snap(target) {
            this.x = target.x + target.width / 2 - VIEW_W / 2;
            this.y = target.y + target.height / 2 - VIEW_H / 2;
            this.clamp();
        },

        clamp() {
            // The world transform scales around the screen center,
            // so when scale < 1 the effective viewport in world-space
            // is wider than VIEW_W. Clamp the camera using those
            // scale-adjusted bounds, otherwise zoom-out shows the
            // raw canvas background outside the world rectangle.
            //
            // Derivation:
            //   screen_x = s * (wx - camera.x - VIEW_W/2) + VIEW_W/2
            // Solving for the world-x at the screen edges gives the
            // bounds below. At scale=1 they collapse back to the
            // original [0, WORLD_W - VIEW_W] clamp.
            const s = (this.scale && this.scale > 0) ? this.scale : 1;
            const halfW = VIEW_W / 2;
            const halfH = VIEW_H / 2;
            const minX = halfW * (1 / s - 1);
            const maxX = WORLD_W - halfW * (1 + 1 / s);
            const minY = halfH * (1 / s - 1);
            const maxY = WORLD_H - halfH * (1 + 1 / s);

            if (maxX <= minX) {
                // World narrower than the zoomed viewport - center
                // it so the world sits in the middle of the screen
                // and any OOB band fills symmetrically.
                this.x = (WORLD_W - VIEW_W) / 2;
            } else {
                this.x = Math.max(minX, Math.min(maxX, this.x));
            }
            if (maxY <= minY) {
                this.y = (WORLD_H - VIEW_H) / 2;
            } else {
                this.y = Math.max(minY, Math.min(maxY, this.y));
            }
        },
    };

    // ---------------------------------------------------------------
    // Screen shake
    //
    // Tiny module. `trigger(mag, dur)` starts (or extends) a shake
    // with the given magnitude in world pixels for `dur` seconds.
    // Offsets are sampled per-draw via offsetX() / offsetY() and
    // added to the world-space translate, so the world appears to
    // rattle while the HUD stays stable (HUD draws outside the
    // world transform).
    //
    // Shakes layer additively up to their peak magnitude - a quick
    // second trigger during an existing shake extends rather than
    // replaces it.
    // ---------------------------------------------------------------
    const shake = {
        timer: 0,
        duration: 0,
        peak: 0,

        trigger(magnitude, duration) {
            // Keep the max of any still-decaying shake so smaller
            // follow-up hits don't cut a big shake short.
            if (this.peak < magnitude) this.peak = magnitude;
            if (this.timer < duration) {
                this.timer = duration;
                this.duration = duration;
            }
        },

        update(dt) {
            if (this.timer > 0) {
                this.timer = Math.max(0, this.timer - dt);
                if (this.timer === 0) {
                    this.peak = 0;
                    this.duration = 0;
                }
            }
        },

        // Current magnitude: linear fade from peak to 0 over duration.
        magnitude() {
            if (this.timer <= 0) return 0;
            return this.peak * (this.timer / this.duration);
        },

        offsetX() {
            const m = this.magnitude();
            return m === 0 ? 0 : (Math.random() - 0.5) * 2 * m;
        },

        offsetY() {
            const m = this.magnitude();
            return m === 0 ? 0 : (Math.random() - 0.5) * 2 * m;
        },

        reset() {
            this.timer = 0;
            this.peak = 0;
            this.duration = 0;
        },
    };

    // ---------------------------------------------------------------
    // Screen flash
    //
    // Full-viewport colored overlay that fades in quickly (first 15%
    // of duration) and fades out over the remainder. Used for the
    // special attack's impact frame. Multiple triggers don't stack
    // brightness - peak is kept so a later smaller trigger doesn't
    // dim an active flash, but alpha stays clamped at 1.0.
    //
    // Cheap: one fillRect per frame while active, zero when idle.
    // ---------------------------------------------------------------
    const flash = {
        alpha: 0,
        timer: 0,
        duration: 0,
        peak: 0,
        color: "#ffffff",

        trigger(intensity, duration, color = "#ffffff") {
            if (intensity > this.peak) this.peak = intensity;
            if (duration > this.timer) {
                this.timer = duration;
                this.duration = duration;
            }
            this.color = color;
        },

        update(dt) {
            if (this.timer <= 0) { this.alpha = 0; return; }
            this.timer = Math.max(0, this.timer - dt);
            if (this.timer === 0) {
                this.alpha = 0;
                this.peak = 0;
                this.duration = 0;
                return;
            }
            const t = 1 - this.timer / this.duration;  // progress 0..1
            // Snap up in the first 15%, linear fade over the rest.
            this.alpha = t < 0.15
                ? this.peak * (t / 0.15)
                : this.peak * (1 - (t - 0.15) / 0.85);
            if (this.alpha > 1) this.alpha = 1;
        },

        draw(ctx) {
            if (this.alpha <= 0) return;
            ctx.save();
            ctx.globalAlpha = this.alpha;
            ctx.fillStyle = this.color;
            ctx.fillRect(0, 0, VIEW_W, VIEW_H);
            ctx.restore();
        },

        reset() {
            this.alpha = 0;
            this.timer = 0;
            this.duration = 0;
            this.peak = 0;
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

        // Switch state without a hard reset if the two clips share
        // frame 0 - keeps the walk <-> idle transition continuous
        // rather than snapping the foot pose back to neutral each
        // time motion starts or stops.
        setState(state) {
            if (state === this.state) return;
            const prev = this.clips[this.state];
            const next = this.clips[state];
            const continuous = prev.currentFrame() === next.frames[0];
            this.state = state;
            if (!continuous) next.reset();
        }

        setDir(dir) {
            this.dir = dir;
        }

        // Optional `speedScale` lets callers tie the clip's rate to
        // motion - a fast run advances the walk cycle faster than a
        // slow creep. Default 1 keeps old behavior.
        update(dt, speedScale = 1) {
            this.clips[this.state].update(dt * speedScale);
        }

        get col() {
            return this.clips[this.state].currentFrame();
        }

        get row() {
            return this.dir;
        }
    }

    // Vertical pixel bob for a given sprite column. Cols 1 / 2 are
    // the walk mid-steps and col 3 is the idle breath-in pose - all
    // three raise the body by 1px so the shoulders float briefly.
    // drawPlayerFrame and the cloak anchor share this table so the
    // cloak stays glued to the shoulders through the bob.
    function playerFrameBob(col) {
        return col === 0 ? 0 : -1;
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
        // ---------------------------------------------------------------
        // Moorish warrior palette.
        //   Skin is a warm dark brown with a shade pass for cheek / neck.
        //   Hood is a near-black purple so it reads as "cloth", not as
        //     a silhouette hole against the dark grove backdrop.
        //   Robe is warm ochre (sand-lit traveller) broken at the waist
        //     by a crimson sash that echoes the animated cloak.
        //   Eyes are warm cream for readability on the dark face at 32px.
        // ---------------------------------------------------------------
        const SKIN       = "#6e4530";
        const SKIN_SHADE = "#4a2d1e";
        const HOOD       = "#201a2e";
        const HOOD_EDGE  = "#12101c";
        const ROBE       = "#b88c46";
        const ROBE_SHADE = "#7a5c2c";
        const SASH       = "#7a1120";
        const SASH_HI    = "#a1302e";
        const BOOT       = "#2a1c12";
        const EYES       = "#f2e0b4";
        const GOLD       = "#ffd166";

        // Ground shadow
        ctx.fillStyle = "rgba(0, 0, 0, 0.32)";
        ctx.beginPath();
        ctx.ellipse(ox + 16, oy + 29, 8, 3, 0, 0, Math.PI * 2);
        ctx.fill();

        // Vertical body bob - 1px up on every frame except the plant
        // (col 0). This is the same table the cloak anchor reads so
        // shoulders and cloak lift together.
        const bob = playerFrameBob(frame);

        // --- Legs / boots ---
        // Cols 1 / 2 are walk mid-steps with alternating feet. Cols
        // 0 / 3 share the neutral stance (standing tall vs. breathing).
        ctx.fillStyle = BOOT;
        const legY = oy + 24;
        if (frame === 1) {
            ctx.fillRect(ox + 11, legY,     3, 4);
            ctx.fillRect(ox + 18, legY - 1, 3, 5);
        } else if (frame === 2) {
            ctx.fillRect(ox + 11, legY - 1, 3, 5);
            ctx.fillRect(ox + 18, legY,     3, 4);
        } else {
            ctx.fillRect(ox + 11, legY, 3, 4);
            ctx.fillRect(ox + 18, legY, 3, 4);
        }

        // --- Robe body ---
        ctx.fillStyle = ROBE;
        ctx.fillRect(ox + 9, oy + 14 + bob, 14, 11);
        // Hem shadow
        ctx.fillStyle = ROBE_SHADE;
        ctx.fillRect(ox + 9, oy + 23 + bob, 14, 2);
        // Vertical seam down the front when facing toward the camera
        if (dir === DIR_DOWN) {
            ctx.fillRect(ox + 15, oy + 14 + bob, 1, 6);
        }

        // --- Crimson sash at waist ---
        ctx.fillStyle = SASH;
        ctx.fillRect(ox + 9, oy + 20 + bob, 14, 3);
        ctx.fillStyle = SASH_HI;
        ctx.fillRect(ox + 9, oy + 20 + bob, 14, 1);

        // Gold clasp - small sparkle on the waist, front only.
        if (dir === DIR_DOWN) {
            ctx.fillStyle = GOLD;
            ctx.fillRect(ox + 15, oy + 21 + bob, 2, 1);
        }

        // --- Head ---
        // Face / skull
        ctx.fillStyle = SKIN;
        ctx.fillRect(ox + 11, oy + 7 + bob, 10, 8);
        // Neck shade at the jawline
        ctx.fillStyle = SKIN_SHADE;
        ctx.fillRect(ox + 12, oy + 13 + bob, 8, 1);

        // --- Hood (direction-aware) ---
        // The hood is a hooded travel garment: a cap across the crown
        // plus side "flaps" that frame the face when seen from the
        // front or side, and fully cover the head when seen from behind.
        ctx.fillStyle = HOOD;
        if (dir === DIR_DOWN) {
            // Cap across the forehead
            ctx.fillRect(ox + 10, oy + 6 + bob, 12, 3);
            // Side flaps
            ctx.fillRect(ox + 10, oy + 9 + bob, 2, 5);
            ctx.fillRect(ox + 20, oy + 9 + bob, 2, 5);
        } else if (dir === DIR_UP) {
            // Back of hood fully covers the head
            ctx.fillRect(ox + 10, oy + 6 + bob, 12, 9);
        } else if (dir === DIR_LEFT) {
            // Hood wraps around the back (right side of sprite) and
            // across the crown; face opening on the left.
            ctx.fillRect(ox + 11, oy + 6 + bob, 11, 4);
            ctx.fillRect(ox + 19, oy + 9 + bob, 3, 5);
        } else { // DIR_RIGHT
            ctx.fillRect(ox + 10, oy + 6 + bob, 11, 4);
            ctx.fillRect(ox + 10, oy + 9 + bob, 3, 5);
        }

        // Hood inner rim - 1px darker line so the cloth reads as
        // layered rather than a flat block.
        ctx.fillStyle = HOOD_EDGE;
        if (dir === DIR_DOWN) {
            ctx.fillRect(ox + 10, oy + 8 + bob, 12, 1);
        } else if (dir === DIR_LEFT) {
            ctx.fillRect(ox + 12, oy + 9 + bob, 10, 1);
        } else if (dir === DIR_RIGHT) {
            ctx.fillRect(ox + 10, oy + 9 + bob, 10, 1);
        }

        // --- Eyes (hidden when facing away) ---
        if (dir !== DIR_UP) {
            ctx.fillStyle = EYES;
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
            // Two-frame breath: neutral stand -> shoulders lift 1px.
            // Slow tempo (~1.7s/cycle) reads as breathing, not fidgeting.
            idle: new Animation([0, 3], 0.85, true),
            // Classic step-return-step-return cycle. Frames 1 and 2
            // are mid-step poses with a body bob; frame 0 is the plant.
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
            super: 0.2,
            levelUp: 1.5,
            // Coin pickups: a swept burst should register as one
            // sound, not a flurry - keep the cooldown above the
            // likely frame gap between successive pickups.
            coin: 0.06,
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
                case "super":      this._super(now); break;
                case "levelUp":    this._levelUp(now); break;
                case "coin":       this._coin(now); break;
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

        // Coin chirp - tiny two-note pop so pickups feel snappy.
        _coin(t) {
            const notes = [880, 1320];
            for (let i = 0; i < notes.length; i++) {
                const start = t + i * 0.04;
                const osc = this.ctx.createOscillator();
                const g = this.ctx.createGain();
                osc.type = "square";
                osc.frequency.setValueAtTime(notes[i], start);
                g.gain.setValueAtTime(0.0001, start);
                g.gain.exponentialRampToValueAtTime(0.18, start + 0.01);
                g.gain.exponentialRampToValueAtTime(0.0001, start + 0.09);
                osc.connect(g).connect(this.master);
                osc.start(start);
                osc.stop(start + 0.10);
            }
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

        // Super: layered descending chord over ~0.8s. Three
        // oscillators for body, richness, and a high ping, all
        // sweeping downward together.
        _super(t) {
            const partials = [
                { type: "sawtooth", startHz: 220, endHz: 60,  gain: 0.35 },
                { type: "square",   startHz: 440, endHz: 160, gain: 0.22 },
                { type: "triangle", startHz: 880, endHz: 320, gain: 0.18 },
            ];
            for (const p of partials) {
                const osc = this.ctx.createOscillator();
                const g = this.ctx.createGain();
                osc.type = p.type;
                osc.frequency.setValueAtTime(p.startHz, t);
                osc.frequency.exponentialRampToValueAtTime(p.endHz, t + 0.8);
                g.gain.setValueAtTime(0.0001, t);
                g.gain.exponentialRampToValueAtTime(p.gain, t + 0.02);
                g.gain.exponentialRampToValueAtTime(0.0001, t + 0.85);
                osc.connect(g).connect(this.master);
                osc.start(t);
                osc.stop(t + 0.9);
            }
        },
    };

    // ---------------------------------------------------------------
    // Background music
    //
    // Procedurally synthesized loops (no asset pipeline) - each track
    // is a `schedule(ctx, out, startT, beatDur)` that queues one full
    // loop of notes starting at `startT`. A look-ahead timer keeps
    // the next loop scheduled well before the current one finishes,
    // so the loop boundary is seamless - no audible gap or click.
    //
    // Three tracks:
    //   city    - warm triangle arpeggio over a slow sine pad.
    //             Plays in safe zones (grove + interiors).
    //   dungeon - dark sawtooth drone with sparse eerie highs.
    //             Plays in hostile zones when no enemies are near.
    //   combat  - driving square bass + tense sawtooth lead at a
    //             higher bpm. Plays when any enemy sits within
    //             detect radius of the player.
    //
    // Crossfades are gain ramps: the outgoing track's gain ramps
    // toward 0 while the incoming track's gain ramps to its target
    // volume over `fadeSeconds`. Only one track is audible outside
    // the brief fade overlap, which satisfies the spec.
    //
    // Shares `sound.ctx` + `sound.master` so the existing unlock-
    // on-first-input path handles mobile autoplay with no extra
    // wiring.
    // ---------------------------------------------------------------
    const music = (function () {
        // One-shot note helper. Each scheduled note is a short-lived
        // oscillator + gain pair that self-stops after `dur`, so the
        // audio graph never accumulates - mobile-friendly.
        function scheduleNote(ctx, out, type, t, freq, dur, vol) {
            const osc = ctx.createOscillator();
            const g = ctx.createGain();
            osc.type = type;
            osc.frequency.setValueAtTime(freq, t);
            g.gain.setValueAtTime(0.0001, t);
            g.gain.exponentialRampToValueAtTime(vol, t + 0.025);
            g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(0.05, dur));
            osc.connect(g).connect(out);
            osc.start(t);
            osc.stop(t + dur + 0.05);
        }

        const TRACKS = {
            city: {
                beatDuration: 0.55,
                loopBeats: 16,
                volume: 0.11,
                schedule(ctx, out, t0, bd) {
                    const mel = [
                        [0,  330, 0.45], [2,  392, 0.45], [4,  440, 0.45],
                        [6,  523, 0.55], [8,  440, 0.45], [10, 392, 0.45],
                        [12, 330, 0.45], [14, 293, 0.7],
                    ];
                    for (const [b, f, d] of mel) {
                        scheduleNote(ctx, out, "triangle", t0 + b * bd, f, d, 0.14);
                    }
                    const bass = [
                        [0,  110, 1.8], [4,  146, 1.8],
                        [8,  110, 1.8], [12,  98, 1.8],
                    ];
                    for (const [b, f, d] of bass) {
                        scheduleNote(ctx, out, "sine", t0 + b * bd, f, d, 0.08);
                    }
                },
            },
            dungeon: {
                beatDuration: 0.70,
                loopBeats: 16,
                volume: 0.10,
                schedule(ctx, out, t0, bd) {
                    // Two low drones split across the loop.
                    scheduleNote(ctx, out, "sawtooth", t0 +  0 * bd, 65, 5.0, 0.07);
                    scheduleNote(ctx, out, "sawtooth", t0 +  8 * bd, 73, 5.0, 0.07);
                    const eerie = [
                        [3,  392, 0.45], [7,  349, 0.45],
                        [11, 440, 0.45], [15, 330, 0.6],
                    ];
                    for (const [b, f, d] of eerie) {
                        scheduleNote(ctx, out, "triangle", t0 + b * bd, f, d, 0.06);
                    }
                },
            },
            combat: {
                beatDuration: 0.32,
                loopBeats: 16,
                volume: 0.13,
                schedule(ctx, out, t0, bd) {
                    const bass = [
                        [0, 110, 0.22], [2, 110, 0.22], [4,  98, 0.22], [6,  98, 0.22],
                        [8, 110, 0.22], [10, 110, 0.22], [12, 87, 0.22], [14, 87, 0.22],
                    ];
                    for (const [b, f, d] of bass) {
                        scheduleNote(ctx, out, "square", t0 + b * bd, f, d, 0.12);
                    }
                    const lead = [
                        [1,  330, 0.18], [5,  392, 0.18],
                        [9,  349, 0.18], [13, 440, 0.28],
                    ];
                    for (const [b, f, d] of lead) {
                        scheduleNote(ctx, out, "sawtooth", t0 + b * bd, f, d, 0.08);
                    }
                },
            },
        };

        // Currently-audible track ("active") and any still-fading
        // outgoing track ("prev"). Both keep their look-ahead timer
        // running until fade-out completes so the boundary stays
        // seamless even mid-fade.
        let active = null;
        let prev = null;

        function startTrack(name) {
            const cfg = TRACKS[name];
            const ctx = sound.ctx;
            if (!cfg || !ctx) return null;
            const gain = ctx.createGain();
            gain.gain.value = 0.0001;
            gain.connect(sound.master);

            const loopDur = cfg.beatDuration * cfg.loopBeats;
            let nextLoopAt = ctx.currentTime + 0.05;
            cfg.schedule(ctx, gain, nextLoopAt, cfg.beatDuration);
            nextLoopAt += loopDur;

            // Look-ahead: every 200ms, if the next loop starts in the
            // ~0.6s horizon, queue it. Keeps the loop boundary
            // seamless without over-scheduling (which would make
            // stop / fade less responsive).
            const timerId = setInterval(() => {
                if (!sound.ctx) return;
                if (nextLoopAt < sound.ctx.currentTime + 0.6) {
                    cfg.schedule(sound.ctx, gain, nextLoopAt, cfg.beatDuration);
                    nextLoopAt += loopDur;
                }
            }, 200);

            return { name, cfg, gain, loopDur, nextLoopAt, timerId };
        }

        function fadeOut(player, fadeSeconds) {
            if (!player || !sound.ctx) return;
            const t = sound.ctx.currentTime;
            try {
                player.gain.gain.cancelScheduledValues(t);
                const current = Math.max(0.0001, player.gain.gain.value);
                player.gain.gain.setValueAtTime(current, t);
                player.gain.gain.exponentialRampToValueAtTime(0.0001, t + fadeSeconds);
            } catch (_e) { /* node disconnected */ }
            // Release the scheduler + audio node just after fade
            // finishes so no trailing notes pop post-silence.
            setTimeout(() => {
                clearInterval(player.timerId);
                try { player.gain.disconnect(); } catch (_e) {}
            }, (fadeSeconds + 0.2) * 1000);
        }

        return {
            playMusic(name, fadeSeconds = 1.5) {
                if (!sound.enabled) return;
                sound._init();
                if (!sound.ctx) return;
                if (!TRACKS[name]) return;
                if (active && active.name === name) return;

                if (prev) fadeOut(prev, 0.2);
                if (active) {
                    fadeOut(active, fadeSeconds);
                    prev = active;
                }
                const p = startTrack(name);
                if (!p) return;
                active = p;
                const t = sound.ctx.currentTime;
                p.gain.gain.setValueAtTime(0.0001, t);
                p.gain.gain.exponentialRampToValueAtTime(p.cfg.volume, t + fadeSeconds);
            },

            stopMusic(fadeSeconds = 0.5) {
                if (prev) fadeOut(prev, fadeSeconds);
                if (active) fadeOut(active, fadeSeconds);
                prev = null;
                active = null;
            },

            fadeTransition(oldName, newName, fadeSeconds = 1.5) {
                // oldName is informational - the module tracks the
                // current track internally. The signature matches
                // the requested API.
                this.playMusic(newName, fadeSeconds);
            },

            currentTrack() { return active ? active.name : null; },
        };
    })();

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
    // Super Power button (touch / pointer)
    //
    // Sits beside the power button. Shares the same
    // press-visual-feedback + cooldown-ring idiom, tinted purple so
    // it reads as distinct from POWER / ATK. Fires `superPower`.
    // ---------------------------------------------------------------
    const superPowerButton = {
        x: 0, y: 0,
        radius: 38,

        layout() {
            this.x = VIEW_W - 178;
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
            const ready = superPower.ready;
            const frac = superPower.cooldownFrac();

            ctx.save();

            // Base circle - muted while charging, vivid purple ready.
            ctx.globalAlpha = this.pressed ? 0.95 : 0.6;
            ctx.fillStyle = ready ? "#b06bff" : "#3e2a60";
            ctx.beginPath();
            ctx.arc(this.x, cy, this.radius, 0, Math.PI * 2);
            ctx.fill();

            // Pie-slice cooldown fill (same as POWER button).
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
            ctx.globalAlpha = 0.95;
            ctx.strokeStyle = ready ? "#f0d8ff" : "#888";
            ctx.lineWidth = this.pressed ? 4 : 3;
            ctx.beginPath();
            ctx.arc(this.x, cy, this.radius, 0, Math.PI * 2);
            ctx.stroke();

            // Label - lightning bolt + "SUPER".
            ctx.globalAlpha = 1;
            ctx.fillStyle = "#1a1a24";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.font = "bold 16px system-ui, sans-serif";
            ctx.fillText("⚡", this.x, cy - 7);
            ctx.font = "bold 10px system-ui, sans-serif";
            ctx.fillText("SUPER", this.x, cy + 8);

            ctx.restore();
        },
    };

    // ---------------------------------------------------------------
    // Special Attack button (touch / pointer)
    //
    // Third button in the row: sits left of SUPER. Crimson so it
    // reads as magic-tied rather than power/super, and dims when
    // magic is below the cast cost so the player can see at a glance
    // whether they can fire.
    // ---------------------------------------------------------------
    const specialButton = {
        x: 0, y: 0,
        radius: 38,

        layout() {
            this.x = VIEW_W - 276;
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
            const ready = specialAttack.ready;
            // Magic fraction toward cost - fills a ring around the
            // button as the player builds up to a cast.
            const frac = Math.min(1, player.magic / specialAttack.magicCost);

            ctx.save();

            ctx.globalAlpha = this.pressed ? 0.95 : 0.6;
            ctx.fillStyle = ready ? "#e63946" : "#5a1a22";
            ctx.beginPath();
            ctx.arc(this.x, cy, this.radius, 0, Math.PI * 2);
            ctx.fill();

            // Magic-fill pie slice mirroring POWER/SUPER cooldown UI.
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

            ctx.globalAlpha = 0.95;
            ctx.strokeStyle = ready ? "#ffd6dc" : "#888";
            ctx.lineWidth = this.pressed ? 4 : 3;
            ctx.beginPath();
            ctx.arc(this.x, cy, this.radius, 0, Math.PI * 2);
            ctx.stroke();

            ctx.globalAlpha = 1;
            ctx.fillStyle = "#1a1a24";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.font = "bold 17px system-ui, sans-serif";
            ctx.fillText("✦", this.x, cy - 7);
            ctx.font = "bold 10px system-ui, sans-serif";
            ctx.fillText("SPECIAL", this.x, cy + 8);

            ctx.restore();
        },
    };

    // ---------------------------------------------------------------
    // Battlefield Nova button (touch / pointer)
    //
    // Stacked above the three-button POWER row so it sits a row by
    // itself - keeps the default cluster uncrowded while giving the
    // ultimate a clear home. Mirrors the SUPER button visuals: a
    // cooldown pie-slice + magic-cost gate combined.
    // ---------------------------------------------------------------
    const novaButton = {
        x: 0, y: 0,
        radius: 38,

        layout() {
            // Right-aligned, stacked above the POWER button's row.
            this.x = VIEW_W - 80;
            this.y = VIEW_H - 260;
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
            const ready = battlefieldNova.ready;
            // Dual fill: magic progress + cooldown progress. Show
            // the more-restrictive one so the player sees which gate
            // is still closed. Cooldown typically dominates.
            const magicFrac = Math.min(1, player.magic / battlefieldNova.magicCost);
            const cdFrac = battlefieldNova.cooldownFrac();
            const frac = Math.min(magicFrac, cdFrac);

            ctx.save();
            ctx.globalAlpha = this.pressed ? 0.95 : 0.62;
            ctx.fillStyle = ready ? "#ff7f3a" : "#5a2f1a";
            ctx.beginPath();
            ctx.arc(this.x, cy, this.radius, 0, Math.PI * 2);
            ctx.fill();

            if (!ready) {
                ctx.globalAlpha = 0.85;
                ctx.fillStyle = "rgba(0, 0, 0, 0.58)";
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

            ctx.globalAlpha = 0.95;
            ctx.strokeStyle = ready ? "#ffe1c6" : "#888";
            ctx.lineWidth = this.pressed ? 4 : 3;
            ctx.beginPath();
            ctx.arc(this.x, cy, this.radius, 0, Math.PI * 2);
            ctx.stroke();

            ctx.globalAlpha = 1;
            ctx.fillStyle = "#1a1a24";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.font = "bold 17px system-ui, sans-serif";
            ctx.fillText("◎", this.x, cy - 7);
            ctx.font = "bold 10px system-ui, sans-serif";
            ctx.fillText("NOVA", this.x, cy + 8);

            ctx.restore();
        },
    };

    // ---------------------------------------------------------------
    // Pause button (touch / pointer)
    //
    // Tiny top-right square. Toggles the paused flag when tapped.
    // While paused, the on-screen menu takes over, so tapping the
    // same icon during pause is a no-op (menu handles resume).
    // ---------------------------------------------------------------
    const pauseButton = {
        x: 0, y: 0,
        w: 36, h: 36,

        layout() {
            this.x = VIEW_W - this.w - 12;
            this.y = 12;
        },

        pressed: false,
        pointerId: null,
        justPressed: false,

        contains(x, y) {
            return x >= this.x && x <= this.x + this.w &&
                   y >= this.y && y <= this.y + this.h;
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
            const y = this.y + (this.pressed ? 1 : 0);
            ctx.globalAlpha = 0.75;
            ctx.fillStyle = "rgba(20, 20, 30, 0.85)";
            roundRectPath(ctx, this.x, y, this.w, this.h, 6);
            ctx.fill();
            ctx.strokeStyle = "rgba(255, 209, 102, 0.45)";
            ctx.lineWidth = 1;
            ctx.stroke();
            // Two vertical bars = classic pause icon.
            ctx.globalAlpha = 1;
            ctx.fillStyle = "#e8e8f0";
            const cx = this.x + this.w / 2;
            const cy = y + this.h / 2;
            ctx.fillRect(cx - 6, cy - 8, 4, 16);
            ctx.fillRect(cx + 2, cy - 8, 4, 16);
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
            return gameState === "playing" &&
                (nearestNpc() !== null || nearestLore() !== null);
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
        superPowerButton.layout();
        specialButton.layout();
        novaButton.layout();
        interactButton.layout();
        pauseButton.layout();
    });
    // Button layouts need to be valid before the first frame, but
    // resizeDisplay() runs before any of these objects exist. Kick
    // layouts once now that every button is defined.
    attackButton.layout();
    weaponSwapButton.layout();
    superPowerButton.layout();
    powerButton.layout();
    specialButton.layout();
    novaButton.layout();
    interactButton.layout();
    pauseButton.layout();

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

    // Wheel zoom (desktop). deltaY > 0 = scroll down = zoom out.
    // Preventdefault so the page doesn't scroll when the canvas is
    // in the middle of a long page.
    canvas.addEventListener("wheel", (e) => {
        if (gameState !== "playing" || paused) return;
        if (e.deltaY < 0) camera.zoomIn();
        else if (e.deltaY > 0) camera.zoomOut();
        e.preventDefault();
    }, { passive: false });

    // Pinch tracker - tracks two active pointers and computes the
    // distance ratio between down + current. When pinch is active
    // the joystick is suppressed so the two-finger gesture doesn't
    // also drive movement.
    const pinch = {
        active: false,
        idA: null, idB: null,
        ax: 0, ay: 0, bx: 0, by: 0,
        startDist: 0,
        startScaleTarget: 1,
    };
    function pinchDist() {
        const dx = pinch.ax - pinch.bx;
        const dy = pinch.ay - pinch.by;
        return Math.hypot(dx, dy);
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

        // Cinematic: highest-priority modal. A tap advances the
        // sequence; no other buttons react while text rolls.
        // Scripted dialogue is above cinematic in the modal stack.
        if (scriptedDialogue.isOpen()) {
            scriptedDialogue.advance();
            e.preventDefault();
            return;
        }
        if (cinematic.isOpen()) {
            cinematic.advance();
            e.preventDefault();
            return;
        }

        // Pause: routes all taps to the pause-menu row rects. The
        // pause button itself is tappable too (to resume), but it's
        // easier to consume it here than reason about re-entry.
        if (paused) {
            if (pauseMenu.handlePointer(x, y)) {
                e.preventDefault();
                return;
            }
            if (pauseButton.contains(x, y)) {
                paused = false;
                e.preventDefault();
                return;
            }
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

        // Pause button sits in the top-right corner, well clear of
        // the joystick region. Tapping toggles into the pause menu.
        // Tutorial SKIP chip sits above the mobile button cluster,
        // so it gets first crack at taps in that region.
        if (tutorial.handlePointer(x, y)) {
            e.preventDefault();
            return;
        }

        if (pauseButton.onDown(x, y, e.pointerId)) {
            canvas.setPointerCapture(e.pointerId);
            paused = true;
            pauseButton.consumeJustPressed();  // consume so update() doesn't retoggle
            e.preventDefault();
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
        if (superPowerButton.onDown(x, y, e.pointerId)) {
            canvas.setPointerCapture(e.pointerId);
            e.preventDefault();
            return;
        }
        if (novaButton.onDown(x, y, e.pointerId)) {
            canvas.setPointerCapture(e.pointerId);
            e.preventDefault();
            return;
        }
        if (specialButton.onDown(x, y, e.pointerId)) {
            canvas.setPointerCapture(e.pointerId);
            e.preventDefault();
            return;
        }
        if (interactButton.onDown(x, y, e.pointerId)) {
            canvas.setPointerCapture(e.pointerId);
            e.preventDefault();
            return;
        }

        // If the joystick is already active and a SECOND finger
        // lands on an empty area, convert the gesture into a pinch
        // zoom. Suppress the joystick for the duration so the
        // two-finger motion doesn't also drive movement.
        if (!pinch.active && joystick.active &&
            e.pointerId !== joystick.pointerId) {
            pinch.active = true;
            pinch.idA = joystick.pointerId;
            pinch.idB = e.pointerId;
            pinch.ax = joystick.stickX ?? joystick.baseX ?? x;
            pinch.ay = joystick.stickY ?? joystick.baseY ?? y;
            pinch.bx = x;
            pinch.by = y;
            pinch.startDist = pinchDist();
            pinch.startScaleTarget = camera.userScaleTarget;
            // Stop the joystick from steering during the pinch.
            joystick.active = false;
            joystick.dx = 0;
            joystick.dy = 0;
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
        if (pinch.active &&
            (e.pointerId === pinch.idA || e.pointerId === pinch.idB)) {
            const { x, y } = pointerToCanvas(e);
            if (e.pointerId === pinch.idA) { pinch.ax = x; pinch.ay = y; }
            else                           { pinch.bx = x; pinch.by = y; }
            const d = pinchDist();
            if (d > 0 && pinch.startDist > 0) {
                const ratio = d / pinch.startDist;
                camera.setZoomTarget(pinch.startScaleTarget * ratio);
            }
            e.preventDefault();
            return;
        }
        if (joystick.pointerId === e.pointerId) {
            const { x, y } = pointerToCanvas(e);
            joystick.onMove(x, y, e.pointerId);
            e.preventDefault();
        }
    });

    function endPointer(e) {
        if (pinch.active &&
            (e.pointerId === pinch.idA || e.pointerId === pinch.idB)) {
            pinch.active = false;
            pinch.idA = pinch.idB = null;
            return;
        }
        joystick.onUp(e.pointerId);
        attackButton.onUp(e.pointerId);
        weaponSwapButton.onUp(e.pointerId);
        powerButton.onUp(e.pointerId);
        superPowerButton.onUp(e.pointerId);
        specialButton.onUp(e.pointerId);
        novaButton.onUp(e.pointerId);
        interactButton.onUp(e.pointerId);
        restartButton.onUp(e.pointerId);
        pauseButton.onUp(e.pointerId);
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

        // Gold coins - the purse. Coins are picked up automatically
        // on contact (routed here instead of `inventory`) and spent
        // at the merchant's shop.
        coins: 0,

        // Magic meter. Tops up from red orbs dropped by enemies,
        // capped at maxMagic. Future: power moves could spend magic
        // instead of (or alongside) their current cooldown timers.
        magic: 0,
        maxMagic: 100,

        // Recruited warrior companions - each entry is a small
        // snapshot `{ id, name, role }` of the source NPC rather
        // than a live reference, so NPCs can still run their own
        // wander / patrol routines untouched. Squad cap lives in
        // the `companions` module and grows per story chapter.
        squad: [],

        // Creatures of the Light - a tiny, separate roster that
        // exists alongside the squad / army. Each entry is a value
        // snapshot { speciesId }; live creatures live in the
        // lightCreatures array so they can be culled / drawn with
        // their own pipeline. Hard-capped at maxLightCreatures so
        // the Light Herd never competes with the main formation.
        lightCreatures: [],
        maxLightCreatures: 3,

        // Charge-attack state. isCharging flips true on attack-press,
        // accumulates chargeTime (clamped at maxCharge) while held,
        // and fires the weapon on release with a damage multiplier
        // proportional to how far past the charge threshold we got.
        isCharging: false,
        chargeTime: 0,
        chargeStartTime: 0,
        maxCharge: 2,  // seconds

        // Parallel charge state for the special attack. Same
        // press / release contract as the primary attack but owns
        // its own timer so each button can be held independently.
        specialCharging: false,
        specialChargeTime: 0,

        // Currently-equipped weapon index into `weapons[]`.
        // 0 = sword (melee), 1 = energy blast (projectile).
        weaponIndex: 0,
    };

    // ---------------------------------------------------------------
    // Cloak
    //
    // 4-point follow-chain rendered behind the player sprite. Point 0
    // is pinned to the shoulders; each subsequent point lags behind
    // its predecessor along the current drag direction with a frame-
    // rate-independent smoothing step. Drag is opposite to velocity
    // when moving and straight down when idle, so the cloak settles
    // naturally at rest.
    //
    // A perpendicular sine sway scaled by move speed gives it a
    // flowing motion without needing physics. All buffers are
    // preallocated - zero per-frame allocations for mobile GC.
    // ---------------------------------------------------------------
    const cloak = {
        points: [
            { x: 0, y: 0 },
            { x: 0, y: 0 },
            { x: 0, y: 0 },
            { x: 0, y: 0 },
        ],
        widths: [11, 9, 6, 2],  // taper from shoulder to tail tip
        segLen: 8,              // rest length between adjacent points
        stiffness: 14,          // chain catch-up rate (higher = stiffer)
        color: "#7a1120",       // deep red
        wavePhase: 0,

        // Anchor offset from the player sprite's top-left origin.
        // Shoulders sit ~12px below the sprite top on a 32px sprite.
        anchorOffsetX: 16,
        anchorOffsetY: 12,

        // Preallocated rim buffers for draw().
        _left: [
            { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 },
        ],
        _right: [
            { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 },
        ],

        // Snap every point onto the anchor. Called on respawn and
        // zone transitions so the cloak doesn't stretch across the
        // world when the player teleports.
        snap() {
            const ax = player.x + this.anchorOffsetX;
            const ay = player.y + this.anchorOffsetY;
            for (const p of this.points) {
                p.x = ax;
                p.y = ay;
            }
            this.wavePhase = 0;
        },

        update(dt) {
            const vx = player.vx;
            const vy = player.vy;
            const speed = Math.hypot(vx, vy);
            const moving = speed > 5;

            // Shoulder anchor tracks the sprite's per-frame vertical
            // bob so the cloak stays glued to the body through the
            // walk / breath cycles instead of detaching by 1px.
            const bob = playerFrameBob(player.animator.col);
            this.points[0].x = player.x + this.anchorOffsetX;
            this.points[0].y = player.y + this.anchorOffsetY + bob;

            // Drag direction: opposite velocity when moving, else down.
            let dragX, dragY;
            if (moving) {
                dragX = -vx / speed;
                dragY = -vy / speed;
            } else {
                dragX = 0;
                dragY = 1;
            }

            // Perpendicular unit vector for the sway wave.
            const perpX = -dragY;
            const perpY =  dragX;

            // Wave advances faster at higher speed; amplitude scales
            // with speed so idle still has a subtle shimmer.
            this.wavePhase += dt * (2 + speed * 0.03);
            const speedFactor = Math.min(1, speed / 140);
            const baseAmp = moving ? 0.35 : 0.08;

            const k = 1 - Math.exp(-this.stiffness * dt);

            for (let i = 1; i < this.points.length; i++) {
                const prev = this.points[i - 1];
                const p = this.points[i];
                const wave = Math.sin(this.wavePhase + i * 0.9) *
                    baseAmp * speedFactor * i;
                const tx = prev.x + (dragX + perpX * wave) * this.segLen;
                const ty = prev.y + (dragY + perpY * wave) * this.segLen;
                p.x += (tx - p.x) * k;
                p.y += (ty - p.y) * k;
            }
        },

        draw() {
            const pts = this.points;
            const ws  = this.widths;
            const n   = pts.length;

            // Build tapered outline: for each node compute a unit
            // normal from its segment direction, then push left/right
            // rim points by the width at that node.
            for (let i = 0; i < n; i++) {
                let dx, dy;
                if (i === 0) {
                    dx = pts[1].x - pts[0].x;
                    dy = pts[1].y - pts[0].y;
                } else if (i === n - 1) {
                    dx = pts[i].x - pts[i - 1].x;
                    dy = pts[i].y - pts[i - 1].y;
                } else {
                    dx = pts[i + 1].x - pts[i - 1].x;
                    dy = pts[i + 1].y - pts[i - 1].y;
                }
                const len = Math.hypot(dx, dy) || 1;
                const nx = -dy / len;
                const ny =  dx / len;
                const w  = ws[i];
                this._left[i].x  = pts[i].x + nx * w;
                this._left[i].y  = pts[i].y + ny * w;
                this._right[i].x = pts[i].x - nx * w;
                this._right[i].y = pts[i].y - ny * w;
            }

            ctx.beginPath();
            ctx.moveTo(this._left[0].x, this._left[0].y);
            for (let i = 1; i < n; i++) {
                ctx.lineTo(this._left[i].x, this._left[i].y);
            }
            for (let i = n - 1; i >= 0; i--) {
                ctx.lineTo(this._right[i].x, this._right[i].y);
            }
            ctx.closePath();
            ctx.fillStyle = this.color;
            ctx.fill();

            // Subtle dark rim for depth.
            ctx.lineWidth = 1;
            ctx.strokeStyle = "rgba(0, 0, 0, 0.35)";
            ctx.stroke();
        },
    };

    // ---------------------------------------------------------------
    // Aura
    //
    // Soft mystical glow + a few rising motes around the player.
    // The glow is a single pre-baked radial gradient on an offscreen
    // canvas; at runtime we draw it with a pulsing scale + globalAlpha
    // so there are no per-frame gradient allocations (a common mobile
    // GC hazard). Motes are a tiny preallocated pool that respawn in
    // place when they time out.
    //
    // Color is gold (divine) to match the player's existing palette.
    // ---------------------------------------------------------------
    const aura = (function () {
        const COLOR = "255, 209, 102";  // gold, matches player.color
        const MOTE_COLOR = "255, 226, 140";
        // Corruption tint - deep violet that reads as "something
        // wrong is in the halo" rather than competing with the gold.
        const CORRUPT_COLOR = "140, 60, 200";

        // Pre-bake the glow into a small offscreen canvas so the
        // gradient stops are created exactly once. We bake a second
        // purple canvas for the corruption overlay, composited at
        // runtime with an alpha tied to corruption.value.
        const GLOW_SIZE = 128;
        function bakeGlow(rgb) {
            const c = document.createElement("canvas");
            c.width = GLOW_SIZE;
            c.height = GLOW_SIZE;
            const gctx = c.getContext("2d");
            const center = GLOW_SIZE / 2;
            const grad = gctx.createRadialGradient(
                center, center, 0,
                center, center, GLOW_SIZE / 2
            );
            grad.addColorStop(0,    `rgba(${rgb}, 0.45)`);
            grad.addColorStop(0.5,  `rgba(${rgb}, 0.12)`);
            grad.addColorStop(1,    `rgba(${rgb}, 0)`);
            gctx.fillStyle = grad;
            gctx.fillRect(0, 0, GLOW_SIZE, GLOW_SIZE);
            return c;
        }
        const glowCanvas    = bakeGlow(COLOR);
        const corruptCanvas = bakeGlow(CORRUPT_COLOR);

        // Preallocated mote pool.
        const MOTE_COUNT = 6;
        const motes = new Array(MOTE_COUNT);
        for (let i = 0; i < MOTE_COUNT; i++) {
            motes[i] = {
                x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 1, size: 1,
            };
        }

        function respawn(m) {
            const angle = Math.random() * Math.PI * 2;
            const radius = 12 + Math.random() * 16;
            m.x = player.x + 16 + Math.cos(angle) * radius;
            // Orbit is flatter vertically for a top-down feel.
            m.y = player.y + 16 + Math.sin(angle) * radius * 0.65;
            m.vx = (Math.random() - 0.5) * 8;
            m.vy = -8 - Math.random() * 10;
            m.life = 0;
            m.maxLife = 1.2 + Math.random() * 1.0;
            m.size = 1.0 + Math.random() * 1.1;
        }

        return {
            baseRadius: 30,
            pulseAmp: 4,      // +/- pixels of radius pulse
            baseAlpha: 0.40,  // multiplied with the baked gradient
            alphaAmp: 0.14,
            pulseSpeed: 1.8,
            phase: 0,

            // Called on startup, respawn, and zone transitions so
            // motes don't trail from the previous position.
            snap() {
                this.phase = 0;
                for (const m of motes) {
                    respawn(m);
                    // Stagger lifetimes so they don't all pulse in
                    // unison from the first frame.
                    m.life = Math.random() * m.maxLife;
                }
            },

            update(dt) {
                this.phase += dt * this.pulseSpeed;
                for (const m of motes) {
                    m.life += dt;
                    if (m.life >= m.maxLife) {
                        respawn(m);
                    } else {
                        m.x += m.vx * dt;
                        m.y += m.vy * dt;
                    }
                }
            },

            draw() {
                const cx = player.x + 16;
                const cy = player.y + 16;
                const r  = this.baseRadius + Math.sin(this.phase) * this.pulseAmp;
                const a  = this.baseAlpha  + Math.sin(this.phase * 0.7) * this.alphaAmp;

                // Glow: baked gradient drawn at the pulsing size.
                // Under corruption, fade the gold glow and layer the
                // purple glow on top so the shift reads as tint, not
                // addition.
                const cv = corruption.value;
                ctx.globalAlpha = a * (1 - cv * 0.4);
                ctx.drawImage(glowCanvas, cx - r, cy - r, r * 2, r * 2);
                if (cv > 0) {
                    // Corruption halo pulses a touch faster than the
                    // gold so at high values it feels agitated.
                    const rc = r * (1 + cv * 0.08);
                    ctx.globalAlpha = a * cv * 1.1;
                    ctx.drawImage(corruptCanvas, cx - rc, cy - rc, rc * 2, rc * 2);
                }
                ctx.globalAlpha = 1;

                // Motes: tiny fading circles. Alpha fades in / out so
                // they don't pop at spawn / death.
                for (const m of motes) {
                    const frac = m.life / m.maxLife;
                    const fade = frac < 0.2
                        ? frac / 0.2
                        : frac > 0.6
                            ? 1 - (frac - 0.6) / 0.4
                            : 1;
                    ctx.fillStyle = `rgba(${MOTE_COLOR}, ${(fade * 0.55).toFixed(3)})`;
                    ctx.beginPath();
                    ctx.arc(m.x, m.y, m.size, 0, Math.PI * 2);
                    ctx.fill();
                }
            },
        };
    })();

    // ---------------------------------------------------------------
    // Charge attack VFX
    //
    // Visual + audio feedback for the charge-attack buildup. Three
    // strands of feedback that all intensify with chargeTime:
    //   - Halo   : a small bright disc around the player, tinted
    //              cyan below the 1s threshold and gold past it.
    //   - Motes  : a tiny particle pool that spawns out at a radius
    //              and converges on the player. Preallocated - zero
    //              per-frame allocation even at peak emission.
    //   - Rising : a single sine oscillator whose pitch + gain ramp
    //              with chargeTime. Started on charge begin, gently
    //              faded out on release.
    //
    // Particle count is capped at MAX_PARTICLES (12) so even at full
    // emission it's trivial on mobile: ~12 arc calls per frame.
    // ---------------------------------------------------------------
    const chargeFx = (function () {
        const MAX_PARTICLES = 12;
        const particles = new Array(MAX_PARTICLES);
        for (let i = 0; i < MAX_PARTICLES; i++) {
            particles[i] = {
                x: 0, y: 0, vx: 0, vy: 0,
                life: 0, maxLife: 1, size: 1,
                alive: false,
            };
        }

        let spawnAccum = 0;
        let rising = null;   // { osc, g } while charging

        function findIdle() {
            for (const p of particles) if (!p.alive) return p;
            return null;
        }

        function spawnOne() {
            const p = findIdle();
            if (!p) return;
            const pcx = player.x + player.width / 2;
            const pcy = player.y + player.height / 2;
            const angle = Math.random() * Math.PI * 2;
            const radius = 58 + Math.random() * 28;
            const px = pcx + Math.cos(angle) * radius;
            const py = pcy + Math.sin(angle) * radius;
            const lifespan = 0.45 + Math.random() * 0.2;
            // Converge: sized so the particle reaches the center by
            // the time its life runs out.
            p.x = px;
            p.y = py;
            p.vx = (pcx - px) / lifespan;
            p.vy = (pcy - py) / lifespan;
            p.life = 0;
            p.maxLife = lifespan;
            p.size = 1 + Math.random() * 1.4;
            p.alive = true;
        }

        function tickSound(active, t) {
            if (!sound.ctx) return;
            if (active) {
                if (!rising) {
                    const ctx = sound.ctx;
                    const osc = ctx.createOscillator();
                    const g = ctx.createGain();
                    osc.type = "sine";
                    osc.frequency.setValueAtTime(180, ctx.currentTime);
                    g.gain.setValueAtTime(0.0001, ctx.currentTime);
                    osc.connect(g).connect(sound.master);
                    try { osc.start(); } catch (_e) {}
                    rising = { osc, g };
                }
                const ctx = sound.ctx;
                const now = ctx.currentTime;
                // 180 Hz idle -> ~680 Hz at full charge.
                const pitch = 180 + t * 500;
                // Peak around 0.10 so it doesn't drown out sfx.
                const vol = 0.02 + t * 0.08;
                try {
                    rising.osc.frequency.cancelScheduledValues(now);
                    rising.osc.frequency.setValueAtTime(pitch, now);
                    rising.g.gain.cancelScheduledValues(now);
                    rising.g.gain.setValueAtTime(vol, now);
                } catch (_e) { /* node gone */ }
            } else if (rising) {
                const ctx = sound.ctx;
                const now = ctx.currentTime;
                const node = rising;
                rising = null;
                try {
                    node.g.gain.cancelScheduledValues(now);
                    const v = Math.max(0.0001, node.g.gain.value);
                    node.g.gain.setValueAtTime(v, now);
                    node.g.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
                } catch (_e) {}
                setTimeout(() => {
                    try { node.osc.stop(); } catch (_e) {}
                    try { node.osc.disconnect(); node.g.disconnect(); } catch (_e) {}
                }, 140);
            }
        }

        return {
            update(dt) {
                // Age existing particles regardless of charge state
                // so strays finish naturally after a release.
                for (const p of particles) {
                    if (!p.alive) continue;
                    p.life += dt;
                    if (p.life >= p.maxLife) { p.alive = false; continue; }
                    p.x += p.vx * dt;
                    p.y += p.vy * dt;
                }

                if (player.isCharging) {
                    const t = Math.min(1, player.chargeTime / player.maxCharge);
                    // 3/s at the start, 14/s at full charge.
                    spawnAccum += (3 + t * 11) * dt;
                    while (spawnAccum >= 1) {
                        spawnOne();
                        spawnAccum -= 1;
                    }
                    tickSound(true, t);
                } else {
                    spawnAccum = 0;
                    tickSound(false, 0);
                }
            },

            draw(ctx) {
                if (!player.isCharging) {
                    // Still draw stray particles so they finish out
                    // their converge after a release.
                    let any = false;
                    for (const p of particles) if (p.alive) { any = true; break; }
                    if (!any) return;
                }

                const pcx = player.x + player.width / 2;
                const pcy = player.y + player.height / 2;
                const t = Math.min(1, player.chargeTime / player.maxCharge);
                const ready = player.chargeTime >= 1;
                const color = ready ? "#ffd166" : "#8ad9ff";

                // Halo around the player - grows + brightens with
                // chargeTime. Drawn additively so it brightens the
                // sprite underneath rather than flat-tinting it.
                if (player.isCharging) {
                    ctx.save();
                    ctx.globalCompositeOperation = "lighter";
                    const r = 20 + t * 16;
                    ctx.globalAlpha = 0.18 + t * 0.35;
                    ctx.fillStyle = color;
                    ctx.beginPath();
                    ctx.arc(pcx, pcy, r, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.restore();
                }

                // Converging motes.
                ctx.save();
                ctx.fillStyle = color;
                for (const p of particles) {
                    if (!p.alive) continue;
                    const frac = p.life / p.maxLife;
                    const alpha = (1 - frac) * (0.5 + t * 0.45);
                    ctx.globalAlpha = alpha;
                    ctx.beginPath();
                    ctx.arc(p.x, p.y, p.size * (1 - frac * 0.3), 0, Math.PI * 2);
                    ctx.fill();
                }
                ctx.restore();
            },

            reset() {
                for (const p of particles) p.alive = false;
                spawnAccum = 0;
                tickSound(false, 0);
            },
        };
    })();

    // ---------------------------------------------------------------
    // Player particle trail
    //
    // Tiny bright motes dropped behind the player proportional to
    // move velocity. Preallocated pool (no per-frame alloc); fades
    // in ~0.35s. Layered on top of the cloak + aura - cloak handles
    // the cloth sweep, trail handles the "energy after-image" when
    // moving fast. burst() is called by charged-attack releases for
    // an extra punch of brighter motes.
    // ---------------------------------------------------------------
    const playerTrail = (function () {
        const CAP = 16;
        const pool = new Array(CAP);
        for (let i = 0; i < CAP; i++) {
            pool[i] = { x: 0, y: 0, life: 0, maxLife: 0.35, size: 1, alive: false };
        }
        function respawn(p, x, y, life, size) {
            p.x = x; p.y = y;
            p.life = 0;
            p.maxLife = life;
            p.size = size;
            p.alive = true;
        }
        let spawnAccum = 0;
        return {
            update(dt) {
                const speed = Math.hypot(player.vx, player.vy);
                if (speed > 40) {
                    spawnAccum += (speed / 80) * dt * 8;
                    while (spawnAccum >= 1) {
                        spawnAccum -= 1;
                        for (const p of pool) {
                            if (!p.alive) {
                                const jx = (Math.random() - 0.5) * 10;
                                const jy = (Math.random() - 0.5) * 6;
                                respawn(p,
                                    player.x + player.width / 2 + jx,
                                    player.y + player.height - 2 + jy,
                                    0.32 + Math.random() * 0.15,
                                    1 + Math.random() * 1.2);
                                break;
                            }
                        }
                    }
                } else {
                    spawnAccum = 0;
                }
                for (const p of pool) {
                    if (!p.alive) continue;
                    p.life += dt;
                    if (p.life >= p.maxLife) p.alive = false;
                }
            },
            burst(count, size, life) {
                let spawned = 0;
                for (const p of pool) {
                    if (spawned >= count) break;
                    if (p.alive) continue;
                    const ang = Math.random() * Math.PI * 2;
                    const r = 10 + Math.random() * 12;
                    respawn(p,
                        player.x + player.width / 2 + Math.cos(ang) * r,
                        player.y + player.height / 2 + Math.sin(ang) * r,
                        life, size);
                    spawned++;
                }
            },
            draw(ctx) {
                for (const p of pool) {
                    if (!p.alive) continue;
                    const t = p.life / p.maxLife;
                    const a = (1 - t) * 0.85;
                    ctx.globalAlpha = a;
                    ctx.fillStyle = "rgba(255, 230, 180, 1)";
                    ctx.fillRect(
                        Math.round(p.x - p.size / 2),
                        Math.round(p.y - p.size / 2),
                        p.size, p.size
                    );
                }
                ctx.globalAlpha = 1;
            },
            reset() {
                for (const p of pool) p.alive = false;
                spawnAccum = 0;
            },
        };
    })();

    // ---------------------------------------------------------------
    // Ambient environment particles
    //
    // 14 preallocated motes that drift upward across the viewport
    // with a soft flicker. Palette shifts by zone: warm gold in
    // safe zones, cool blue in hostile zones, violet in corrupting
    // zones. Respawns at the bottom of the current viewport so it
    // follows the camera without any cull bookkeeping.
    // ---------------------------------------------------------------
    const ambientParticles = (function () {
        const CAP = 14;
        const motes = new Array(CAP);
        for (let i = 0; i < CAP; i++) {
            motes[i] = { x: 0, y: 0, vx: 0, vy: 0,
                         life: 0, maxLife: 1, size: 1, alive: false };
        }
        function respawn(m) {
            m.x = camera.x + Math.random() * VIEW_W;
            m.y = camera.y + VIEW_H - Math.random() * 40;
            m.vx = (Math.random() - 0.5) * 8;
            m.vy = -6 - Math.random() * 10;
            m.life = 0;
            m.maxLife = 3 + Math.random() * 2.5;
            m.size = 1 + Math.random() * 1.2;
            m.alive = true;
        }
        function paletteFor(level) {
            if (!level) return "255, 220, 150";
            if (level.corrupting) return "170, 110, 220";
            if (!level.safe)       return "150, 170, 220";
            return "255, 220, 150";
        }
        return {
            update(dt) {
                let live = 0;
                for (const m of motes) {
                    if (!m.alive) continue;
                    m.life += dt;
                    m.x += m.vx * dt;
                    m.y += m.vy * dt;
                    m.vx *= 0.99;
                    if (m.life >= m.maxLife) m.alive = false;
                    else live++;
                }
                const target = 10;
                for (const m of motes) {
                    if (live >= target) break;
                    if (!m.alive) { respawn(m); live++; }
                }
            },
            draw(ctx) {
                const rgb = paletteFor(currentLevel);
                for (const m of motes) {
                    if (!m.alive) continue;
                    const frac = m.life / m.maxLife;
                    const fade = frac < 0.1 ? frac / 0.1
                               : frac > 0.7 ? 1 - (frac - 0.7) / 0.3
                               : 1;
                    const flicker = 0.6 + 0.4 * Math.abs(Math.sin(m.life * 4));
                    const a = fade * flicker * 0.45;
                    ctx.fillStyle = `rgba(${rgb}, ${a.toFixed(3)})`;
                    ctx.fillRect(
                        Math.round(m.x - m.size / 2),
                        Math.round(m.y - m.size / 2),
                        m.size, m.size
                    );
                }
            },
            reset() {
                for (const m of motes) m.alive = false;
            },
        };
    })();

    // ---------------------------------------------------------------
    // Cinematic FX orchestrator
    //
    // A single layer on top of the existing shake / flash / camera
    // zoom / chargeFx / playerTrail systems that composes them into
    // one call: cinematicFx.impact(x, y, { scale, color }).
    //
    // Spec-shape layers:
    //   core      - world-space effect pool (not used yet; reserved
    //               for future "main effect" overlays that pair with
    //               a specific attack).
    //   particles - short-lived sparks in world space.
    //   screen    - facade for the existing screen shake / flash /
    //               zoom, accessed via impact() so callers don't
    //               need to know the individual modules.
    //   post      - facade for slow-mo (specialAttack.slowMoTimer).
    //
    // Also owns a ground-residue pool for the "lingering glow after
    // attack" aftertaste. All pools are preallocated; adaptive cap
    // reduces spawn counts when the enemy roster is crowded so big
    // fights stay smooth on mobile.
    // ---------------------------------------------------------------
    const cinematicFx = (function () {
        const MAX_SPARKS = 64;
        const MAX_RESIDUES = 16;
        const sparks = new Array(MAX_SPARKS);
        for (let i = 0; i < MAX_SPARKS; i++) {
            sparks[i] = {
                x: 0, y: 0, vx: 0, vy: 0,
                life: 0, maxLife: 0, size: 1,
                color: "255,220,140", alive: false,
            };
        }
        const residues = new Array(MAX_RESIDUES);
        for (let i = 0; i < MAX_RESIDUES; i++) {
            residues[i] = {
                x: 0, y: 0, r: 0, life: 0, maxLife: 0,
                color: "255,220,140", alive: false,
            };
        }

        // Adaptive cap - if enemies is big, halve spark spawn counts
        // so a 20-enemy horde doesn't compound into a spark storm.
        function crowdScale() {
            return enemies.length > 20 ? 0.5 : 1;
        }

        // Standard sparks burst from a point. `color` is a CSS rgb
        // triple string "R,G,B" so the alpha can be templated later.
        function spawnSparks(x, y, color, count, speed, life) {
            const n = Math.max(1, Math.round(count * crowdScale()));
            let spawned = 0;
            for (const s of sparks) {
                if (spawned >= n) break;
                if (s.alive) continue;
                const ang = Math.random() * Math.PI * 2;
                const sp = speed * (0.6 + Math.random() * 0.7);
                s.x = x; s.y = y;
                s.vx = Math.cos(ang) * sp;
                s.vy = Math.sin(ang) * sp;
                s.life = 0;
                s.maxLife = life * (0.7 + Math.random() * 0.5);
                s.size = 1 + Math.random() * 1.5;
                s.color = color;
                s.alive = true;
                spawned++;
            }
        }

        // Ground residue - a glowing disc that fades over `duration`.
        function spawnResidue(x, y, color, radius, duration) {
            for (const r of residues) {
                if (r.alive) continue;
                r.x = x; r.y = y;
                r.r = radius;
                r.life = 0;
                r.maxLife = duration;
                r.color = color;
                r.alive = true;
                return;
            }
        }

        return {
            // Layer arrays (spec shape). Exposed for debug + future
            // extension; modules can push their own effects here.
            core: [], particles: sparks, screen: [], post: [],

            // Composite impact: shake + flash + zoom + sparks + residue
            // + optional slow-mo. One call replaces a stack of ad-hoc
            // calls at each release site.
            //
            //   opts.scale    - 0.5-1.5 intensity multiplier (default 1)
            //   opts.color    - sparks / residue color "R,G,B" string
            //   opts.sparks   - number of sparks to emit
            //   opts.residue  - radius for the ground glow (0 = skip)
            //   opts.slowMo   - seconds of slow-mo (0 = skip)
            //   opts.flash    - flash intensity 0..1 (default 0.4 * scale)
            //   opts.shake    - shake magnitude (default 8 * scale)
            //   opts.zoom     - zoom peak (1.0 = skip)
            impact(x, y, opts = {}) {
                const scale = opts.scale ?? 1;
                const color = opts.color ?? "255, 220, 140";
                const flashI = opts.flash ?? Math.min(0.9, 0.4 * scale);
                const shakeM = opts.shake ?? 8 * scale;
                const sparksN = opts.sparks ?? Math.round(12 * scale);
                const residueR = opts.residue ?? 0;
                const slowMoS = opts.slowMo ?? 0;
                const zoomP = opts.zoom ?? 1.0;

                if (flashI > 0) flash.trigger(flashI, 0.18 + scale * 0.04);
                if (shakeM > 0) shake.trigger(shakeM, 0.18 + scale * 0.04);
                if (sparksN > 0) {
                    spawnSparks(x, y, color, sparksN,
                        140 + scale * 60, 0.32 + scale * 0.18);
                }
                if (residueR > 0) {
                    spawnResidue(x, y, color, residueR, 1.2 + scale * 0.6);
                }
                if (zoomP > 1.0) camera.zoomPulse(zoomP, 0.25);
                if (slowMoS > 0) {
                    specialAttack.slowMoTimer = Math.max(
                        specialAttack.slowMoTimer, slowMoS
                    );
                }
            },

            // Bare spark burst without a full impact (no shake/flash).
            // Useful for secondary effects like mid-beam pulses.
            burst(x, y, color, count) {
                spawnSparks(x, y, color ?? "255, 220, 140",
                    count ?? 10, 160, 0.4);
            },

            // Standalone residue without shake/flash. Handy for
            // "leftover energy" drawn after a beam despawns.
            residue(x, y, color, radius, duration) {
                spawnResidue(x, y, color ?? "255, 220, 140",
                    radius, duration ?? 1.2);
            },

            update(dt) {
                for (const s of sparks) {
                    if (!s.alive) continue;
                    s.life += dt;
                    if (s.life >= s.maxLife) { s.alive = false; continue; }
                    s.x += s.vx * dt;
                    s.y += s.vy * dt;
                    // Friction so sparks arc + settle rather than
                    // fly off like rays.
                    s.vx *= 0.92;
                    s.vy *= 0.92;
                    // Gentle gravity so residues settle downward.
                    s.vy += 80 * dt;
                }
                for (const r of residues) {
                    if (!r.alive) continue;
                    r.life += dt;
                    if (r.life >= r.maxLife) r.alive = false;
                }
            },

            // World-space draw - residues first (underneath),
            // sparks on top.
            drawWorld(ctx) {
                for (const r of residues) {
                    if (!r.alive) continue;
                    const t = r.life / r.maxLife;
                    const a = (1 - t) * 0.55;
                    // Layered radial falloff via two circles - a
                    // cheap substitute for a gradient that runs
                    // 2 fillStyle changes per residue.
                    ctx.globalAlpha = a * 0.4;
                    ctx.fillStyle = `rgba(${r.color}, 1)`;
                    ctx.beginPath();
                    ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.globalAlpha = a * 0.7;
                    ctx.beginPath();
                    ctx.arc(r.x, r.y, r.r * 0.55, 0, Math.PI * 2);
                    ctx.fill();
                }
                ctx.globalAlpha = 1;

                for (const s of sparks) {
                    if (!s.alive) continue;
                    const t = s.life / s.maxLife;
                    const fade = (1 - t) * 0.9;
                    ctx.fillStyle = `rgba(${s.color}, ${fade.toFixed(3)})`;
                    ctx.fillRect(
                        Math.round(s.x - s.size / 2),
                        Math.round(s.y - s.size / 2),
                        s.size, s.size
                    );
                }
            },

            reset() {
                for (const s of sparks) s.alive = false;
                for (const r of residues) r.alive = false;
            },
        };
    })();
    // ---------------------------------------------------------------
    // Corruption
    //
    // A normalized 0..1 value that rises while the player lingers in
    // "corrupting" zones (flagged with `level.corrupting: true` - the
    // Abyss today) and decays in safe zones. Small spikes on kills
    // inside a corrupting zone so the meter responds to action, not
    // just exposure. Peak value is tracked so future mechanics can
    // gate on "highest you've been" rather than current reading.
    //
    // Difficulty hook: corruption scales incoming damage via the
    // existing `player.damageModifiers` chain. A modifier is pushed
    // once at boot; clearing + re-pushing on restart keeps the chain
    // well-known instead of growing across runs.
    //
    // Expansion points:
    //   - `corrupting` flag can be added to any level.
    //   - `onKill` already branches on zone, so adding corruption
    //     gain from specific enemies is a one-line addition.
    //   - Future thresholds (e.g. whisper SFX at >0.5) read from
    //     `corruption.value` and keep the module the source of truth.
    // ---------------------------------------------------------------
    const corruption = {
        value: 0,
        max: 1,
        peak: 0,
        // Rates are per-second so dt-scaling is automatic.
        //   Gain fills the meter in ~85s of pure exposure.
        //   Decay drains it in ~3min of time in a safe zone.
        //   Kill gain is a small spike so combat feels "costly".
        gainPerSecond:  0.012,
        decayPerSecond: 0.006,
        killGain:       0.02,

        // Zones whose `corrupting` flag is true expose the player.
        _exposes(level) { return !!(level && level.corrupting); },

        update(dt) {
            if (this._exposes(currentLevel)) {
                this.value = Math.min(this.max, this.value + this.gainPerSecond * dt);
            } else if (currentLevel && currentLevel.safe) {
                this.value = Math.max(0, this.value - this.decayPerSecond * dt);
            }
            if (this.value > this.peak) this.peak = this.value;
        },

        onKill() {
            if (this._exposes(currentLevel)) {
                this.value = Math.min(this.max, this.value + this.killGain);
                if (this.value > this.peak) this.peak = this.value;
            }
        },

        // Incoming-damage multiplier. 1.0 at rest, up to 1.45 at full
        // corruption - enough that combat tightens without becoming
        // a wall.
        damageMultiplier() { return 1 + this.value * 0.45; },

        reset() {
            this.value = 0;
            this.peak  = 0;
        },
    };

    // Wire corruption into the damage pipeline. Runs as a multiplier
    // in the existing damageModifiers chain, so other modifiers
    // (armor, resistances) still compose naturally.
    player.damageModifiers.push((dmg) => dmg * corruption.damageMultiplier());

    // ---------------------------------------------------------------
    // Crown
    //
    // A cosmetic-plus-ability overlay that rides on top of the
    // existing attack systems:
    //
    //   energy      0..max, builds from kills + magic orbs
    //   level       derived from story chapter (1..4+)
    //   active      true during the short "Crown Mode" window
    //   activeTimer seconds remaining on Crown Mode
    //
    // When energy hits max, Crown Mode auto-activates for ~8s with a
    // brief cinematic (flash + zoom + shake). While active, the
    // existing charged / special attacks get a size + damage boost
    // via a shared crown.attackMult / crown.sizeMult pair so the
    // integration is one-line in each activate call.
    //
    // Visual: a small 3-pronged gold crown drawn above the player's
    // sprite, with a pre-baked glow and a preallocated 6-sparkle pool
    // that pulses around it. Level steps up the glow alpha and
    // sparkle count so the crown visibly evolves per chapter.
    // ---------------------------------------------------------------
    const crown = (function () {
        const GLOW_SIZE = 48;
        // One pre-baked glow canvas (gold radial gradient), reused
        // every frame via drawImage with a size + alpha from the
        // active level + mode. Zero per-frame gradient allocation.
        const glow = document.createElement("canvas");
        glow.width = glow.height = GLOW_SIZE;
        (function () {
            const g = glow.getContext("2d");
            const c = GLOW_SIZE / 2;
            const grad = g.createRadialGradient(c, c, 0, c, c, GLOW_SIZE / 2);
            grad.addColorStop(0,   "rgba(255, 235, 140, 0.55)");
            grad.addColorStop(0.5, "rgba(255, 220, 130, 0.18)");
            grad.addColorStop(1,   "rgba(255, 220, 130, 0)");
            g.fillStyle = grad;
            g.fillRect(0, 0, GLOW_SIZE, GLOW_SIZE);
        })();

        // Preallocated sparkle pool. `count` active sparkles is
        // chosen from level each frame; the rest idle.
        const SPARKLE_CAP = 6;
        const sparkles = new Array(SPARKLE_CAP);
        for (let i = 0; i < SPARKLE_CAP; i++) {
            sparkles[i] = { angle: 0, radius: 0, phase: 0, life: 0, alive: false };
        }
        function respawnSparkle(s) {
            s.angle = Math.random() * Math.PI * 2;
            s.radius = 10 + Math.random() * 12;
            s.phase = Math.random() * Math.PI * 2;
            s.life = 0;
            s.maxLife = 0.8 + Math.random() * 0.6;
            s.alive = true;
        }

        return {
            energy: 0,
            max: 100,
            level: 1,
            active: false,
            activeTimer: 0,
            activeDuration: 8.0,
            pulsePhase: 0,

            // Per-frame multipliers consumed by the attack systems.
            // 1.0 when Crown Mode is dormant; 1.4x damage + 1.3x
            // size when active.
            attackMult: 1,
            sizeMult: 1,

            hasFullEnergy() { return this.energy >= this.max; },

            // Adds energy from any gameplay source (kills, orbs).
            // No-op while Crown Mode is burning down - the boost
            // comes free during those 8s.
            add(amount) {
                if (this.active) return;
                this.energy = Math.min(this.max, this.energy + amount);
                if (this.energy >= this.max) this.activate();
            },

            // Triggers Crown Mode with the small cinematic. Always
            // consumes the full energy pool even if the player had
            // "overshot" on the final pickup.
            activate() {
                if (this.active) return false;
                this.energy = 0;
                this.active = true;
                this.activeTimer = this.activeDuration;
                // Brief cinematic - shake + flash + camera punch.
                // Slow-mo hijacks the specialAttack slowMoTimer (the
                // enemy-dt scale already reads from it), so enemies
                // pause for a beat without a new timing system.
                shake.trigger(10, 0.28);
                flash.trigger(0.6, 0.28);
                camera.zoomPulse(1.08, 0.35);
                specialAttack.slowMoTimer = Math.max(
                    specialAttack.slowMoTimer, 0.35
                );
                sound.play("levelUp");
                questLog.showToast("Crown Mode!", 2.2);
                return true;
            },

            // Resolve level from story chapter. Runs every update -
            // cheap, and it keeps the crown synced to chapter
            // advances without a separate event hook.
            _refreshLevel() {
                const idx = Math.max(0, story.chapterOrder.indexOf(story.state));
                // chapter1 -> 1, chapter3 -> 2, chapter5 -> 3,
                // chapter6 -> 4 so each stage steps the visuals up.
                this.level = idx < 2 ? 1
                           : idx < 4 ? 2
                           : idx < 5 ? 3
                           : 4;
            },

            update(dt) {
                this._refreshLevel();
                this.pulsePhase += dt;

                if (this.active) {
                    this.activeTimer = Math.max(0, this.activeTimer - dt);
                    if (this.activeTimer === 0) this.active = false;
                }

                // Dynamic attack / size multipliers that the weapon
                // dispatch reads at activation time.
                this.attackMult = this.active ? 1.4 : 1;
                this.sizeMult   = this.active ? 1.3 : 1;

                // Sparkle pool: the number of live sparkles steps
                // with level, so level 4 has twice the shimmer as
                // level 1. Active Crown Mode spawns a fresh one
                // every tick if slots are free.
                const want = 2 + this.level;
                let liveCount = 0;
                for (const s of sparkles) if (s.alive) liveCount++;
                if (liveCount < want) {
                    for (const s of sparkles) {
                        if (!s.alive) { respawnSparkle(s); break; }
                    }
                }
                for (const s of sparkles) {
                    if (!s.alive) continue;
                    s.life += dt;
                    s.phase += dt * 3;
                    if (s.life >= s.maxLife) s.alive = false;
                }
            },

            draw(ctx) {
                const cx = player.x + player.width / 2;
                const cy = player.y - 8;  // just above the sprite's head
                const lvl = this.level;

                // Glow halo, scaled by level + pulse + active state.
                const basePulse = 0.9 + 0.1 * Math.sin(this.pulsePhase * 2);
                const lvlGlow = 0.35 + lvl * 0.12;
                const activeBoost = this.active ? 1.5 : 1;
                const glowR = (18 + lvl * 4) * basePulse * activeBoost;
                ctx.save();
                ctx.globalAlpha = Math.min(1, lvlGlow * activeBoost);
                ctx.drawImage(glow,
                    cx - glowR, cy - glowR + 8,
                    glowR * 2, glowR * 2);
                ctx.globalAlpha = 1;

                // Crown sprite. A gold trapezoid base + three
                // pointed prongs each tipped with a coloured gem.
                // Position nudges up 1px when Crown Mode is active
                // so the cinematic reads immediately.
                const crownY = cy - 2 - (this.active ? 1 : 0);
                const baseY = crownY;
                const baseW = 14;
                // Band
                ctx.fillStyle = "#ffd166";
                ctx.fillRect(cx - baseW / 2, baseY, baseW, 4);
                ctx.fillStyle = "#c9963a";
                ctx.fillRect(cx - baseW / 2, baseY + 3, baseW, 1);
                // Three prongs
                ctx.fillStyle = "#ffd166";
                ctx.fillRect(cx - 6, baseY - 4, 3, 4);
                ctx.fillRect(cx - 1, baseY - 6, 3, 6);
                ctx.fillRect(cx + 3, baseY - 4, 3, 4);
                // Prong tips - gems, coloured by level for a visible
                // evolution each chapter step.
                const gem = lvl >= 4 ? ["#ff8ec6", "#b06bff", "#ff8ec6"]
                          : lvl >= 3 ? ["#8ad9ff", "#b06bff", "#8ad9ff"]
                          : lvl >= 2 ? ["#8ad9ff", "#ffd166", "#8ad9ff"]
                          :            ["#c5c5d0", "#ffd166", "#c5c5d0"];
                ctx.fillStyle = gem[0]; ctx.fillRect(cx - 5, baseY - 5, 1, 1);
                ctx.fillStyle = gem[1]; ctx.fillRect(cx, baseY - 7, 1, 1);
                ctx.fillStyle = gem[2]; ctx.fillRect(cx + 4, baseY - 5, 1, 1);

                // Sparkles - tiny gold pixels orbiting at offset
                // angles around the crown. Alpha eases in + out
                // over each sparkle's short life.
                for (const s of sparkles) {
                    if (!s.alive) continue;
                    const t = s.life / s.maxLife;
                    const fade = t < 0.3 ? t / 0.3
                               : t > 0.6 ? 1 - (t - 0.6) / 0.4
                               : 1;
                    const sx = cx + Math.cos(s.angle + s.phase * 0.5) * s.radius;
                    const sy = crownY + Math.sin(s.angle + s.phase * 0.5) * 6
                        - Math.abs(Math.sin(s.phase)) * s.radius * 0.5;
                    ctx.fillStyle = `rgba(255, 240, 160, ${(fade * 0.9).toFixed(3)})`;
                    ctx.fillRect(Math.round(sx), Math.round(sy), 2, 2);
                }
                ctx.restore();
            },

            reset() {
                this.energy = 0;
                this.active = false;
                this.activeTimer = 0;
                this.attackMult = 1;
                this.sizeMult = 1;
                for (const s of sparkles) s.alive = false;
            },
        };
    })();

    player.crown = crown;

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
        // Harder shake on damage than on an enemy hit so taking a
        // hit feels distinct from landing one.
        shake.trigger(8, 0.22);

        if (player.hp <= 0) {
            player.alive = false;
            gameState = "gameover";
            // Fade the music out so the defeat sits in silence.
            // restartGame will pull the zone track back in on the
            // next tick via the music picker.
            music.stopMusic(0.8);
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
    // Story progression
    //
    // A single `story.state` string advances forward through the
    // CHAPTERS catalog based on player actions. Every other system
    // (NPC dialogue, objectives, HUD) can query `story.is(id)`,
    // `story.atLeast(id)`, or `story.title()` to branch.
    //
    // Persistence: the current state is mirrored to localStorage so
    // a page reload keeps progress. `restartGame` intentionally
    // clears it (death = fresh campaign) to match the rest of the
    // reset story - inventory, quests, upgrades, coins, etc.
    //
    // Triggers (wired below in combat / transition / quest paths):
    //   chapter1  default - "Arrival"
    //   chapter2  first time the player enters the caverns
    //   chapter3  finishing the `slay10` quest (receive Golden Key)
    //   chapter4  first time the player enters the shrine
    //   chapter5  defeating a boss
    //
    // Adding a new chapter: append to CHAPTERS + chapterOrder and
    // call `story.advance("chapterN")` from wherever the new event
    // fires. Nothing else cares about the list length.
    // ---------------------------------------------------------------
    const CHAPTERS = {
        chapter1: { id: "chapter1", title: "Arrival" },
        chapter2: { id: "chapter2", title: "The Hunt Begins" },
        chapter3: { id: "chapter3", title: "Shrine's Call" },
        chapter4: { id: "chapter4", title: "Into the Shrine" },
        chapter5: { id: "chapter5", title: "Victory" },
        chapter6: { id: "chapter6", title: "The Deeper Dark" },
    };

    const STORY_STORAGE_KEY = "ethereon.storyState";

    const story = {
        state: "chapter1",
        // Fine-grained mission tag (e.g. "first_hunt_complete") set
        // by the missions module on each completion. Lives alongside
        // `state` so debug overlays and downstream conditionals can
        // read either the chapter or the last mission outcome.
        missionTag: null,
        // Ordered list drives `atLeast` and enforces one-way advance.
        chapterOrder: [
            "chapter1", "chapter2", "chapter3", "chapter4", "chapter5", "chapter6",
        ],

        is(id) { return this.state === id; },

        atLeast(id) {
            const a = this.chapterOrder.indexOf(this.state);
            const b = this.chapterOrder.indexOf(id);
            return b >= 0 && a >= b;
        },

        title() {
            return CHAPTERS[this.state]?.title ?? "";
        },

        // Moves forward to `id` if and only if it's further along
        // the chapter order. Ignores attempts to skip sideways /
        // backward. Toasts + persists on a real advance.
        advance(id) {
            const target = this.chapterOrder.indexOf(id);
            const current = this.chapterOrder.indexOf(this.state);
            if (target < 0 || target <= current) return false;

            this.state = id;
            this.save();
            sound.play("levelUp");

            // Cinematic if one's defined for this chapter, otherwise
            // fall back to the compact toast. Keeps the notification
            // shape uniform but lets any chapter graduate to a full
            // sequence with no call-site changes.
            if (CINEMATICS[id]) {
                cinematic.play(CINEMATICS[id]);
            } else {
                questLog.showToast(
                    `New chapter - ${CHAPTERS[id].title}`,
                    3.0
                );
            }
            return true;
        },

        save() {
            try {
                if (typeof localStorage !== "undefined") {
                    localStorage.setItem(STORY_STORAGE_KEY, this.state);
                }
            } catch (_e) { /* Safari private mode, full quota, etc. */ }
        },

        load() {
            try {
                if (typeof localStorage === "undefined") return;
                const v = localStorage.getItem(STORY_STORAGE_KEY);
                if (v && CHAPTERS[v]) this.state = v;
            } catch (_e) { /* ignore */ }
        },

        reset() {
            this.state = "chapter1";
            try {
                if (typeof localStorage !== "undefined") {
                    localStorage.removeItem(STORY_STORAGE_KEY);
                }
            } catch (_e) { /* ignore */ }
        },
    };

    // Pull any persisted chapter from a previous session.
    story.load();

    // ---------------------------------------------------------------
    // Mission manager
    //
    // Linear, single-active-mission progression layer that sits on
    // top of the chapter / quest systems. Existing chapter advances
    // and quest completions still work; missions hook into the same
    // beats so the player sees one canonical "current objective" at
    // any time, with an enforced sequential gate.
    //
    // Public API (matches the spec):
    //   missions.list[]
    //   missions.currentMissionIndex
    //   missions.startMission(index)
    //   missions.completeMission(index)
    //   missions.getCurrentMission()
    //
    // Plus convenience helpers:
    //   completeById(id)       - the typical caller, since hooks
    //                            know the mission id, not its slot.
    //   canTrigger(id)         - guard for mission-gated events.
    //   reset()                - rewinds for a fresh run.
    //
    // Each mission carries an optional `chapter` (advances story to
    // that chapter on complete) and a `tag` (sets story.missionTag
    // to "<tag>_complete") so downstream NPC dialogue and event
    // checks can branch on either.
    // ---------------------------------------------------------------
    const missions = {
        list: [
            { id: 1, name: "Speak with the Village Elder",
              completed: false, chapter: null,       tag: "intro" },
            { id: 2, name: "Accept the Elder's first hunt",
              completed: false, chapter: null,       tag: "first_hunt_start" },
            { id: 3, name: "Cull three beasts in the caverns",
              completed: false, chapter: "chapter2", tag: "first_hunt" },
            { id: 4, name: "Earn the Golden Key",
              completed: false, chapter: "chapter3", tag: "key_earned" },
            { id: 5, name: "Enter the Ethereon Shrine",
              completed: false, chapter: "chapter4", tag: "shrine_entered" },
            { id: 6, name: "Defeat the Shrine Keeper",
              completed: false, chapter: "chapter5", tag: "keeper_fallen" },
            { id: 7, name: "Descend into the Abyss",
              completed: false, chapter: "chapter6", tag: "abyss_entered" },
        ],
        currentMissionIndex: 0,

        getCurrentMission() {
            return this.list[this.currentMissionIndex] ?? null;
        },

        // Spec-named alias for callers that want the natural API.
        startMission(index) {
            if (index < 0 || index >= this.list.length) return false;
            // Sequential gate: cannot start mission N+1 until N is
            // completed. This is the rule that prevents two missions
            // running at once.
            if (index > 0 && !this.list[index - 1].completed) return false;
            // Don't restart an already-completed mission.
            if (this.list[index].completed) return false;
            this.currentMissionIndex = index;
            return true;
        },

        completeMission(index) {
            // Trigger guard: the only mission a caller can complete
            // is the active one. Out-of-order completes are dropped
            // silently so a stale event hook can't skip the chain.
            if (index !== this.currentMissionIndex) return false;
            const m = this.list[index];
            if (!m || m.completed) return false;
            m.completed = true;

            // Story sync. `chapter` advances the story module (which
            // in turn fires its cinematic / toast); `tag` sets the
            // fine-grained missionTag for debug + dialogue branches.
            if (m.chapter) story.advance(m.chapter);
            story.missionTag = `${m.tag}_complete`;

            questLog.showToast(`Mission complete: ${m.name}`, 2.6);
            sound.play("levelUp");

            // Auto-advance the cursor onto the next mission so the
            // next event hook can complete it (no separate startMission
            // call required for the linear flow). startMission stays
            // available for callers that want explicit control.
            // The "NEW MISSION" banner fires here so the player
            // always sees the next objective spelled out.
            if (index + 1 < this.list.length) {
                this.currentMissionIndex = index + 1;
                newMissionBanner.show(this.list[this.currentMissionIndex].name);
            }
            return true;
        },

        completeById(id) {
            const cur = this.getCurrentMission();
            if (!cur || cur.id !== id) return false;
            return this.completeMission(this.currentMissionIndex);
        },

        // Trigger-time guard. Event handlers call this before firing
        // mission-specific work so they don't double-trigger or run
        // out of order:
        //   if (missions.canTrigger(3)) { ... }
        canTrigger(id) {
            const cur = this.getCurrentMission();
            return !!(cur && cur.id === id);
        },

        reset() {
            for (const m of this.list) m.completed = false;
            this.currentMissionIndex = 0;
            story.missionTag = null;
        },
    };

    // ---------------------------------------------------------------
    // Chapter-staged text picker
    //
    // NPC dialogue (and any other text that wants to react to story
    // progress) can be declared as a chapter-keyed object:
    //
    //   greeting: {
    //       chapter1: "Hello, stranger.",
    //       chapter3: "Back again - you carry the key, I see.",
    //       chapter5: "Hero of the grove.",
    //   }
    //
    // `pickStage(obj)` walks `story.chapterOrder` forward and
    // returns the latest entry the player's chapter qualifies for.
    // Missing chapters fall through to the previous stage, so two
    // stages are enough to cover a full campaign if that's all the
    // NPC has to say.
    //
    // Plain strings and functions pass through unchanged - an NPC
    // can stay static, use function-form (any condition), or use
    // the staged object - whichever fits.
    // ---------------------------------------------------------------
    function pickStage(stages) {
        if (stages == null) return null;
        if (typeof stages === "string") return stages;
        if (typeof stages === "function") return stages();
        let chosen = null;
        for (const chId of story.chapterOrder) {
            if (chId in stages && story.atLeast(chId)) {
                chosen = stages[chId];
            }
        }
        return chosen;
    }

    // ---------------------------------------------------------------
    // Lore discovery
    //
    // Levels can carry a `lore: [...]` list of world-space objects
    // the player can read:
    //
    //   { id, name, kind: "book"|"statue"|"relic", x, y, text }
    //
    // Each entry is a one-off discovery - read once, mark collected,
    // and the object stays in the world (slightly dimmed) as a
    // breadcrumb. `loreLog` tracks the set of collected ids and
    // persists it to localStorage so a page reload preserves
    // discovered history (match the story-state pattern).
    //
    // `restartGame` clears the set - death ends the run including
    // its lore run.
    // ---------------------------------------------------------------
    const LORE_STORAGE_KEY = "ethereon.loreCollected";

    const loreLog = {
        collected: new Set(),

        has(id) { return this.collected.has(id); },
        count() { return this.collected.size; },

        // Walk every level's lore list and sum - gives a stable
        // denominator for the "3 / 7" HUD counter.
        total() {
            let n = 0;
            for (const id in LEVELS) {
                const list = LEVELS[id].lore;
                if (list) n += list.length;
            }
            return n;
        },

        // Marks `id` collected, returns true on first-time collect.
        collect(id) {
            if (this.collected.has(id)) return false;
            this.collected.add(id);
            this.save();
            return true;
        },

        save() {
            try {
                if (typeof localStorage === "undefined") return;
                localStorage.setItem(
                    LORE_STORAGE_KEY,
                    JSON.stringify([...this.collected])
                );
            } catch (_e) { /* ignore */ }
        },

        load() {
            try {
                if (typeof localStorage === "undefined") return;
                const raw = localStorage.getItem(LORE_STORAGE_KEY);
                if (!raw) return;
                const arr = JSON.parse(raw);
                if (Array.isArray(arr)) this.collected = new Set(arr);
            } catch (_e) { /* ignore */ }
        },

        reset() {
            this.collected = new Set();
            try {
                if (typeof localStorage !== "undefined") {
                    localStorage.removeItem(LORE_STORAGE_KEY);
                }
            } catch (_e) { /* ignore */ }
        },
    };

    loreLog.load();

    // ---------------------------------------------------------------
    // Cinematics
    //
    // Short, modal, text-based sequences that fire on story beats.
    // While a cinematic is active the world freezes, a dark letter-
    // box fades in, and lines are shown one at a time - advances
    // automatically on a timer or immediately on any input.
    //
    // State machine phases:
    //   "in"    fade-in (bars + dim sweep onto the world)
    //   "hold"  the current line is displayed; auto-advances or
    //           the player can tap / press any key to skip ahead
    //   "out"   fade-out; on end -> close()
    //
    // Data shape (CINEMATICS catalog, keyed by story chapter id):
    //   { title, lines: [ "..." ] , perLine?, fadeIn?, fadeOut? }
    // ---------------------------------------------------------------
    const CINEMATICS = {
        chapter2: {
            title: "Chapter 2 - The Hunt Begins",
            lines: [
                "Three beasts fall. Their echoes drain into the cavern floor.",
                "The grove will sleep easier tonight - but the deep does not.",
                "Something older has noticed you now. And it is counting.",
            ],
        },
        chapter3: {
            title: "Chapter 3 - Shrine's Call",
            lines: [
                'The Elder presses the Golden Key into your palm.',
                '"The shrine\'s lock answers to this, and nothing else."',
                '"Whatever is down there has waited long enough. End it."',
            ],
        },
        chapter4: {
            title: "Chapter 4 - Into the Shrine",
            lines: [
                "The shrine's gate parts without a sound.",
                "Inside, the walls feel like they are breathing.",
                "Somewhere ahead, the Keeper turns its eyes toward you.",
            ],
        },
        chapter5: {
            title: "Chapter 5 - Victory",
            lines: [
                "The Keeper falls, and a silence floods the shrine.",
                "The Ethereon Heart pulses once - softly - then goes still.",
                "The world beyond the gate is quiet again.",
                "You have bought it time.",
            ],
        },
        chapter6: {
            title: "Chapter 6 - The Deeper Dark",
            lines: [
                "The shrine's floor splits along a seam you never saw.",
                "A staircase descends into air that tastes of forgotten ages.",
                "Whatever the Keeper guarded - it was never the shrine.",
                "It was this.",
            ],
        },
    };

    const cinematic = {
        active: null,
        // Defaults; overridable per-cinematic config.
        _defaults: { perLine: 3.6, fadeIn: 0.5, fadeOut: 0.5, lineFadeIn: 0.4 },

        isOpen() { return this.active !== null; },

        play(cfg) {
            if (!cfg) return;
            const lines = Array.isArray(cfg) ? cfg : (cfg.lines || []);
            if (lines.length === 0) return;
            this.active = {
                title: cfg.title ?? null,
                lines,
                index: 0,
                lineTimer: 0,
                perLine: cfg.perLine ?? this._defaults.perLine,
                fadeIn: cfg.fadeIn ?? this._defaults.fadeIn,
                fadeOut: cfg.fadeOut ?? this._defaults.fadeOut,
                lineFadeIn: this._defaults.lineFadeIn,
                phase: "in",
                phaseTimer: cfg.fadeIn ?? this._defaults.fadeIn,
            };
        },

        // Tap / key advances to the next line, or ends the
        // cinematic if already on the last one. The very first
        // tap during fade-in skips that fade so the player never
        // waits a second before the story starts.
        advance() {
            if (!this.active) return;
            const a = this.active;
            if (a.phase === "in") {
                a.phase = "hold";
                a.phaseTimer = 0;
                return;
            }
            if (a.phase !== "hold") return;
            a.index++;
            a.lineTimer = 0;
            if (a.index >= a.lines.length) {
                a.phase = "out";
                a.phaseTimer = a.fadeOut;
            }
        },

        close() {
            this.active = null;
        },

        update(dt) {
            if (!this.active) return;
            const a = this.active;
            if (a.phase === "in") {
                a.phaseTimer = Math.max(0, a.phaseTimer - dt);
                if (a.phaseTimer <= 0) a.phase = "hold";
            } else if (a.phase === "hold") {
                a.lineTimer += dt;
                if (a.lineTimer >= a.perLine) this.advance();
            } else if (a.phase === "out") {
                a.phaseTimer = Math.max(0, a.phaseTimer - dt);
                if (a.phaseTimer <= 0) this.close();
            }
        },

        // Alpha of the letterbox / dim layers based on phase.
        _curtainAlpha() {
            const a = this.active;
            if (a.phase === "in")  return 1 - a.phaseTimer / a.fadeIn;
            if (a.phase === "out") return a.phaseTimer / a.fadeOut;
            return 1;
        },

        draw(ctx) {
            if (!this.active) return;
            const a = this.active;
            const alpha = this._curtainAlpha();

            // Full-screen dim sweep
            ctx.save();
            ctx.globalAlpha = alpha * 0.65;
            ctx.fillStyle = "#000";
            ctx.fillRect(0, 0, VIEW_W, VIEW_H);

            // Classic cinematic letterbox - solid black top/bottom
            // bars 15% tall.
            const barH = Math.max(48, Math.round(VIEW_H * 0.15));
            ctx.globalAlpha = alpha;
            ctx.fillStyle = "#000";
            ctx.fillRect(0, 0, VIEW_W, barH);
            ctx.fillRect(0, VIEW_H - barH, VIEW_W, barH);

            // Chapter title sits inside the top bar.
            if (a.title) {
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                drawShadowedText(
                    a.title,
                    VIEW_W / 2, barH / 2,
                    "#ffd166",
                    "bold 14px system-ui, sans-serif"
                );
            }

            // Current line - fades in for the first fraction of its
            // hold window so successive lines feel like cuts.
            if (a.phase !== "out" && a.index < a.lines.length) {
                let lineAlpha = 1;
                if (a.phase === "hold" && a.lineTimer < a.lineFadeIn) {
                    lineAlpha = a.lineTimer / a.lineFadeIn;
                } else if (a.phase === "in") {
                    lineAlpha = 0;
                }
                ctx.globalAlpha = alpha * lineAlpha;

                const maxW = Math.min(640, VIEW_W - 48);
                const font = "18px system-ui, sans-serif";
                const wrapped = wrapText(a.lines[a.index], maxW, font);
                const lineH = 26;
                let ly = VIEW_H / 2 - ((wrapped.length - 1) * lineH) / 2;
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                for (const ln of wrapped) {
                    drawShadowedText(
                        ln,
                        VIEW_W / 2, ly,
                        "#e8e8f0",
                        font
                    );
                    ly += lineH;
                }
            }

            // "tap / any key" prompt only after the line has settled
            // so it doesn't compete with the fade-in.
            if (a.phase === "hold" && a.lineTimer > 0.9) {
                const pulse = 0.55 + 0.45 *
                    Math.abs(Math.sin(performance.now() * 0.003));
                ctx.globalAlpha = alpha * pulse * 0.7;
                const label = a.index < a.lines.length - 1
                    ? "Tap / any key to continue"
                    : "Tap / any key to close";
                drawShadowedText(
                    label,
                    VIEW_W / 2, VIEW_H - barH / 2,
                    "#a0a0b8",
                    "bold 11px system-ui, sans-serif"
                );
            }

            ctx.restore();
        },

        reset() { this.active = null; },
    };

    // ---------------------------------------------------------------
    // Scripted dialogue box
    //
    // Bottom-of-screen dialogue panel with a typewriter effect,
    // speaker name, and tap/key-to-continue. Distinct from the
    // menu-driven dialogue system: no options, no open-ended
    // input, just lines that advance on input and close on the
    // last one.
    //
    // Used for:
    //   - opening intro (played once per session on startGame)
    //   - first Elder encounter (played once, before the menu)
    //   - mission briefs (played once per quest, before accept)
    //
    // Priority: highest modal (even above cinematic), since these
    // are always short and directly solicit player input. ESC skips
    // the entire sequence in one tap, firing onDone so the followup
    // flow still runs.
    // ---------------------------------------------------------------
    const scriptedDialogue = {
        active: null,
        charsPerSec: 42,

        isOpen() { return this.active !== null; },

        play(lines, onDone = null) {
            if (!lines || !lines.length) {
                if (onDone) onDone();
                return;
            }
            this.active = { lines, index: 0, charsShown: 0, onDone };
        },

        // Called by any advance input (tap / key other than ESC):
        //   - Mid-typewriter -> finish the current line instantly.
        //   - Line complete  -> move to next line, or close + fire
        //                       onDone if we were on the last line.
        advance() {
            if (!this.active) return;
            const a = this.active;
            const line = a.lines[a.index];
            const full = line.text.length;
            if (Math.floor(a.charsShown) < full) {
                a.charsShown = full;
                return;
            }
            a.index++;
            a.charsShown = 0;
            if (a.index >= a.lines.length) this._finish();
        },

        // ESC skips the whole sequence in one press.
        skip() { if (this.active) this._finish(); },

        _finish() {
            const onDone = this.active.onDone;
            this.active = null;
            if (onDone) onDone();
        },

        update(dt) {
            if (!this.active) return;
            const a = this.active;
            const line = a.lines[a.index];
            if (!line) return;
            if (a.charsShown < line.text.length) {
                a.charsShown = Math.min(
                    line.text.length,
                    a.charsShown + this.charsPerSec * dt
                );
            }
        },

        draw(ctx) {
            if (!this.active) return;
            const a = this.active;
            const line = a.lines[a.index];
            if (!line) return;

            const boxW = Math.min(640, VIEW_W - 32);
            const boxH = line.speaker ? 150 : 130;
            const x = Math.floor((VIEW_W - boxW) / 2);
            const y = VIEW_H - boxH - 18;

            // Full-screen dim so world reads as "story mode".
            ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
            ctx.fillRect(0, 0, VIEW_W, VIEW_H);

            // Panel
            ctx.save();
            roundRectPath(ctx, x, y, boxW, boxH, 10);
            ctx.fillStyle = "rgba(14, 14, 22, 0.94)";
            ctx.fill();
            ctx.strokeStyle = "rgba(255, 209, 102, 0.55)";
            ctx.lineWidth = 2;
            ctx.stroke();

            // Speaker name banner
            let textTop = y + 16;
            if (line.speaker) {
                ctx.textBaseline = "top";
                ctx.textAlign = "left";
                drawShadowedText(line.speaker, x + 18, y + 12,
                    "#ffd166",
                    "bold 16px system-ui, sans-serif");
                ctx.strokeStyle = "rgba(255, 209, 102, 0.28)";
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(x + 16, y + 36);
                ctx.lineTo(x + boxW - 16, y + 36);
                ctx.stroke();
                textTop = y + 46;
            }

            // Typewriter body - wrapped in-place as chars arrive.
            const full = line.text.length;
            const shown = Math.floor(a.charsShown);
            const displayed = line.text.substring(0, shown);
            const wrapped = wrapText(displayed, boxW - 36,
                "15px system-ui, sans-serif");
            let ly = textTop;
            for (const w of wrapped) {
                drawShadowedText(w, x + 18, ly, "#e8e8f0",
                    "15px system-ui, sans-serif");
                ly += 22;
            }

            // Continue prompt once typing completes. Pulses so it
            // reads as the live advance target.
            const hintY = y + boxH - 10;
            if (shown >= full) {
                const pulse = 0.55 + 0.45 *
                    Math.abs(Math.sin(performance.now() * 0.004));
                ctx.globalAlpha = pulse;
                ctx.textAlign = "right";
                ctx.textBaseline = "bottom";
                const lastLine = a.index === a.lines.length - 1;
                drawShadowedText(
                    lastLine
                        ? "Tap or press any key to begin"
                        : "Tap or press any key to continue",
                    x + boxW - 14, hintY,
                    "#ffd166",
                    "bold 11px system-ui, sans-serif"
                );
                ctx.globalAlpha = 1;
            }
            // Skip hint always visible in the bottom-left.
            ctx.textAlign = "left";
            ctx.textBaseline = "bottom";
            ctx.globalAlpha = 0.7;
            drawShadowedText("ESC / BACK to skip",
                x + 14, hintY, "#a0a0b8",
                "11px system-ui, sans-serif");
            ctx.globalAlpha = 1;

            ctx.restore();
        },

        reset() { this.active = null; },
    };

    // Large center-screen "New Mission: ..." banner for mission
    // handoffs. Purely a toast with extra weight - no input gate.
    const newMissionBanner = {
        text: "",
        timer: 0,
        duration: 3.2,

        show(name) {
            this.text = name;
            this.timer = this.duration;
        },

        update(dt) {
            if (this.timer > 0) this.timer = Math.max(0, this.timer - dt);
        },

        draw(ctx) {
            if (this.timer <= 0) return;
            const t = 1 - this.timer / this.duration;
            // Fade in the first 20%, hold, fade out the last 30%.
            const alpha = t < 0.2
                ? t / 0.2
                : t > 0.7
                    ? 1 - (t - 0.7) / 0.3
                    : 1;

            const w = Math.min(420, VIEW_W - 40);
            const h = 72;
            const x = Math.floor((VIEW_W - w) / 2);
            const y = Math.floor(VIEW_H * 0.28);

            ctx.save();
            ctx.globalAlpha = alpha;
            roundRectPath(ctx, x, y, w, h, 10);
            ctx.fillStyle = "rgba(14, 14, 22, 0.92)";
            ctx.fill();
            ctx.strokeStyle = "rgba(255, 209, 102, 0.7)";
            ctx.lineWidth = 2;
            ctx.stroke();

            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            drawShadowedText("NEW MISSION",
                x + w / 2, y + 22,
                "#ffd166",
                "bold 13px system-ui, sans-serif");
            drawShadowedText(this.text,
                x + w / 2, y + 48,
                "#e8e8f0",
                "bold 16px system-ui, sans-serif");
            ctx.restore();
        },

        reset() { this.text = ""; this.timer = 0; },
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
            title: "Chapter 1 - First Hunt",
            // Written as the Elder's actual voice - the quest IS
            // the story beat. elderInteract wraps this in Elder: "..."
            // and appends the progress counter.
            description:
                "Three beasts have crept up from the caverns. " +
                "Cull them, and the grove can breathe again.",
            kind: "kill",
            target: 3,
            rewardXp: 30,
            rewardScore: 50,
            next: "slay10",
        },
        slay10: {
            id: "slay10",
            title: "Chapter 2 - The Deeper Dark",
            description:
                "Press on into the caverns. Ten more, and I will trust " +
                "you with the Golden Key.",
            kind: "kill",
            target: 10,
            rewardXp: 80,
            rewardScore: 150,
            // Hands over the shrine key on completion - gates the
            // caverns-to-shrine transition behind this quest.
            rewardItem: "gold_key",
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
            // Mission 2: accepting the Elder's first hunt closes the
            // "Accept the brief" beat. No-op if mission 2 isn't current.
            if (id === "slay3") missions.completeById(2);
            // Mission brief: slay3 gets a short scripted explanation
            // so the player sees why they're fighting and what the
            // payoff is. Plays in the elder's voice since they
            // issued the quest.
            if (id === "slay3" && !story.slay3BriefShown) {
                story.slay3BriefShown = true;
                scriptedDialogue.play([
                    { speaker: "Village Elder", text: "There are waves of creatures below..." },
                    { speaker: "Village Elder", text: "Survive them, and you'll earn the key." },
                ]);
            }
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
            if (tmpl.rewardItem) {
                addToInventory(tmpl.rewardItem);
            }
            sound.play("levelUp");
            const itemSuffix = tmpl.rewardItem && ITEMS[tmpl.rewardItem]
                ? `  (+ ${ITEMS[tmpl.rewardItem].name})`
                : "";
            this.showToast(`Quest complete: ${tmpl.title}!${itemSuffix}`);
            this.active = null;

            // Story beats driven by quest completion. Each quest is
            // a deliberate milestone - finishing one earns the next
            // chapter. If the advance is a real step forward, it
            // will play a cinematic; otherwise story.advance is a
            // no-op, so it's safe to call blindly here.
            if (tmpl.id === "slay3")  story.advance("chapter2");
            if (tmpl.id === "slay10") story.advance("chapter3");
            // Mission sync. completeById's id-must-match-current rule
            // means stale quest events never skip ahead.
            if (tmpl.id === "slay3")  missions.completeById(3);
            if (tmpl.id === "slay10") missions.completeById(4);
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
            // Coins are currency rather than inventory items. Marked
            // `currency: true` so `updateDrops` routes them into
            // `player.coins` on pickup instead of the inventory list.
            currency: true,
            value: 1,
            use(_player) {},
        },
        // Keys are inventory tokens the door system consumes on
        // unlock. `use` is a no-op - keys are spent by walking
        // through a matching locked exit, not from the inventory.
        gold_key: {
            id: "gold_key",
            name: "Golden Key",
            color: "#ffd166",
            isKey: true,
            use(_player) {},
        },
        // Magic orbs - crimson pickups dropped by slain enemies.
        // `magicValue` routes the drop into `player.magic` in
        // updateDrops, mirroring how `currency: true` routes coins
        // into `player.coins`. Keeps the drop pipeline uniform.
        magic_orb: {
            id: "magic_orb",
            name: "Magic Orb",
            color: "#e63946",
            magicValue: 10,
            use(_player) {},
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

    // Active follower NPCs (subset of Npc instances that were
    // recruited into the squad). They live outside any level's npcs
    // list so they move with the player across zones automatically.
    const followers = [];

    // ---------------------------------------------------------------
    // Ambient animals
    //
    // Lightweight "city life" entities that don't interact with
    // combat or NPCs - birds float overhead in slow loops, critters
    // hop around the ground in short bursts. Only spawn in safe
    // zones (grove) so they don't compete with enemy readability in
    // dungeons.
    //
    // Each frame we distance-cull updates to 600px from the player,
    // and view-cull draws to the visible rect. Preallocated pool
    // means zero GC after the initial spawnAll().
    // ---------------------------------------------------------------
    const animals = {
        items: [],
        _updateCullSq: 600 * 600,

        spawnAll() {
            this.items.length = 0;
            if (!currentLevel || !currentLevel.safe) return;

            // 6 birds + 12 small critters = 18 total. Plenty of
            // ambient motion; nothing close to the NPC tick cost.
            const BIRDS = 6, CRITTERS = 12;
            for (let i = 0; i < BIRDS + CRITTERS; i++) {
                const isBird = i < BIRDS;
                this.items.push({
                    kind: isBird ? "bird" : "critter",
                    x: 200 + Math.random() * Math.max(200, WORLD_W - 400),
                    y: 200 + Math.random() * Math.max(200, WORLD_H - 400),
                    vx: 0, vy: 0,
                    phase: Math.random() * Math.PI * 2,
                    timer: Math.random() * 2,
                    hopT: 0,
                    speed: isBird ? 52 + Math.random() * 28
                                  : 30 + Math.random() * 18,
                    size: isBird ? 3 : 4,
                    color: isBird
                        ? (Math.random() < 0.5 ? "#e8e8f0" : "#a0a0b8")
                        : (Math.random() < 0.5 ? "#8c6c3c" : "#6c4a2a"),
                });
            }
        },

        update(dt) {
            if (!this.items.length) return;
            const pcx = player.x + player.width / 2;
            const pcy = player.y + player.height / 2;
            for (const a of this.items) {
                const dx = a.x - pcx;
                const dy = a.y - pcy;
                if (dx * dx + dy * dy > this._updateCullSq) continue;

                if (a.kind === "bird") {
                    // Lazy circular-ish flight. Phase drifts so
                    // loops don't sync to a perfect circle.
                    a.phase += dt * 0.8;
                    a.x += Math.cos(a.phase) * a.speed * dt;
                    a.y += Math.sin(a.phase * 0.7) * a.speed * 0.6 * dt;
                    if (a.x < 80 || a.x > WORLD_W - 80) a.phase += Math.PI;
                    if (a.y < 80 || a.y > WORLD_H - 80) a.phase += Math.PI;
                } else {
                    // Critters hop in random short bursts with
                    // generous pauses between.
                    a.timer -= dt;
                    if (a.timer <= 0) {
                        a.timer = 1.2 + Math.random() * 1.5;
                        a.hopT = 0.3;
                        const ang = Math.random() * Math.PI * 2;
                        a.vx = Math.cos(ang) * a.speed;
                        a.vy = Math.sin(ang) * a.speed * 0.5;
                    }
                    if (a.hopT > 0) {
                        a.hopT = Math.max(0, a.hopT - dt);
                        a.x += a.vx * dt;
                        a.y += a.vy * dt;
                    }
                }
            }
        },

        // View-frustum culled draw. Each entry is ~2 fillRects so
        // the only risk to mobile perf is hundreds on-screen; with
        // 18 total and the cull, we're firmly in the green.
        draw(ctx) {
            if (!this.items.length) return;
            const vx0 = camera.x - 32;
            const vy0 = camera.y - 32;
            const vx1 = camera.x + VIEW_W + 32;
            const vy1 = camera.y + VIEW_H + 32;
            for (const a of this.items) {
                if (a.x < vx0 || a.x > vx1 || a.y < vy0 || a.y > vy1) continue;
                if (a.kind === "bird") {
                    // Tiny V-shape + soft ground shadow below.
                    ctx.fillStyle = a.color;
                    ctx.fillRect(a.x - 3, a.y, 2, 1);
                    ctx.fillRect(a.x + 1, a.y, 2, 1);
                    ctx.fillStyle = "rgba(0, 0, 0, 0.14)";
                    ctx.fillRect(a.x - 2, a.y + 18, 4, 1);
                } else {
                    ctx.fillStyle = a.color;
                    ctx.fillRect(a.x, a.y, a.size, a.size);
                    // Tail pixel for a bit of character.
                    ctx.fillStyle = "rgba(0, 0, 0, 0.28)";
                    ctx.fillRect(a.x + a.size - 1, a.y + a.size, 1, 1);
                }
            }
        },

        reset() { this.items.length = 0; },
    };

    // ---------------------------------------------------------------
    // Creatures of the Light
    //
    // A separate tier of entities that doesn't touch the NPC,
    // follower, or enemy systems:
    //   - spawn rarely on zone entry (city outskirts / hostile
    //     edges). Wild creatures wander slowly and show an "E"
    //     interact bubble when the player gets close.
    //   - Recruitment: interact key next to a wild creature rolls a
    //     success chance (story-boosted). On success the creature
    //     joins player.lightCreatures (capped at 3) and flips into
    //     autonomous combat mode. On fail it slips away.
    //   - Three species with distinct combat kinds:
    //       wolf  - fast melee, targets enemies.
    //       bird  - ranged, fires from distance.
    //       stag  - support, heals nearby followers in an aura.
    //
    // Visuals: a soft additive aura halo + 3 orbiting sparkles per
    // creature, tinted per species (gold / white / cyan). Cheap -
    // <=4 creatures on-screen at a time (1 wild + up to 3 tamed).
    // ---------------------------------------------------------------
    const LIGHT_SPECIES = {
        wolf: {
            id: "wolf",
            name: "Wolf of Light",
            color: "#ffd166",
            auraColor: "rgba(255, 220, 140, 0.38)",
            maxHp: 30, speed: 150,
            engageRange: 260, preferredRange: 22,
            attackRange: 34, attackDamage: 3, attackCooldown: 0.55,
            kind: "melee",
        },
        bird: {
            id: "bird",
            name: "Skylight Bird",
            color: "#ffffff",
            auraColor: "rgba(255, 255, 255, 0.35)",
            maxHp: 16, speed: 140,
            engageRange: 340, preferredRange: 180,
            attackRange: 260, attackDamage: 2, attackCooldown: 0.9,
            kind: "ranged",
        },
        stag: {
            id: "stag",
            name: "Dawn Stag",
            color: "#8ad9ff",
            auraColor: "rgba(138, 217, 255, 0.35)",
            maxHp: 40, speed: 100,
            engageRange: 160, preferredRange: 32,
            attackRange: 0, attackDamage: 0, attackCooldown: 0,
            kind: "support",
            healRate: 5,       // hp/sec restored to followers in aura
            auraRadius: 90,
        },
    };

    // Live creatures in the world. Each entry is a plain object -
    // avoids a class hierarchy since these don't share enough with
    // Enemy / Npc to be worth inheriting.
    const lightCreatures = [];
    // Biome-aware rates per level id. Cities are "sightings at the
    // outskirts" (low), dungeon edges are "reinforcements crossing
    // over" (mid), and the Abyss is a special area - the veil is
    // thin there, so sightings are notably more common.
    const WILD_LIGHT_BIOME_RATE = {
        grove:      0.16,
        port_halen: 0.20,
        emberhold:  0.18,
        caverns:    0.22,
        shrine:     0.24,
        abyss:      0.42,   // special area - sightings feel common
    };
    const WILD_LIGHT_DEFAULT_RATE = 0.15;

    function maybeSpawnWildLightCreature(level) {
        if (!level || level.isInterior) return;
        // One wild creature at a time - skip if there's already a
        // wild one in the world.
        for (const c of lightCreatures) if (c.state === "wild") return;
        const rate = WILD_LIGHT_BIOME_RATE[level.id] ?? WILD_LIGHT_DEFAULT_RATE;
        if (Math.random() > rate) return;

        // Pick a species, slightly weighted by chapter so early runs
        // see more wolves (basic) and late runs see more stags
        // (support).
        const chapterIdx = Math.max(0, story.chapterOrder.indexOf(story.state));
        const r = Math.random();
        let speciesId;
        if (chapterIdx < 2)      speciesId = r < 0.6 ? "wolf" : r < 0.85 ? "bird" : "stag";
        else if (chapterIdx < 4) speciesId = r < 0.4 ? "wolf" : r < 0.75 ? "bird" : "stag";
        else                     speciesId = r < 0.3 ? "wolf" : r < 0.6  ? "bird" : "stag";
        const species = LIGHT_SPECIES[speciesId];

        // Drop into one of the four outskirts with a small random
        // offset so the spawn point feels curated, not grid-snapped.
        const m = 140;
        const edge = Math.floor(Math.random() * 4);
        let x, y;
        if (edge === 0)      { x = m + Math.random() * (WORLD_W - 2*m); y = m; }
        else if (edge === 1) { x = m + Math.random() * (WORLD_W - 2*m); y = WORLD_H - m; }
        else if (edge === 2) { x = m; y = m + Math.random() * (WORLD_H - 2*m); }
        else                 { x = WORLD_W - m; y = m + Math.random() * (WORLD_H - 2*m); }

        lightCreatures.push({
            species,
            x, y,
            width: 28, height: 28,
            hp: species.maxHp, maxHp: species.maxHp,
            state: "wild",      // wild | follow | engage | retreat | flee
            target: null,
            cooldown: 0,
            phase: Math.random() * Math.PI * 2,
            sparklePhase: Math.random() * Math.PI * 2,
            wanderX: x, wanderY: y,
            wanderTimer: 0,
            fleeTimer: 0,
        });
    }

    // Preload a tamed light creature from a save snapshot (species
    // id only; hp is reset). Spawns right next to the player so it
    // doesn't leak across zones.
    function rehireLightCreature(snap) {
        const species = LIGHT_SPECIES[snap.speciesId];
        if (!species) return;
        const pcx = player.x + player.width / 2;
        const pcy = player.y + player.height / 2;
        lightCreatures.push({
            species,
            x: pcx + (Math.random() - 0.5) * 48,
            y: pcy + 40 + Math.random() * 20,
            width: 28, height: 28,
            hp: species.maxHp, maxHp: species.maxHp,
            state: "follow", target: null,
            cooldown: 0,
            phase: Math.random() * Math.PI * 2,
            sparklePhase: Math.random() * Math.PI * 2,
            wanderX: 0, wanderY: 0, wanderTimer: 0, fleeTimer: 0,
        });
    }

    function nearestHostileForLight(c) {
        const cx = c.x + c.width / 2;
        const cy = c.y + c.height / 2;
        const r2 = c.species.engageRange * c.species.engageRange;
        let best = null, bestD = r2;
        for (const e of enemies) {
            if (!e.alive || e.ally || e.neutral) continue;
            const dx = (e.x + e.width / 2) - cx;
            const dy = (e.y + e.height / 2) - cy;
            const d = dx * dx + dy * dy;
            if (d < bestD) { best = e; bestD = d; }
        }
        return best;
    }

    function performLightAttack(c) {
        if (!c.target || !c.target.alive) return;
        const sx = c.x + c.width / 2;
        const sy = c.y + c.height / 2;
        const tcx = c.target.x + c.target.width / 2;
        const tcy = c.target.y + c.target.height / 2;
        if (c.species.kind === "ranged") {
            const dx = tcx - sx, dy = tcy - sy;
            const mag = Math.hypot(dx, dy) || 1;
            projectiles.push({
                x: sx - 5, y: sy - 5, w: 10, h: 10,
                vx: (dx / mag) * 380, vy: (dy / mag) * 380,
                life: 1.0,
                damage: c.species.attackDamage,
                color: c.species.color,
                age: 0, alive: true,
            });
        } else if (c.species.kind === "melee") {
            c.target.takeHit(c.species.attackDamage, { x: sx, y: sy });
            if (!c.target.alive) onEnemyDefeated(c.target);
        }
    }

    function lightCreatureNearPlayer(c, radius = 60) {
        const cx = c.x + c.width / 2;
        const cy = c.y + c.height / 2;
        const px = player.x + player.width / 2;
        const py = player.y + player.height / 2;
        const dx = cx - px, dy = cy - py;
        return dx * dx + dy * dy < radius * radius;
    }

    // Called by the interact key when no NPC / neutral is closer.
    function nearestWildLightCreature() {
        for (const c of lightCreatures) {
            if (c.state === "wild" && lightCreatureNearPlayer(c)) return c;
        }
        return null;
    }

    function reachOutToLightCreature(c) {
        if (!c || c.state !== "wild") return;
        if (player.lightCreatures.length >= player.maxLightCreatures) {
            questLog.showToast(
                "Your light-companions are already at your side.", 2.4
            );
            return;
        }
        // Story-boosted chance: 40% base + 8% per chapter advanced,
        // capped at 80%. Early-game recruits are earned; late-game
        // recruits almost always succeed.
        const chapterIdx = Math.max(0, story.chapterOrder.indexOf(story.state));
        const succ = Math.min(0.8, 0.4 + chapterIdx * 0.08);
        if (Math.random() < succ) {
            c.state = "follow";
            c.hp = c.species.maxHp;
            player.lightCreatures.push({ speciesId: c.species.id });
            questLog.showToast(
                `${c.species.name} accepts your call.`, 2.8
            );
            flash.trigger(0.35, 0.25);
            sound.play("levelUp");
        } else {
            c.state = "flee";
            c.fleeTimer = 0.8;
            questLog.showToast(
                `${c.species.name} slips back into the light.`, 2.0
            );
        }
    }

    function updateLightCreatures(dt) {
        const pcx = player.x + player.width / 2;
        const pcy = player.y + player.height / 2;

        for (let i = lightCreatures.length - 1; i >= 0; i--) {
            const c = lightCreatures[i];
            c.phase += dt * 3;
            c.sparklePhase += dt * 2;
            if (c.cooldown > 0) c.cooldown -= dt;

            // Flee despawn: fail-to-recruit creatures fade away.
            if (c.state === "flee") {
                c.fleeTimer -= dt;
                if (c.fleeTimer <= 0) {
                    lightCreatures.splice(i, 1);
                    continue;
                }
                // Drift away from the player during the fade.
                const dx = c.x - pcx, dy = c.y - pcy;
                const d = Math.hypot(dx, dy) || 1;
                c.x += (dx / d) * 90 * dt;
                c.y += (dy / d) * 90 * dt;
                continue;
            }

            if (c.state === "wild") {
                // Gentle wander near the spawn point.
                c.wanderTimer -= dt;
                if (c.wanderTimer <= 0) {
                    c.wanderTimer = 2 + Math.random() * 2;
                    c.wanderX = c.x + (Math.random() - 0.5) * 60;
                    c.wanderY = c.y + (Math.random() - 0.5) * 60;
                }
                const dx = c.wanderX - c.x;
                const dy = c.wanderY - c.y;
                const dist = Math.hypot(dx, dy);
                if (dist > 2) {
                    const step = Math.min(dist, c.species.speed * 0.3 * dt);
                    c.x += (dx / dist) * step;
                    c.y += (dy / dist) * step;
                }
                continue;
            }

            // --- Tamed states: follow / engage / retreat ----------
            // Retreat if low health.
            const hpFrac = c.hp / c.maxHp;
            if (c.state !== "retreat" && hpFrac < 0.25) {
                c.state = "retreat";
            }
            if (c.state === "retreat") {
                c.hp = Math.min(c.maxHp, c.hp + 12 * dt);
                if (c.hp / c.maxHp >= 0.75) c.state = "follow";
            }

            // Stag support tick: heals nearby followers + player.
            if (c.species.kind === "support" && c.state !== "retreat") {
                const r2 = c.species.auraRadius * c.species.auraRadius;
                const cx = c.x + c.width / 2;
                const cy = c.y + c.height / 2;
                const heal = c.species.healRate * dt;
                for (const f of followers) {
                    if (f.hp <= 0 || f.hp >= f.maxHp) continue;
                    const dx = (f.x + f.width / 2) - cx;
                    const dy = (f.y + f.height / 2) - cy;
                    if (dx * dx + dy * dy < r2) {
                        f.hp = Math.min(f.maxHp, f.hp + heal);
                    }
                }
                // Small player regen too (slower so it's flavor, not
                // a replacement for potions).
                if (player.hp < player.maxHp) {
                    const dx = pcx - cx, dy = pcy - cy;
                    if (dx * dx + dy * dy < r2) {
                        player.hp = Math.min(
                            player.maxHp, player.hp + heal * 0.5
                        );
                    }
                }
            }

            // Target selection for melee/ranged combat species.
            if (c.state !== "retreat" && c.species.kind !== "support") {
                if (!c.target || !c.target.alive) {
                    c.target = nearestHostileForLight(c);
                }
                c.state = c.target ? "engage" : "follow";
            } else if (c.state !== "retreat") {
                // Stag always follows unless retreating.
                c.state = "follow";
            }

            let moving = false;
            if (c.state === "engage" && c.target) {
                const tcx = c.target.x + c.target.width / 2;
                const tcy = c.target.y + c.target.height / 2;
                const cx = c.x + c.width / 2;
                const cy = c.y + c.height / 2;
                const dx = tcx - cx, dy = tcy - cy;
                const dist = Math.hypot(dx, dy) || 1;
                const pref = c.species.preferredRange;
                const DEAD = 6;
                if (dist - pref > DEAD) {
                    const step = Math.min(dist - pref, c.species.speed * dt);
                    c.x += (dx / dist) * step;
                    c.y += (dy / dist) * step;
                    moving = true;
                } else if (pref - dist > DEAD) {
                    const step = Math.min(pref - dist, c.species.speed * dt);
                    c.x -= (dx / dist) * step;
                    c.y -= (dy / dist) * step;
                    moving = true;
                }
                if (dist <= c.species.attackRange && c.cooldown <= 0) {
                    performLightAttack(c);
                    c.cooldown = c.species.attackCooldown;
                }
            } else {
                // Follow: drift behind the player with per-creature
                // slot offset so multiple creatures don't stack.
                // When no enemies are nearby the creature also adds
                // a small roam offset per-phase so the "resting"
                // formation doesn't look rigid - they circle the
                // player instead of locking to a grid slot.
                const slotIdx = lightCreatures.indexOf(c);
                const offX = -40 + (slotIdx * 28);
                const offY = -34 + (slotIdx % 2) * 8;
                const hasEnemy = !!nearestHostileForLight(c);
                const roamX = hasEnemy ? 0 : Math.cos(c.phase * 0.7) * 14;
                const roamY = hasEnemy ? 0 : Math.sin(c.phase * 0.5) * 8;
                const tx = pcx + offX + roamX;
                const ty = pcy + offY + roamY;
                const dx = tx - (c.x + c.width / 2);
                const dy = ty - (c.y + c.height / 2);
                const dist = Math.hypot(dx, dy);
                if (dist > 10) {
                    const step = Math.min(dist, c.species.speed * 0.55 * dt);
                    c.x += (dx / dist) * step;
                    c.y += (dy / dist) * step;
                    moving = true;
                }
            }
            c._moving = moving;
        }
    }

    function drawLightCreatures(ctx) {
        if (lightCreatures.length === 0) return;
        for (const c of lightCreatures) {
            const cx = c.x + c.width / 2;
            const cy = c.y + c.height / 2;

            // Additive aura - tinted by species, pulses with phase.
            // Wild creatures get a bigger, slower pulse + an outer
            // shimmer ring so they read as clearly "ethereal", not
            // just another combatant.
            const isWild = c.state === "wild";
            const pulse = 0.7 + 0.3 * Math.sin(c.phase);
            ctx.save();
            ctx.globalCompositeOperation = "lighter";
            if (isWild) {
                // Outer shimmer - wider, slower. Only on wild state.
                ctx.globalAlpha = 0.25 * pulse;
                ctx.fillStyle = c.species.auraColor;
                ctx.beginPath();
                ctx.arc(cx, cy, 32 + Math.sin(c.phase * 0.6) * 3, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.globalAlpha = (isWild ? 0.55 : 0.45) * pulse;
            ctx.fillStyle = c.species.auraColor;
            ctx.beginPath();
            ctx.arc(cx, cy, isWild ? 24 : 22, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();

            // Body - filled circle in species color.
            ctx.fillStyle = c.species.color;
            ctx.beginPath();
            ctx.arc(cx, cy, 8, 0, Math.PI * 2);
            ctx.fill();

            // Species silhouette over the body.
            if (c.species.id === "wolf") {
                // Triangle ears + snout
                ctx.fillRect(cx - 7, cy - 10, 2, 4);
                ctx.fillRect(cx + 5, cy - 10, 2, 4);
                ctx.fillStyle = "#1a1a24";
                ctx.fillRect(cx - 1, cy + 1, 2, 2);
            } else if (c.species.id === "bird") {
                // Wing beats on animated bob.
                const wing = Math.floor(Math.sin(c.phase * 5) * 2);
                ctx.fillRect(cx - 11, cy - 1 + wing, 5, 2);
                ctx.fillRect(cx + 6,  cy - 1 + wing, 5, 2);
                ctx.fillStyle = "#1a1a24";
                ctx.fillRect(cx - 1, cy - 1, 2, 2);
            } else if (c.species.id === "stag") {
                // Antlers
                ctx.fillRect(cx - 5, cy - 12, 1, 5);
                ctx.fillRect(cx - 7, cy - 10, 2, 2);
                ctx.fillRect(cx + 4, cy - 12, 1, 5);
                ctx.fillRect(cx + 6, cy - 10, 2, 2);
            }

            // Orbiting sparkles. 3 small specks at staggered angles
            // so the creature reads as radiating softly.
            ctx.globalAlpha = 1;
            for (let j = 0; j < 3; j++) {
                const ang = c.sparklePhase + (j / 3) * Math.PI * 2;
                const r = 16 + Math.sin(c.sparklePhase * 2 + j) * 3;
                const sx = cx + Math.cos(ang) * r;
                const sy = cy + Math.sin(ang) * r * 0.6;
                const a = 0.5 + 0.5 * Math.sin(c.sparklePhase * 2 + j);
                ctx.globalAlpha = a * 0.7;
                ctx.fillStyle = c.species.color;
                ctx.fillRect(Math.round(sx), Math.round(sy), 2, 2);
            }
            ctx.globalAlpha = 1;

            // "Reach out" bubble on wild creatures near the player.
            if (c.state === "wild" && lightCreatureNearPlayer(c)) {
                const bx = cx, by = cy - 22;
                ctx.save();
                ctx.fillStyle = "#1a1a24";
                ctx.beginPath();
                ctx.arc(bx, by, 11, 0, Math.PI * 2);
                ctx.fill();
                ctx.strokeStyle = c.species.color;
                ctx.lineWidth = 1.5;
                ctx.stroke();
                ctx.fillStyle = c.species.color;
                ctx.font = "bold 12px system-ui, sans-serif";
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillText("E", bx, by + 1);
                ctx.restore();
            }

            // Tiny HP pip for tamed creatures that have taken damage.
            if (c.state !== "wild" && c.hp < c.maxHp) {
                const barW = 20, barH = 2;
                ctx.fillStyle = "#1a1a24";
                ctx.fillRect(cx - barW / 2, cy - 14, barW, barH);
                ctx.fillStyle = c.species.color;
                ctx.fillRect(
                    cx - barW / 2, cy - 14,
                    barW * Math.max(0, c.hp / c.maxHp), barH
                );
            }
        }
    }

    function resetLightCreatures() {
        lightCreatures.length = 0;
    }

    // ---------------------------------------------------------------
    // Squad roles
    //
    // Each recruited NPC carries a `squadRole` id keyed into this
    // catalog. The role drives:
    //   maxHp              starting / max health
    //   moveSpeed          engage-state travel speed
    //   engageRange        detect enemies within this radius
    //   preferredRange     desired distance from target in engage
    //   attackRange        must be within this to actually hit
    //   attackDamage       per-swing / per-shot
    //   attackCooldown     seconds between attacks
    //   retreatThreshold   hp-frac below which follower retreats
    //   recoverThreshold   hp-frac above which retreat ends
    //   regenPerSec        hp/sec while retreating
    //   kind               "melee" | "ranged" | "tank" - attack style
    //   drawsAggro         true for tanks; enemies near them swap
    //                      their target from the player to the tank
    //   accentColor        HP bar fill + ranged projectile tint
    //
    // Adding a new role is one entry in this catalog plus a new
    // branch in `performFollowerAttack` (or a shared kind).
    // ---------------------------------------------------------------
    const SQUAD_ROLES = {
        melee: {
            id: "melee",
            name: "Melee Warrior",
            maxHp: 45,
            moveSpeed: 72,
            engageRange: 260,
            preferredRange: 24,
            attackRange: 32,
            attackDamage: 2,
            attackCooldown: 0.70,
            retreatThreshold: 0.30,
            recoverThreshold: 0.70,
            regenPerSec: 10,
            kind: "melee",
            accentColor: "#ffd166",
        },
        ranged: {
            id: "ranged",
            name: "Ranged Fighter",
            maxHp: 28,
            moveSpeed: 62,
            engageRange: 340,
            preferredRange: 180,
            attackRange: 240,
            attackDamage: 2,
            attackCooldown: 1.10,
            retreatThreshold: 0.30,
            recoverThreshold: 0.65,
            regenPerSec: 12,
            kind: "ranged",
            projectileSpeed: 380,
            accentColor: "#8ad9ff",
        },
        tank: {
            id: "tank",
            name: "Tank",
            maxHp: 90,
            moveSpeed: 52,
            engageRange: 240,
            preferredRange: 20,
            attackRange: 36,
            attackDamage: 1,
            attackCooldown: 1.30,
            retreatThreshold: 0.18,
            recoverThreshold: 0.45,
            regenPerSec: 8,
            kind: "tank",
            drawsAggro: true,
            accentColor: "#c96565",
        },
    };

    // Fixed formation offsets relative to the player's center.
    // Ordered so the first slot fills directly behind-left, the next
    // behind-right, and so on - a small arc that keeps the line of
    // sight in front of the player mostly clear.
    const FOLLOW_SLOTS = [
        { dx: -36, dy:  32 },
        { dx:  36, dy:  32 },
        { dx: -52, dy:   0 },
        { dx:  52, dy:   0 },
        { dx: -36, dy: -32 },
        { dx:  36, dy: -32 },
        { dx:   0, dy:  56 },
    ];

    const FOLLOW_IDLE_RADIUS = 6;     // within this, follower idles
    const FOLLOW_SEPARATION  = 26;    // below this, followers repel
    const FOLLOW_MAX_SPEED_X = 2.2;   // speed multiplier cap when far

    // Short window between any two squad attacks. Prevents multiple
    // followers from resolving a strike on the exact same tick, which
    // reads as a single chaotic burst rather than a coordinated squad.
    // Hit at >10 attacks/s across the whole squad cap of 6; feels busy
    // but readable.
    let _squadBeatTimer = 0;
    const SQUAD_BEAT_INTERVAL = 0.08;

    // Squad attack VFX pool. Each entry is a short-lived world-space
    // marker: an expanding ring for melee impact or a brief muzzle
    // flash for ranged shots. The array is appended / spliced in
    // place, so a frame of combat with 6 followers tops out at ~6
    // entries - trivial for mobile.
    const squadFx = [];
    function spawnSquadFx(x, y, kind, color) {
        squadFx.push({
            x, y, kind,
            color: color || "#ffffff",
            timer: 0.18,
            duration: 0.18,
        });
    }
    function updateSquadFx(dt) {
        for (let i = squadFx.length - 1; i >= 0; i--) {
            const fx = squadFx[i];
            fx.timer -= dt;
            if (fx.timer <= 0) squadFx.splice(i, 1);
        }
    }
    function drawSquadFx(ctx) {
        for (const fx of squadFx) {
            const t = 1 - fx.timer / fx.duration;  // 0..1 progress
            ctx.save();
            if (fx.kind === "slash") {
                // Expanding ring around the impact point.
                const r = 6 + t * 18;
                ctx.globalAlpha = (1 - t) * 0.9;
                ctx.strokeStyle = fx.color;
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.arc(fx.x, fx.y, r, 0, Math.PI * 2);
                ctx.stroke();
            } else {
                // Muzzle flash - quick shrinking dot at the follower's
                // firing point; reads as "something was shot from here".
                const r = Math.max(1, 6 - t * 5);
                ctx.globalAlpha = (1 - t) * 0.9;
                ctx.fillStyle = fx.color;
                ctx.beginPath();
                ctx.arc(fx.x, fx.y, r, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.restore();
        }
    }

    // Remove a Npc instance from whichever level's npcs array it
    // currently lives in. Returns the level id it was plucked from,
    // or null if it wasn't found anywhere. Recorded on the NPC as
    // `homeLevelId` so dismiss can put it back later.
    function removeNpcFromLevel(npc) {
        for (const levelId in LEVELS) {
            const list = LEVELS[levelId].npcs;
            if (!list) continue;
            const idx = list.indexOf(npc);
            if (idx !== -1) {
                list.splice(idx, 1);
                return levelId;
            }
        }
        return null;
    }

    // Pick the nearest live enemy within this follower's engageRange.
    // Returns null in safe zones or if nothing is close enough.
    function pickFollowerTarget(f) {
        if (isSafeZone()) return null;
        const fcx = f.x + f.width / 2;
        const fcy = f.y + f.height / 2;
        const r2 = f.roleCfg.engageRange * f.roleCfg.engageRange;
        let best = null;
        let bestD = r2;
        for (const e of enemies) {
            if (!e.alive) continue;
            const dx = (e.x + e.width / 2) - fcx;
            const dy = (e.y + e.height / 2) - fcy;
            const d = dx * dx + dy * dy;
            if (d < bestD) { best = e; bestD = d; }
        }
        return best;
    }

    // Fire a follower's attack. Melee / tank hit the target directly;
    // ranged spawns a projectile with the follower's accent color into
    // the shared projectiles array (same collision pipeline as the
    // player's energy weapon).
    function performFollowerAttack(f) {
        if (!f.target || !f.target.alive) return;
        const role = f.roleCfg;
        const fcx = f.x + f.width / 2;
        const fcy = f.y + f.height / 2;
        const tcx = f.target.x + f.target.width / 2;
        const tcy = f.target.y + f.target.height / 2;
        f.attackFlashTimer = 0.12;
        // Tiny shake on every squad swing - just enough to register
        // impact without muddying up real threats. Clamps via the
        // shake module's existing peak-preserve rule.
        shake.trigger(role.kind === "ranged" ? 2 : 3, 0.08);

        if (role.kind === "ranged") {
            const dx = tcx - fcx;
            const dy = tcy - fcy;
            const mag = Math.hypot(dx, dy) || 1;
            const speed = role.projectileSpeed;
            projectiles.push({
                x: fcx - 5, y: fcy - 5,
                w: 10, h: 10,
                vx: (dx / mag) * speed,
                vy: (dy / mag) * speed,
                life: 1.1,
                damage: role.attackDamage,
                color: role.accentColor,
                age: 0,
                alive: true,
            });
            // Muzzle flash at the firing point, tinted with the
            // role's accent color so shots are visually tagged to
            // their shooter.
            spawnSquadFx(fcx, fcy, "muzzle", role.accentColor);
            return;
        }

        // Melee / tank: single-target hit with the target's existing
        // hit-flash + knockback. Counts as a clean defeat like any
        // other damage source. Spawn an expanding slash ring at the
        // impact point so the player sees WHICH enemy got hit by a
        // squadmate - critical when multiple followers are engaged.
        f.target.takeHit(role.attackDamage, { x: fcx, y: fcy });
        spawnSquadFx(tcx, tcy, "slash", role.accentColor);
        if (!f.target.alive) onEnemyDefeated(f.target);
    }

    // Damage a follower. Mirrors the player damage chokepoint:
    // iframes gate repeated hits, hp floors at 0 (non-lethal - a
    // downed follower stays put and regenerates during retreat).
    function damageFollower(f, amount) {
        if (f.iframes > 0) return;
        f.hp = Math.max(0, f.hp - amount);
        f.iframes = 0.55;
        // Always retreat after a hit that crosses the threshold.
        if (f.hp / f.maxHp <= f.roleCfg.retreatThreshold) {
            f.fightState = "retreat";
            f.target = null;
        }
        sound.play("playerHurt");
    }

    // Advances every active follower. Kept separate from updateNpcs
    // so followers can run in every zone (including hostile ones)
    // without interfering with zone-local NPC routines.
    //
    // Each follower runs a tiny state machine:
    //   follow  - no target, trail the player in formation.
    //   engage  - hold to the role's preferredRange, attack on cd.
    //   retreat - hp below retreatThreshold: pull to formation,
    //             regen passively until recoverThreshold restores.
    // Zone + combat-aware music pick. Safe zones always play city.
    // In hostile zones, an enemy within COMBAT_DETECT_PX of the
    // player promotes "dungeon" to "combat"; otherwise dungeon.
    // Checked every 0.75s so short-lived flips (a single enemy
    // dropping in / out of range for one frame) don't thrash.
    let _musicPickTimer = 0;
    function desiredMusic() {
        if (isSafeZone()) return "city";
        const COMBAT_DETECT_PX = 300;
        const r2 = COMBAT_DETECT_PX * COMBAT_DETECT_PX;
        const pcx = player.x + player.width / 2;
        const pcy = player.y + player.height / 2;
        for (const e of enemies) {
            if (!e.alive) continue;
            const dx = (e.x + e.width / 2) - pcx;
            const dy = (e.y + e.height / 2) - pcy;
            if (dx * dx + dy * dy < r2) return "combat";
        }
        return "dungeon";
    }
    function updateMusicState(dt) {
        _musicPickTimer -= dt;
        if (_musicPickTimer > 0) return;
        _musicPickTimer = 0.75;
        music.playMusic(desiredMusic());
    }
    // Force a zone-entry fade on transition so the track matches
    // the new level without waiting up to 0.75s for the picker.
    function kickMusicForZone() {
        _musicPickTimer = 0;
    }

    function updateFollowers(dt) {
        const pcx = player.x + player.width / 2;
        const pcy = player.y + player.height / 2;
        const hostile = !isSafeZone();

        // Tick the shared beat + the VFX pool alongside per-follower
        // timers so combat effects decay even if no one is engaging.
        if (_squadBeatTimer > 0) {
            _squadBeatTimer = Math.max(0, _squadBeatTimer - dt);
        }
        updateSquadFx(dt);

        for (let i = 0; i < followers.length; i++) {
            const f = followers[i];
            const role = f.roleCfg;
            f.age += dt;
            if (f.iframes > 0) f.iframes = Math.max(0, f.iframes - dt);
            if (f.attackCooldownTimer > 0)
                f.attackCooldownTimer = Math.max(0, f.attackCooldownTimer - dt);
            if (f.attackFlashTimer > 0)
                f.attackFlashTimer = Math.max(0, f.attackFlashTimer - dt);

            // State machine: retreat has priority. Regenerate while
            // retreating; once healed above recoverThreshold, drop
            // back to follow.
            if (f.fightState === "retreat") {
                f.hp = Math.min(f.maxHp, f.hp + role.regenPerSec * dt);
                if (f.hp / f.maxHp >= role.recoverThreshold) {
                    f.fightState = "follow";
                }
            } else if (f.hp / f.maxHp <= role.retreatThreshold) {
                f.fightState = "retreat";
                f.target = null;
            } else if (hostile) {
                // Pick / keep a target. Drop one that's run way
                // outside engage range so followers don't chase
                // across the whole map.
                if (f.target && !f.target.alive) f.target = null;
                if (f.target) {
                    const tcx = f.target.x + f.target.width / 2;
                    const tcy = f.target.y + f.target.height / 2;
                    const dx = tcx - (f.x + f.width / 2);
                    const dy = tcy - (f.y + f.height / 2);
                    const leash2 = role.engageRange * role.engageRange * 2.5;
                    if (dx * dx + dy * dy > leash2) f.target = null;
                }
                if (!f.target) f.target = pickFollowerTarget(f);
                f.fightState = f.target ? "engage" : "follow";
            } else {
                f.fightState = "follow";
                f.target = null;
            }

            const slot = FOLLOW_SLOTS[i % FOLLOW_SLOTS.length];
            let moving = false;
            let faceDir = null;

            if (f.fightState === "engage" && f.target) {
                // Hold preferred distance: approach if too far, back
                // off if too close (ranged). Dead zone keeps the
                // sprite from jitter-stepping at exactly the radius.
                const tcx = f.target.x + f.target.width / 2;
                const tcy = f.target.y + f.target.height / 2;
                const fcx = f.x + f.width / 2;
                const fcy = f.y + f.height / 2;
                const tdx = tcx - fcx;
                const tdy = tcy - fcy;
                const tdist = Math.hypot(tdx, tdy) || 1;
                const delta = tdist - role.preferredRange;
                const DEAD_ZONE = 5;
                if (Math.abs(delta) > DEAD_ZONE) {
                    const sign = delta > 0 ? 1 : -1;
                    const step = Math.min(Math.abs(delta),
                        role.moveSpeed * dt);
                    const inv = 1 / tdist;
                    f.x += tdx * inv * step * sign;
                    f.y += tdy * inv * step * sign;
                    moving = true;
                }
                faceDir = dirFromVector(tdx, tdy);

                // Beat gate: if another follower already fired this
                // tiny window, hold the swing for a few frames so
                // strikes space out instead of stacking on one beat.
                if (tdist <= role.attackRange &&
                    f.attackCooldownTimer <= 0 &&
                    _squadBeatTimer <= 0) {
                    performFollowerAttack(f);
                    f.attackCooldownTimer = role.attackCooldown;
                    _squadBeatTimer = SQUAD_BEAT_INTERVAL;
                }
            } else {
                // follow or retreat: head to the formation slot.
                const tx = pcx + slot.dx - f.width / 2;
                const ty = pcy + slot.dy - f.height / 2;
                const dx = tx - f.x;
                const dy = ty - f.y;
                const dist = Math.hypot(dx, dy);
                if (dist > FOLLOW_IDLE_RADIUS) {
                    const catchup = Math.min(FOLLOW_MAX_SPEED_X,
                        1 + dist / 80);
                    const step = Math.min(dist, f.speed * catchup * dt);
                    const inv = 1 / dist;
                    f.x += dx * inv * step;
                    f.y += dy * inv * step;
                    moving = true;
                    faceDir = dirFromVector(dx, dy);
                }
            }

            if (f.animator) {
                f.animator.setState(moving ? "walk" : "idle");
                if (faceDir !== null) f.animator.setDir(faceDir);
                f.animator.update(dt);
            }
        }

        // Pairwise separation - push followers apart when they
        // overlap. Tiny O(n^2) that saturates at <50 ops for the
        // max squad of 7; fine for mobile.
        for (let i = 0; i < followers.length; i++) {
            const a = followers[i];
            for (let j = i + 1; j < followers.length; j++) {
                const b = followers[j];
                const dx = (b.x + b.width / 2) - (a.x + a.width / 2);
                const dy = (b.y + b.height / 2) - (a.y + a.height / 2);
                const d = Math.hypot(dx, dy);
                if (d > FOLLOW_SEPARATION || d === 0) continue;
                const push = (FOLLOW_SEPARATION - d) * 0.5;
                const ix = (dx / d) * push;
                const iy = (dy / d) * push;
                a.x -= ix; a.y -= iy;
                b.x += ix; b.y += iy;
            }
        }
    }

    // Enemy target resolution: a tank follower within aggroRange
    // supersedes the player. This is how "tank draws attention"
    // lands without rewriting the enemy AI - they still chase a
    // single target, just a different one.
    function enemyTarget(enemy) {
        const ecx = enemy.x + enemy.width / 2;
        const ecy = enemy.y + enemy.height / 2;
        const AGGRO_RADIUS_SQ = 180 * 180;
        let best = null;
        let bestD = AGGRO_RADIUS_SQ;
        for (const f of followers) {
            if (!f.roleCfg || !f.roleCfg.drawsAggro) continue;
            if (f.hp <= 0) continue;
            const dx = (f.x + f.width / 2) - ecx;
            const dy = (f.y + f.height / 2) - ecy;
            const d = dx * dx + dy * dy;
            if (d < bestD) { best = f; bestD = d; }
        }
        return best || player;
    }

    // Snap every follower onto a formation slot near the player.
    // Called after zone transitions and save loads so the squad
    // doesn't visibly stream in from the old room.
    function snapFollowersToPlayer() {
        const pcx = player.x + player.width / 2;
        const pcy = player.y + player.height / 2;
        for (let i = 0; i < followers.length; i++) {
            const f = followers[i];
            const slot = FOLLOW_SLOTS[i % FOLLOW_SLOTS.length];
            f.x = pcx + slot.dx - f.width / 2;
            f.y = pcy + slot.dy - f.height / 2;
        }
    }

    // Called from every kill path (sword, energy projectile, power
    // move) so score, drops, quest progress, and boss defeat all
    // fire together. Keeping it in one function means future death
    // hooks (combo counter, on-kill heals) go in a single spot.
    function onEnemyDefeated(enemy) {
        stats.addKill(enemy);
        rollEnemyDrop(enemy);
        corruption.onKill();
        noteKillTimestamp();
        spawner.onEnemyDefeated(enemy);
        // Crown energy drips in from every kill - a full 100-kill
        // pool, so around 20 kills fills Crown Mode at baseline.
        // Boss kills push the crown harder as a reward beat.
        crown.add(enemy && enemy.isBoss ? 40 : 5);
        if (enemy.isBoss && enemy.levelId) {
            defeatedBosses.add(enemy.levelId);
            questLog.showToast(`${enemy.name} defeated!`, 2.6);
            sound.play("levelUp");
            // Victory chapter - the Shrine Keeper's fall closes the
            // main campaign beat.
            story.advance("chapter5");
            // Mission 6: Shrine Keeper falls.
            if (enemy.levelId === "shrine") missions.completeById(6);
            // Shrine specifically unlocks the Abyss. A second toast
            // queues after the defeat banner so the player knows a
            // new path just opened behind them.
            if (enemy.levelId === "shrine") {
                setTimeout(() => {
                    questLog.showToast(
                        "A seam in the east wall grinds open. Something deeper stirs.",
                        3.2
                    );
                }, 2800);
            }
        }
    }

    // Rolls on enemy death. Tunable drop table in one place.
    function rollEnemyDrop(enemy) {
        const cx = enemy.x + enemy.width / 2;
        const cy = enemy.y + enemy.height / 2;

        // Bosses always leave a purse plus a potion and a pair of
        // magic orbs - a big reward for the long fight. Coins arc
        // out in a short circle so pickup feels like a burst.
        if (enemy.isBoss) {
            spawnDrop(cx, cy - 20, "potion");
            spawnDrop(cx - 18, cy - 20, "magic_orb");
            spawnDrop(cx + 18, cy - 20, "magic_orb");
            const coinCount = 8;
            for (let i = 0; i < coinCount; i++) {
                const angle = (i / coinCount) * Math.PI * 2;
                const r = 26 + Math.random() * 14;
                spawnDrop(
                    cx + Math.cos(angle) * r,
                    cy + Math.sin(angle) * r,
                    "coin"
                );
            }
            return;
        }

        // Regular enemy table:
        //   20% potion, 40% one coin, 15% two coins, 15% magic orb,
        //   10% nothing.
        const r = Math.random();
        if (r < 0.20) {
            spawnDrop(cx, cy, "potion");
        } else if (r < 0.60) {
            spawnDrop(cx, cy, "coin");
        } else if (r < 0.75) {
            spawnDrop(cx - 8, cy, "coin");
            spawnDrop(cx + 8, cy, "coin");
        } else if (r < 0.90) {
            spawnDrop(cx, cy, "magic_orb");
        }
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
                const tmpl = ITEMS[d.itemId];
                if (tmpl && tmpl.currency) {
                    // Currency drop - goes into the purse, not the
                    // inventory. `value` defaults to 1 when unset.
                    player.coins += tmpl.value ?? 1;
                    sound.play("coin");
                    tutorial.onPickup();
                } else if (tmpl && tmpl.magicValue) {
                    // Magic orb - refills the magic meter up to cap.
                    // Bypasses the inventory entirely so picking up
                    // at full magic simply fizzles (no wasted slot).
                    player.magic = Math.min(
                        player.maxMagic,
                        player.magic + tmpl.magicValue
                    );
                    sound.play("coin");
                    tutorial.onPickup();
                    // Orbs charge the crown too - small add so the
                    // primary feeder is still kills.
                    crown.add(4);
                } else {
                    addToInventory(d.itemId);
                }
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

    // Pause flag. When true, update() short-circuits before ticking
    // any gameplay subsystem, so the world visibly freezes. draw()
    // keeps running so the overlay renders; the last frame stays
    // visible behind it.
    let paused = false;

    // Debug overlay toggle (D key). Surfaces mission progression,
    // story state, active quest, and squad cap so it's easy to
    // spot mission overlap or off-by-one chapter advances during
    // playtests. Off by default; not persisted.
    let debugOverlay = false;

    // ---------------------------------------------------------------
    // Tutorial
    //
    // Five-step onboarding nudge that appears only on a fresh install
    // (persisted in localStorage so it never replays once finished or
    // skipped). Each step watches a single natural gameplay action
    // and advances when the player does it; no timers, no forced
    // pauses. Skip is a single tap / click on the SKIP chip.
    //
    // Steps are declarative - adding a sixth is one entry here plus
    // a matching onTrigger call in the game logic for that action.
    // ---------------------------------------------------------------
    const TUTORIAL_KEY = "ethereon.tutorialDone";
    const tutorial = (function () {
        const STEPS = [
            { text: "Move around",                            trigger: "move" },
            { text: "Attack enemies",                         trigger: "attack" },
            { text: "Collect coins and red orbs",             trigger: "pickup" },
            { text: "Use special attack when magic is full",  trigger: "special" },
            { text: "Find warriors and recruit them",         trigger: "recruit" },
        ];

        let active = false;
        let step = 0;
        let moveDistance = 0;       // accumulates px moved for step 1
        const MOVE_THRESHOLD = 80;

        // Rect cached each draw so the pointer handler can hit-test
        // without re-computing layout. Uses the same contract as
        // pauseMenu rects / startButton.rect.
        const skipRect = { x: 0, y: 0, w: 0, h: 0 };

        function markDone() {
            active = false;
            try { localStorage.setItem(TUTORIAL_KEY, "1"); }
            catch (_e) { /* private mode, etc. */ }
        }

        function advance() {
            if (!active) return;
            step++;
            if (step >= STEPS.length) markDone();
        }

        function onTrigger(name) {
            if (!active) return;
            const cur = STEPS[step];
            if (cur && cur.trigger === name) advance();
        }

        return {
            start() {
                try {
                    if (localStorage.getItem(TUTORIAL_KEY) === "1") return;
                } catch (_e) {}
                active = true;
                step = 0;
                moveDistance = 0;
            },

            isActive() { return active; },
            text()     { return active && STEPS[step] ? STEPS[step].text : ""; },
            stepNum()  { return step + 1; },
            total()    { return STEPS.length; },
            skipRect,

            skip() { markDone(); },

            // Per-frame nudge for step 1. Accumulates actual travel
            // distance so standing still with keys held can't trip
            // the threshold.
            onMove(dx, dy) {
                if (!active || step !== 0) return;
                moveDistance += Math.hypot(dx, dy);
                if (moveDistance > MOVE_THRESHOLD) onTrigger("move");
            },
            onAttack()  { onTrigger("attack");  },
            onPickup()  { onTrigger("pickup");  },
            onSpecial() { onTrigger("special"); },
            onRecruit() { onTrigger("recruit"); },

            handlePointer(x, y) {
                if (!active) return false;
                const r = skipRect;
                if (x >= r.x && x <= r.x + r.w &&
                    y >= r.y && y <= r.y + r.h) {
                    this.skip();
                    return true;
                }
                return false;
            },
        };
    })();
    tutorial.start();

    // ---------------------------------------------------------------
    // Save / load
    //
    // Persists a focused slice of run state to localStorage:
    //   - player pose + resources + inventory + squad
    //   - stats (score, kills, level, xp)
    //   - baseline mutations from shop upgrades (so reloads keep
    //     purchased damage / HP / cooldown bumps)
    //   - story chapter + quest progress + defeated bosses +
    //     unlocked doors + current level id
    //
    // What's intentionally dropped: live enemy positions, in-flight
    // projectiles, scatter tile scatter. On load we transitionTo the
    // saved level which reseeds enemies - accept that as the cost of
    // a simple save format.
    //
    // Versioned so future schema changes can reject old blobs
    // cleanly instead of corrupting a run.
    // ---------------------------------------------------------------
    const SAVE_KEY = "ethereon.save";
    const SAVE_VERSION = 1;

    const saveGame = {
        exists() {
            try { return localStorage.getItem(SAVE_KEY) !== null; }
            catch { return false; }
        },

        read() {
            try {
                const raw = localStorage.getItem(SAVE_KEY);
                if (!raw) return null;
                const data = JSON.parse(raw);
                if (data.version !== SAVE_VERSION) return null;
                return data;
            } catch { return null; }
        },

        write() {
            const data = {
                version: SAVE_VERSION,
                savedAt: Date.now(),
                levelId: currentLevel.id,
                player: {
                    x: player.x, y: player.y,
                    hp: player.hp, maxHp: player.maxHp,
                    magic: player.magic, maxMagic: player.maxMagic,
                    coins: player.coins,
                    inventory: [...player.inventory],
                    squad: player.squad.map(m => ({ ...m })),
                    lightCreatures: player.lightCreatures.map(c => ({ ...c })),
                    weaponIndex: player.weaponIndex,
                },
                stats: {
                    score: stats.score, kills: stats.kills,
                    level: stats.level, xp: stats.xp,
                    xpForNext: stats.xpForNext,
                },
                weapons: {
                    swordDamage:    swordWeapon.damage,
                    energyDamage:   energyWeapon.damage,
                    energyCooldown: energyWeapon.cooldownMax,
                    powerDamage:    powerMove.damage,
                    attackCooldown: attack.cooldown,
                },
                story: story.state,
                missionTag: story.missionTag,
                missions: {
                    currentMissionIndex: missions.currentMissionIndex,
                    completed: missions.list.map(m => !!m.completed),
                },
                quest: {
                    active: questLog.active ? { ...questLog.active } : null,
                    completedIds: [...questLog.completedIds],
                },
                defeatedBosses: [...defeatedBosses],
                unlockedDoors:  [...unlockedDoors],
            };
            try {
                localStorage.setItem(SAVE_KEY, JSON.stringify(data));
                return true;
            } catch { return false; }
        },

        apply(data) {
            if (!data) return false;

            // Baseline weapon tunables first, so any further damage
            // math (on enemy contact, etc.) reads the restored vals.
            swordWeapon.damage    = data.weapons.swordDamage;
            energyWeapon.damage   = data.weapons.energyDamage;
            energyWeapon.cooldownMax = data.weapons.energyCooldown;
            powerMove.damage      = data.weapons.powerDamage;
            attack.cooldown       = data.weapons.attackCooldown;

            // Stats + story + quest log
            stats.score     = data.stats.score;
            stats.kills     = data.stats.kills;
            stats.level     = data.stats.level;
            stats.xp        = data.stats.xp;
            stats.xpForNext = data.stats.xpForNext;
            story.state     = data.story;
            story.missionTag = data.missionTag ?? null;
            // Mission roster restore. Older saves without the field
            // fall through to a fresh roster (reset()), so loading a
            // pre-mission save doesn't crash.
            if (data.missions) {
                missions.currentMissionIndex = Math.min(
                    data.missions.currentMissionIndex ?? 0,
                    missions.list.length - 1
                );
                const flags = data.missions.completed ?? [];
                for (let i = 0; i < missions.list.length; i++) {
                    missions.list[i].completed = !!flags[i];
                }
            } else {
                missions.reset();
            }
            questLog.active = data.quest.active
                ? { ...data.quest.active }
                : null;
            questLog.completedIds = new Set(data.quest.completedIds);

            // Sets
            defeatedBosses.clear();
            for (const id of data.defeatedBosses) defeatedBosses.add(id);
            unlockedDoors.clear();
            for (const k of data.unlockedDoors) unlockedDoors.add(k);

            // Transition to the saved level. This reseeds enemies,
            // clears projectiles/drops, and runs the chapter-entry
            // advance (which is a no-op if we're already past it).
            const target = LEVELS[data.levelId] || LEVELS.grove;
            transitionTo(target.id, null, { x: data.player.x, y: data.player.y });

            // Restore player resources after transitionTo has reset
            // velocity / position to its defaults.
            player.x = data.player.x;
            player.y = data.player.y;
            player.hp = data.player.hp;
            player.maxHp = data.player.maxHp;
            player.magic = data.player.magic;
            player.maxMagic = data.player.maxMagic;
            player.coins = data.player.coins;
            player.inventory.length = 0;
            for (const id of data.player.inventory) player.inventory.push(id);
            // Squad: dismiss any current followers back to their
            // home zones first, then rehire from the snapshot roster
            // so the live followers array matches the save's squad.
            companions.dismissAll();
            companions.rehire(data.player.squad);
            // Light creatures: wipe live list + snapshot roster,
            // then replay from the save. Next seed spawns live
            // entities from the restored snapshots.
            resetLightCreatures();
            player.lightCreatures.length = 0;
            for (const s of (data.player.lightCreatures ?? [])) {
                if (LIGHT_SPECIES[s.speciesId]) {
                    player.lightCreatures.push({ speciesId: s.speciesId });
                }
            }
            player.weaponIndex = data.player.weaponIndex;

            camera.snap(player);
            cloak.snap();
            aura.snap();
            snapFollowersToPlayer();
            return true;
        },

        load() { return this.apply(this.read()); },

        clear() {
            try { localStorage.removeItem(SAVE_KEY); } catch {}
        },
    };

    // Pause-menu state. Rects are screen-space and refreshed each
    // draw so they automatically follow resize without a layout
    // callback. Touch + keyboard both route here via handleAction.
    const pauseMenu = {
        rects: {
            resume: { x: 0, y: 0, w: 0, h: 0 },
            save:   { x: 0, y: 0, w: 0, h: 0 },
            load:   { x: 0, y: 0, w: 0, h: 0 },
        },
        // Brief on-screen toast inside the pause panel - "Saved.",
        // "No save found.", etc. Ticks from update() while paused.
        statusText: "",
        statusTimer: 0,

        setStatus(msg) {
            this.statusText = msg;
            this.statusTimer = 2.2;
        },

        handleAction(name) {
            if (name === "resume") {
                paused = false;
                return;
            }
            if (name === "save") {
                this.setStatus(saveGame.write() ? "Saved." : "Save failed.");
                return;
            }
            if (name === "load") {
                if (!saveGame.exists()) { this.setStatus("No save found."); return; }
                if (saveGame.load()) {
                    this.setStatus("Loaded.");
                    paused = false;
                } else {
                    this.setStatus("Load failed.");
                }
            }
        },

        handlePointer(x, y) {
            for (const [name, r] of Object.entries(this.rects)) {
                if (x >= r.x && x <= r.x + r.w &&
                    y >= r.y && y <= r.y + r.h) {
                    this.handleAction(name);
                    return true;
                }
            }
            return false;
        },

        tick(dt) {
            if (this.statusTimer > 0) {
                this.statusTimer = Math.max(0, this.statusTimer - dt);
                if (this.statusTimer === 0) this.statusText = "";
            }
        },
    };

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
                    if (!e.alive || e.ally) continue;
                    const b = e.bounds();
                    if (
                        p.x < b.x + b.w && p.x + p.w > b.x &&
                        p.y < b.y + b.h && p.y + p.h > b.y
                    ) {
                        e.takeHit(p.damage, {
                            x: p.x + p.w / 2,
                            y: p.y + p.h / 2,
                        });
                        if (!e.alive) onEnemyDefeated(e);
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
        fire(player, mult = 1) {
            // Latch this weapon's damage into the attack module so the
            // collision path picks it up. Charge attacks multiply it
            // for this swing only - attack.damage is re-latched every
            // fire() so the mutation doesn't leak into the next one.
            attack.damage = Math.max(1, Math.round(this.damage * mult));
            attack.tryStart(player);
        },
        update(_dt) { /* attack module ticks itself */ },
        reset() { /* attack state is reset elsewhere */ },
    };

    // ---------------------------------------------------------------
    // Charged sword spin
    //
    // Fires on a sword-weapon charge-release past the 1s threshold.
    // A single 360-degree AoE with a circular slash VFX and a brief
    // sprite-rotation on the player - the "payoff" of holding the
    // charge on the melee weapon.
    //
    // Damage is passed in from the charge-release code so the same
    // multiplier math drives tap, charged shot, and spin uniformly.
    // Each enemy is hit once per spin via the shared hitEnemies set.
    // ---------------------------------------------------------------
    const swordSpin = {
        // Base radius at full charge. Scaled down for the medium
        // tier so the wider-arc slash sits between tap and spin.
        baseRadius: 92,
        radius: 92,
        duration: 0.45,         // total animation + hit window
        activeTimer: 0,
        damage: 1,
        level: 2,               // 1 = wider arc, 2 = full 360 spin
        hitEnemies: new Set(),

        isActive() { return this.activeTimer > 0; },

        // level: 1 (medium / wider arc) | 2 (full 360 spin).
        // Knockback strength rides on level too - the Enemy's
        // takeHit() knockback already scales with `from` distance;
        // a shorter hit radius naturally means closer impacts,
        // but we also bump damage as the headline effect.
        activate(dmg, level = 2) {
            this.damage = Math.max(1, dmg | 0);
            this.level = level;
            this.radius = level >= 2 ? this.baseRadius : this.baseRadius * 0.62;
            this.duration = level >= 2 ? 0.45 : 0.32;
            this.activeTimer = this.duration;
            this.hitEnemies.clear();
            sound.play("attack");
        },

        update(dt) {
            if (this.activeTimer > 0) {
                this.activeTimer = Math.max(0, this.activeTimer - dt);
            }
        },

        reset() {
            this.activeTimer = 0;
            this.hitEnemies.clear();
        },

        // Progress 0..1 across the visual window, used by both draw
        // and the player sprite rotation in drawPlayer.
        progress() {
            if (this.activeTimer <= 0) return 0;
            return 1 - this.activeTimer / this.duration;
        },

        draw(ctx, entity) {
            if (this.activeTimer <= 0) return;
            const t = this.progress();
            const cx = Math.round(entity.x + entity.width / 2);
            const cy = Math.round(entity.y + entity.height / 2);

            // Sweep arc - a bright gold 3/4 circle that rotates as the
            // animation progresses, reading as a spinning blade trail.
            const sweepStart = -Math.PI / 2 + t * Math.PI * 3;
            const sweepArc = Math.PI * 1.5;
            const r = this.radius * Math.min(1, t + 0.15);
            const alpha = 1 - t;

            ctx.save();
            ctx.strokeStyle = "#ffd166";
            ctx.lineWidth = 6 * (1 - t) + 2;
            ctx.globalAlpha = alpha * 0.9;
            ctx.beginPath();
            ctx.arc(cx, cy, r, sweepStart, sweepStart + sweepArc);
            ctx.stroke();

            // Inner highlight sweep on a slightly smaller ring, offset
            // so the two arcs read as depth rather than a flat line.
            ctx.strokeStyle = "#fff6d6";
            ctx.lineWidth = 3 * (1 - t) + 1;
            ctx.globalAlpha = alpha * 0.7;
            ctx.beginPath();
            ctx.arc(cx, cy, r * 0.85,
                sweepStart + 0.3, sweepStart + sweepArc - 0.3);
            ctx.stroke();

            // Ghost outline at max radius - marks the edge of the
            // damage zone so the player understands the AoE reach.
            if (t > 0.25) {
                ctx.strokeStyle = "rgba(255, 246, 214, 0.55)";
                ctx.lineWidth = 1.5;
                ctx.globalAlpha = (1 - t) * 0.55;
                ctx.beginPath();
                ctx.arc(cx, cy, this.radius, 0, Math.PI * 2);
                ctx.stroke();
            }
            ctx.restore();
        },
    };

    function updateSwordSpinCollision() {
        if (!swordSpin.isActive()) return;
        const cx = player.x + player.width / 2;
        const cy = player.y + player.height / 2;
        const r2 = swordSpin.radius * swordSpin.radius;
        for (const e of enemies) {
            if (!e.alive || e.ally || swordSpin.hitEnemies.has(e)) continue;
            const ex = e.x + e.width / 2;
            const ey = e.y + e.height / 2;
            const dx = ex - cx;
            const dy = ey - cy;
            if (dx * dx + dy * dy < r2) {
                e.takeHit(swordSpin.damage, { x: cx, y: cy });
                swordSpin.hitEnemies.add(e);
                if (!e.alive) onEnemyDefeated(e);
            }
        }
    }

    // ---------------------------------------------------------------
    // Charged energy beam
    //
    // Fires on an energy-weapon charge-release past the 1s threshold.
    // A wide stationary beam cast from the player's center in the
    // facing direction, piercing every enemy along its length. No
    // travel step - the beam is a live hitbox for its entire 0.32s
    // window, so hits register instantly on overlap rather than
    // waiting on a projectile to arrive.
    //
    // Hit test is a point-on-oriented-rect check plus a small
    // enemy-radius fudge, so large sprites still trigger at the
    // beam edge. Each enemy is hit once via hitEnemies, same
    // contract as the rest of the AoE modules.
    // ---------------------------------------------------------------
    const energyBeam = {
        // Live beam geometry. length / width / duration are reset on
        // activate() from per-level presets so the medium / full
        // tiers scale cleanly.
        length: 640,
        width: 34,
        duration: 0.32,
        activeTimer: 0,
        damage: 1,
        level: 2,               // 1 = medium, 2 = massive
        dirX: 1, dirY: 0,
        originX: 0, originY: 0,
        hitEnemies: new Set(),

        // Continuous-damage repeat: the beam lives long enough that
        // enemies entering late should still take hits. Per-enemy
        // nextHitAt cooldown keeps damage from stacking each frame.
        _rehitCooldown: 0.22,
        _nextHitAt: new Map(),

        isActive() { return this.activeTimer > 0; },

        // level: 1 (medium - narrower + shorter) | 2 (massive beam).
        activate(dmg, entity, level = 2) {
            this.damage = Math.max(1, dmg | 0);
            this.level = level;
            if (level >= 2) {
                // Massive: full-screen-ish length, thick, stays live
                // long enough to sweep through a wave.
                this.length = 760;
                this.width  = 48;
                this.duration = 0.55;
            } else {
                // Medium: wider than a projectile, shorter than full.
                this.length = 520;
                this.width  = 28;
                this.duration = 0.28;
            }
            this.activeTimer = this.duration;
            this.hitEnemies.clear();
            this._nextHitAt.clear();
            const fx = entity.facing.x;
            const fy = entity.facing.y;
            const mag = Math.hypot(fx, fy) || 1;
            this.dirX = fx / mag;
            this.dirY = fy / mag;
            this.originX = entity.x + entity.width / 2;
            this.originY = entity.y + entity.height / 2;
            sound.play("attack");
        },

        update(dt) {
            if (this.activeTimer > 0) {
                this.activeTimer = Math.max(0, this.activeTimer - dt);
            }
        },

        reset() {
            this.activeTimer = 0;
            this.hitEnemies.clear();
        },

        progress() {
            if (this.activeTimer <= 0) return 0;
            return 1 - this.activeTimer / this.duration;
        },

        draw(ctx) {
            if (this.activeTimer <= 0) return;
            const t = this.progress();
            const alpha = 1 - t;

            ctx.save();
            ctx.translate(this.originX, this.originY);
            ctx.rotate(Math.atan2(this.dirY, this.dirX));

            // Outer glow halo - widest, softest.
            ctx.globalAlpha = alpha * 0.38;
            ctx.fillStyle = "#8ad9ff";
            ctx.fillRect(0, -this.width, this.length, this.width * 2);

            // Main beam - shrinks slightly as it fades for a "spent"
            // feel without dropping brightness suddenly.
            const coreW = this.width * (1 - t * 0.25);
            ctx.globalAlpha = alpha;
            ctx.fillStyle = "#eaf7ff";
            ctx.fillRect(0, -coreW * 0.5, this.length, coreW);

            // White center line - the searing streak down the middle.
            ctx.globalAlpha = alpha * 0.95;
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, -2, this.length, 4);

            // Muzzle burst at the origin - a brighter disc that fades
            // first, reading as the moment of release.
            if (t < 0.5) {
                ctx.globalAlpha = (1 - t / 0.5) * 0.8;
                ctx.fillStyle = "#ffffff";
                ctx.beginPath();
                ctx.arc(0, 0, 18 - t * 20, 0, Math.PI * 2);
                ctx.fill();
            }

            ctx.restore();
        },
    };

    function updateEnergyBeamCollision() {
        if (!energyBeam.isActive()) return;
        const ox = energyBeam.originX;
        const oy = energyBeam.originY;
        const dx = energyBeam.dirX;
        const dy = energyBeam.dirY;
        const halfW = energyBeam.width * 0.5;
        const len = energyBeam.length;
        const now = performance.now() / 1000;
        const continuous = energyBeam.level >= 2;
        const rehit = energyBeam.level >= 2
            ? energyBeam._rehitCooldown
            : Infinity; // medium: once-per-beam only
        const PERP_PAD = 12;

        for (const e of enemies) {
            if (!e.alive || e.ally) continue;
            // For one-shot mode (medium), bail if we already hit this
            // enemy this beam.
            if (!continuous && energyBeam.hitEnemies.has(e)) continue;
            const ecx = e.x + e.width / 2;
            const ecy = e.y + e.height / 2;
            const rx = ecx - ox;
            const ry = ecy - oy;
            const along = rx * dx + ry * dy;
            if (along < 0 || along > len) continue;
            const perp = Math.abs(-rx * dy + ry * dx);
            if (perp > halfW + PERP_PAD) continue;

            // Continuous mode: per-enemy re-hit cooldown so a
            // stationary target doesn't take a hit each frame.
            if (continuous) {
                const next = energyBeam._nextHitAt.get(e) ?? 0;
                if (now < next) continue;
                energyBeam._nextHitAt.set(e, now + rehit);
            } else {
                energyBeam.hitEnemies.add(e);
            }
            e.takeHit(energyBeam.damage, {
                x: ox + dx * along, y: oy + dy * along,
            });
            if (!e.alive) onEnemyDefeated(e);
        }
    }

    // Energy blast: owns its own cooldown and spawns a projectile on
    // fire. Uses the same `sound.play("attack")` cue for now so the
    // existing spam guard applies.
    const energyWeapon = {
        id: "energy",
        name: "Energy Blast",
        shortName: "ENERGY",
        glyph: "✦",
        color: "#8ad9ff",
        damage: 1,            // base projectile damage; level-ups bump it
        cooldownMax: 0.5,
        cooldownTimer: 0,
        get ready() { return this.cooldownTimer <= 0; },
        cooldownFrac() {
            if (this.cooldownTimer <= 0) return 1;
            return 1 - this.cooldownTimer / this.cooldownMax;
        },
        fire(player, mult = 1) {
            if (!this.ready) return;
            this.cooldownTimer = this.cooldownMax;
            // Charged shots hit harder and travel a touch slower (bigger,
            // beefier bolt). Damage defaults to 1 per shot when no mult
            // is applied, matching the pre-charge baseline.
            const base = this.damage ?? 1;
            spawnProjectile(player, {
                color: this.color,
                damage: Math.max(1, Math.round(base * mult)),
            });
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
            shake.trigger(10, 0.3);
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
            if (!e.alive || e.ally || powerMove.hitEnemies.has(e)) continue;
            const ex = e.x + e.width / 2;
            const ey = e.y + e.height / 2;
            const dx = ex - cx;
            const dy = ey - cy;
            if (dx * dx + dy * dy <= r2) {
                e.takeHit(powerMove.damage, { x: cx, y: cy });
                powerMove.hitEnemies.add(e);
                if (!e.alive) onEnemyDefeated(e);
            }
        }
    }

    // ---------------------------------------------------------------
    // Super Power
    //
    // The "nuke". Triples the power-move's reach, quadruples the
    // damage, and lasts nearly a full second - but takes ~15 seconds
    // to recharge so using it is a real commitment.
    //
    // The animation layers three concentric rings expanding at
    // staggered speeds + a bright central flash that fades over the
    // first fraction of the window. Visually loud so it reads as a
    // once-in-a-fight moment.
    // ---------------------------------------------------------------
    const superPower = {
        // Tunables
        cooldownMax: 15.0,
        activeDuration: 0.85,
        radius: 220,
        damage: 12,

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
            sound.play("super");
            // Dramatic shake for the nuke. Long + strong.
            shake.trigger(18, 0.7);
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

        draw(ctx, entity) {
            if (this.activeTimer <= 0) return;
            const t = 1 - this.activeTimer / this.activeDuration;  // 0 -> 1
            const cx = Math.round(entity.x + entity.width / 2);
            const cy = Math.round(entity.y + entity.height / 2);

            ctx.save();

            // Central flash: brightest at the start of the cast,
            // fades out in the first third of the window.
            if (t < 0.35) {
                const flash = 1 - t / 0.35;
                ctx.globalAlpha = flash;
                ctx.fillStyle = "#fff6d6";
                ctx.beginPath();
                ctx.arc(cx, cy, 90 - t * 60, 0, Math.PI * 2);
                ctx.fill();
            }

            // Three expanding rings staggered in start time and color
            // so the blast reads as multi-layered energy, not a
            // single ring.
            const rings = [
                { start: 0.00, color: "#ffd166", width: 12 },
                { start: 0.18, color: "#ff8e3a", width: 9 },
                { start: 0.36, color: "#fff6d6", width: 6 },
            ];
            for (const ring of rings) {
                const localT = (t - ring.start) / (1 - ring.start);
                if (localT <= 0 || localT >= 1) continue;
                const r = this.radius * localT;
                const alpha = (1 - localT) * 0.85;
                ctx.globalAlpha = alpha;
                ctx.strokeStyle = ring.color;
                ctx.lineWidth = ring.width * (1 - localT) + 2;
                ctx.beginPath();
                ctx.arc(cx, cy, r, 0, Math.PI * 2);
                ctx.stroke();
            }

            // Trailing outer halo - final flourish.
            if (t > 0.4 && t < 0.9) {
                const ht = (t - 0.4) / 0.5;
                ctx.globalAlpha = (1 - ht) * 0.25;
                ctx.fillStyle = "#ffd166";
                ctx.beginPath();
                ctx.arc(cx, cy, this.radius * (0.7 + ht * 0.3), 0, Math.PI * 2);
                ctx.fill();
            }

            ctx.restore();
        },
    };

    function updateSuperPowerCollision() {
        if (superPower.activeTimer <= 0) return;
        const cx = player.x + player.width / 2;
        const cy = player.y + player.height / 2;
        const r2 = superPower.radius * superPower.radius;

        for (const e of enemies) {
            if (!e.alive || e.ally || superPower.hitEnemies.has(e)) continue;
            const ex = e.x + e.width / 2;
            const ey = e.y + e.height / 2;
            const dx = ex - cx;
            const dy = ey - cy;
            if (dx * dx + dy * dy <= r2) {
                e.takeHit(superPower.damage, { x: cx, y: cy });
                superPower.hitEnemies.add(e);
                if (!e.alive) onEnemyDefeated(e);
            }
        }
    }

    // ---------------------------------------------------------------
    // Special Attack
    //
    // Magic-fuelled burst distinct from powerMove / superPower:
    //   - Gate is a magic cost (50), not a cooldown, so pacing is
    //     driven by red-orb drops rather than a timer.
    //   - Casts for `castDuration` seconds during which the player
    //     is movement-locked - a visible "commit" that rewards
    //     aggressive positioning before firing.
    //   - Spawns a large AoE wave that damages every enemy in its
    //     expanding radius exactly once.
    //   - Kicks in a short slow-motion window on impact that scales
    //     `dt` passed to enemy AI / spawner, so the blast lands with
    //     visible weight without freezing the UI.
    //
    // Visuals: white flash, crimson expanding ring, pink inner ring,
    // and a fading halo - all drawn in a single module so the timing
    // stays tight together.
    // ---------------------------------------------------------------
    const specialAttack = {
        // Tunables
        magicCost: 50,
        castDuration: 0.32,     // movement lock window
        activeDuration: 0.70,   // visual + hit window
        slowMoDuration: 0.32,   // enemy slow-mo window
        slowMoScale: 0.35,      // enemies tick at 35% speed during it
        baseRadius: 240,
        baseDamage: 10,
        radius: 240,            // live values, scaled on activate() by level
        damage: 10,
        level: 0,               // 0=tap, 1=medium, 2=full

        // Runtime
        castTimer: 0,
        activeTimer: 0,
        slowMoTimer: 0,
        hitEnemies: new Set(),

        get ready() {
            return player.magic >= this.magicCost &&
                   this.activeTimer <= 0 &&
                   this.castTimer <= 0;
        },

        // Used by updateMovement to ignore input during the cast.
        isCasting() { return this.castTimer > 0; },

        // Used by the main update loop to scale enemy dt during
        // slow-mo. Returns 1 when no slow-mo is active.
        enemyTimeScale() {
            return this.slowMoTimer > 0 ? this.slowMoScale : 1;
        },

        // level: 0 (tap) | 1 (medium hold) | 2 (full charge).
        // Radius + damage scale so a held special hits harder and
        // reaches further, while still costing the flat 50 magic.
        activate(level = 0) {
            if (!this.ready) return false;
            player.magic -= this.magicCost;
            this.level = level;
            const radiusScale = 1 + level * 0.18;   // 1.0 / 1.18 / 1.36
            const damageScale = 1 + level * 0.35;   // 1.0 / 1.35 / 1.70
            // Crown Mode multiplies radius + damage on top of the
            // hold-tier, so a charged special under Crown reaches
            // further and hits harder.
            this.radius = this.baseRadius * radiusScale * crown.sizeMult;
            this.damage = Math.round(this.baseDamage * damageScale * crown.attackMult);
            this.castTimer    = this.castDuration;
            this.activeTimer  = this.activeDuration;
            this.slowMoTimer  = this.slowMoDuration;
            this.hitEnemies.clear();
            sound.play("super");
            // Shake + flash ramp with the charge level so the held
            // release reads as the bigger payoff.
            shake.trigger(22 + level * 4, 0.5);
            flash.trigger(0.8 + level * 0.08, 0.28);
            camera.zoomPulse(1.12 + level * 0.03, 0.22);
            tutorial.onSpecial();
            return true;
        },

        update(dt) {
            if (this.castTimer > 0)   this.castTimer   = Math.max(0, this.castTimer - dt);
            if (this.activeTimer > 0) this.activeTimer = Math.max(0, this.activeTimer - dt);
            if (this.slowMoTimer > 0) this.slowMoTimer = Math.max(0, this.slowMoTimer - dt);
        },

        reset() {
            this.castTimer = 0;
            this.activeTimer = 0;
            this.slowMoTimer = 0;
            this.hitEnemies.clear();
        },

        draw(ctx, entity) {
            if (this.activeTimer <= 0) return;
            const t = 1 - this.activeTimer / this.activeDuration;  // 0..1
            const cx = Math.round(entity.x + entity.width / 2);
            const cy = Math.round(entity.y + entity.height / 2);

            ctx.save();

            // Bright white flash for the first quarter of the cast.
            if (t < 0.25) {
                const flash = 1 - t / 0.25;
                ctx.globalAlpha = flash * 0.9;
                ctx.fillStyle = "#ffffff";
                ctx.beginPath();
                ctx.arc(cx, cy, 110 - t * 80, 0, Math.PI * 2);
                ctx.fill();
            }

            // Two expanding rings in crimson / pink so the wave reads
            // as magic-burst instead of reusing the super's palette.
            const rings = [
                { start: 0.00, color: "#e63946", width: 14 },
                { start: 0.16, color: "#ffb3c0", width: 8  },
            ];
            for (const ring of rings) {
                const localT = (t - ring.start) / (1 - ring.start);
                if (localT <= 0 || localT >= 1) continue;
                const r = this.radius * localT;
                const alpha = (1 - localT) * 0.88;
                ctx.globalAlpha = alpha;
                ctx.strokeStyle = ring.color;
                ctx.lineWidth = ring.width * (1 - localT) + 2;
                ctx.beginPath();
                ctx.arc(cx, cy, r, 0, Math.PI * 2);
                ctx.stroke();
            }

            // Trailing halo fills in the wake of the rings.
            if (t > 0.3 && t < 0.9) {
                const ht = (t - 0.3) / 0.6;
                ctx.globalAlpha = (1 - ht) * 0.28;
                ctx.fillStyle = "#e63946";
                ctx.beginPath();
                ctx.arc(cx, cy, this.radius * (0.7 + ht * 0.3), 0, Math.PI * 2);
                ctx.fill();
            }

            ctx.restore();
        },
    };

    // Radius grows with time, so enemies further out aren't hit until
    // the ring reaches them. Each enemy takes the strike exactly once.
    function updateSpecialAttackCollision() {
        if (specialAttack.activeTimer <= 0) return;
        const cx = player.x + player.width / 2;
        const cy = player.y + player.height / 2;
        const t  = 1 - specialAttack.activeTimer / specialAttack.activeDuration;
        const currentR = specialAttack.radius * Math.min(1, t + 0.2);
        const r2 = currentR * currentR;

        for (const e of enemies) {
            if (!e.alive || e.ally || specialAttack.hitEnemies.has(e)) continue;
            const ex = e.x + e.width / 2;
            const ey = e.y + e.height / 2;
            const dx = ex - cx;
            const dy = ey - cy;
            if (dx * dx + dy * dy < r2) {
                e.takeHit(specialAttack.damage, { x: cx, y: cy });
                specialAttack.hitEnemies.add(e);
                if (!e.alive) onEnemyDefeated(e);
            }
        }
    }

    // ---------------------------------------------------------------
    // Battlefield Nova
    //
    // Top-tier panic button: a screen-wide radial shockwave that
    // strikes every enemy once. Paired gates (high magic cost +
    // long cooldown) keep it rare; the cinematic activation + three
    // staggered expanding rings make the cast feel like a proper
    // "payoff" beat rather than a fourth AoE.
    //
    // Radius: 520px (typically covers the full viewport on mobile
    // and most of a desktop screen). Damage: 25. Cost: 80 magic +
    // 25s cooldown, enforced together so full-magic spam still
    // waits for the timer.
    // ---------------------------------------------------------------
    const battlefieldNova = {
        magicCost: 80,
        cooldownMax: 25,
        activeDuration: 1.1,     // visual + hit window
        slowMoDuration: 0.5,     // dramatic hang when it lands
        radius: 520,
        damage: 25,

        cooldownTimer: 0,
        activeTimer: 0,
        hitEnemies: new Set(),

        get ready() {
            return this.cooldownTimer <= 0 &&
                   this.activeTimer <= 0 &&
                   player.magic >= this.magicCost;
        },

        cooldownFrac() {
            if (this.cooldownTimer <= 0) return 1;
            return 1 - this.cooldownTimer / this.cooldownMax;
        },

        activate() {
            if (!this.ready) return false;
            player.magic -= this.magicCost;
            this.cooldownTimer = this.cooldownMax;
            this.activeTimer = this.activeDuration;
            this.hitEnemies.clear();

            // Cinematic: heavy flash, big shake, brief zoom, 0.5s
            // slow-mo via the shared specialAttack.slowMoTimer so
            // the enemy tick scale reuses the existing plumbing.
            flash.trigger(0.95, 0.4);
            shake.trigger(26, 0.6);
            camera.zoomPulse(1.15, 0.3);
            specialAttack.slowMoTimer = Math.max(
                specialAttack.slowMoTimer, this.slowMoDuration
            );
            sound.play("super");
            return true;
        },

        update(dt) {
            if (this.activeTimer > 0)
                this.activeTimer = Math.max(0, this.activeTimer - dt);
            if (this.cooldownTimer > 0)
                this.cooldownTimer = Math.max(0, this.cooldownTimer - dt);
        },

        reset() {
            this.cooldownTimer = 0;
            this.activeTimer = 0;
            this.hitEnemies.clear();
        },

        draw(ctx, entity) {
            if (this.activeTimer <= 0) return;
            const t = 1 - this.activeTimer / this.activeDuration;
            const cx = Math.round(entity.x + entity.width / 2);
            const cy = Math.round(entity.y + entity.height / 2);

            ctx.save();

            // Central bright disc that fades quickly - the "core".
            if (t < 0.3) {
                const flashA = 1 - t / 0.3;
                ctx.globalAlpha = flashA;
                ctx.fillStyle = "#fff6d6";
                ctx.beginPath();
                ctx.arc(cx, cy, 140 - t * 120, 0, Math.PI * 2);
                ctx.fill();
            }

            // Three staggered shockwave rings in white / gold / red,
            // each starting at a different phase so they sweep out
            // one after the other rather than layering flat.
            const rings = [
                { start: 0.00, color: "#ffffff", width: 18 },
                { start: 0.15, color: "#ffd166", width: 12 },
                { start: 0.32, color: "#ff8e3a", width: 8  },
            ];
            for (const r of rings) {
                const localT = (t - r.start) / (1 - r.start);
                if (localT <= 0 || localT >= 1) continue;
                const radius = this.radius * localT;
                const alpha = (1 - localT) * 0.9;
                ctx.globalAlpha = alpha;
                ctx.strokeStyle = r.color;
                ctx.lineWidth = r.width * (1 - localT) + 2;
                ctx.beginPath();
                ctx.arc(cx, cy, radius, 0, Math.PI * 2);
                ctx.stroke();
            }

            // Trailing gold halo at the very edge of the blast radius
            // so the damage footprint stays readable until the end.
            if (t > 0.45 && t < 0.9) {
                const ht = (t - 0.45) / 0.45;
                ctx.globalAlpha = (1 - ht) * 0.22;
                ctx.fillStyle = "#ffd166";
                ctx.beginPath();
                ctx.arc(cx, cy, this.radius * (0.85 + ht * 0.15), 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.restore();
        },
    };

    // Radial sweep damage - each enemy takes the strike exactly once
    // as the outermost ring passes them. Uses the same expanding-hit
    // pattern as the special attack so high-radius enemies only get
    // hit when the wave actually reaches them.
    function updateBattlefieldNovaCollision() {
        if (battlefieldNova.activeTimer <= 0) return;
        const cx = player.x + player.width / 2;
        const cy = player.y + player.height / 2;
        const t = 1 - battlefieldNova.activeTimer / battlefieldNova.activeDuration;
        const currentR = battlefieldNova.radius * Math.min(1, t + 0.1);
        const r2 = currentR * currentR;
        for (const e of enemies) {
            if (!e.alive || e.ally || battlefieldNova.hitEnemies.has(e)) continue;
            const ex = e.x + e.width / 2;
            const ey = e.y + e.height / 2;
            const dx = ex - cx;
            const dy = ey - cy;
            if (dx * dx + dy * dy < r2) {
                e.takeHit(battlefieldNova.damage, { x: cx, y: cy });
                battlefieldNova.hitEnemies.add(e);
                if (!e.alive) onEnemyDefeated(e);
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

    // ---------------------------------------------------------------
    // Enemy factions
    //
    // Each faction is a small preset layered over the Enemy's base
    // opts at construction time: stat scales, tint, behavior flags.
    // Enemy.update reads the flags to branch into faction-specific
    // behavior each tick:
    //   shadow   - teleport closer to target on a cooldown.
    //   hunter   - pack bonus: speed boost when near other hunters.
    //   sentinel - ranged + buff aura: fires a slow bolt at the
    //              player, and any enemy within AURA_R gets a
    //              per-frame speed boost.
    //   guardian - heavy: slow + hard-hitting, starts neutral
    //              (doesn't pursue until provoked); player can
    //              press E next to one to offer alliance.
    // ---------------------------------------------------------------
    const FACTIONS = {
        shadow: {
            id: "shadow",
            name: "Shadow Walker",
            tint: "rgba(58, 26, 74, 0.5)",
            teleport: true,
            teleportMin: 2.0,
            teleportMax: 3.5,
            hpScale: 0.9,
            speedScale: 1.05,
        },
        hunter: {
            id: "hunter",
            name: "Hunter",
            tint: "rgba(140, 58, 26, 0.45)",
            pack: true,
            hpScale: 0.9,
            speedScale: 1.0,
        },
        sentinel: {
            id: "sentinel",
            name: "Sentinel",
            tint: "rgba(42, 90, 58, 0.45)",
            ranged: true,
            buffAura: true,
            buffSpeedMult: 1.25,
            preferredRange: 220,
            hpScale: 1.3,
            speedScale: 0.7,
        },
        guardian: {
            id: "guardian",
            name: "Forest Guardian",
            tint: "rgba(85, 115, 74, 0.48)",
            heavy: true,
            neutral: true,
            knockbackScale: 0.4,
            hpScale: 2.0,
            speedScale: 0.55,
            damageScale: 1.6,
        },
    };

    // Hostile projectiles owned by enemy factions (sentinel bolts).
    // Kept separate from the player's `projectiles` array so the
    // collision path can target the player exclusively.
    const hostileProjectiles = [];

    // World rule: ENEMY energy never uses the "light" palette
    // (gold / cyan / white). Those are reserved for the player,
    // NPC warriors, and town allies. Any caller that passes a
    // light-ish color gets remapped to a dark / corrupted tone
    // so the visual identity stays consistent across enemy types.
    const ENEMY_DARK_PALETTE = [
        "#b9f0c9",   // sickly green (sentinel)
        "#c080ff",   // violet (shadow / warden)
        "#e06666",   // blood red
        "#ff8040",   // corrupted amber
    ];
    function sanitizeEnemyColor(color) {
        if (!color) return ENEMY_DARK_PALETTE[0];
        // Very light / golden / cyan tones are remapped. A cheap
        // heuristic is enough here - anything starting with #ff or
        // #fff likely reads as "light" to the player.
        const c = color.toLowerCase();
        if (c.startsWith("#fff") || c === "#ffd166" ||
            c === "#8ad9ff" || c === "#eaf7ff" ||
            c === "#fff6d6") {
            return ENEMY_DARK_PALETTE[
                Math.floor(Math.random() * ENEMY_DARK_PALETTE.length)
            ];
        }
        return color;
    }

    function spawnHostileProjectile(fromX, fromY, toX, toY, dmg, color) {
        const dx = toX - fromX;
        const dy = toY - fromY;
        const mag = Math.hypot(dx, dy) || 1;
        const speed = 240;
        hostileProjectiles.push({
            x: fromX - 5, y: fromY - 5,
            w: 10, h: 10,
            vx: (dx / mag) * speed,
            vy: (dy / mag) * speed,
            life: 1.6,
            damage: Math.max(1, dmg | 0),
            // Enforce the rule at the single spawn chokepoint.
            color: sanitizeEnemyColor(color),
            age: 0, alive: true,
        });
    }

    function updateHostileProjectiles(dt) {
        if (!hostileProjectiles.length) return;
        for (let i = hostileProjectiles.length - 1; i >= 0; i--) {
            const p = hostileProjectiles[i];
            p.age += dt;
            p.life -= dt;
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            if (p.life <= 0 ||
                p.x < 0 || p.y < 0 ||
                p.x > WORLD_W || p.y > WORLD_H) {
                p.alive = false;
            }
            if (p.alive && player.alive) {
                const px = player.x, py = player.y;
                if (p.x < px + player.width && p.x + p.w > px &&
                    p.y < py + player.height && p.y + p.h > py) {
                    damagePlayer(p.damage);
                    p.alive = false;
                }
            }
            if (!p.alive) hostileProjectiles.splice(i, 1);
        }
    }

    function drawHostileProjectiles(ctx) {
        for (const p of hostileProjectiles) {
            const cx = Math.round(p.x + p.w / 2);
            const cy = Math.round(p.y + p.h / 2);
            ctx.save();
            ctx.globalAlpha = 0.55;
            ctx.fillStyle = p.color;
            ctx.beginPath();
            ctx.arc(cx, cy, 8, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;
            ctx.fillStyle = "#ffffff";
            ctx.beginPath();
            ctx.arc(cx, cy, 2, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        }
    }

    // Per-frame synergy pass. Zeroes buffMult on every enemy, then
    // sentinel auras stack a speed multiplier onto any enemy within
    // AURA_R. Compose by max() so stacked auras don't runaway-speed.
    function applyFactionSynergies() {
        const AURA_R_SQ = 120 * 120;
        for (const e of enemies) {
            if (!e.alive) continue;
            e.buffMult = 1;
        }
        for (const s of enemies) {
            if (!s.alive || !s.faction || !s.faction.buffAura) continue;
            const scx = s.x + s.width / 2;
            const scy = s.y + s.height / 2;
            const mult = s.faction.buffSpeedMult || 1.2;
            for (const e of enemies) {
                if (e === s || !e.alive) continue;
                const dx = (e.x + e.width / 2) - scx;
                const dy = (e.y + e.height / 2) - scy;
                if (dx * dx + dy * dy < AURA_R_SQ && mult > e.buffMult) {
                    e.buffMult = mult;
                }
            }
        }
    }

    // ---------------------------------------------------------------
    // Enemy variants
    //
    // Size / stat band layered on top of any faction preset. Each
    // spawn rolls a variant (small / medium / large) weighted so
    // mediums are the baseline and the extremes stay rare. Size
    // only scales the sprite draw - the collision / knockback box
    // stays at the standard 32x32 so hitreg stays consistent.
    // ---------------------------------------------------------------
    const VARIANTS = {
        small:  { sizeScale: 0.72, hpScale: 0.6, speedScale: 1.30 },
        medium: { sizeScale: 1.00, hpScale: 1.0, speedScale: 1.00 },
        large:  { sizeScale: 1.35, hpScale: 1.8, speedScale: 0.72 },
    };
    // Strength-weighted variant roll. Early-game almost-always
    // medium; stronger players start seeing more smalls (pests) and
    // larges (tanks) for variety.
    function pickVariant(strength) {
        const rS = 0.10 + Math.min(0.18, strength * 0.02);
        const rL = 0.08 + Math.min(0.22, strength * 0.03);
        const r = Math.random();
        if (r < rS) return "small";
        if (r < rS + rL) return "large";
        return "medium";
    }

    // Color-tint palette used for subtle per-spawn visual variety.
    // Applied via source-atop so only the sprite's opaque pixels
    // get tinted, on top of any faction tint (which has its own
    // source-atop pass).
    const ENEMY_TINTS = [
        null,                            // untinted - most common
        "rgba(210, 90, 90, 0.28)",       // rust
        "rgba(90, 180, 110, 0.28)",      // moss
        "rgba(110, 140, 220, 0.28)",     // cold
        "rgba(190, 140, 210, 0.28)",     // violet
    ];
    function pickEnemyTint() {
        // 55% untinted, 45% randomly from the 4 tints.
        if (Math.random() < 0.55) return null;
        return ENEMY_TINTS[1 + Math.floor(Math.random() * (ENEMY_TINTS.length - 1))];
    }

    // Movement styles - four patterns that cover the spec.
    // "direct" is the existing behavior; the others wrap the step
    // with style-specific modifiers in Enemy.update.
    const MOVE_STYLES = ["direct", "zigzag", "heavy", "burst"];
    function pickMoveStyle(faction) {
        // Heavy sits naturally on guardians; sentinels stay direct
        // since their AI already manages preferred range.
        if (faction === "sentinel") return "direct";
        if (faction === "guardian") return Math.random() < 0.6 ? "heavy" : "direct";
        if (faction === "shadow")   return Math.random() < 0.4 ? "burst" : "direct";
        if (faction === "hunter")   return Math.random() < 0.35 ? "zigzag" : "direct";
        const r = Math.random();
        if (r < 0.25) return "zigzag";
        if (r < 0.40) return "burst";
        if (r < 0.50) return "heavy";
        return "direct";
    }

    // Attack types. Ranged is authoritative on sentinel; quick /
    // heavy scale contactDamage + attack cooldown for non-ranged
    // enemies so melee variants feel distinct.
    const ATTACK_TYPES = {
        quick: { damageMult: 0.7,  cdMin: 0.35 },
        heavy: { damageMult: 1.6,  cdMin: 1.10 },
    };
    function pickAttackType(variant, faction) {
        if (faction === "sentinel") return "ranged";
        if (variant === "large")    return "heavy";
        if (variant === "small")    return "quick";
        return Math.random() < 0.5 ? "quick" : "heavy";
    }

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

            // Knockback impulse. `takeHit(dmg, from)` sets these
            // from the hit direction and `update` integrates them
            // with exponential decay. `knockbackScale` (0..1) lets
            // bosses / elites resist - set low on heavy enemies.
            this.kbVx = 0;
            this.kbVy = 0;
            this.knockbackScale = opts.knockbackScale ?? 1.0;

            // Faction preset. Layered AFTER the base opts so per-
            // zone base stats shine through when no faction is set.
            this.factionId = opts.faction ?? null;
            this.faction = this.factionId ? FACTIONS[this.factionId] : null;
            if (this.faction) {
                const f = this.faction;
                this.hp = Math.max(1, Math.round(this.hp * (f.hpScale ?? 1)));
                this.maxHp = this.hp;
                this.speed = this.speed * (f.speedScale ?? 1);
                if (f.damageScale) {
                    this.contactDamage = Math.round(this.contactDamage * f.damageScale);
                }
                if (f.knockbackScale != null) this.knockbackScale = f.knockbackScale;
                this.neutral = !!f.neutral;
                this.ally = false;
                this.buffMult = 1;
                if (f.teleport) {
                    this.teleportTimer =
                        f.teleportMin + Math.random() * (f.teleportMax - f.teleportMin);
                }
                if (f.ranged) {
                    this.rangedCd = 0.6 + Math.random() * 0.8;
                    this.rangedCdMax = 1.8;
                }
            }
            // Pack bonus accumulator (hunter).
            this._packBonus = 1;
            // Phase-transition i-frames, used by multi-phase bosses.
            // Zero on regular enemies so takeHit's gate is a no-op.
            this.phaseInvincibleTimer = 0;

            // --- Variant / visual / behavior layer ---
            // Variants scale stats on top of whatever faction already
            // set. Roll if the caller didn't pass one explicitly.
            this.variant = opts.variant || pickVariant(playerStrength());
            const vCfg = VARIANTS[this.variant] || VARIANTS.medium;
            this.sizeScale = vCfg.sizeScale;
            this.hp = Math.max(1, Math.round(this.hp * vCfg.hpScale));
            this.maxHp = this.hp;
            this.speed = this.speed * vCfg.speedScale;

            // Movement style + attack type. Caller can override via
            // opts; otherwise roll by faction + variant so the crowd
            // is varied without being incoherent.
            this.moveStyle = opts.moveStyle || pickMoveStyle(this.factionId);
            this.attackType = opts.attackType
                ?? pickAttackType(this.variant, this.factionId);
            if (this.attackType && ATTACK_TYPES[this.attackType]) {
                const a = ATTACK_TYPES[this.attackType];
                this.contactDamage = Math.max(
                    1, Math.round(this.contactDamage * a.damageMult)
                );
                this.attackCdMin = a.cdMin;
            } else {
                this.attackCdMin = 0.6;
            }

            // Color tint layered on top of faction tint for subtle
            // per-spawn visual variety. Null = untinted.
            this.colorTint = opts.colorTint ?? pickEnemyTint();

            // Movement-style runtime state.
            this._zigPhase = Math.random() * Math.PI * 2;
            this._burstTimer = 0.5 + Math.random() * 0.8;
            this._burstDashing = false;

            // Contact attack cue - set on overlap, fades out
            // drives the brief lunge offset in draw().
            this.attackTimer = 0;
            this.attackNextAt = 0;

            // Elite promotion - bigger, stronger, glowing. Caller
            // sets opts.isElite (rareOpts does this already) or it
            // rolls from the rareSlots path in the spawner. Applied
            // LAST so it compounds on the variant + faction stats.
            this.isElite = !!opts.isElite;
            if (this.isElite) {
                this.hp = Math.max(1, Math.round(this.hp * 1.4));
                this.maxHp = this.hp;
                this.contactDamage = Math.round(this.contactDamage * 1.35);
                this.sizeScale *= 1.12;
                this.knockbackScale *= 0.8;
            }
        }

        update(dt, target) {
            if (!this.alive) return;

            if (this.hitFlash > 0) this.hitFlash = Math.max(0, this.hitFlash - dt);
            if (this.attackTimer > 0)
                this.attackTimer = Math.max(0, this.attackTimer - dt);

            // Knockback integration: while the impulse is alive the
            // enemy slides away from the hit source and their AI
            // is suppressed for the frame. Exponential decay so it
            // feels like a thrust, not a teleport.
            if (this.kbVx !== 0 || this.kbVy !== 0) {
                this.x += this.kbVx * dt;
                this.y += this.kbVy * dt;
                const decay = Math.exp(-8 * dt);
                this.kbVx *= decay;
                this.kbVy *= decay;
                // Clamp to world so knockback can't push off-map.
                this.x = Math.max(0, Math.min(WORLD_W - this.width, this.x));
                this.y = Math.max(0, Math.min(WORLD_H - this.height, this.y));
                if (Math.abs(this.kbVx) < 4 && Math.abs(this.kbVy) < 4) {
                    this.kbVx = 0;
                    this.kbVy = 0;
                }
                // Fall through to animator update below, skip AI.
                this.animator.setState("walk");
                this.animator.update(dt);
                return;
            }

            // Faction target override. Allies attack nearest hostile
            // enemy (not the player). Neutral guardians idle until
            // provoked (they flip to hostile via takeHit).
            let effectiveTarget = target;
            if (this.ally) {
                effectiveTarget = nearestHostileEnemy(this) || null;
                if (!effectiveTarget) {
                    // No one to fight; roam near home.
                    this.animator.setState("idle");
                    this.animator.update(dt);
                    return;
                }
            } else if (this.neutral) {
                // Neutral: stand still, animate idle, take no action.
                this.animator.setState("idle");
                this.animator.update(dt);
                return;
            }

            // Steer toward the target's center using a unit vector,
            // so diagonal approach isn't faster than cardinal approach.
            const cx = this.x + this.width / 2;
            const cy = this.y + this.height / 2;
            const tx = effectiveTarget.x + effectiveTarget.width / 2;
            const ty = effectiveTarget.y + effectiveTarget.height / 2;

            const dx = tx - cx;
            const dy = ty - cy;
            const dist = Math.hypot(dx, dy);

            // Shadow: periodically teleport closer to the target.
            // Caps distance so it doesn't land on top of the player.
            if (this.faction && this.faction.teleport && !this.ally) {
                this.teleportTimer -= dt;
                if (this.teleportTimer <= 0 && dist > 80) {
                    const step = Math.max(80, dist * 0.5);
                    this.x += (dx / (dist || 1)) * step;
                    this.y += (dy / (dist || 1)) * step;
                    this.hitFlash = 0.12;  // brief blink cue
                    this.teleportTimer =
                        this.faction.teleportMin +
                        Math.random() *
                        (this.faction.teleportMax - this.faction.teleportMin);
                }
            }

            // Hunter pack bonus: proximity to other hunters boosts
            // speed. Counted here instead of in synergies because
            // the pack stat is intrinsic to the hunter's AI.
            if (this.faction && this.faction.pack) {
                let packmates = 0;
                for (const e of enemies) {
                    if (e === this || !e.alive) continue;
                    if (!e.faction || !e.faction.pack) continue;
                    const edx = (e.x + e.width / 2) - cx;
                    const edy = (e.y + e.height / 2) - cy;
                    if (edx * edx + edy * edy < 150 * 150) packmates++;
                }
                this._packBonus = 1 + Math.min(3, packmates) * 0.12;
            } else {
                this._packBonus = 1;
            }

            // Sentinel: hold preferred distance from the target +
            // fire on cooldown when within line of sight range.
            let moveStep = this.speed * (this.buffMult || 1) *
                           (this._packBonus || 1) * dt;
            let wantsMove = dist > 0.5;
            if (this.faction && this.faction.ranged && !this.ally) {
                const pref = this.faction.preferredRange || 200;
                if (dist < pref - 30) {
                    // Too close: back off instead of approaching.
                    this.x -= (dx / dist) * moveStep;
                    this.y -= (dy / dist) * moveStep;
                    wantsMove = true;
                } else if (dist > pref + 30) {
                    this.x += (dx / dist) * moveStep;
                    this.y += (dy / dist) * moveStep;
                    wantsMove = true;
                } else {
                    wantsMove = false;
                }
                // Ranged fire.
                this.rangedCd -= dt;
                if (this.rangedCd <= 0 && dist < pref + 80) {
                    this.rangedCd = this.rangedCdMax;
                    spawnHostileProjectile(
                        cx, cy, tx, ty,
                        Math.max(1, Math.round(this.contactDamage * 0.6)),
                        "#b9f0c9"
                    );
                }
            } else if (wantsMove) {
                const inv = 1 / dist;
                // Movement-style modifier: zigzag adds perpendicular
                // sway, burst alternates pause / dash, heavy slows.
                let stepX = dx * inv * moveStep;
                let stepY = dy * inv * moveStep;
                const style = this.moveStyle;
                if (style === "zigzag") {
                    this._zigPhase += dt * 5;
                    const perpX = -dy * inv;
                    const perpY =  dx * inv;
                    const sway = Math.sin(this._zigPhase) * moveStep * 0.7;
                    stepX += perpX * sway;
                    stepY += perpY * sway;
                } else if (style === "heavy") {
                    stepX *= 0.75;
                    stepY *= 0.75;
                } else if (style === "burst") {
                    this._burstTimer -= dt;
                    if (this._burstTimer <= 0) {
                        this._burstDashing = !this._burstDashing;
                        this._burstTimer = this._burstDashing
                            ? 0.35
                            : 0.7 + Math.random() * 0.5;
                    }
                    if (this._burstDashing) {
                        stepX *= 2.2;
                        stepY *= 2.2;
                    } else {
                        stepX = 0;
                        stepY = 0;
                    }
                }
                this.x += stepX;
                this.y += stepY;
                wantsMove = Math.abs(stepX) > 0.01 || Math.abs(stepY) > 0.01;
            }

            if (wantsMove) {
                const d = dirFromVector(dx, dy);
                if (d !== null) this.animator.setDir(d);
            }

            this.animator.setState(wantsMove ? "walk" : "idle");
            this.animator.update(dt);
        }

        draw(ctx) {
            if (!this.alive) return;
            const x = Math.round(this.x);
            const y = Math.round(this.y);

            // Attack-state lunge: a 2px nudge toward the target for
            // the brief attackTimer window. Simulates an attack frame
            // without new sprite art.
            let lungeX = 0, lungeY = 0;
            if (this.attackTimer > 0 && player.alive) {
                const pcx = player.x + player.width / 2;
                const pcy = player.y + player.height / 2;
                const ldx = pcx - (x + this.width / 2);
                const ldy = pcy - (y + this.height / 2);
                const lmag = Math.hypot(ldx, ldy) || 1;
                lungeX = (ldx / lmag) * 2;
                lungeY = (ldy / lmag) * 2;
            }

            // Size-scaled sprite draw. When sizeScale != 1 we call
            // drawImage directly so the sprite can stretch; collision
            // stays at the unscaled 32x32 box so hitreg is consistent.
            const scale = this.sizeScale || 1;
            const dw = this.width * scale;
            const dh = this.height * scale;
            const drawX = x + lungeX - (dw - this.width) / 2;
            const drawY = y + lungeY - (dh - this.height) / 2;
            ctx.drawImage(
                this.sheet.image,
                this.animator.col * this.sheet.frameW,
                this.animator.row * this.sheet.frameH,
                this.sheet.frameW, this.sheet.frameH,
                drawX, drawY, dw, dh
            );

            // Faction tint - one source-atop fillRect per tinted
            // enemy. Shadow / hunter / sentinel / guardian each
            // carry a distinct color so the crowd reads as mixed.
            if (this.faction) {
                ctx.save();
                ctx.globalCompositeOperation = "source-atop";
                ctx.fillStyle = this.faction.tint;
                ctx.fillRect(drawX, drawY, dw, dh);
                ctx.restore();
            }
            // Per-spawn color tint layered on top for subtle variety.
            if (this.colorTint) {
                ctx.save();
                ctx.globalCompositeOperation = "source-atop";
                ctx.fillStyle = this.colorTint;
                ctx.fillRect(drawX, drawY, dw, dh);
                ctx.restore();
            }

            // Elite halo - thin gold ring around the sprite plus a
            // soft additive glow so the player can pick elites out
            // of a crowd at a glance.
            if (this.isElite) {
                const cx = drawX + dw / 2;
                const cy = drawY + dh / 2;
                const r = Math.max(dw, dh) * 0.6;
                ctx.save();
                ctx.globalCompositeOperation = "lighter";
                const pulse = 0.5 + 0.25 * Math.sin(performance.now() * 0.006);
                ctx.globalAlpha = 0.35 + pulse * 0.15;
                ctx.fillStyle = "#ffd166";
                ctx.beginPath();
                ctx.arc(cx, cy, r, 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();
                ctx.strokeStyle = "rgba(255, 230, 130, 0.8)";
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.arc(cx, cy, r * 0.88, 0, Math.PI * 2);
                ctx.stroke();
            }

            // Allied guardian marker - a thin green ring so the
            // player can tell at a glance which creature is with
            // them instead of against them.
            if (this.ally) {
                ctx.save();
                ctx.strokeStyle = "rgba(130, 220, 120, 0.8)";
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.arc(x + this.width / 2, y + this.height - 2, 10, 0, Math.PI * 2);
                ctx.stroke();
                ctx.restore();
            }

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

        takeHit(damage = 1, from = null) {
            // Multi-phase bosses get a short i-frame window on each
            // phase transition so the player can't delete the next
            // phase in the first half-second. No-op on regular enemies.
            if (this.phaseInvincibleTimer > 0) {
                this.hitFlash = this.hitFlashDuration * 0.4;
                return;
            }
            this.hp -= damage;
            this.hitFlash = this.hitFlashDuration;
            sound.play("enemyHit");
            // Neutral guardian provoked: flips hostile and pursues
            // the player from the next tick. Offering alliance (E)
            // would have been the peaceful path.
            if (this.neutral && !this.ally) this.neutral = false;

            // Small screen shake on impact; slightly bigger for
            // kill hits so the payoff reads.
            const killing = this.hp <= 0;
            shake.trigger(killing ? 5 : 3, killing ? 0.18 : 0.10);

            // Knockback away from the hit source. `from` is a
            // { x, y } point in world space (attacker center /
            // projectile center); skipped if the caller didn't
            // supply one or this enemy resists.
            if (from && this.knockbackScale > 0) {
                const cx = this.x + this.width / 2;
                const cy = this.y + this.height / 2;
                const dx = cx - from.x;
                const dy = cy - from.y;
                const d = Math.hypot(dx, dy);
                if (d > 0.01) {
                    const kbSpeed = 220 * this.knockbackScale;
                    this.kbVx = (dx / d) * kbSpeed;
                    this.kbVy = (dy / d) * kbSpeed;
                } else {
                    // Hit from inside - push randomly so nothing
                    // stays perfectly stuck.
                    const a = Math.random() * Math.PI * 2;
                    this.kbVx = Math.cos(a) * 120 * this.knockbackScale;
                    this.kbVy = Math.sin(a) * 120 * this.knockbackScale;
                }
            }

            if (killing) this.alive = false;
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
    // Boss
    //
    // A heavier enemy with a deliberate attack loop rather than
    // blind pursuit. Three phases:
    //
    //   stalk    - slow pursuit while they size the player up
    //   wind-up  - short telegraph (red aura pulse) before a charge
    //   charge   - locked-direction dash at ~4x base speed
    //   recover  - brief stand-still window, vulnerable to attack
    //
    // The whole pattern is on a single `stateTimer`, so tuning is
    // done by editing the durations and speeds at the top of the
    // file. Bosses inherit from Enemy so they ride the same hit-
    // flash / takeHit / bounds path as regular mobs.
    // ---------------------------------------------------------------
    class Boss extends Enemy {
        constructor(x, y, opts = {}) {
            super(x, y, {
                width: 64,
                height: 64,
                speed: opts.speed ?? 70,
                hp: opts.hp ?? 28,
                reward: opts.reward ?? 500,
                xpReward: opts.xpReward ?? 100,
                contactDamage: opts.contactDamage ?? 25,
                // Heavy - mostly shrugs off knockback, so the player
                // can't simply juggle them with a sword.
                knockbackScale: opts.knockbackScale ?? 0.2,
                ...opts,
            });
            this.isBoss = true;
            this.name = opts.name ?? "Shrine Keeper";
            // Level this boss belongs to, so its defeat can be
            // remembered without respawning on every visit.
            this.levelId = opts.levelId ?? null;

            this.behavior = "stalk";
            this.stateTimer = 1.8;
            this.chargeVx = 0;
            this.chargeVy = 0;
            this.bobPhase = Math.random() * Math.PI * 2;

            // Tunables
            this.stalkDuration = 1.8;        // time between charges
            this.windUpDuration = 0.45;      // telegraph window
            this.chargeDuration = 0.55;      // dash window
            this.chargeSpeedMultiplier = 4;  // of base speed
            this.recoverDuration = 1.2;      // vulnerable pause

            // Multi-phase mode (Throne Warden). Off by default so
            // the Shrine Keeper keeps its existing single-phase AI.
            // When on, HP thresholds at 66% and 33% flip phase state
            // and retune stalk / windup / recover cadence on the fly.
            this.multiPhase = !!opts.multiPhase;
            this.phase = 1;
            this.phaseInvincibleTimer = 0;    // >0 -> takeHit() is a no-op
            this.rangedCd = 0;
            this.targetIndex = 0;             // round-robin: player, squad[0], ...
            if (this.multiPhase) this._applyPhase(1);
        }

        _applyPhase(n) {
            this.phase = n;
            if (n === 1) {
                // Slow + heavy: long telegraphs, short stalk bursts,
                // hits hard but forgiving windows for the player to
                // learn the pattern.
                this.speed = 58;
                this.stalkDuration = 2.0;
                this.windUpDuration = 0.55;
                this.recoverDuration = 1.3;
                this.chargeSpeedMultiplier = 4.0;
                this.contactDamage = 22;
                this.rangedCd = Infinity;
            } else if (n === 2) {
                // Faster + ranged: shorter cycles plus periodic
                // projectile volleys between charges so the player
                // can't just sit outside melee range.
                this.speed = 86;
                this.stalkDuration = 1.4;
                this.windUpDuration = 0.38;
                this.recoverDuration = 1.0;
                this.chargeSpeedMultiplier = 4.6;
                this.contactDamage = 24;
                this.rangedCd = 1.5;
            } else {
                // Aggressive + cinematic: tight windows, big speed,
                // ranged volleys still firing so the phase reads as
                // "everything at once". flash + shake on each charge.
                this.speed = 108;
                this.stalkDuration = 0.9;
                this.windUpDuration = 0.28;
                this.recoverDuration = 0.7;
                this.chargeSpeedMultiplier = 5.2;
                this.contactDamage = 28;
                this.rangedCd = 1.0;
            }
        }

        _checkPhaseTransition() {
            if (!this.multiPhase) return;
            const frac = this.hp / this.maxHp;
            const want = frac > 0.66 ? 1 : frac > 0.33 ? 2 : 3;
            if (want !== this.phase) {
                const newPhase = want;
                this._applyPhase(newPhase);
                // Phase transition cinematic. Short i-frame window
                // + flash + shake + zoom + toast so the change
                // reads as a beat, not a stat flicker.
                this.phaseInvincibleTimer = 0.9;
                this.behavior = "stalk";
                this.stateTimer = 0.9;
                flash.trigger(0.7, 0.35);
                shake.trigger(18, 0.45);
                camera.zoomPulse(1.1, 0.3);
                questLog.showToast(
                    newPhase === 2
                        ? `${this.name}: shift - ranged fury!`
                        : `${this.name}: final stand!`,
                    2.4
                );
                sound.play("super");
            }
        }

        _currentTarget(player) {
            // Round-robin between the player and any live squad
            // members. Reshuffle each time stalk starts so the
            // target isn't predictable.
            const candidates = [player];
            for (const f of followers) {
                if (f.hp > 0) candidates.push(f);
            }
            const idx = this.targetIndex % candidates.length;
            return candidates[idx];
        }

        update(dt, target) {
            if (!this.alive) return;
            if (this.hitFlash > 0) {
                this.hitFlash = Math.max(0, this.hitFlash - dt);
            }
            if (this.phaseInvincibleTimer > 0) {
                this.phaseInvincibleTimer = Math.max(
                    0, this.phaseInvincibleTimer - dt
                );
            }

            // Multi-phase target routing: rotate between player +
            // live squad members each stalk cycle. Falls through to
            // the caller's target when multiPhase is off.
            const aimedTarget = this.multiPhase
                ? this._currentTarget(player)
                : target;

            this.stateTimer -= dt;
            this.bobPhase += dt * 3;

            // Phase 2+: ranged volley during stalk / recover windows
            // so the boss isn't only dangerous at melee.
            if (this.multiPhase && this.phase >= 2 && this.alive) {
                this.rangedCd -= dt;
                if (this.rangedCd <= 0 &&
                    (this.behavior === "stalk" || this.behavior === "recover")) {
                    const base = 1.8 - (this.phase - 2) * 0.4;
                    this.rangedCd = base;
                    const cx = this.x + this.width / 2;
                    const cy = this.y + this.height / 2;
                    const tx = aimedTarget.x + aimedTarget.width / 2;
                    const ty = aimedTarget.y + aimedTarget.height / 2;
                    // 1 bolt in phase 2, 3 in phase 3 (a fan pattern).
                    const volley = this.phase >= 3 ? 3 : 1;
                    for (let i = 0; i < volley; i++) {
                        const spread = (i - (volley - 1) / 2) * 0.18;
                        const dx = tx - cx;
                        const dy = ty - cy;
                        const ang = Math.atan2(dy, dx) + spread;
                        const far = 240;
                        spawnHostileProjectile(
                            cx, cy,
                            cx + Math.cos(ang) * far,
                            cy + Math.sin(ang) * far,
                            Math.max(1, Math.round(this.contactDamage * 0.35)),
                            this.phase >= 3 ? "#ffa040" : "#c080ff"
                        );
                    }
                }
            }

            switch (this.behavior) {
                case "stalk":
                    this._stepToward(aimedTarget, this.speed, dt);
                    if (this.stateTimer <= 0) {
                        this.behavior = "windup";
                        this.stateTimer = this.windUpDuration;
                    }
                    break;

                case "windup":
                    // Freeze in place and telegraph. The red aura
                    // pulse in draw() tells the player to dodge.
                    if (this.stateTimer <= 0) {
                        // Lock in the charge direction at this moment.
                        const cx = this.x + this.width / 2;
                        const cy = this.y + this.height / 2;
                        const tx = aimedTarget.x + aimedTarget.width / 2;
                        const ty = aimedTarget.y + aimedTarget.height / 2;
                        const dx = tx - cx;
                        const dy = ty - cy;
                        const d = Math.hypot(dx, dy) || 1;
                        const s = this.speed * this.chargeSpeedMultiplier;
                        this.chargeVx = (dx / d) * s;
                        this.chargeVy = (dy / d) * s;
                        this.behavior = "charge";
                        this.stateTimer = this.chargeDuration;
                        // Phase 3 punches in extra weight on each
                        // charge start so the finale reads cinematic.
                        if (this.multiPhase && this.phase >= 3) {
                            shake.trigger(10, 0.18);
                            flash.trigger(0.25, 0.12);
                        }
                    }
                    break;

                case "charge":
                    this.x += this.chargeVx * dt;
                    this.y += this.chargeVy * dt;
                    // Stay on the map during a dash.
                    this.x = Math.max(0, Math.min(WORLD_W - this.width, this.x));
                    this.y = Math.max(0, Math.min(WORLD_H - this.height, this.y));
                    if (this.stateTimer <= 0) {
                        this.behavior = "recover";
                        this.stateTimer = this.recoverDuration;
                    }
                    break;

                case "recover":
                    // Vulnerable window - boss stands still.
                    if (this.stateTimer <= 0) {
                        this.behavior = "stalk";
                        this.stateTimer = this.stalkDuration + Math.random() * 0.8;
                        // Cycle to the next target after each full
                        // charge cycle so the boss doesn't tunnel on
                        // one unit.
                        if (this.multiPhase) this.targetIndex++;
                    }
                    break;
            }

            // After behavior step, re-check phase thresholds - if a
            // player hit crossed one last frame, transition now.
            this._checkPhaseTransition();
        }

        _stepToward(target, speed, dt) {
            const cx = this.x + this.width / 2;
            const cy = this.y + this.height / 2;
            const tx = target.x + target.width / 2;
            const ty = target.y + target.height / 2;
            const dx = tx - cx;
            const dy = ty - cy;
            const d = Math.hypot(dx, dy);
            if (d > 0.5) {
                const inv = 1 / d;
                this.x += dx * inv * speed * dt;
                this.y += dy * inv * speed * dt;
            }
        }

        draw(ctx) {
            if (!this.alive) return;
            const x = Math.round(this.x);
            const y = Math.round(this.y);

            // Shadow
            ctx.fillStyle = "rgba(0, 0, 0, 0.42)";
            ctx.beginPath();
            ctx.ellipse(x + 32, y + 60, 22, 5, 0, 0, Math.PI * 2);
            ctx.fill();

            // Wind-up telegraph: pulsing red aura around the boss.
            if (this.behavior === "windup") {
                const t = 1 - this.stateTimer / this.windUpDuration; // 0 -> 1
                const pulse = 0.35 + 0.55 * Math.abs(Math.sin(t * 18));
                ctx.save();
                ctx.globalAlpha = pulse * 0.6;
                ctx.fillStyle = "#ff3030";
                ctx.beginPath();
                ctx.arc(x + 32, y + 32, 44 + t * 8, 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();
            }

            // Charge streak: motion-blur feel via a semi-transparent
            // trail box behind the boss.
            if (this.behavior === "charge") {
                ctx.save();
                ctx.globalAlpha = 0.28;
                ctx.fillStyle = "#ff6a6a";
                ctx.fillRect(x - 6, y - 6, 76, 76);
                ctx.restore();
            }

            const bob = Math.sin(this.bobPhase) * 1;

            // Body
            ctx.fillStyle = "#8c1e3e";
            ctx.fillRect(x + 4, y + 10, 56, 48);
            ctx.fillStyle = "#5a0f26";
            ctx.fillRect(x + 4, y + 50, 56, 8);
            // Shoulder highlight
            ctx.fillStyle = "#b83a5a";
            ctx.fillRect(x + 6, y + 12, 52, 3);

            // Brow
            ctx.fillStyle = "#3c0812";
            ctx.fillRect(x + 12, y + 22 + bob, 12, 3);
            ctx.fillRect(x + 40, y + 22 + bob, 12, 3);

            // Eyes (glow red in recover, menacing white otherwise)
            const eyeColor = this.behavior === "recover" ? "#ffa0a0" : "#ffe6e6";
            ctx.fillStyle = eyeColor;
            ctx.fillRect(x + 14, y + 26 + bob, 8, 6);
            ctx.fillRect(x + 42, y + 26 + bob, 8, 6);
            ctx.fillStyle = "#1a1a24";
            ctx.fillRect(x + 16, y + 28 + bob, 4, 4);
            ctx.fillRect(x + 44, y + 28 + bob, 4, 4);

            // Mouth with tooth line
            ctx.fillStyle = "#1a1a24";
            ctx.fillRect(x + 18, y + 42, 28, 6);
            ctx.fillStyle = "#ffe6e6";
            for (let tx = x + 20; tx < x + 46; tx += 4) {
                ctx.fillRect(tx, y + 43, 2, 2);
            }

            // Hit flash (source-atop over the body - same trick as Enemy).
            if (this.hitFlash > 0) {
                const a = Math.min(1, this.hitFlash / this.hitFlashDuration);
                ctx.save();
                ctx.globalCompositeOperation = "source-atop";
                ctx.fillStyle = `rgba(255, 255, 255, ${a.toFixed(3)})`;
                ctx.fillRect(x, y, this.width, this.height);
                ctx.restore();
            }
        }
    }

    // Track which bosses have been defeated this run so they don't
    // respawn every time the player revisits their room. Cleared on
    // restart like the door-lock set.
    const defeatedBosses = new Set();

    // Spawn up to 4 reserve recruits as ally "skirmishers" at the
    // start of a hostile zone. Each skirmisher is a basic Enemy
    // instance with ally + neutral flags matching the allied-guardian
    // contract, so the existing ally AI + damage routing apply with
    // no new pipeline. Damage and hp are modest so they support the
    // player rather than trivializing waves.
    //
    // Positions fan out in a short arc behind the player so the
    // battle reads as "you brought a line", not a surprise drop.
    function spawnReserveSkirmishers() {
        const reserves = companions.reserveCount();
        if (reserves <= 0) return;
        const count = Math.min(4, reserves);
        const pcx = player.x + player.width / 2;
        const pcy = player.y + player.height / 2;
        const slots = [
            { dx: -64, dy:  40 },
            { dx:  64, dy:  40 },
            { dx: -96, dy:   0 },
            { dx:  96, dy:   0 },
        ];
        for (let i = 0; i < count; i++) {
            const s = slots[i];
            const e = new Enemy(pcx + s.dx - 16, pcy + s.dy - 16, {
                hp: 12, speed: 80, contactDamage: 4,
                reward: 0, xpReward: 0,
            });
            // Flip to ally after construction so the normal ally /
            // neutral collision paths kick in. Also skip the elite
            // ring + faction tint by leaving faction unset.
            e.ally = true;
            e.neutral = false;
            e.isSkirmisher = true;
            // Small visual: grey-green tint so they read as friendly
            // irregulars, not enemies.
            e.colorTint = "rgba(120, 180, 120, 0.35)";
            enemies.push(e);
        }
    }

    function spawnBoss(config, levelId) {
        if (!config) return null;
        if (defeatedBosses.has(levelId)) return null;
        if (enemies.length >= MAX_ENEMIES) return null;
        // Story gate: if the boss config carries a chapterGate, only
        // spawn the boss when the player has reached that chapter.
        // Avoids surfacing a chapter-3 boss during chapter-1 scouting.
        if (config.chapterGate && !story.atLeast(config.chapterGate)) {
            return null;
        }
        const boss = new Boss(config.x, config.y, { ...config, levelId });
        enemies.push(boss);
        return boss;
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
    // Rolling kill-rate tracker. Timestamps of enemy defeats in the
    // last 30s, popped as they age out. Drives one factor of the
    // player-strength heuristic below without scanning every enemy
    // per frame.
    const killHistory = [];
    function noteKillTimestamp() {
        const now = performance.now() / 1000;
        killHistory.push(now);
        // Drop old entries so the array can't grow unbounded.
        while (killHistory.length && killHistory[0] < now - 30) {
            killHistory.shift();
        }
    }
    function recentKillsPerMin() {
        const now = performance.now() / 1000;
        while (killHistory.length && killHistory[0] < now - 30) {
            killHistory.shift();
        }
        // Kills over 30s -> kills per minute.
        return killHistory.length * 2;
    }

    // Lightweight composite of offensive progression. Used by the
    // wave builder to nudge count + enemy stats so a leveled-up
    // player with a sharpened sword sees denser / tougher waves than
    // a fresh run. Clamped at the top so it can't cascade into a
    // kill-in-one-hit meta.
    function playerStrength() {
        const levelScore = stats.level;
        const sword = swordWeapon.damage ?? 1;
        const energy = energyWeapon.damage ?? 1;
        const dmgScore = Math.max(sword, energy) - 1;  // bonus over baseline
        const killScore = Math.min(6, recentKillsPerMin() / 10);
        return levelScore + dmgScore + killScore;
    }

    // Builds the configuration for wave N based on the level's base
    // opts, the wave index (0..total-1), and the player's current
    // strength. Keeps the math in one place so adaptive tuning is
    // easy to read + tweak.
    // Strength-weighted faction mix. Weak players face mostly
    // shadow + hunter; stronger players see sentinels and the
    // occasional guardian. buildWave picks a faction for each
    // spawn slot from this table.
    function pickFactionForSlot(strength) {
        // Weights sum to 100. Rebalanced by strength so late-game
        // waves skew toward the harder factions without dropping
        // variety completely.
        let wShadow, wHunter, wSentinel, wGuardian;
        if (strength < 2) {
            wShadow = 55; wHunter = 35; wSentinel = 8;  wGuardian = 2;
        } else if (strength < 5) {
            wShadow = 40; wHunter = 35; wSentinel = 18; wGuardian = 7;
        } else {
            wShadow = 30; wHunter = 28; wSentinel = 28; wGuardian = 14;
        }
        let r = Math.random() * (wShadow + wHunter + wSentinel + wGuardian);
        if ((r -= wShadow)   < 0) return "shadow";
        if ((r -= wHunter)   < 0) return "hunter";
        if ((r -= wSentinel) < 0) return "sentinel";
        return "guardian";
    }

    function buildWave(index, total, strength, baseOpts, perWaveBase) {
        // Wave count: base + index ramp + strength bump, hard-capped
        // so stronger players don't summon literal hordes. Larger
        // ceiling (20) now that the spawner's maxOnScreen cap keeps
        // the active population readable regardless of queue size.
        const count = Math.min(
            20,
            perWaveBase + 2 + index + Math.floor(strength * 0.6)
        );
        // Stat scale: gentle per-wave ramp plus strength add. Enemies
        // never exceed 2.5x their base stats even at max strength +
        // final wave, so the curve is firm but fair.
        const hpScale = Math.min(2.5, 1 + index * 0.15 + strength * 0.08);
        const spdScale = Math.min(1.6, 1 + index * 0.05 + strength * 0.03);
        const opts = {
            hp: Math.max(1, Math.round((baseOpts.hp ?? 3) * hpScale)),
            speed: Math.round((baseOpts.speed ?? 100) * spdScale),
        };
        // Preserve passthrough fields (contactDamage, reward, xpReward)
        // so zone-specific tuning survives the scale pass.
        if (baseOpts.contactDamage != null) opts.contactDamage = baseOpts.contactDamage;
        if (baseOpts.reward != null)        opts.reward        = baseOpts.reward;
        if (baseOpts.xpReward != null)      opts.xpReward      = baseOpts.xpReward;

        // Per-slot faction roll. Separated so rareOpts-composed
        // elites still carry the faction flavor into their stats
        // and synergies.
        const factions = new Array(count);
        for (let i = 0; i < count; i++) {
            factions[i] = pickFactionForSlot(strength);
        }

        // Rare slots: one elite per wave at ~35% chance once the
        // player has a little strength, adding variance without
        // telegraphing the exact spawn index.
        const rareSlots = new Set();
        const rareChance = 0.20 + Math.min(0.25, strength * 0.04);
        if (count > 0 && Math.random() < rareChance) {
            rareSlots.add(Math.floor(Math.random() * count));
        }
        return { count, opts, rareSlots, factions };
    }

    function rareOpts(base) {
        return {
            hp: Math.max(1, Math.round((base.hp ?? 3) * 2)),
            speed: Math.round((base.speed ?? 100) * 1.1 + 10),
            contactDamage: base.contactDamage,
            reward: Math.round((base.reward ?? 10) * 3),
            xpReward: Math.round((base.xpReward ?? 10) * 2),
            isElite: true,
            // Elites lean into the "large, heavy hitter" read -
            // variant + move style are pinned so the elite always
            // feels like a distinct threat rather than a random
            // reshuffle.
            variant: "large",
            moveStyle: "heavy",
            attackType: "heavy",
        };
    }

    const spawner = {
        // --- Placement constraints ---
        minDistFromPlayer: 200,
        margin: 64,

        // --- Per-level config (set by configure) ---
        baseOpts: {},
        baseWaveCount: 3,
        perWaveBase: 5,

        // --- Wave runtime ---
        waveIndex: 0,         // 1-based externally, 0-based internally
        totalWaves: 3,
        waveState: "idle",    // "active" | "intermission" | "complete"
        intermissionTimer: 0,
        spawnQueue: 0,        // enemies left to spawn in this wave
        spawnTimer: 0,        // seconds until next stagger-spawn
        spawnIndex: 0,        // cursor into rareSlots (which indexes are elite)
        remainingToKill: 0,   // alive + unspawned wave members
        currentOpts: {},
        rareSlots: new Set(),

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
                const col = Math.floor(x / TILE);
                const row = Math.floor(y / TILE);
                if (world.isSolid(col, row)) continue;
                return { x, y };
            }
            return null;
        },

        configure(level) {
            this.baseOpts = level.enemyOpts ?? {};
            // Per-zone tuning bumped to the "longer fight" range:
            // 8 / 10 / 12 as the base, +strength nudge up to the
            // 20-wave cap below. Early zones stay manageable; late
            // zones feel like real campaigns.
            const map = { caverns: 8, shrine: 10, abyss: 12 };
            this.baseWaveCount = level.waveCount ?? map[level.id] ?? 6;
            this.perWaveBase = Math.max(3, level.enemyCount ?? 5);
        },

        // Seed the first wave on level entry. Boss (if any) is spawned
        // alongside so shrine's Keeper still appears immediately.
        seed() {
            if (isSafeZone()) return;
            const strength = playerStrength();
            // Strength bump up to +6 now that base waves are higher.
            // Hard cap at 20 per spec so campaigns don't become
            // endurance tests.
            this.totalWaves = Math.min(
                20,
                this.baseWaveCount + Math.min(6, Math.floor(strength / 2))
            );
            this.waveIndex = 0;
            this.startWave();
            if (currentLevel.boss) {
                spawnBoss(currentLevel.boss, currentLevel.id);
            }
            // Large-scale battle: reserve recruits spawn as ally
            // skirmishers in hostile zones. Bounded so the screen
            // doesn't flood - only as many as 4 at a time, even if
            // the player has 20 reserves.
            spawnReserveSkirmishers();
        },

        startWave() {
            const cfg = buildWave(
                this.waveIndex, this.totalWaves,
                playerStrength(), this.baseOpts, this.perWaveBase
            );
            this.spawnQueue = cfg.count;
            this.remainingToKill = cfg.count;
            this.spawnIndex = 0;
            this.spawnTimer = 0.15;     // small lead-in before the first spawn
            this.currentOpts = cfg.opts;
            this.rareSlots = cfg.rareSlots;
            this.currentFactions = cfg.factions || [];
            this.waveState = "active";
            questLog.showToast(
                `Wave ${this.waveIndex + 1} / ${this.totalWaves}`, 1.8
            );
        },

        onEnemyDefeated(enemy) {
            // Bosses don't count toward wave clear - they're their
            // own encounter beat on top of the wave pacing.
            if (enemy && enemy.isBoss) return;
            if (this.waveState !== "active") return;
            if (this.remainingToKill > 0) this.remainingToKill--;
            if (this.remainingToKill === 0 && this.spawnQueue === 0) {
                this.onWaveCleared();
            }
        },

        onWaveCleared() {
            this.waveIndex++;
            if (this.waveIndex >= this.totalWaves) {
                this.waveState = "complete";
                this.onAllWavesCleared();
            } else {
                this.waveState = "intermission";
                // Short break every 5 waves. Gives the player a
                // breather and a chance to reposition + loot after
                // a sustained push.
                const longBreak = this.waveIndex % 5 === 0;
                this.intermissionTimer = longBreak ? 5.0 : 2.5;
                questLog.showToast(
                    longBreak
                        ? `Wave ${this.waveIndex} cleared - brief reprieve.`
                        : `Wave ${this.waveIndex} cleared!`,
                    longBreak ? 2.2 : 1.4
                );
                sound.play("levelUp");
            }
        },

        // Final wave reward: drops a small loot burst in front of
        // the player - a potion + two magic orbs to refill resources
        // ahead of the next zone.
        onAllWavesCleared() {
            const pcx = player.x + player.width / 2;
            const pcy = player.y + player.height / 2;
            spawnDrop(pcx, pcy + 36, "potion");
            spawnDrop(pcx - 24, pcy + 36, "magic_orb");
            spawnDrop(pcx + 24, pcy + 36, "magic_orb");
            questLog.showToast(
                "All waves cleared! The path ahead opens.", 3.0
            );
            sound.play("levelUp");
        },

        update(dt) {
            if (isSafeZone()) return;
            if (this.waveState === "complete" || this.waveState === "idle") return;

            if (this.waveState === "intermission") {
                this.intermissionTimer -= dt;
                if (this.intermissionTimer <= 0) this.startWave();
                return;
            }

            // active: stagger-spawn the remaining queue. On-screen
            // cap keeps the population readable on mobile even when
            // a wave queue is large. Queued spawns wait patiently
            // until a slot opens, so wave clear is still gated on
            // killing the full queued count.
            const MAX_ON_SCREEN = 14;
            // Burst waves: every 4th wave drops a small cluster of
            // enemies from multiple compass edges all at once, then
            // continues the normal stagger. Reads as a coordinated
            // ambush instead of an endless trickle.
            const burstWave = (this.waveIndex + 1) % 4 === 0;
            // Spawn cadence scales with wave depth so later waves
            // pour in faster. Clamped so the screen never floods.
            const baseCd = Math.max(0.18,
                0.32 - this.waveIndex * 0.012);
            if (this.spawnQueue > 0 && enemies.length < MAX_ON_SCREEN) {
                this.spawnTimer -= dt;
                if (this.spawnTimer <= 0) {
                    // Burst wave: spawn up to 3 enemies in a single
                    // tick from different directions. Regular waves
                    // keep the 1-per-tick stagger.
                    const batch = burstWave ? 3 : 1;
                    for (let b = 0; b < batch; b++) {
                        if (this.spawnQueue <= 0) break;
                        if (enemies.length >= MAX_ON_SCREEN) break;
                        const slotIdx = this.spawnIndex;
                        const isRare = this.rareSlots.has(slotIdx);
                        const base = isRare
                            ? rareOpts(this.currentOpts)
                            : this.currentOpts;
                        const faction = this.currentFactions[slotIdx] || null;
                        const opts = faction
                            ? Object.assign({}, base, { faction })
                            : base;
                        // Burst spawns fan out around the player on
                        // a specific edge per slot so the ambush
                        // reads as "from all sides". Regular waves
                        // use the classic random world-space spot.
                        const spot = burstWave
                            ? this.findEdgeSpot(b)
                            : this.findSpot();
                        if (spot) spawnEnemy(spot.x, spot.y, opts);
                        this.spawnQueue--;
                        this.spawnIndex++;
                    }
                    this.spawnTimer = burstWave ? 0.7 : baseCd;
                }
            }
        },

        // Cluster spawn: picks a point on one of four compass edges
        // around the player, ~300px out, so burst-wave enemies come
        // from distinct directions rather than one hot spot.
        findEdgeSpot(slot) {
            const pcx = player.x + player.width / 2;
            const pcy = player.y + player.height / 2;
            const side = slot % 4;
            const dist = 300;
            let x, y;
            if (side === 0)      { x = pcx; y = pcy - dist; }
            else if (side === 1) { x = pcx; y = pcy + dist; }
            else if (side === 2) { x = pcx - dist; y = pcy; }
            else                 { x = pcx + dist; y = pcy; }
            // Small jitter so spawns don't all snap to the exact
            // cardinal axes.
            x += (Math.random() - 0.5) * 80;
            y += (Math.random() - 0.5) * 80;
            // Clamp to the world.
            x = Math.max(this.margin, Math.min(WORLD_W - this.margin, x));
            y = Math.max(this.margin, Math.min(WORLD_H - this.margin, y));
            return { x, y };
        },

        reset() {
            this.waveIndex = 0;
            this.waveState = "idle";
            this.intermissionTimer = 0;
            this.spawnQueue = 0;
            this.spawnTimer = 0;
            this.spawnIndex = 0;
            this.remainingToKill = 0;
            this.rareSlots = new Set();
        },
    };

    // Initialize runtime values from the opening config before seeding.
    spawner.configure(currentLevel);
    spawner.reset();
    spawner.seed();
    animals.spawnAll();
    maybeSpawnWildLightCreature(currentLevel);
    // Note: city cluster assignment + cityChat reset run later in
    // the IIFE, once the cityChat module has been initialized -
    // moving these up here would TDZ-crash on the `const cityChat`
    // that lives further down in the file.

    // Collapse the cloak onto the player's starting position and
    // stagger the aura motes so the first drawn frame doesn't show
    // a tail stretched from (0,0) or a cluster of particles popping
    // in together.
    cloak.snap();
    aura.snap();

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

            // Per-NPC pause + walk windows. Passing different ranges
            // gives each NPC their own rhythm - kids bounce quickly,
            // elders linger, shopkeepers barely move.
            this.idleMin = config.idleMin ?? 1.2;
            this.idleMax = config.idleMax ?? 3.6;
            this.walkMin = config.walkMin ?? 3.0;
            this.walkMax = config.walkMax ?? 6.0;

            // Routine selector:
            //   "wander"  (default) - random point within wanderRadius of home
            //   "patrol"            - cycles through config.waypoints in order
            //   "gather"            - occasionally heads to config.gatherPoint
            //                         (with jitter) instead of wandering.
            // Adding a new routine is one more branch in
            // `_pickWanderTarget` plus new config fields.
            this.routine = config.routine ?? "wander";
            this.waypoints = config.waypoints ?? null;
            this.waypointIndex = 0;
            this.gatherPoint = config.gatherPoint ?? null;
            this.gatherChance = config.gatherChance ?? 0.35;
            this.gatherJitter = config.gatherJitter ?? 48;

            this.state = "idle";
            this.stateTimer = 0.3 + Math.random() * this.idleMax;
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
                    this.stateTimer = this.walkMin +
                        Math.random() * (this.walkMax - this.walkMin);
                }
                return;
            }

            // Walking - step toward target, stop when close or when
            // the safety timer runs out.
            const dx = this.targetX - this.x;
            const dy = this.targetY - this.y;
            const dist = Math.hypot(dx, dy);
            const reached = dist < 2;
            if (reached || this.stateTimer <= 0) {
                // Only advance the patrol cursor on clean arrival.
                // If the walk timer simply expired, the next walk
                // re-targets the same waypoint so long routes still
                // complete after a short pause.
                if (reached && this.routine === "patrol" &&
                    this.waypoints && this.waypoints.length > 0) {
                    this.waypointIndex =
                        (this.waypointIndex + 1) % this.waypoints.length;
                }
                this.state = "idle";
                this.stateTimer = this.idleMin +
                    Math.random() * (this.idleMax - this.idleMin);
                return;
            }
            // Night / dusk slow everyone down so the city visibly
            // winds down after dark. worldClock returns 1.0 during
            // the day so this is a no-op otherwise.
            const step = Math.min(dist, this.speed * worldClock.npcSpeedMult() * dt);
            const inv = 1 / dist;
            this.x += dx * inv * step;
            this.y += dy * inv * step;
        }

        _pickWanderTarget() {
            let tx, ty;

            if (this.routine === "patrol" &&
                this.waypoints && this.waypoints.length > 0) {
                // Head toward the current waypoint (advanced on
                // arrival in `update`, not here).
                const wp = this.waypoints[this.waypointIndex];
                tx = wp.x;
                ty = wp.y;
            } else if (this.routine === "gather" && this.gatherPoint &&
                       Math.random() < this.gatherChance) {
                // Occasionally walk to the shared gather spot with a
                // little jitter so multiple gatherers don't pile on
                // exactly the same tile.
                tx = this.gatherPoint.x + (Math.random() - 0.5) * this.gatherJitter * 2;
                ty = this.gatherPoint.y + (Math.random() - 0.5) * this.gatherJitter * 2;
            } else {
                // Default: random polar target within wanderRadius
                // of the NPC's home spawn.
                const angle = Math.random() * Math.PI * 2;
                const r = 18 + Math.random() * this.wanderRadius;
                tx = this.homeX + Math.cos(angle) * r;
                ty = this.homeY + Math.sin(angle) * r;
            }

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
        // Distance-cull: NPCs too far from the player skip their
        // state-machine tick this frame. They still draw (cheap),
        // so the player sees a populated city; they just pause
        // their wander / patrol until the player gets closer. This
        // keeps mobile perf stable in a dense city even with 30+
        // NPCs since idle work is bounded by "what's nearby".
        const pcx = player.x + player.width / 2;
        const pcy = player.y + player.height / 2;
        const CULL_SQ = 900 * 900;
        for (const n of activeNpcs()) {
            const cx = n.x + n.width / 2;
            const cy = n.y + n.height / 2;
            const dx = cx - pcx;
            const dy = cy - pcy;
            if (dx * dx + dy * dy > CULL_SQ) continue;
            n.update(dt);
        }
        // Followers live outside any level's npcs list so they
        // travel with the player - always ticked so combat AI
        // doesn't freeze if the player walks far from the npc list.
        updateFollowers(dt);
        // Ambient animals run with their own internal cull, so no
        // extra distance check needed here.
        animals.update(dt);
        updateLightCreatures(dt);
        updateChatBubbles(dt);
        cityChat.tick(dt);
        worldClock.update(dt);
        cityEvents.update(dt);
        mysticalEvents.update(dt);
    }

    function activeNpcs() {
        return currentLevel.npcs || [];
    }

    // Lore entries for the current level. Returns [] for levels
    // without any, so call sites don't need null-guards.
    function activeLore() {
        return currentLevel.lore || [];
    }

    // Loose 50-px proximity - a bit more forgiving than NPC range
    // since lore objects don't move so they're easier to miss-target.
    const LORE_INTERACT_RANGE = 50;

    function loreIsNear(entry) {
        const cx = entry.x + 16;  // lore sprite is 32x32
        const cy = entry.y + 16;
        const px = player.x + player.width / 2;
        const py = player.y + player.height / 2;
        const dx = px - cx;
        const dy = py - cy;
        return dx * dx + dy * dy <= LORE_INTERACT_RANGE * LORE_INTERACT_RANGE;
    }

    // Closest lore entry within range, or null.
    function nearestLore() {
        let best = null;
        let bestD = Infinity;
        const r2 = LORE_INTERACT_RANGE * LORE_INTERACT_RANGE;
        const px = player.x + player.width / 2;
        const py = player.y + player.height / 2;
        for (const entry of activeLore()) {
            const cx = entry.x + 16;
            const cy = entry.y + 16;
            const dx = px - cx;
            const dy = py - cy;
            const d = dx * dx + dy * dy;
            if (d <= r2 && d < bestD) {
                best = entry;
                bestD = d;
            }
        }
        return best;
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

        // Market stalls: tiny awning + counter sprite, skips the
        // window / door / label pass that a full building draws.
        if (b.stall) {
            // Counter box.
            ctx.fillStyle = b.wall ?? "#8c5a3c";
            ctx.fillRect(x, y + 10, b.w, b.h - 10);
            ctx.fillStyle = "rgba(0, 0, 0, 0.22)";
            ctx.fillRect(x, y + b.h - 3, b.w, 3);
            // Striped awning above.
            ctx.fillStyle = b.roof ?? "#c8913a";
            ctx.fillRect(x - 3, y, b.w + 6, 12);
            ctx.fillStyle = "rgba(255, 255, 255, 0.22)";
            for (let sx = 2; sx < b.w + 4; sx += 8) {
                ctx.fillRect(x - 3 + sx, y, 4, 12);
            }
            // Corner posts to anchor the awning to the ground.
            ctx.fillStyle = "#3c2818";
            ctx.fillRect(x - 2, y, 2, b.h);
            ctx.fillRect(x + b.w, y, 2, b.h);
            return;
        }

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

    // Paints a small padlock hovering over each locked border gate
    // in the current level. Stops rendering the moment the door is
    // in `unlockedDoors`.
    function drawLockIndicators(ctx) {
        const exits = currentLevel.exits;
        const fromId = currentLevel.id;
        const sides = ["west", "east", "north", "south"];

        for (const dir of sides) {
            const exit = resolveExit(exits[dir]);
            if (!exit || !exit.keyId) continue;
            if (unlockedDoors.has(doorKey(fromId, dir))) continue;

            let x, y;
            const midX = WORLD_W / 2;
            const midY = WORLD_H / 2;
            const inset = 22;
            if (dir === "west")       { x = inset;           y = midY; }
            else if (dir === "east")  { x = WORLD_W - inset; y = midY; }
            else if (dir === "north") { x = midX;            y = inset; }
            else                      { x = midX;            y = WORLD_H - inset; }

            drawPadlock(ctx, Math.round(x), Math.round(y));
        }
    }

    // Small gold padlock: shackle + body + keyhole. Drawn at world
    // coords so it scrolls with the border gate.
    function drawPadlock(ctx, cx, cy) {
        ctx.save();
        // Faint dark halo so the lock reads on any tile behind it.
        ctx.fillStyle = "rgba(12, 12, 22, 0.55)";
        ctx.beginPath();
        ctx.arc(cx, cy, 13, 0, Math.PI * 2);
        ctx.fill();

        // Shackle
        ctx.strokeStyle = "#ffd166";
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(cx, cy - 3, 5, Math.PI, 0);
        ctx.stroke();

        // Body
        ctx.fillStyle = "#ffd166";
        ctx.fillRect(cx - 7, cy - 2, 14, 11);
        ctx.fillStyle = "#caa048";
        ctx.fillRect(cx - 7, cy + 8, 14, 1);

        // Keyhole
        ctx.fillStyle = "#3c2818";
        ctx.beginPath();
        ctx.arc(cx, cy + 3, 1.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillRect(cx - 0.8, cy + 3, 1.6, 4);
        ctx.restore();
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

    // Lore-object sprite. Three visual flavors: book, statue,
    // relic. Collected entries render dimmed so they still read as
    // landmarks without calling attention to already-read content.
    // Fresh entries carry a soft gold halo that pulses so they
    // catch the eye from across the room.
    function drawLoreObject(ctx, entry) {
        const x = Math.round(entry.x);
        const y = Math.round(entry.y);
        const collected = loreLog.has(entry.id);

        // Fresh lore gets a pulsing gold halo so the player can
        // spot it without hunting every corner.
        if (!collected) {
            const pulse = 0.35 + 0.4 *
                Math.abs(Math.sin(performance.now() * 0.003));
            ctx.save();
            ctx.globalAlpha = pulse;
            ctx.fillStyle = "#ffd166";
            ctx.beginPath();
            ctx.arc(x + 16, y + 20, 20, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        }

        // Ground shadow
        ctx.fillStyle = "rgba(0, 0, 0, 0.32)";
        ctx.beginPath();
        ctx.ellipse(x + 16, y + 29, 7, 2.5, 0, 0, Math.PI * 2);
        ctx.fill();

        // Body by kind.
        const kind = entry.kind || "book";
        if (kind === "book") {
            // Closed tome
            ctx.fillStyle = collected ? "#6a4a2a" : "#8c5a3c";
            ctx.fillRect(x + 10, y + 14, 12, 14);
            ctx.fillStyle = collected ? "#4a3018" : "#5c3a20";
            ctx.fillRect(x + 10, y + 14, 12, 2);
            ctx.fillStyle = collected ? "#c8b88a" : "#f0e0c0";
            ctx.fillRect(x + 12, y + 17, 8, 10);
            ctx.fillStyle = collected ? "#6a4a2a" : "#8c5a3c";
            ctx.fillRect(x + 15, y + 17, 2, 10);  // spine
        } else if (kind === "statue") {
            // Squat plinth with a head
            ctx.fillStyle = collected ? "#787888" : "#a0a0b0";
            ctx.fillRect(x + 8, y + 12, 16, 16);
            ctx.fillStyle = collected ? "#555562" : "#7a7a8a";
            ctx.fillRect(x + 8, y + 26, 16, 2);
            ctx.fillStyle = collected ? "#686878" : "#888898";
            ctx.fillRect(x + 11, y + 6, 10, 8);
            ctx.fillStyle = "#1a1a24";
            ctx.fillRect(x + 13, y + 10, 2, 2);
            ctx.fillRect(x + 17, y + 10, 2, 2);
        } else {
            // Relic: faceted crystal on a base
            ctx.fillStyle = collected ? "#463050" : "#553070";
            ctx.fillRect(x + 8, y + 24, 16, 4);
            ctx.fillStyle = collected ? "#604060" : "#c060c0";
            ctx.beginPath();
            ctx.moveTo(x + 16, y + 6);
            ctx.lineTo(x + 24, y + 16);
            ctx.lineTo(x + 16, y + 24);
            ctx.lineTo(x + 8, y + 16);
            ctx.closePath();
            ctx.fill();
            ctx.fillStyle = collected ? "#8060a0" : "#e8a0e8";
            ctx.fillRect(x + 14, y + 11, 3, 3);
        }

        // Interact bubble when the player is in range.
        if (gameState === "playing" && loreIsNear(entry)) {
            const bx = x + 16;
            const by = y - 14;
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

    // Opens a lore entry as a dialogue box (reuses the existing
    // modal pipeline). `dialogue.open` accepts any `{ name,
    // dialogue }` shape, so synthesizing one here keeps the lore
    // UI visually consistent with NPC conversations.
    function openLore(entry) {
        const firstTime = loreLog.collect(entry.id);
        if (firstTime) {
            sound.play("levelUp");
            questLog.showToast(
                `Lore discovered  (${loreLog.count()}/${loreLog.total()})`,
                2.2
            );
        }
        dialogue.open({
            name: entry.name,
            dialogue: {
                greeting: entry.text,
                options: [
                    { label: "Close.", close: true },
                ],
            },
        });
    }

    // NPC variant classifier. Pure string-matching over role / id
    // so the existing NPC configs don't need to be rewritten - we
    // just infer a category once and cache on the instance.
    function resolveNpcVariant(n) {
        if (n._variant) return n._variant;
        let v = "villager";
        if (n.role === "warrior")                    v = "warrior";
        else if (n.id === "elder")                   v = "elder";
        else if (/merchant|fish|stall|keep|market|smith|carver/i
            .test(n.id || "") ||
            /merchant|smith|carver|seller/i.test(n.name || "")) v = "merchant";
        n._variant = v;
        return v;
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

        // Subtle per-variant decoration. Each touch is 1-3 pixels
        // so the base sprite stays recognizable - warriors gleam a
        // little, elders wear a richer hat, merchants show a coin
        // on the sash. Villagers (default) get nothing.
        const variant = resolveNpcVariant(n);
        if (variant === "warrior") {
            // Shoulder gloss - thin white line on the left shoulder.
            ctx.fillStyle = "rgba(255, 255, 255, 0.55)";
            ctx.fillRect(x + 9, y + 13 + bob, 4, 1);
        } else if (variant === "elder") {
            // Gold hat brim highlight + a small cap jewel.
            ctx.fillStyle = "#ffd166";
            ctx.fillRect(x + 10, y + 4 + bob, 12, 1);
            ctx.fillRect(x + 15, y + 1 + bob, 2, 2);
        } else if (variant === "merchant") {
            // Coin pixel on the sash.
            ctx.fillStyle = "#ffd166";
            ctx.fillRect(x + 20, y + 19 + bob, 2, 2);
        }

        // Interact hint when in range (world-space bubble with "E").
        // Followers are always within range, so their bubbles would
        // clutter the screen - suppressed for the whole squad.
        if (gameState === "playing" && !n._isFollower && npcIsNear(n)) {
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

        // Follower combat overlays. HP bar only while damaged so
        // idle followers stay uncluttered. Attack-flash tints the
        // sprite white briefly on each hit / shot. Retreat gets a
        // small arrow hint so the player notices one's pulling out.
        if (n._isFollower && n.maxHp) {
            if (n.hp < n.maxHp) {
                const frac = Math.max(0, n.hp / n.maxHp);
                const barW = 22, barH = 3;
                const bx = x + 5, by = y - 5;
                ctx.fillStyle = "#1a1a24";
                ctx.fillRect(bx, by, barW, barH);
                ctx.fillStyle = (n.roleCfg && n.roleCfg.accentColor) || "#7ad17a";
                ctx.fillRect(bx, by, barW * frac, barH);
            }
            if (n.attackFlashTimer > 0) {
                const a = Math.min(1, n.attackFlashTimer / 0.12);
                ctx.save();
                ctx.globalCompositeOperation = "source-atop";
                ctx.fillStyle = `rgba(255, 255, 255, ${(a * 0.8).toFixed(3)})`;
                ctx.fillRect(x, y, 32, 32);
                ctx.restore();
            }
            if (n.fightState === "retreat") {
                ctx.fillStyle = "rgba(255, 200, 200, 0.85)";
                ctx.font = "bold 10px system-ui, sans-serif";
                ctx.textAlign = "center";
                ctx.textBaseline = "bottom";
                ctx.fillText("!", x + 16, y - 7);
            }
        }
    }

    // --- Companions ---
    //
    // Recruitment is gated on three checks:
    //   - role: only NPCs tagged `role: "warrior"` qualify.
    //   - storyState: each warrior carries a `recruitChapter` id;
    //     story must be atLeast that chapter for them to say yes.
    //   - squad cap: starts at `baseMax` (2) and grows by one per
    //     advanced chapter, so later chapters unlock more slots.
    //
    // Squad entries are value-only snapshots so the source NPC can
    // still wander / patrol in its home zone untouched. Future
    // "follow the player" behavior can read `player.squad` and look
    // up live NPC refs by id.
    const companions = {
        baseMax: 2,
        // Lifetime recruit cap. The live-follower cap below keeps
        // the formation readable; extras become reserves that appear
        // as skirmishers in hostile zones and fade in/out with the
        // player's range.
        hardCap: 25,
        activeCap: 6,

        maxSize() {
            // Per-chapter growth: chapter1 (idx 0) = 2, +1 per
            // advanced chapter. Hard-capped at 6 so the formation
            // stays readable and enemies don't vanish under a mob.
            //   chapter1 -> 2      chapter4 -> 5
            //   chapter2 -> 3      chapter5 -> 6
            //   chapter3 -> 4      chapter6 -> 6 (capped)
            const idx = Math.max(0, story.chapterOrder.indexOf(story.state));
            return Math.min(this.hardCap, this.baseMax + idx);
        },

        has(npcId) {
            for (const m of player.squad) if (m.id === npcId) return true;
            return false;
        },

        canRecruit(npc) {
            if (!npc || npc.role !== "warrior") {
                return { ok: false, reason: "not_warrior" };
            }
            if (this.has(npc.id)) return { ok: false, reason: "already" };
            if (player.squad.length >= this.maxSize()) {
                return { ok: false, reason: "full" };
            }
            const req = npc.recruitChapter ?? "chapter1";
            if (!story.atLeast(req)) return { ok: false, reason: "early", req };
            return { ok: true };
        },

        recruit(npc) {
            // Pluck from the home zone's npcs array so they stop
            // wandering their old spot; remember which zone + the
            // pre-recruit routine for dismiss(). Then register as
            // a live follower and snap onto a formation slot.
            const home = removeNpcFromLevel(npc);
            npc.homeLevelId = home;
            npc._originalRoutine = npc.routine;
            npc.routine = "follow";
            npc._isFollower = true;

            // Role-driven combat stats. Default to melee so any
            // warrior without an explicit squadRole tag still works.
            const roleCfg = SQUAD_ROLES[npc.squadRole] ?? SQUAD_ROLES.melee;
            npc.roleCfg = roleCfg;
            npc.maxHp = roleCfg.maxHp;
            npc.hp = roleCfg.maxHp;
            npc.iframes = 0;
            npc.fightState = "follow";
            npc.target = null;
            // Stagger initial cooldown so fresh recruits don't all
            // wind up firing on the same tick the first time they
            // engage a shared pack of enemies.
            npc.attackCooldownTimer = Math.random() * 0.35;
            npc.attackFlashTimer = 0;  // brief on-strike hit-flash cue

            // Active-follower cap: only the first N recruits actively
            // follow the player. Extras are reserves - tracked on
            // player.squad but parked in their home zone until the
            // active slot frees up (or a hostile zone promotes them
            // into a skirmisher). reserve=true on the NPC signals
            // skip-follower-tick.
            if (followers.length < this.activeCap) {
                followers.push(npc);
                npc.reserve = false;
            } else {
                // Reserve: put them back in the home zone's list so
                // they keep wandering their old spot, but flagged so
                // future promotions can find them quickly.
                npc.reserve = true;
                const home = LEVELS[npc.homeLevelId];
                if (home && home.npcs && home.npcs.indexOf(npc) === -1) {
                    npc.x = npc.homeX;
                    npc.y = npc.homeY;
                    home.npcs.push(npc);
                }
            }
            player.squad.push({
                id: npc.id, name: npc.name, role: npc.role,
                squadRole: roleCfg.id,
            });
            snapFollowersToPlayer();
            tutorial.onRecruit();
        },

        // Count of recruited warriors NOT currently in the active
        // follower slot - used by HUD + skirmisher spawning.
        reserveCount() {
            return Math.max(0, player.squad.length - followers.length);
        },

        // Return every active follower to their home zone's npcs
        // list and drop the squad snapshots. Used before load()
        // replays a saved squad roster.
        dismissAll() {
            while (followers.length) {
                const f = followers.pop();
                f.routine = f._originalRoutine ?? "wander";
                f._isFollower = false;
                const home = LEVELS[f.homeLevelId];
                if (home && home.npcs && home.npcs.indexOf(f) === -1) {
                    // Reset to home position on the way back so they
                    // don't resume wandering from the player's feet.
                    f.x = f.homeX;
                    f.y = f.homeY;
                    home.npcs.push(f);
                }
            }
            player.squad.length = 0;
        },

        // Re-recruit from a list of snapshots (as stored in
        // player.squad by saveGame). Skips any id that can't be
        // found in any level's npcs array - e.g. a squad member
        // that was never returned before load.
        rehire(snapshots) {
            for (const snap of snapshots) {
                for (const levelId in LEVELS) {
                    const list = LEVELS[levelId].npcs;
                    if (!list) continue;
                    const npc = list.find(n => n.id === snap.id);
                    if (npc) {
                        this.recruit(npc);
                        break;
                    }
                }
            }
        },

        reset() { this.dismissAll(); },
    };

    // Reads the currently-open dialogue's NPC so a single dialogue
    // option (`action: recruitInteract`) works across every warrior
    // without per-NPC closures. Prints a toast for every branch so
    // the player always gets feedback on why the answer was yes/no.
    function recruitInteract() {
        const npc = dialogue.active && dialogue.active.npc;
        if (!npc) return;

        const res = companions.canRecruit(npc);
        if (res.ok) {
            companions.recruit(npc);
            sound.play("levelUp");
            questLog.showToast(
                `${npc.name} joins your squad!  (${player.squad.length}/${companions.maxSize()})`,
                2.8
            );
            return;
        }
        let msg;
        if (res.reason === "already") {
            msg = `${npc.name} is already at your side.`;
        } else if (res.reason === "full") {
            msg = `Your squad is full (max ${companions.hardCap})`;
        } else if (res.reason === "early") {
            msg = `${npc.name}: "Not yet. Earn your name first."`;
        } else {
            msg = `${npc.name} can't be recruited.`;
        }
        questLog.showToast(msg, 2.4);
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
    // Each shop item owns its own buy-effect via `onBuy()`. `price`
    // may mutate after a purchase (upgrades get more expensive each
    // time); `basePrice` is preserved so `resetShopPrices` can roll
    // the table back on restart. Adding a new ware is one more
    // object here.
    const SHOP_ITEMS = [
        {
            id: "potion",
            name: "Health Potion",
            effect: "Restores 30 HP",
            basePrice: 15,
            price: 15,
            onBuy() {
                healPlayer(30);
                questLog.showToast(
                    `Potion quaffed - HP ${Math.ceil(player.hp)}/${player.maxHp}.`,
                    1.8
                );
            },
        },
        {
            id: "sword_upgrade",
            name: "Sword Upgrade",
            effect: "+1 sword damage",
            basePrice: 50,
            price: 50,
            onBuy() {
                swordWeapon.damage += 1;
                // Each upgrade raises the next price so late-game
                // bosses actually feel like a sink.
                this.price = Math.floor(this.price * 1.8);
                questLog.showToast(
                    `Sword sharpened!  (${swordWeapon.damage} dmg)`,
                    2.0
                );
            },
        },
        {
            id: "energy_upgrade",
            name: "Energy Upgrade",
            effect: "+1 energy damage",
            basePrice: 70,
            price: 70,
            onBuy() {
                energyWeapon.damage += 1;
                this.price = Math.floor(this.price * 1.8);
                questLog.showToast(
                    `Energy focus tuned!  (${energyWeapon.damage} dmg)`,
                    2.0
                );
            },
        },
        {
            id: "vitality",
            name: "Vitality Rune",
            effect: "+10 max HP",
            basePrice: 100,
            price: 100,
            onBuy() {
                player.maxHp += 10;
                // Also top up by the same amount so the purchase
                // reads as an instant power bump, not a hidden bar
                // extension.
                healPlayer(10);
                this.price = Math.floor(this.price * 1.8);
                questLog.showToast(
                    `Vitality surges - max HP ${player.maxHp}.`,
                    2.0
                );
            },
        },
    ];

    // Called by restartGame to wipe upgrade inflation so a new run
    // sees original prices.
    function resetShopPrices() {
        for (const item of SHOP_ITEMS) {
            if (item.basePrice != null) item.price = item.basePrice;
        }
    }

    const shop = {
        open_: false,
        itemRects: [],
        closeRect: null,

        open()  { this.open_ = true;  this.itemRects = []; this.closeRect = null; },
        close() { this.open_ = false; this.itemRects = []; this.closeRect = null; },
        isOpen() { return this.open_; },

        // Checks the purse and routes to the item's own onBuy
        // callback so the shop module stays dumb about effects.
        // Insufficient coins is a loud-toast rejection; any future
        // "locked" or "sold out" state can gate here by returning
        // early before deducting.
        selectItem(index) {
            const item = SHOP_ITEMS[index];
            if (!item) return;
            if (player.coins < item.price) {
                questLog.showToast(
                    `Not enough coins  (${player.coins}/${item.price}g)`,
                    1.8
                );
                return;
            }
            player.coins -= item.price;
            sound.play("coin");
            if (typeof item.onBuy === "function") {
                item.onBuy();
            } else {
                questLog.showToast(`Purchased: ${item.name}`, 2.0);
            }
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

            // First-time Elder meeting: play a scripted scene
            // (typewriter box) before the menu opens. The onDone
            // handler re-calls dialogue.open with the flag set so
            // the normal menu path runs on the second pass.
            if (npc.id === "elder" && !story.elderIntroShown) {
                story.elderIntroShown = true;
                const ELDER_INTRO_LINES = [
                    { speaker: npc.name, text: "You're new here... I can tell." },
                    { speaker: npc.name, text: "This place isn't as peaceful as it looks." },
                    { speaker: npc.name, text: "The dungeon below... it's changing." },
                    { speaker: npc.name, text: "If you're going down there... you'll need help." },
                ];
                scriptedDialogue.play(ELDER_INTRO_LINES, () => {
                    // Complete mission 1 here so the "speak with
                    // Elder" beat closes even if the player taps
                    // away before re-entering the menu.
                    missions.completeById(1);
                    this.open(npc);
                });
                return;
            }

            const d = npc.dialogue;
            // Greeting may be a plain string (static), a function
            // (open-time compute of any condition), or a chapter-
            // keyed object (staged lines keyed by story chapter).
            // `pickStage` handles all three uniformly.
            const greeting = typeof d.greeting === "function"
                ? d.greeting(npc)
                : pickStage(d.greeting) ?? d.greeting;
            // Options: either a plain array OR a chapter-keyed object
            // (same shape as greeting). Using pickStage here means
            // repeat visits reflect the story - new questions per
            // chapter instead of the same menu forever.
            const options = Array.isArray(d.options)
                ? d.options
                : pickStage(d.options) ?? d.options;
            this.active = {
                speaker: npc.name,
                npc,                   // kept so submitQuestion can call askNpc
                greeting,
                options,
                text: greeting,
                mode: "menu",
            };
            this.optionRects = [];

            // Mission 1: speaking with the Elder is the opening
            // beat. completeById is a no-op if mission 1 isn't
            // current, so re-talking later is safe.
            if (npc.id === "elder") missions.completeById(1);
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
            // Central hub - on the plaza just east of the fountain.
            // Plaza center at world (1600, 1152).
            x: 1644,
            y: 1172,
            width: 32, height: 32,
            interactRange: 60,
            // Wide enough to pace the plaza.
            wanderRadius: 72,
            speed: 24,
            colors: { robe: "#6b4e91", trim: "#503872", sash: "#ffd166", hat: "#4a2f70" },
            dialogue: {
                // Chapter-staged greeting. The Elder carries a line
                // for every chapter since they anchor the campaign.
                greeting: {
                    chapter1: '"Greetings, traveler. The grove welcomes you."',
                    chapter2: '"Back from the caverns? Their dark runs deep. Keep at it."',
                    chapter3: '"You carry the Golden Key. The shrine waits - walk with care."',
                    chapter4: '"You stood at the shrine\'s threshold. Whatever comes, we\'ll mourn or cheer."',
                    chapter5: '"Hero of the grove. The Keeper\'s silence - that\'s your work. Thank you."',
                },
                // Chapter-staged options. Each mission beat with the
                // Elder has a distinct prompt + a short response that
                // reacts to the campaign state so repeat visits feel
                // like a real conversation, not a repeat menu. The
                // staged form resolves via pickStage in dialogue.open
                // (same rule as greeting / knowledge).
                options: {
                    chapter1: [
                        {
                            label: "Who are you?",
                            response: "I am the Elder - keeper of these grounds since before the star-fall.",
                        },
                        {
                            label: "What is this place?",
                            response: "The Sunlit Grove. Last safe haven before the dark places east.",
                        },
                        {
                            label: "Is there work for me?",
                            action: elderInteract,
                        },
                        { label: "Ask a question...", input: true },
                        { label: "Goodbye.", close: true },
                    ],
                    chapter2: [
                        {
                            label: "How do I press deeper?",
                            response: "Head east through the caverns. Their dark runs deeper than it looks - mind the echoes.",
                        },
                        {
                            label: "Tell me of the Golden Key.",
                            response: "It opens the shrine. Finish a longer hunt and I'll place it in your hand myself.",
                        },
                        {
                            label: "I'm ready for more work.",
                            action: elderInteract,
                        },
                        { label: "Ask a question...", input: true },
                        { label: "Goodbye.", close: true },
                    ],
                    chapter3: [
                        {
                            label: "The shrine awaits - what should I know?",
                            response: "The Keeper guards the heart. Strike when it rests. Do not let its rush break your line.",
                        },
                        {
                            label: "What of the key I carry?",
                            response: "Consumed by the lock. You'll know it when it turns.",
                        },
                        {
                            label: "Any last advice?",
                            response: "Take a companion if the grove will give one. No one walks the shrine alone.",
                        },
                        { label: "Ask a question...", input: true },
                        { label: "Goodbye.", close: true },
                    ],
                    chapter4: [
                        {
                            label: "I stand at the threshold.",
                            response: "Then cross. We've waited long enough. We'll be here, whatever comes.",
                        },
                        {
                            label: "What if I fall?",
                            response: "The grove remembers. So would we. But don't plan on falling - plan on the next step.",
                        },
                        {
                            label: "What is the Heart, truly?",
                            response: "A thing older than this grove. When it stops, the world stops. The Keeper was made to keep it beating.",
                        },
                        { label: "Ask a question...", input: true },
                        { label: "Goodbye.", close: true },
                    ],
                    chapter5: [
                        {
                            label: "It is done.",
                            response: "It is done. The grove breathes easier tonight because of you.",
                        },
                        {
                            label: "What now?",
                            response: "Now we rest. And watch the deeper dark - in case it is not yet done with us.",
                        },
                        {
                            label: "Was this the plan all along?",
                            response: "No plan. Only hope, and you. That was enough, as it turns out.",
                        },
                        { label: "Ask a question...", input: true },
                        { label: "Goodbye.", close: true },
                    ],
                    chapter6: [
                        {
                            label: "The Abyss opened beneath us.",
                            response: "It was never closed. Only quiet. Now it listens - so listen back.",
                        },
                        {
                            label: "Will you come with me?",
                            response: "I cannot. I am the grove's anchor. But my voice, and my thanks, and whatever blade you find on your way - those go with you.",
                        },
                        {
                            label: "Is there a way to end it?",
                            response: "Endings are rare. Better to bind what you cannot kill. Carry the light down with you.",
                        },
                        { label: "Ask a question...", input: true },
                        { label: "Goodbye.", close: true },
                    ],
                },
                knowledge: [
                    { keywords: ["name", "who are", "elder"], response: "I am the Elder - keeper of the grove." },
                    { keywords: ["grove", "place", "town", "city"], response: "The Sunlit Grove. The star-fall spared it for a reason." },
                    { keywords: ["shop", "merchant", "buy"], response: "Hemlen's shop lies west of the plaza. Tell them the Elder sent you." },
                    { keywords: ["quest", "work", "job", "help"], response: "Hunts, mostly. Select 'Any work?' and I'll set you a task." },
                    { keywords: ["east", "cavern", "dungeon", "danger"], response: "East lies the Echo Caverns, and beyond, the Shrine. Tread carefully." },
                    { keywords: ["shrine", "lock", "gate", "sealed"], response: "The shrine gate is sealed with a golden lock. Prove yourself, and I'll hand you the key." },
                    { keywords: ["key", "golden", "unlock"], response: "Complete my second task - the Experienced Hunter - and the Golden Key is yours." },
                    { keywords: ["boss", "keeper", "guardian"], response: "The Shrine Keeper guards the heart. Watch its rush - strike only when it rests." },
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
            // Residential district - amid the houses in the SW.
            x: 800,
            y: 1760,
            width: 32, height: 32,
            interactRange: 60,
            // Sometimes strolls toward the central plaza (errands,
            // visiting the Elder). Mostly stays near home.
            routine: "gather",
            gatherPoint: { x: 1600, y: 1220 },  // plaza south edge
            gatherChance: 0.15,
            walkMin: 6, walkMax: 12,
            idleMin: 2.0, idleMax: 4.0,
            wanderRadius: 140,
            speed: 42,
            colors: { robe: "#4e915c", trim: "#356840", sash: "#a0d0a0", hat: "#2f5a3a" },
            dialogue: {
                greeting: {
                    chapter1: '"Oh! A visitor. Good to see a new face."',
                    chapter3: '"The whole grove\'s talking about you."',
                    chapter5: '"Hero on my street! Don\'t tread on the roses."',
                },
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
            // Warrior of the watch - recruitable from chapter2 once
            // the player has proved themselves in the caverns.
            // Skirmisher: ranged role, keeps distance, pecks with
            // energy bolts.
            role: "warrior",
            squadRole: "ranged",
            recruitChapter: "chapter2",
            // Patrols the east gate on a three-waypoint loop:
            // north of the gate, at the gate, south of the gate.
            x: 2900,
            y: 1140,
            width: 32, height: 32,
            interactRange: 60,
            wanderRadius: 110,
            speed: 54,
            // Patrol route - cycles through these spots in order.
            routine: "patrol",
            waypoints: [
                { x: 2900, y: 1000 },  // north of gate
                { x: 3040, y: 1140 },  // at the gate
                { x: 2900, y: 1280 },  // south of gate
            ],
            walkMin: 8, walkMax: 14,    // long enough to reach waypoints
            idleMin: 0.6, idleMax: 1.4, // short pauses between legs
            colors: { robe: "#3c5c8c", trim: "#223a5a", sash: "#8ad9ff", hat: "#1a2c46" },
            dialogue: {
                greeting: {
                    chapter1: '"Stay alert out there. The watch is thin."',
                    chapter2: '"Back in one piece? The caverns are waking up."',
                    chapter3: '"Golden Key on you? That gate answers to it now."',
                    chapter4: '"You went past the gate. Word of advice - don\'t look down."',
                    chapter5: '"Hero. I stood this watch for nothing, it seems. Good work."',
                },
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
                    { label: "Fight with me.", action: recruitInteract },
                    { label: "Ask a question...", input: true },
                    { label: "Goodbye.", close: true },
                ],
                knowledge: [
                    { keywords: ["name", "who"], response: "A scout. I watch the east gate." },
                    { keywords: ["east", "gate"], response: "East is the Echo Caverns. Don't go unprepared." },
                    { keywords: ["cavern"], response: "Enemies there hit harder than grove critters. Three blows each, at least." },
                    { keywords: ["shrine", "lock", "sealed"], response: "The shrine's gate is locked past the caverns. The Elder holds the key." },
                    { keywords: ["key", "golden", "unlock"], response: "The Golden Key? Elder's got it - earn it by finishing their second hunt." },
                    { keywords: ["boss", "keeper", "guardian", "monster"], response: "Something big lives past the shrine gate. Don't charge it - bait the rush and punish the pause." },
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

        // --- Central hub residents -----------------------------------

        new Npc({
            id: "herald", name: "Herald",
            x: 1460, y: 1060, width: 32, height: 32,
            interactRange: 58, wanderRadius: 80, speed: 34,
            // Patrols three corners of the plaza reading news.
            routine: "patrol",
            waypoints: [
                { x: 1460, y: 1060 },  // plaza NW
                { x: 1760, y: 1080 },  // plaza NE
                { x: 1600, y: 1260 },  // plaza S
            ],
            walkMin: 6, walkMax: 10,
            idleMin: 2.0, idleMax: 3.8,  // pauses to proclaim
            colors: { robe: "#a83232", trim: "#701818", sash: "#ffd166", hat: "#501010" },
            dialogue: {
                greeting: '"Hear ye! Good day, traveler!"',
                options: [
                    { label: "Any news?", response: "Crier by trade - I announce what the Captain and Elder decide." },
                    { label: "Who are you?", response: "Town Herald. I carry the grove's voice." },
                    { label: "Ask a question...", input: true },
                    { label: "Goodbye.", close: true },
                ],
                knowledge: [
                    { keywords: ["name", "who"], response: "I'm the Herald - I cry news across the grove." },
                    { keywords: ["news", "announce", "proclaim"], response: "Today: caravan still missing, shrine still sealed, Elder still ornery." },
                    { keywords: ["elder", "captain"], response: "The Elder governs; the Captain enforces. I just repeat them louder." },
                    { keywords: ["shrine", "cavern"], response: "Bad news east. I stopped calling it out - no one went anyway." },
                ],
                fallback: "A proclamation for another day, friend.",
            },
        }),

        new Npc({
            id: "priest", name: "Priest",
            x: 1736, y: 1196, width: 32, height: 32,
            interactRange: 58, wanderRadius: 36, speed: 16,
            // Tends the fountain - long pauses, tiny steps.
            idleMin: 3.0, idleMax: 6.0,
            walkMin: 2.0, walkMax: 4.0,
            colors: { robe: "#dcdce8", trim: "#9898a8", sash: "#8ad9ff", hat: "#a0a0b0" },
            dialogue: {
                greeting: {
                    chapter1: '"Peace find you, wanderer."',
                    chapter4: '"The water trembled when the gate opened. It remembers."',
                    chapter5: '"Still waters again. You gave that to us."',
                },
                options: [
                    { label: "Who are you?", response: "I tend the fountain, and the small prayers that go with it." },
                    { label: "What is this place?", response: "The grove's heart. Water rose here the night the star fell." },
                    { label: "Ask a question...", input: true },
                    { label: "Goodbye.", close: true },
                ],
                knowledge: [
                    { keywords: ["name", "who", "priest"], response: "A keeper of the water. I tend the fountain." },
                    { keywords: ["fountain", "water", "plaza"], response: "The fountain predates the grove. Older waters, stranger powers." },
                    { keywords: ["star", "fall"], response: "The star-fall left scars. Water remembers what stone forgets." },
                    { keywords: ["shrine"], response: "The shrine is water's twin - elder, darker. Tread gently there." },
                ],
                fallback: "The water offers no clear answer to that.",
            },
        }),

        new Npc({
            id: "child1", name: "Child",
            x: 1520, y: 1288, width: 32, height: 32,
            interactRange: 54, wanderRadius: 100, speed: 60,
            // Kid energy - barely pauses, bursts between spots.
            idleMin: 0.3, idleMax: 1.0,
            walkMin: 2.0, walkMax: 4.5,
            colors: { robe: "#f0d060", trim: "#a08040", sash: "#fff090", hat: "#606030" },
            dialogue: {
                greeting: '"Tag! You\'re it!"',
                options: [
                    { label: "Who are you?", response: "I live over there. Wanna play?" },
                    { label: "Seen anything strange?", response: "The Scout said the caverns SHOUT at night. I believe them." },
                    { label: "Ask a question...", input: true },
                    { label: "Goodbye.", close: true },
                ],
                knowledge: [
                    { keywords: ["name", "who"], response: "I'm just a kid! I run fast, I think." },
                    { keywords: ["play", "game", "tag"], response: "Bet you can't catch me. ... bet you CAN'T." },
                    { keywords: ["cavern", "shrine", "danger"], response: "Momma says never go east. But you went east, right? What's it like?" },
                ],
                fallback: "Grownups are weird. Ask about tag!",
            },
        }),

        // --- Market district residents ------------------------------

        new Npc({
            id: "farmer", name: "Farmer",
            x: 2192, y: 664, width: 32, height: 32,
            interactRange: 60, wanderRadius: 28, speed: 18,
            // Tends the produce stall - barely moves.
            idleMin: 3.0, idleMax: 6.0,
            walkMin: 1.5, walkMax: 3.0,
            colors: { robe: "#6a5030", trim: "#4a3018", sash: "#d0a060", hat: "#402818" },
            dialogue: {
                greeting: '"Fresh greens, picked this morning!"',
                options: [
                    { label: "What do you sell?", response: "Greens and roots, until Hemlen restocks. Keepers stew needs SOMETHING." },
                    { label: "Who are you?", response: "Just a farmer. The west fields are mine." },
                    { label: "Ask a question...", input: true },
                    { label: "Goodbye.", close: true },
                ],
                knowledge: [
                    { keywords: ["name", "who"], response: "A farmer. I work the west fields." },
                    { keywords: ["sell", "food", "greens", "produce"], response: "Carrots, turnips, chard. Simple fare - good fare." },
                    { keywords: ["caravan"], response: "Hemlen's my best customer. If his caravan returned, I'd double production overnight." },
                    { keywords: ["field", "farm", "crop"], response: "Fields drink from the fountain water. Best crops this side of the star-fall." },
                ],
                fallback: "I know grain better than gossip.",
            },
        }),

        new Npc({
            id: "weaver", name: "Weaver",
            x: 2456, y: 660, width: 32, height: 32,
            interactRange: 60, wanderRadius: 22, speed: 16,
            // At the loom - long, meditative pauses.
            idleMin: 4.0, idleMax: 7.0,
            walkMin: 1.5, walkMax: 3.0,
            colors: { robe: "#68926a", trim: "#3c5c3c", sash: "#e0e080", hat: "#2c4a2c" },
            dialogue: {
                greeting: '"Silks, wools, and wonders - at fair prices!"',
                options: [
                    { label: "What do you weave?", response: "Travelling cloaks mostly. Got one dyed grove-green, just your size." },
                    { label: "Who are you?", response: "A weaver. My looms clack in time with the market bells." },
                    { label: "Ask a question...", input: true },
                    { label: "Goodbye.", close: true },
                ],
                knowledge: [
                    { keywords: ["name", "who", "weaver"], response: "A weaver. I dye threads in the old colors." },
                    { keywords: ["cloth", "cloak", "wool", "sell"], response: "Cloaks, scarves, carpets. Quiet work, loud looms." },
                    { keywords: ["grove", "color"], response: "The green here changes with the season. I try to catch it in dye." },
                ],
                fallback: "Threads, traveler - threads are what I know.",
            },
        }),

        new Npc({
            id: "apprentice", name: "Apprentice",
            x: 2360, y: 780, width: 32, height: 32,
            interactRange: 58, wanderRadius: 140, speed: 62,
            // Runs messages - sometimes bolts toward the guild
            // entrance, otherwise paces the market district.
            routine: "gather",
            gatherPoint: { x: 1390, y: 950 },   // guild door area
            gatherChance: 0.30,
            gatherJitter: 70,
            walkMin: 6, walkMax: 12,
            idleMin: 0.5, idleMax: 1.2,   // barely stops
            colors: { robe: "#3c8a8c", trim: "#204548", sash: "#a0e0d8", hat: "#163034" },
            dialogue: {
                greeting: '"Sorry - rushing - errands!"',
                options: [
                    { label: "What are you doing?", response: "Running between the guild and the market. Messages!" },
                    { label: "Who are you?", response: "The Captain's apprentice. I fetch more than I fight, lately." },
                    { label: "Ask a question...", input: true },
                    { label: "Goodbye.", close: true },
                ],
                knowledge: [
                    { keywords: ["name", "who", "apprentice"], response: "Apprentice of the guild. One day I'll fight; today I fetch." },
                    { keywords: ["captain", "guild"], response: "Captain keeps me running. Paperwork, rumors, market prices." },
                    { keywords: ["train", "sword", "fight"], response: "I train at dawn in the guild hall. Come watch me flail someday." },
                ],
                fallback: "Late already - gotta run!",
            },
        }),

        new Npc({
            id: "fisher", name: "Fisher",
            x: 2176, y: 520, width: 32, height: 32,
            interactRange: 60, wanderRadius: 30, speed: 20,
            // Leans on the stall. Patient.
            idleMin: 3.5, idleMax: 6.5,
            walkMin: 1.5, walkMax: 3.0,
            colors: { robe: "#3a6a9a", trim: "#1a3858", sash: "#a0c0e0", hat: "#14263c" },
            dialogue: {
                greeting: '"Catch of the day - if you like eels."',
                options: [
                    { label: "What do you sell?", response: "Eels and lampreys from the north streams. Not everyone's favorite." },
                    { label: "Who are you?", response: "A fisher. I work the cold streams beyond the NW grove." },
                    { label: "Ask a question...", input: true },
                    { label: "Goodbye.", close: true },
                ],
                knowledge: [
                    { keywords: ["name", "who", "fisher"], response: "A fisher. I work the north streams." },
                    { keywords: ["fish", "eel", "catch", "sell"], response: "Eels today, lamprey yesterday. The streams go cold east of the caverns." },
                    { keywords: ["water", "stream"], response: "Waters flow strange since the star-fall. Fish follow stranger currents." },
                ],
                fallback: "Ask me about streams, not stars.",
            },
        }),

        // --- Residential district residents -------------------------

        new Npc({
            id: "grandmother", name: "Grandmother",
            x: 560, y: 1730, width: 32, height: 32,
            interactRange: 60, wanderRadius: 22, speed: 10,
            // Rocks on the porch. Long pauses, tiny excursions.
            idleMin: 4.0, idleMax: 8.0,
            walkMin: 1.5, walkMax: 3.5,
            colors: { robe: "#8860a8", trim: "#4a2a60", sash: "#f0d8ff", hat: "#301a44" },
            dialogue: {
                greeting: {
                    chapter1: '"Settle in, dear. I\'ve seen worse than you."',
                    chapter3: '"You carry a shrine key. Oh, the ghosts I\'ve seen try."',
                    chapter5: '"The night the star fell - it felt like tonight. Only quieter."',
                },
                options: [
                    { label: "Who are you?", response: "Nana to most. I remember the star-fall, if you can believe it." },
                    { label: "Any stories?", response: "The shrine was a temple once. Beautiful. Now - well. Now it isn't." },
                    { label: "Ask a question...", input: true },
                    { label: "Goodbye.", close: true },
                ],
                knowledge: [
                    { keywords: ["name", "who", "nana", "grandmother"], response: "Folks call me Nana. Older than the grove's stone." },
                    { keywords: ["star", "fall"], response: "I remember the night it fell. The world bent and snapped back wrong." },
                    { keywords: ["shrine", "temple"], response: "It was a temple, once. Before. Go gently past its door." },
                    { keywords: ["story", "history"], response: "Bring me tea someday and I'll talk your ear off." },
                ],
                fallback: "These old ears miss half of what they hear, child.",
            },
        }),

        new Npc({
            id: "child2", name: "Child",
            x: 940, y: 1700, width: 32, height: 32,
            interactRange: 54, wanderRadius: 80, speed: 56,
            idleMin: 0.3, idleMax: 1.0,
            walkMin: 2.0, walkMax: 4.5,
            colors: { robe: "#d070a0", trim: "#8a4670", sash: "#f8b0d0", hat: "#5a2a48" },
            dialogue: {
                greeting: '"Have you seen my cat?"',
                options: [
                    { label: "A cat?", response: "Black, three white socks. If you spot him, tell him supper is cold." },
                    { label: "Who are you?", response: "Just me. I live in the pink house, kinda." },
                    { label: "Ask a question...", input: true },
                    { label: "Goodbye.", close: true },
                ],
                knowledge: [
                    { keywords: ["name", "who"], response: "Me! And my cat. Mostly my cat." },
                    { keywords: ["cat", "pet"], response: "He hunts mice by the SE trees. If you find him, please PLEASE tell me." },
                    { keywords: ["house", "home"], response: "We live past the path. I'll show you - after I find my cat." },
                ],
                fallback: "My cat would know. Probably.",
            },
        }),

        new Npc({
            id: "gardener", name: "Gardener",
            x: 660, y: 1820, width: 32, height: 32,
            interactRange: 60, wanderRadius: 60, speed: 26,
            colors: { robe: "#7a8c3c", trim: "#4a5820", sash: "#c8d880", hat: "#2a3810" },
            dialogue: {
                greeting: '"Mind the seedlings, traveler."',
                options: [
                    { label: "What are you growing?", response: "Ethereon roses. Pale blue, won't bloom till the star rises again." },
                    { label: "Who are you?", response: "Town gardener. The flowers here are old - older than the houses." },
                    { label: "Ask a question...", input: true },
                    { label: "Goodbye.", close: true },
                ],
                knowledge: [
                    { keywords: ["name", "who", "gardener"], response: "A gardener. I tend the grove's slow-blooming things." },
                    { keywords: ["flower", "rose", "plant", "grow"], response: "Ethereon roses, blue as a winter sky. They wait centuries to bloom." },
                    { keywords: ["villager"], response: "The Villager and I swap cuttings every moon. Good neighbor." },
                ],
                fallback: "Ask the roses. They're older than us both.",
            },
        }),

        new Npc({
            id: "farmwife", name: "Farmer's Wife",
            x: 900, y: 1560, width: 32, height: 32,
            interactRange: 60, wanderRadius: 46, speed: 24,
            colors: { robe: "#d0b86a", trim: "#8a7440", sash: "#fff0a0", hat: "#503c1c" },
            dialogue: {
                greeting: '"Mind the laundry line!"',
                options: [
                    { label: "Who are you?", response: "The Farmer's better half. I keep the house while they mind the fields." },
                    { label: "Busy morning?", response: "Washing, mending, baking, worrying. The usual four." },
                    { label: "Ask a question...", input: true },
                    { label: "Goodbye.", close: true },
                ],
                knowledge: [
                    { keywords: ["name", "who", "farm", "wife"], response: "I keep house for the Farmer. Busy work, honest work." },
                    { keywords: ["farm", "farmer", "field"], response: "My partner works the west fields. Good soil, patient rows." },
                    { keywords: ["bread", "bake", "food"], response: "Bread's in the oven. Come back later - the house smells of honey." },
                ],
                fallback: "Not my field, dear. Try the Captain.",
            },
        }),

        // --- Extra townsfolk (compact configs, keyword-only) ---
        // Market stallkeepers + shoppers + residents. Each is a
        // full Npc so existing systems (wander, dialogue, view
        // cull) just apply; their dialogue is intentionally short
        // to keep file size manageable.
        new Npc({
            id: "stallkeep_fruit", name: "Fruit Seller",
            x: 2110 - 16, y: 700, width: 32, height: 32,
            interactRange: 56, wanderRadius: 12, speed: 16,
            colors: { robe: "#c96535", trim: "#6c3018", sash: "#ffd166", hat: "#4a2810" },
            dialogue: {
                greeting: '"Fresh from the orchards. Don\'t tell the Elder my prices."',
                options: [
                    { label: "What do you sell?", response: "Apples, figs, grove-berries. Sweet enough to make your sword hand shake." },
                    { label: "Goodbye.", close: true },
                ],
            },
        }),
        new Npc({
            id: "stallkeep_cloth", name: "Cloth Seller",
            x: 2490 - 16, y: 700, width: 32, height: 32,
            interactRange: 56, wanderRadius: 10, speed: 14,
            colors: { robe: "#5a7ea0", trim: "#2a3e58", sash: "#c0c0d8", hat: "#1e2e42" },
            dialogue: {
                greeting: '"Cloth woven in the old way. Dye\'s honest."',
                options: [
                    { label: "Any deals?", response: "Deals for heroes, not hagglers. Show a blade if you want a discount." },
                    { label: "Goodbye.", close: true },
                ],
            },
        }),
        new Npc({
            id: "stallkeep_spice", name: "Spice Seller",
            x: 2300 - 16, y: 768, width: 32, height: 32,
            interactRange: 56, wanderRadius: 8, speed: 14,
            colors: { robe: "#a84b4b", trim: "#5a2020", sash: "#ffd166", hat: "#3a1414" },
            dialogue: {
                greeting: '"Saffron, cardamom, fire-root. One of them isn\'t for soup."',
                options: [
                    { label: "Which one?", response: "*winks* Fire-root. A pinch in your wineskin and you\'ll feel braver than you are." },
                    { label: "Goodbye.", close: true },
                ],
            },
        }),
        new Npc({
            id: "shopper_1", name: "Shopper",
            x: 2360, y: 540, width: 32, height: 32,
            interactRange: 54, wanderRadius: 60, speed: 28,
            colors: { robe: "#9c6aa8", trim: "#5a3064", sash: "#e2c6ea", hat: "#3a1c44" },
            dialogue: {
                greeting: '"Figs are too dear today. Everything is."',
                options: [{ label: "Goodbye.", close: true }],
            },
        }),
        new Npc({
            id: "shopper_2", name: "Shopper",
            x: 2200, y: 620, width: 32, height: 32,
            interactRange: 54, wanderRadius: 70, speed: 32,
            colors: { robe: "#6a8c50", trim: "#2e4226", sash: "#c0d890", hat: "#1e2c14" },
            dialogue: {
                greeting: '"If the caverns quiet, trade picks back up. Gods willing."',
                options: [{ label: "Goodbye.", close: true }],
            },
        }),
        new Npc({
            id: "kid_plaza", name: "Kid",
            x: 1700, y: 1240, width: 32, height: 32,
            interactRange: 48, wanderRadius: 90, speed: 58,
            idleMin: 0.3, idleMax: 1.0,
            walkMin: 1.2, walkMax: 2.4,
            colors: { robe: "#e8a858", trim: "#8c5630", sash: "#ffd166", hat: "#5a351a" },
            dialogue: {
                greeting: '"Tag! ... wait. Are you IT?"',
                options: [{ label: "No. Goodbye.", close: true }],
            },
        }),
        new Npc({
            id: "farmer", name: "Farmer",
            x: 560, y: 1280, width: 32, height: 32,
            interactRange: 58, wanderRadius: 60, speed: 22,
            colors: { robe: "#7a8a4a", trim: "#3e4624", sash: "#a0b060", hat: "#2a3012" },
            dialogue: {
                greeting: '"Rain\'s late. Grove-berries will be sour again."',
                options: [
                    { label: "Any word from the east?", response: "Quieter than last week. Could mean calm. Could mean the wrong thing held its breath." },
                    { label: "Goodbye.", close: true },
                ],
            },
        }),
        new Npc({
            id: "beggar", name: "Beggar",
            x: 1260, y: 1180, width: 32, height: 32,
            interactRange: 50, wanderRadius: 24, speed: 12,
            colors: { robe: "#555560", trim: "#28282e", sash: "#8e8e98", hat: "#1a1a22" },
            dialogue: {
                greeting: '"A coin, traveler? A blessing for a coin."',
                options: [{ label: "Goodbye.", close: true }],
            },
        }),
        new Npc({
            id: "watcher", name: "Watcher",
            x: 2860, y: 1300, width: 32, height: 32,
            interactRange: 58, wanderRadius: 40, speed: 24,
            colors: { robe: "#3a5070", trim: "#1c2a42", sash: "#8ab4d8", hat: "#10182a" },
            dialogue: {
                greeting: '"Eyes on the east. Always."',
                options: [{ label: "Goodbye.", close: true }],
            },
        }),
        new Npc({
            id: "child_sw", name: "Child",
            x: 860, y: 1800, width: 32, height: 32,
            interactRange: 46, wanderRadius: 70, speed: 50,
            idleMin: 0.2, idleMax: 0.8,
            colors: { robe: "#a8c0d8", trim: "#5a7090", sash: "#ffd166", hat: "#2a4258" },
            dialogue: {
                greeting: '"Mom says don\'t bother adventurers. So I\'m not."',
                options: [{ label: "Goodbye.", close: true }],
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
                greeting: {
                    chapter1: '"Welcome to my shop, traveler. Browse freely."',
                    chapter3: '"Word is you took the Elder\'s task. Coins well earned."',
                    chapter5: '"The hero, in my humble shop! I\'ve... not raised prices. Promise."',
                },
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
                    { keywords: ["shrine", "lock", "sealed", "gate"], response: "Lights. Humming. And a sealed gate. You'll need the Elder's Golden Key to even step inside." },
                    { keywords: ["key", "golden", "unlock"], response: "Key's not for sale, friend - it's the Elder's to give. Do their tasks." },
                    { keywords: ["elder", "village"], response: "The Elder keeps order. A good sort, even if they drive a hard bargain." },
                    { keywords: ["gold", "money", "coin", "price"], response: "Coins open doors, traveler. Slay beasts, gather coin, prosper." },
                ],
                fallback: "Trade's my business - I can't say I know much beyond it.",
            },
        }),
    ];

    // Tavern interior roster - Keeper behind the bar. Offers a
    // "Rest" option that heals the player back to full HP, plus
    // gossip. Positions use tavern_interior coords (17x11 tile
    // room = 544x352 px).
    LEVELS.tavern_interior.npcs = [
        new Npc({
            id: "keeper",
            name: "Keeper",
            // Behind the counter, north-center.
            x: 272 - 16,
            y: 120,
            width: 32, height: 32,
            interactRange: 66,
            wanderRadius: 22,
            speed: 18,
            colors: { robe: "#a54824", trim: "#6e2e18", sash: "#f0c270", hat: "#4a1e0c" },
            dialogue: {
                greeting: {
                    chapter1: '"Sit a spell, traveler. Tales flow free here."',
                    chapter2: '"Heard you were in the caverns. The stew knows tough customers."',
                    chapter4: '"So the shrine opened. Drinks on the house if you come back whole."',
                    chapter5: '"The hero drinks free tonight. Sit. Breathe. You earned it."',
                },
                options: [
                    {
                        label: "Rest by the fire.",
                        action() {
                            healPlayer(player.maxHp);
                            questLog.showToast("You feel fully restored.", 2.0);
                        },
                    },
                    {
                        label: "Who are you?",
                        response: "Folk call me Keeper. I keep the stew warm and the stories warmer.",
                    },
                    {
                        label: "Hear any rumors?",
                        response: "The caverns have grown louder. Shadows where there shouldn't be any.",
                    },
                    { label: "Ask a question...", input: true },
                    { label: "Goodbye.", close: true },
                ],
                knowledge: [
                    { keywords: ["name", "who", "keeper"], response: "Keeper, they call me. I run the Travellers' Rest." },
                    { keywords: ["rest", "heal", "sleep"], response: "A seat by the fire restores you completely. Pick 'Rest by the fire.'" },
                    { keywords: ["food", "stew", "drink", "menu"], response: "Stew. Always stew. Today's is a miracle." },
                    { keywords: ["rumor", "gossip", "news"], response: "The Scout's been jumpier than usual. And Hemlen's caravan? Still nowhere." },
                    { keywords: ["shrine", "boss", "keeper of"], response: "They say something rose beyond the shrine gate. If you hear its roar, you're too close." },
                    { keywords: ["elder"], response: "A stern sort, our Elder. But fair. Do their work and they'll see you right." },
                    { keywords: ["town", "grove", "city"], response: "The Sunlit Grove's quiet, but every road to the east starts here." },
                ],
                fallback: "Folks come here to not think so hard. Have a pint and try again.",
            },
        }),

        new Npc({
            id: "bard", name: "Bard",
            x: 120, y: 210, width: 32, height: 32,
            interactRange: 58, wanderRadius: 18, speed: 14,
            colors: { robe: "#7440c0", trim: "#4a1c80", sash: "#c0a0ff", hat: "#2c0c50" },
            dialogue: {
                greeting: '"La la - another song, friend?"',
                options: [
                    { label: "Play a tune.", response: "*strums* ...a quiet one, for travelers bound east." },
                    { label: "Who are you?", response: "A wandering bard. My strings keep better time than my feet." },
                    { label: "Ask a question...", input: true },
                    { label: "Goodbye.", close: true },
                ],
                knowledge: [
                    { keywords: ["name", "who", "bard"], response: "A bard. Songs for copper, stories for free." },
                    { keywords: ["song", "music", "play", "tune"], response: "I know sea-shanties, funeral dirges, and one very good limerick." },
                    { keywords: ["shrine", "star"], response: "There's a ballad older than the grove about the star-fall. I only know two verses." },
                    { keywords: ["keeper", "captain", "elder"], response: "Keepers a soft mark. Captains a hard one. Elder pays if the tune is sad enough." },
                ],
                fallback: "*hums* ... no words for that one yet.",
            },
        }),

        new Npc({
            id: "drunk", name: "Patron",
            x: 400, y: 250, width: 32, height: 32,
            interactRange: 58, wanderRadius: 24, speed: 16,
            colors: { robe: "#b09060", trim: "#705030", sash: "#f0d8a0", hat: "#402818" },
            dialogue: {
                greeting: '"\'nother round... *hic*... for our friend!"',
                options: [
                    { label: "What have you heard?", response: "Shh - the caverns whisper. I heard \'em. Or I heard the stew. Same thing." },
                    { label: "Who are you?", response: "Just a patron. Patron saint of patrons, some say. Nobody says that." },
                    { label: "Ask a question...", input: true },
                    { label: "Goodbye.", close: true },
                ],
                knowledge: [
                    { keywords: ["name", "who"], response: "Me? I\'m \'imself. Or \'erself. Depends on the hour." },
                    { keywords: ["drink", "beer", "ale", "stew"], response: "Stew\'s the best in three counties. The ale\'s WORSE in seven." },
                    { keywords: ["cavern", "shrine", "boss"], response: "Past the gate... big. Red. Eats noise. Trust me on that one." },
                ],
                fallback: "*hic* ...never heard of it.",
            },
        }),
    ];

    // Guild hall interior roster - Captain at the quest board.
    // Dialogue is placeholder for future side contracts; the "Post
    // a contract" option is the extension seam.
    LEVELS.guild_interior.npcs = [
        new Npc({
            id: "captain",
            name: "Captain",
            // Commander of the watch - holds their post until the
            // Shrine is ready to fall. Recruitable in chapter4+.
            // Tank: heavy HP, low damage, draws enemy attention.
            role: "warrior",
            squadRole: "tank",
            recruitChapter: "chapter4",
            x: 272 - 16,
            y: 120,
            width: 32, height: 32,
            interactRange: 66,
            wanderRadius: 28,
            speed: 22,
            colors: { robe: "#3c5c8c", trim: "#223a5a", sash: "#8ad9ff", hat: "#1a2c46" },
            dialogue: {
                greeting: {
                    chapter1: '"Adventurer. The guild logs every blade that passes through."',
                    chapter2: '"Caverns on your sword? Good. Keep the logs honest."',
                    chapter3: '"Key-bearer. Your name goes in the thicker ledger now."',
                    chapter5: '"By the guild\'s mark - you\'re a Blade of Ethereon. Stand down, captain\'s orders."',
                },
                options: [
                    {
                        label: "What does the guild do?",
                        response: "We track sightings, post contracts, and keep the roads walkable. Mostly.",
                    },
                    {
                        label: "Got any work?",
                        response: "Finish the Elder's chain first. When the shrine falls, we'll have contracts worth posting.",
                    },
                    {
                        label: "Who are you?",
                        response: "Captain of the watch - what little of it remains since the star-fall.",
                    },
                    { label: "Fight with me.", action: recruitInteract },
                    { label: "Ask a question...", input: true },
                    { label: "Goodbye.", close: true },
                ],
                knowledge: [
                    { keywords: ["name", "who", "captain"], response: "Captain of the grove watch. Once commanded a hundred swords; now, a handful." },
                    { keywords: ["guild", "contract", "work", "job", "quest"], response: "Contracts come and go. The Elder's chain is today's only active posting." },
                    { keywords: ["shrine", "boss", "keeper of"], response: "Slay the Shrine Keeper and the Guild will mark you a Blade of Ethereon." },
                    { keywords: ["elder"], response: "The Elder is the true authority here. We log; they decide." },
                    { keywords: ["scout"], response: "Our Scout reports to me. Good eye, that one - listen when they speak." },
                    { keywords: ["weapon", "sword", "energy"], response: "Keep your edge sharp. The caverns don't forgive a dull blade." },
                    { keywords: ["caverns", "east"], response: "East of here, past the gate - that's guild territory. Or was, before the caverns soured." },
                    { keywords: ["star", "fall"], response: "Since the star fell, the map's been rewriting itself. We catalog what remains." },
                ],
                fallback: "Stick to contracts, traveler. The guild survives on clear purpose.",
            },
        }),

        new Npc({
            id: "scribe", name: "Scribe",
            x: 120, y: 210, width: 32, height: 32,
            interactRange: 58, wanderRadius: 12, speed: 12,
            colors: { robe: "#555560", trim: "#2c2c34", sash: "#a0a0a8", hat: "#1a1a22" },
            dialogue: {
                greeting: '"One moment - ink is drying."',
                options: [
                    { label: "What do you record?", response: "Contracts, killcounts, roster changes. The Captain signs; I log." },
                    { label: "Who are you?", response: "Guild scribe. My ink outlasts swords." },
                    { label: "Ask a question...", input: true },
                    { label: "Goodbye.", close: true },
                ],
                knowledge: [
                    { keywords: ["name", "who", "scribe"], response: "Scribe of the guild. Letters, ledgers, losses." },
                    { keywords: ["record", "log", "ledger", "contract"], response: "Every contract gets two copies. One goes to the Captain, one goes east with you." },
                    { keywords: ["history", "star", "fall"], response: "The ledger only goes back a hundred years. Anything older lives in song." },
                ],
                fallback: "I record answers; I don't usually give them.",
            },
        }),

        new Npc({
            id: "recruit", name: "Recruit",
            // Eager rookie - first warrior willing to join you,
            // available from the very first chapter.
            // Melee warrior: balanced hp + damage, closes the gap.
            role: "warrior",
            squadRole: "melee",
            recruitChapter: "chapter1",
            x: 400, y: 250, width: 32, height: 32,
            interactRange: 58, wanderRadius: 36, speed: 40,
            colors: { robe: "#687488", trim: "#343c48", sash: "#b8c0d0", hat: "#202a38" },
            dialogue: {
                greeting: '"Hah! ...*pant*... drill time!"',
                options: [
                    { label: "What are you training?", response: "Footwork, mostly. The Captain says footwork wins fights." },
                    { label: "Who are you?", response: "Fresh recruit. Haven't earned the watch cloak yet." },
                    { label: "Fight with me.", action: recruitInteract },
                    { label: "Ask a question...", input: true },
                    { label: "Goodbye.", close: true },
                ],
                knowledge: [
                    { keywords: ["name", "who", "recruit"], response: "Recruit of the grove watch. Swords today, cloak tomorrow." },
                    { keywords: ["train", "drill", "sword", "fight"], response: "Footwork drills at dawn. The Captain says if you can't walk, you can't swing." },
                    { keywords: ["captain"], response: "The Captain's tough but fair. Mostly tough." },
                    { keywords: ["shrine", "boss"], response: "My first contract'll be the shrine, I bet. I hope my footwork's ready." },
                ],
                fallback: "Ask the Captain - I'm still learning.",
            },
        }),
    ];

    // ---------------------------------------------------------------
    // City life - social clustering + chat bubbles + rumors
    //
    // Wraps the existing Npc wander/gather machinery:
    // - CITY_CLUSTERS declares magnet points in each safe zone.
    // - assignCityClusters walks the roster at level load and flips
    //   a portion of NPCs into "gather" routines pointed at those
    //   clusters, so the city naturally pools into small groups
    //   around the plaza / tavern / market instead of spreading flat.
    // - cityChat drives occasional NPC-to-NPC bubble exchanges,
    //   picking a pair of nearby idlers every few seconds.
    // - cityRumors surfaces one of a rotating pool of flavor lines
    //   as a floating bubble so the player can just walk past and
    //   catch the world's mood.
    //
    // All of this is mobile-safe: bubbles are a small pool that
    // fades + splices, zones are static data, and the chat picker
    // is O(npcs) at a throttled cadence. Nothing runs outside safe
    // zones, so dungeons stay unaffected.
    // ---------------------------------------------------------------
    const CITY_CLUSTERS = {
        grove: [
            { id: "plaza",   x: 1600, y: 1220, radius: 90, capacity: 5 },
            { id: "market",  x: 2320, y: 640,  radius: 80, capacity: 4 },
            { id: "tavern",  x: 1760, y: 1030, radius: 60, capacity: 3 },
            { id: "southsq", x: 900,  y: 1720, radius: 80, capacity: 4 },
        ],
        port_halen: [
            { id: "dock",    x: 940,  y: 900,  radius: 90, capacity: 5 },
            { id: "harbor",  x: 880,  y: 700,  radius: 70, capacity: 3 },
            { id: "market",  x: 1160, y: 720,  radius: 60, capacity: 3 },
        ],
        emberhold: [
            { id: "forge",   x: 1010, y: 720,  radius: 80, capacity: 4 },
            { id: "miners",  x: 640,  y: 720,  radius: 70, capacity: 3 },
            { id: "carver",  x: 1260, y: 760,  radius: 60, capacity: 3 },
        ],
    };

    // Flavor bubbles. Each NPC, when idly waiting for something to
    // do, may emit one of these. Picked at random per-trigger so
    // the same NPC doesn't keep repeating themselves.
    const CITY_CHAT_LINES = [
        "Did you hear what happened below?",
        "Something is changing...",
        "Three travelers passed through this morning.",
        "The fountain water looks brighter today.",
        "I haven't slept right since the gate reopened.",
        "They say the shrine hums at night now.",
        "Keep your head down and your blade clean.",
        "My cousin swore she saw a wolf of light.",
        "Trade's slow - the roads east are off-limits.",
        "A stranger asked about the Elder. Not the first.",
    ];

    // Rumors the player catches as ambient, chapter-aware lines.
    // NOT tied to any NPC - they float up over the nearest idle
    // villager every so often so the city feels like it's talking
    // to itself. story.missionTag branches surface story-reactive
    // rumors when available.
    const CITY_RUMORS = [
        { minIdx: 0, text: "Strange creatures were seen in the outskirts." },
        { minIdx: 0, text: "The Elder knows more than they're saying." },
        { minIdx: 1, text: "Caverns growl deeper than last season." },
        { minIdx: 2, text: "Key-bearers are few. Keep your guard." },
        { minIdx: 3, text: "The shrine's gate draws stranger tides." },
        { minIdx: 4, text: "That crown... it's reacting, isn't it?" },
        { minIdx: 5, text: "The Abyss didn't close. It only listened." },
    ];

    // Assigns a fraction of a level's roster to gather routines
    // pointed at its cluster list. Honors each cluster's capacity
    // so groups form as sizes 3-6 naturally rather than the whole
    // crowd piling onto one spot. Warriors + named-quest NPCs keep
    // their patrol / wander routines untouched so the campaign
    // flow isn't disrupted.
    function assignCityClusters(levelId) {
        const clusters = CITY_CLUSTERS[levelId];
        const level = LEVELS[levelId];
        if (!clusters || !level || !level.npcs) return;
        const fill = clusters.map(c => ({ id: c.id, count: 0 }));

        for (const npc of level.npcs) {
            if (!npc || npc._clusterAssigned) continue;
            // Skip warriors + NPCs with existing patrol / gather
            // contracts so campaign-critical behavior isn't lost.
            if (npc.role === "warrior") continue;
            if (npc.routine === "patrol") continue;
            if (npc.routine === "gather" && npc.gatherPoint) continue;

            // 65% of eligible wanderers get pulled into a cluster.
            if (Math.random() > 0.65) continue;

            // Pick the cluster with the most capacity remaining so
            // groups fill in parallel rather than oversaturating one.
            let pick = null, best = -1;
            for (let i = 0; i < clusters.length; i++) {
                const headroom = clusters[i].capacity - fill[i].count;
                if (headroom > best) { best = headroom; pick = i; }
            }
            if (pick == null || best <= 0) continue;

            const c = clusters[pick];
            npc._clusterAssigned = true;
            npc.routine = "gather";
            npc.gatherPoint = { x: c.x, y: c.y };
            npc.gatherChance = 0.55;
            npc.gatherJitter = c.radius * 0.7;
            fill[pick].count++;
        }
    }

    // Chat bubbles - ephemeral world-space text attached to an NPC
    // or fixed world point. Rendered over NPCs in the draw pipeline
    // and fades out with its timer.
    const chatBubbles = [];
    function spawnChatBubble(ownerOrPoint, text, duration = 3.0) {
        chatBubbles.push({
            owner: ownerOrPoint.x != null ? null : ownerOrPoint,
            // Point fallback: used for rumors with no specific owner.
            px: ownerOrPoint.x ?? 0,
            py: ownerOrPoint.y ?? 0,
            text,
            timer: duration,
            duration,
        });
    }
    function updateChatBubbles(dt) {
        for (let i = chatBubbles.length - 1; i >= 0; i--) {
            chatBubbles[i].timer -= dt;
            if (chatBubbles[i].timer <= 0) chatBubbles.splice(i, 1);
        }
    }
    function drawChatBubbles(ctx) {
        if (!chatBubbles.length) return;
        ctx.save();
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        for (const b of chatBubbles) {
            const x = b.owner
                ? Math.round(b.owner.x + b.owner.width / 2)
                : Math.round(b.px);
            const y = b.owner
                ? Math.round(b.owner.y - 2)
                : Math.round(b.py);
            const fade = Math.min(1, b.timer / 0.5);
            ctx.globalAlpha = fade;
            ctx.font = "11px system-ui, sans-serif";
            const w = Math.ceil(ctx.measureText(b.text).width) + 12;
            const h = 18;
            roundRectPath(ctx, x - w / 2, y - h - 4, w, h, 4);
            ctx.fillStyle = "rgba(14, 14, 22, 0.9)";
            ctx.fill();
            ctx.strokeStyle = "rgba(138, 217, 255, 0.55)";
            ctx.lineWidth = 1;
            ctx.stroke();
            drawShadowedText(b.text, x, y - 6,
                "#e8e8f0", "11px system-ui, sans-serif");
        }
        ctx.globalAlpha = 1;
        ctx.restore();
    }

    // Chat + rumor ticker. Runs only in safe zones, throttled so
    // the city chatters at a believable cadence (a bubble every
    // 6-12s, not every frame).
    const cityChat = {
        chatCd: 6 + Math.random() * 6,
        rumorCd: 18 + Math.random() * 12,
        face(a, b) {
            // Point a toward b using the existing animator dir API.
            if (!a.animator) return;
            const dx = (b.x + b.width / 2) - (a.x + a.width / 2);
            const dy = (b.y + b.height / 2) - (a.y + a.height / 2);
            const d = dirFromVector(dx, dy);
            if (d !== null) a.animator.setDir(d);
        },
        tick(dt) {
            if (!currentLevel || !currentLevel.safe) return;

            this.chatCd -= dt;
            if (this.chatCd <= 0) {
                this.chatCd = 5 + Math.random() * 7;
                this._tickChat();
            }
            this.rumorCd -= dt;
            if (this.rumorCd <= 0) {
                this.rumorCd = 16 + Math.random() * 12;
                this._tickRumor();
            }
        },
        _tickChat() {
            const list = currentLevel.npcs;
            if (!list || list.length < 2) return;
            // Pick a pair that's close AND roughly idle (state
            // "idle" in their wander state machine).
            const idlers = [];
            for (const n of list) {
                if (n.state === "idle" && !n._isFollower) idlers.push(n);
            }
            if (idlers.length < 2) return;
            // Find a close pair (squared-dist < 80^2).
            const R2 = 90 * 90;
            for (let tries = 0; tries < 6; tries++) {
                const a = idlers[Math.floor(Math.random() * idlers.length)];
                const b = idlers[Math.floor(Math.random() * idlers.length)];
                if (a === b) continue;
                const dx = a.x - b.x, dy = a.y - b.y;
                if (dx * dx + dy * dy > R2) continue;
                // Pick two different lines so they're in dialogue.
                const lineA = CITY_CHAT_LINES[
                    Math.floor(Math.random() * CITY_CHAT_LINES.length)
                ];
                let lineB;
                do {
                    lineB = CITY_CHAT_LINES[
                        Math.floor(Math.random() * CITY_CHAT_LINES.length)
                    ];
                } while (lineB === lineA);
                this.face(a, b);
                this.face(b, a);
                // Stagger B's bubble so it reads as a reply.
                spawnChatBubble(a, lineA, 3.2);
                setTimeout(() => {
                    if (b && b.alive !== false) spawnChatBubble(b, lineB, 2.8);
                }, 1200);
                return;
            }
        },
        _tickRumor() {
            const list = currentLevel.npcs;
            if (!list || !list.length) return;
            const chapterIdx = Math.max(0, story.chapterOrder.indexOf(story.state));
            const pool = CITY_RUMORS.filter(r => chapterIdx >= (r.minIdx ?? 0));
            if (!pool.length) return;
            // Pick a nearby NPC to the player so the rumor reads
            // as overhearable, not broadcast.
            const pcx = player.x + player.width / 2;
            const pcy = player.y + player.height / 2;
            let best = null, bestD = 360 * 360;
            for (const n of list) {
                if (n._isFollower) continue;
                const dx = (n.x + n.width / 2) - pcx;
                const dy = (n.y + n.height / 2) - pcy;
                const d = dx * dx + dy * dy;
                if (d < bestD) { best = n; bestD = d; }
            }
            if (!best) return;
            const line = pool[Math.floor(Math.random() * pool.length)].text;
            spawnChatBubble(best, line, 4.0);
        },
        reset() {
            this.chatCd = 6 + Math.random() * 6;
            this.rumorCd = 18 + Math.random() * 12;
            chatBubbles.length = 0;
        },
    };

    // ---------------------------------------------------------------
    // World clock + city events + mystical sightings
    //
    // worldClock drives an 8-minute day/night cycle. The phase drives
    // a screen-space color overlay (dawn warm / day clear / dusk warm
    // / night cool), slows NPC wander speed at night, and pulls the
    // roster toward building doors so the city "goes to sleep".
    //
    // cityEvents spawns short random scenes at cluster anchors -
    // gatherings, arguments, performers - that last ~24s and trigger
    // extra chat bubbles on nearby NPCs. Player can "Watch" them for
    // a small coin reward.
    //
    // mysticalEvents are rare (~4 min apart) screen-level sightings:
    // a shooting star streak, a crown pulse, or a glow-creature drift.
    // Nearby NPCs face the event position.
    //
    // All of this runs only in safe zones, stays mobile-cheap
    // (zero per-frame allocations after setup), and layers on top
    // of the existing cityChat / bubbles pool.
    // ---------------------------------------------------------------
    const worldClock = {
        cycleSeconds: 480,   // 8 min per full cycle
        t: 0.18,             // start at dawn so the first load is bright

        update(dt) {
            this.t = (this.t + dt / this.cycleSeconds) % 1;
        },

        phase() {
            const t = this.t;
            if (t < 0.18) return "dawn";
            if (t < 0.58) return "day";
            if (t < 0.72) return "dusk";
            return "night";
        },

        // Screen-space color overlay. Called at the end of the world
        // draw so tiles / sprites all get tinted, but the HUD (drawn
        // after) stays readable.
        drawOverlay(ctx) {
            const p = this.phase();
            if (p === "day") return;
            // Smoothly ramp alpha based on proximity to phase center
            // so transitions glide rather than snap.
            let fill, alpha;
            const t = this.t;
            if (p === "dawn") {
                fill = "rgba(255, 190, 120,";
                const pct = t / 0.18;
                alpha = (1 - pct) * 0.22;
            } else if (p === "dusk") {
                fill = "rgba(240, 130, 90,";
                const pct = (t - 0.58) / (0.72 - 0.58);
                alpha = Math.sin(pct * Math.PI) * 0.26;
            } else {
                // Night: deep blue cast. Holds its peak darkness
                // through the middle of the night.
                fill = "rgba(20, 30, 70,";
                const pct = (t - 0.72) / (1 - 0.72);
                alpha = 0.40 + Math.sin(pct * Math.PI) * 0.10;
            }
            ctx.fillStyle = fill + alpha.toFixed(3) + ")";
            ctx.fillRect(0, 0, VIEW_W, VIEW_H);
        },

        // Warm window glow for nighttime buildings. Drawn in world
        // space so it scrolls with the camera.
        drawBuildingLights(ctx, level) {
            if (this.phase() !== "night") return;
            if (!level || !level.buildings) return;
            for (const b of level.buildings) {
                if (b.stall || !b.doorX) continue;  // skip stalls
                const wy = b.y + Math.floor(b.h * 0.35);
                ctx.fillStyle = "rgba(255, 209, 102, 0.38)";
                ctx.fillRect(b.x + 16, wy, 24, 20);
                ctx.fillRect(b.x + b.w - 40, wy, 24, 20);
            }
        },

        // NPC-tick modifiers pulled from the clock. Simple bands:
        // night cuts wander speed + halves gather chance so the
        // city palpably slows down.
        npcSpeedMult() {
            const p = this.phase();
            return p === "night" ? 0.45 : p === "dusk" ? 0.8 : 1;
        },
        npcGatherBias() {
            // Night pushes every NPC toward home - used by Npc
            // update below to bias wander target selection.
            return this.phase() === "night";
        },
    };

    // --- City events --------------------------------------------------
    const CITY_EVENT_LINES = {
        gathering: [
            "Tell me more...",
            "You don't say.",
            "Huh!",
        ],
        argument: [
            "That's not what I said!",
            "You always do this!",
            "Enough!",
        ],
        performer: [
            "♪ la la la ♪",
            "Bravo!",
            "More!",
        ],
    };

    const cityEvents = {
        active: null,   // { kind, x, y, timer, duration, label }
        cooldown: 30,

        _clusterAnchor(levelId) {
            const zones = CITY_CLUSTERS[levelId];
            if (!zones || !zones.length) return null;
            return zones[Math.floor(Math.random() * zones.length)];
        },

        _kind() {
            const r = Math.random();
            if (r < 0.4) return "gathering";
            if (r < 0.75) return "performer";
            return "argument";
        },

        spawn() {
            if (!currentLevel || !currentLevel.safe) return;
            const anchor = this._clusterAnchor(currentLevel.id);
            if (!anchor) return;
            const kind = this._kind();
            this.active = {
                kind, x: anchor.x, y: anchor.y,
                timer: 24, duration: 24,
                label:
                    kind === "gathering" ? "SMALL CROWD"
                    : kind === "argument" ? "ARGUMENT"
                    : "PERFORMER",
                watched: false,
            };
            // Drop a chat bubble at the anchor so the player
            // notices the event even from a distance.
            const lines = CITY_EVENT_LINES[kind];
            spawnChatBubble(
                { x: anchor.x, y: anchor.y },
                lines[Math.floor(Math.random() * lines.length)],
                3.2
            );
        },

        update(dt) {
            if (!currentLevel || !currentLevel.safe) {
                this.active = null;
                return;
            }
            if (this.active) {
                this.active.timer -= dt;
                // Occasionally spawn an additional bubble at the
                // anchor so the event feels live instead of static.
                if (Math.random() < dt * 0.5) {
                    const lines = CITY_EVENT_LINES[this.active.kind];
                    spawnChatBubble(
                        { x: this.active.x, y: this.active.y - 4 },
                        lines[Math.floor(Math.random() * lines.length)],
                        2.6
                    );
                }
                if (this.active.timer <= 0) this.active = null;
            } else {
                this.cooldown -= dt;
                if (this.cooldown <= 0) {
                    this.cooldown = 45 + Math.random() * 50;
                    if (Math.random() < 0.7) this.spawn();
                }
            }
        },

        draw(ctx) {
            if (!this.active) return;
            const e = this.active;
            const fade = Math.min(1, e.timer / 1.0);
            // Ground marker - a pulsing ring around the event.
            const pulse = 0.6 + 0.4 * Math.abs(Math.sin(performance.now() * 0.004));
            ctx.save();
            ctx.globalAlpha = fade * 0.55 * pulse;
            ctx.strokeStyle =
                e.kind === "argument"  ? "#e06666" :
                e.kind === "performer" ? "#ffd166" :
                                         "#8ad9ff";
            ctx.lineWidth = 2.5;
            ctx.beginPath();
            ctx.arc(e.x, e.y, 40, 0, Math.PI * 2);
            ctx.stroke();
            // Icon / label floating above.
            ctx.globalAlpha = fade;
            ctx.fillStyle = "#1a1a24";
            roundRectPath(ctx, e.x - 46, e.y - 58, 92, 20, 4);
            ctx.fill();
            ctx.strokeStyle = "rgba(255, 209, 102, 0.6)";
            ctx.lineWidth = 1;
            ctx.stroke();
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            drawShadowedText(e.label, e.x, e.y - 48,
                "#ffd166", "bold 10px system-ui, sans-serif");
            ctx.restore();
        },

        // Player interact: watch the event for a small reward.
        watch() {
            if (!this.active || this.active.watched) return false;
            this.active.watched = true;
            const coins = 2 + Math.floor(Math.random() * 4);
            player.coins += coins;
            questLog.showToast(`You paused to watch. +${coins}g`, 2.0);
            sound.play("coin");
            return true;
        },

        reset() {
            this.active = null;
            this.cooldown = 30;
        },
    };

    function nearestCityEvent() {
        if (!cityEvents.active) return null;
        const pcx = player.x + player.width / 2;
        const pcy = player.y + player.height / 2;
        const dx = cityEvents.active.x - pcx;
        const dy = cityEvents.active.y - pcy;
        if (dx * dx + dy * dy > 60 * 60) return null;
        return cityEvents.active;
    }

    // --- Mystical sightings ------------------------------------------
    // Rare (~4 min apart, with randomness). Three kinds. Each runs a
    // short screen-space / world-space animation that draws above
    // everything else in the world layer.
    const mysticalEvents = {
        active: null,
        cooldown: 90 + Math.random() * 120,

        _pick() {
            const r = Math.random();
            if (r < 0.4) return "shootingStar";
            if (r < 0.75) return "crownPulse";
            return "glowDrift";
        },

        trigger() {
            const kind = this._pick();
            const pcx = player.x + player.width / 2;
            const pcy = player.y + player.height / 2;
            if (kind === "shootingStar") {
                this.active = {
                    kind,
                    // Screen-space streak crossing from upper-left
                    // to upper-right, with a randomized y.
                    sx: -60, sy: 30 + Math.random() * 80,
                    ex: VIEW_W + 60, ey: 50 + Math.random() * 60,
                    timer: 2.0, duration: 2.0,
                };
                questLog.showToast("A strange light crosses the sky.", 2.4);
            } else if (kind === "crownPulse") {
                this.active = {
                    kind,
                    x: pcx, y: pcy,
                    timer: 1.5, duration: 1.5,
                };
                // Give the crown a small energy nudge as a reward.
                if (crown) crown.add(8);
                questLog.showToast("The crown pulses - something answered.", 2.6);
                flash.trigger(0.3, 0.4);
            } else {
                // Glow drift: spawn a wild light creature in the
                // world even if the zone roll already passed. Still
                // capped by the "one wild at a time" rule.
                maybeSpawnWildLightCreature(currentLevel);
                this.active = null;  // no extra visual needed
                questLog.showToast("Something of light drifts nearby.", 2.6);
                return;
            }
        },

        update(dt) {
            this.cooldown -= dt;
            if (this.cooldown <= 0) {
                this.cooldown = 210 + Math.random() * 150;
                this.trigger();
            }
            if (this.active) {
                this.active.timer -= dt;
                if (this.active.timer <= 0) this.active = null;
            }
        },

        drawScreen(ctx) {
            // Draws in screen space - called AFTER the world
            // transform restore so the shooting star crosses the
            // viewport, not the world.
            if (!this.active) return;
            const e = this.active;
            if (e.kind === "shootingStar") {
                const t = 1 - e.timer / e.duration;
                const x = e.sx + (e.ex - e.sx) * t;
                const y = e.sy + (e.ey - e.sy) * t;
                ctx.save();
                ctx.globalAlpha = Math.sin(t * Math.PI) * 0.9;
                // Trail
                ctx.strokeStyle = "#ffffff";
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(x, y);
                ctx.lineTo(x - 48, y - 12);
                ctx.stroke();
                // Head
                ctx.fillStyle = "#fff6d6";
                ctx.beginPath();
                ctx.arc(x, y, 3, 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();
            }
        },

        drawWorld(ctx) {
            // World-space: crown pulse emanates from the player.
            if (!this.active) return;
            const e = this.active;
            if (e.kind === "crownPulse") {
                const t = 1 - e.timer / e.duration;
                const r = 40 + t * 160;
                ctx.save();
                ctx.globalAlpha = (1 - t) * 0.7;
                ctx.strokeStyle = "#ffd166";
                ctx.lineWidth = 3;
                ctx.beginPath();
                ctx.arc(e.x, e.y, r, 0, Math.PI * 2);
                ctx.stroke();
                ctx.restore();
            }
        },

        reset() {
            this.active = null;
            this.cooldown = 90 + Math.random() * 120;
        },
    };

    // Run cluster assignment once per level id. Flag prevents a
    // re-entry each zone load from re-shuffling routines.
    const _clustersAssigned = new Set();
    function ensureCityClustersFor(levelId) {
        if (_clustersAssigned.has(levelId)) return;
        _clustersAssigned.add(levelId);
        assignCityClusters(levelId);
    }

    // Boot-time city-life init. Must run AFTER the cityChat +
    // clusters consts above are initialized (they live here because
    // they need the fully-populated grove NPC roster). transitionTo
    // and restartGame hit these paths too, but their function
    // bodies close over the names at call time, so they'll always
    // see the live cityChat binding by the time they run.
    ensureCityClustersFor(currentLevel && currentLevel.id);
    cityChat.reset();
    cityEvents.reset();
    mysticalEvents.reset();

    // Port Halen roster - coastal-city NPCs. Compact configs with
    // keyword-only dialogue to keep the per-NPC data lightweight.
    LEVELS.port_halen.npcs = [
        new Npc({
            id: "dockmaster", name: "Dockmaster",
            x: 884, y: 684, width: 32, height: 32,
            interactRange: 64, wanderRadius: 30, speed: 22,
            colors: { robe: "#24384c", trim: "#18222e", sash: "#8ad9ff", hat: "#0c1420" },
            dialogue: {
                greeting: '"Ahoy, traveler. The tides have been nervous lately."',
                options: [
                    { label: "What's across the harbor?", response: "Open water, and ruin below it. Don't swim far." },
                    { label: "Any work?", response: "Keep the dock clear and the lanterns lit - that's work enough for anyone." },
                    { label: "Goodbye.", close: true },
                ],
            },
        }),
        new Npc({
            id: "fishmonger", name: "Fishmonger",
            x: 1158, y: 728, width: 32, height: 32,
            interactRange: 56, wanderRadius: 14, speed: 14,
            colors: { robe: "#5a8aa8", trim: "#28486a", sash: "#e8e8f0", hat: "#122338" },
            dialogue: {
                greeting: '"Fresh catch! Priced honest, salted twice."',
                options: [
                    { label: "What\'s biting?", response: "Grey-scale lately. They come up looking wrong. I don't sell those ones." },
                    { label: "Goodbye.", close: true },
                ],
            },
        }),
        new Npc({
            id: "lighthouse_keep", name: "Lighthouse Keeper",
            x: 1536, y: 618, width: 32, height: 32,
            interactRange: 64, wanderRadius: 16, speed: 10,
            colors: { robe: "#d4d4de", trim: "#7a7a84", sash: "#a03a3a", hat: "#5a1818" },
            dialogue: {
                greeting: '"I keep the flame lit. The water prefers it."',
                options: [
                    { label: "Seen anything strange?", response: "A shadow under the waves last moon. Big as a barn. I don't call out what I can't name." },
                    { label: "Goodbye.", close: true },
                ],
            },
        }),
        new Npc({
            id: "sailor_a", name: "Sailor",
            x: 940, y: 1250, width: 32, height: 32,
            interactRange: 54, wanderRadius: 80, speed: 42,
            colors: { robe: "#3c6680", trim: "#1c2e44", sash: "#c8d8e8", hat: "#0e1c2e" },
            dialogue: {
                greeting: '"On leave till the next tide. Don\'t tell the captain."',
                options: [{ label: "Goodbye.", close: true }],
            },
        }),
        new Npc({
            id: "harbor_guard", name: "Harbor Guard",
            x: 820, y: 800, width: 32, height: 32,
            interactRange: 60, wanderRadius: 40, speed: 26,
            colors: { robe: "#4a5060", trim: "#222632", sash: "#8ad9ff", hat: "#101420" },
            dialogue: {
                greeting: '"Eyes on the water. Landlubbers stay clear of the dock edge."',
                options: [{ label: "Goodbye.", close: true }],
            },
        }),
        new Npc({
            id: "child_halen", name: "Child",
            x: 500, y: 780, width: 32, height: 32,
            interactRange: 46, wanderRadius: 90, speed: 54,
            colors: { robe: "#f0d080", trim: "#9a6c2e", sash: "#c84a4a", hat: "#5a3818" },
            dialogue: {
                greeting: '"I caught a hermit crab. Want to hold it? (No?)"',
                options: [{ label: "Goodbye.", close: true }],
            },
        }),
        new Npc({
            id: "beachcomber", name: "Beachcomber",
            x: 1420, y: 1260, width: 32, height: 32,
            interactRange: 54, wanderRadius: 120, speed: 28,
            colors: { robe: "#867660", trim: "#3a3024", sash: "#d4c4a0", hat: "#2a2018" },
            dialogue: {
                greeting: '"The tide gives, the tide takes. Mostly takes."',
                options: [{ label: "Goodbye.", close: true }],
            },
        }),
    ];

    // Emberhold roster - forge + miner town. Warmer palette,
    // gruffer personalities.
    LEVELS.emberhold.npcs = [
        new Npc({
            id: "master_smith", name: "Master Smith",
            x: 1000, y: 720, width: 32, height: 32,
            interactRange: 66, wanderRadius: 24, speed: 18,
            colors: { robe: "#52201a", trim: "#2a0f0a", sash: "#ffd166", hat: "#3a130a" },
            dialogue: {
                greeting: '"Steel sings true in this heat. What brings you?"',
                options: [
                    { label: "Who forges here?", response: "Me. Three apprentices. And fire, if you count it - some days I do." },
                    { label: "Any tips?", response: "A sharp edge beats a heavy arm. Strike twice where you\'d strike once." },
                    { label: "Goodbye.", close: true },
                ],
            },
        }),
        new Npc({
            id: "miner_foreman", name: "Miner Foreman",
            x: 620, y: 700, width: 32, height: 32,
            interactRange: 60, wanderRadius: 20, speed: 20,
            colors: { robe: "#382a20", trim: "#1c1410", sash: "#c4a070", hat: "#14100c" },
            dialogue: {
                greeting: '"Deep shafts this week. The wall sings back now - I don\'t like it."',
                options: [
                    { label: "Sings back?", response: "Like the stone is answering when we strike. I told the Smith. He said to strike quieter." },
                    { label: "Goodbye.", close: true },
                ],
            },
        }),
        new Npc({
            id: "stonecarver", name: "Stonecarver",
            x: 1258, y: 750, width: 32, height: 32,
            interactRange: 60, wanderRadius: 18, speed: 14,
            colors: { robe: "#4a4656", trim: "#252030", sash: "#a8a0b8", hat: "#18141e" },
            dialogue: {
                greeting: '"Stone tells you where it wants to break. Listen first."',
                options: [{ label: "Goodbye.", close: true }],
            },
        }),
        new Npc({
            id: "forge_apprentice", name: "Forge Apprentice",
            x: 1040, y: 830, width: 32, height: 32,
            interactRange: 52, wanderRadius: 40, speed: 30,
            colors: { robe: "#c25a3a", trim: "#52201a", sash: "#ffd166", hat: "#3a130a" },
            dialogue: {
                greeting: '"Heat\'s up! Move or get singed."',
                options: [{ label: "Goodbye.", close: true }],
            },
        }),
        new Npc({
            id: "miner_1", name: "Miner",
            x: 700, y: 900, width: 32, height: 32,
            interactRange: 54, wanderRadius: 80, speed: 24,
            colors: { robe: "#382a20", trim: "#1c1410", sash: "#886a4a", hat: "#14100c" },
            dialogue: {
                greeting: '"Coal tastes like iron today. Wrong vein."',
                options: [{ label: "Goodbye.", close: true }],
            },
        }),
        new Npc({
            id: "smith_elder", name: "Elder Smith",
            x: 900, y: 620, width: 32, height: 32,
            interactRange: 62, wanderRadius: 10, speed: 8,
            colors: { robe: "#6a4836", trim: "#30180a", sash: "#ffd166", hat: "#241004" },
            dialogue: {
                greeting: '"You look like you swing a blade. I like that in a traveler."',
                options: [
                    { label: "What was this place?", response: "A forge-hold, a watch-post, a graveyard. All three, turning into one thing lately." },
                    { label: "Goodbye.", close: true },
                ],
            },
        }),
        new Npc({
            id: "ember_child", name: "Child",
            x: 500, y: 860, width: 32, height: 32,
            interactRange: 46, wanderRadius: 80, speed: 52,
            colors: { robe: "#d4a860", trim: "#7a4e20", sash: "#ffd166", hat: "#3a2010" },
            dialogue: {
                greeting: '"Sparks! Sparks everywhere!"',
                options: [{ label: "Goodbye.", close: true }],
            },
        }),
    ];

    // Place the camera on the player before the first frame so we
    // don't see it lerp in from (0, 0).
    camera.snap(player);

    // ---------------------------------------------------------------
    // Enemy update + collision with the player's attack
    // ---------------------------------------------------------------
    // Nearest neutral Forest Guardian within a small interact
    // radius. Used by the interact button to offer alliance.
    function nearestNeutralGuardian() {
        const pcx = player.x + player.width / 2;
        const pcy = player.y + player.height / 2;
        const R_SQ = 60 * 60;
        let best = null;
        let bestD = R_SQ;
        for (const e of enemies) {
            if (!e.alive || !e.neutral || e.ally) continue;
            const dx = (e.x + e.width / 2) - pcx;
            const dy = (e.y + e.height / 2) - pcy;
            const d = dx * dx + dy * dy;
            if (d < bestD) { best = e; bestD = d; }
        }
        return best;
    }

    // Convert a neutral guardian into an ally. Removes it from the
    // wave kill count (it's no longer a hostile to clear) and flips
    // AI to hunt other enemies.
    function allyWithGuardian(e) {
        if (!e || !e.neutral || e.ally) return;
        e.neutral = false;
        e.ally = true;
        // The guardian no longer blocks wave clear - the spawner's
        // remainingToKill should drop to reflect that.
        spawner.onEnemyDefeated(e);
        questLog.showToast("Forest Guardian stands with you.", 2.4);
        sound.play("levelUp");
    }

    // Nearest live enemy that's hostile to an ally. Used by allied
    // guardians to pick a target each tick.
    function nearestHostileEnemy(from) {
        const fcx = from.x + from.width / 2;
        const fcy = from.y + from.height / 2;
        let best = null;
        let bestD = 360 * 360;
        for (const e of enemies) {
            if (e === from || !e.alive) continue;
            if (e.ally || e.neutral) continue;
            const dx = (e.x + e.width / 2) - fcx;
            const dy = (e.y + e.height / 2) - fcy;
            const d = dx * dx + dy * dy;
            if (d < bestD) { best = e; bestD = d; }
        }
        return best;
    }

    function updateEnemies(dt) {
        // Defense in depth: the main tick already gates this on
        // !isSafeZone, but leaving the check here means any future
        // caller (cutscene, debug tool) can't accidentally tick
        // enemy AI inside a safe zone.
        if (isSafeZone()) return;

        // Apply per-frame faction synergies (sentinel aura) before
        // any enemy steps, so the buffMult is fresh when each enemy
        // reads it during its AI tick.
        applyFactionSynergies();

        // Reverse iteration lets us splice dead enemies cheaply.
        for (let i = enemies.length - 1; i >= 0; i--) {
            const e = enemies[i];
            // enemyTarget swaps in a nearby tank follower when one
            // is in aggro range, so the enemy chases the tank
            // instead of the player.
            e.update(dt, enemyTarget(e));
            if (!e.alive) enemies.splice(i, 1);
        }
    }

    function updateAttackCollision() {
        if (!attack.active) return;
        const box = attack.getHitbox(player);
        if (!box) return;

        const px = player.x + player.width / 2;
        const py = player.y + player.height / 2;
        for (const e of enemies) {
            if (!e.alive || e.ally || attack.hitEnemies.has(e)) continue;
            if (rectsOverlap(box, e.bounds())) {
                e.takeHit(attack.damage, { x: px, y: py });
                attack.hitEnemies.add(e);
                // Only award once per enemy, right when the hit is
                // what killed them - multi-hit enemies (opts.hp > 1)
                // won't award until the final blow.
                if (!e.alive) onEnemyDefeated(e);
            }
        }
    }

    // Reused scratch rect so updateEnemyContact doesn't allocate each frame.
    const _playerBox = { x: 0, y: 0, w: 0, h: 0 };

    // Enemy bodies touching the player deal contact damage. `damagePlayer`
    // is a no-op while iframes are active, so one collision won't drain
    // the whole bar.
    function updateEnemyContact() {
        if (isSafeZone()) return;

        // Player contact - allies and neutrals skip, only hostiles
        // can damage on overlap.
        if (player.alive) {
            _playerBox.x = player.x;
            _playerBox.y = player.y;
            _playerBox.w = player.width;
            _playerBox.h = player.height;
            const now = performance.now() / 1000;
            for (const e of enemies) {
                if (!e.alive || e.ally || e.neutral) continue;
                if (rectsOverlap(_playerBox, e.bounds())) {
                    // Respect per-enemy attack cooldown. attackCdMin
                    // is set from the attack type (quick / heavy /
                    // default), so heavy attackers damage less often
                    // than quick ones on the same contact frame.
                    if ((e.attackNextAt ?? 0) > now) { break; }
                    e.attackNextAt = now + (e.attackCdMin || 0.6);
                    e.attackTimer = 0.18;  // drives the lunge in draw
                    damagePlayer(e.contactDamage);
                    break;
                }
            }
        }

        // Follower contact - same ally / neutral exclusion so a
        // guardian on the squad's side isn't damaging them.
        for (const f of followers) {
            if (f.iframes > 0) continue;
            for (const e of enemies) {
                if (!e.alive || e.ally || e.neutral) continue;
                const b = e.bounds();
                if (f.x < b.x + b.w && f.x + f.width > b.x &&
                    f.y < b.y + b.h && f.y + f.height > b.y) {
                    damageFollower(f, e.contactDamage);
                    break;
                }
            }
        }

        // Allied-guardian contact: allies damage hostiles they touch,
        // using their own contact damage with a small per-pair
        // cooldown on the aggressor (stored on the ally) so the
        // damage ticks once per ~0.5s instead of each frame.
        const now = performance.now() / 1000;
        for (const a of enemies) {
            if (!a.alive || !a.ally) continue;
            if ((a._nextSwingAt ?? 0) > now) continue;
            const ab = a.bounds();
            for (const h of enemies) {
                if (h === a || !h.alive || h.ally || h.neutral) continue;
                if (rectsOverlap(ab, h.bounds())) {
                    h.takeHit(Math.max(1, a.contactDamage | 0),
                              { x: a.x + a.width / 2, y: a.y + a.height / 2 });
                    a._nextSwingAt = now + 0.5;
                    if (!h.alive) onEnemyDefeated(h);
                    break;
                }
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

        // Special attack locks the player during the cast so the
        // burst feels like a committed action. Input is dropped and
        // the glide-to-stop deceleration in the physics step below
        // takes over naturally.
        if (specialAttack.isCasting()) {
            dx = 0;
            dy = 0;
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
        // Walk cadence scales with actual speed so a slow creep
        // animates slower than a full-speed run - clamped so it
        // never grinds to a halt or blurs at max pace.
        const moving = Math.abs(player.vx) + Math.abs(player.vy) > 5;
        player.animator.setState(moving ? "walk" : "idle");
        const speed = Math.hypot(player.vx, player.vy);
        const animScale = moving
            ? Math.max(0.45, Math.min(1.3, speed / player.speed))
            : 1;
        player.animator.update(dt, animScale);
        cloak.update(dt);
        aura.update(dt);

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

        const prevX = player.x;
        const prevY = player.y;
        const clampedX = Math.max(0, Math.min(WORLD_W - player.width, nextX));
        const clampedY = Math.max(0, Math.min(WORLD_H - player.height, nextY));

        // Per-axis building collision resolution. Try each axis
        // independently so the player can slide along a wall
        // instead of getting glued to it when both axes would have
        // intersected. Cheap: each collidesWithBuilding is O(b) for
        // a handful of buildings.
        let appliedX = prevX;
        let appliedY = prevY;
        if (!collidesWithBuilding(clampedX, prevY)) appliedX = clampedX;
        if (!collidesWithBuilding(appliedX, clampedY)) appliedY = clampedY;
        player.x = appliedX;
        player.y = appliedY;
        // Tutorial step 1 watches actual traveled distance so mashing
        // an arrow key into a wall doesn't trip the advance.
        tutorial.onMove(player.x - prevX, player.y - prevY);
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

    // Returns true if the player box (x, y, player.width/height)
    // would overlap the solid footprint of any building in the
    // current level. The door rect is excluded so the player can
    // step through it into an interior without being blocked.
    //
    // Small building-solid shrink (2px) keeps the player from
    // snagging on invisible edges caused by the shadow pixel and
    // the roof overhang, so movement stays smooth along walls.
    function collidesWithBuilding(x, y) {
        const buildings = currentLevel.buildings;
        if (!buildings || buildings.length === 0) return false;
        const px1 = x;
        const py1 = y;
        const px2 = x + player.width;
        const py2 = y + player.height;
        for (const b of buildings) {
            const bx1 = b.x + 2;
            const by1 = b.y + 2;
            const bx2 = b.x + b.w - 2;
            const by2 = b.y + b.h - 2;
            if (px1 >= bx2 || px2 <= bx1 || py1 >= by2 || py2 <= by1) continue;
            // Overlapping the box, but the door gap is a free pass
            // so players can walk onto the entry tile.
            if (b.interior) {
                const dx1 = b.doorX;
                const dy1 = b.doorY;
                const dx2 = b.doorX + b.doorW;
                const dy2 = b.doorY + b.doorH;
                if (!(px1 >= dx2 || px2 <= dx1 || py1 >= dy2 || py2 <= dy1)) {
                    continue;  // inside door rect - allowed
                }
            }
            return true;
        }
        return false;
    }

    // Returns true if a level transition was triggered (in which case
    // the caller should early-return - the new level's state is now
    // live). Only triggers when the player's center is within
    // EXIT_TRIGGER_PX of the midpoint of an edge that has an exit.
    // Exit values can be either a level id string (player arrives
    // at the default inset on the opposite side) or an object like
    // { level: "grove", arriveAt: { x, y }, keyId: "gold_key",
    //   lockedMessage: "..." } for specific warp points and/or
    // locked doors. `keyId` gates the transition on the player
    // carrying that inventory item; `lockedMessage` is the toast
    // shown when they don't.
    function resolveExit(exit) {
        if (typeof exit === "string") {
            return {
                level: exit,
                arriveAt: null,
                keyId: null,
                requiresBoss: null,
                lockedMessage: null,
            };
        }
        if (exit && typeof exit === "object") {
            return {
                level: exit.level,
                arriveAt: exit.arriveAt ?? null,
                keyId: exit.keyId ?? null,
                // Gate the exit on a boss defeat. `defeatedBosses`
                // is run-scoped, so restarts re-seal the door until
                // the player fells the boss again.
                requiresBoss: exit.requiresBoss ?? null,
                lockedMessage: exit.lockedMessage ?? null,
            };
        }
        return null;
    }

    // ---------------------------------------------------------------
    // Locked doors
    //
    // An exit with a `keyId` blocks the transition until the player
    // carries that item. The key is consumed the first time the door
    // is opened, and the door is remembered in `unlockedDoors` keyed
    // by "<levelId>:<direction>" so crossing back and forth after
    // the initial unlock is free.
    //
    // Feedback toasts are throttled so a player mashing against the
    // wall doesn't flood the screen.
    // ---------------------------------------------------------------
    const unlockedDoors = new Set();
    function doorKey(levelId, dir) { return `${levelId}:${dir}`; }

    let _lastLockedToast = 0;
    function showLockedFeedback(msg) {
        const now = performance.now();
        if (now - _lastLockedToast < 1200) return;
        _lastLockedToast = now;
        questLog.showToast(msg ?? "The door is locked.", 1.8);
    }

    // Checks every gate on an exit and, when possible, opens it.
    // Returns true iff the player may step through this frame.
    //
    //   Boss gate - hard-blocked until `defeatedBosses` contains
    //               the named level's boss. No key consumed, no
    //               unlocked-doors memo (so the gate stays closed
    //               on restart until the boss falls again).
    //   Key gate  - consumes the matching inventory item the first
    //               time, then memoizes the open state in
    //               `unlockedDoors` so back-and-forth crossing is
    //               free.
    function tryUnlock(fromLevelId, dir, exit) {
        if (exit.requiresBoss &&
            !defeatedBosses.has(exit.requiresBoss)) {
            return false;
        }
        if (!exit.keyId) return true;

        const k = doorKey(fromLevelId, dir);
        if (unlockedDoors.has(k)) return true;

        const idx = player.inventory.indexOf(exit.keyId);
        if (idx === -1) return false;

        player.inventory.splice(idx, 1);
        unlockedDoors.add(k);
        sound.play("levelUp");  // reuse the existing cheerful cue
        const keyName = ITEMS[exit.keyId]?.name ?? "key";
        questLog.showToast(`${keyName} turns - the lock clicks open!`, 2.0);
        return true;
    }

    function maybeTransitionOnEdge(nextX, nextY) {
        const midX = WORLD_W / 2;
        const midY = WORLD_H / 2;
        const pcx = nextX + player.width / 2;
        const pcy = nextY + player.height / 2;

        const exits = currentLevel.exits;
        const fromId = currentLevel.id;

        const west = resolveExit(exits.west);
        if (west && nextX < 0 &&
            Math.abs(pcy - midY) < EXIT_TRIGGER_PX) {
            if (!tryUnlock(fromId, "west", west)) {
                showLockedFeedback(west.lockedMessage);
                return false;
            }
            transitionTo(west.level, "east", west.arriveAt);
            return true;
        }
        const east = resolveExit(exits.east);
        if (east && nextX + player.width > WORLD_W &&
            Math.abs(pcy - midY) < EXIT_TRIGGER_PX) {
            if (!tryUnlock(fromId, "east", east)) {
                showLockedFeedback(east.lockedMessage);
                return false;
            }
            transitionTo(east.level, "west", east.arriveAt);
            return true;
        }
        const north = resolveExit(exits.north);
        if (north && nextY < 0 &&
            Math.abs(pcx - midX) < EXIT_TRIGGER_PX) {
            if (!tryUnlock(fromId, "north", north)) {
                showLockedFeedback(north.lockedMessage);
                return false;
            }
            transitionTo(north.level, "south", north.arriveAt);
            return true;
        }
        const south = resolveExit(exits.south);
        if (south && nextY + player.height > WORLD_H &&
            Math.abs(pcx - midX) < EXIT_TRIGGER_PX) {
            if (!tryUnlock(fromId, "south", south)) {
                showLockedFeedback(south.lockedMessage);
                return false;
            }
            transitionTo(south.level, "north", south.arriveAt);
            return true;
        }
        return false;
    }

    // ---------------------------------------------------------------
    // Combat input - trigger attacks on SPACE, once per press.
    // ---------------------------------------------------------------
    function updateCombatInput(dt) {
        if (!player.alive) {
            // Dying mid-charge shouldn't leak state into a respawn.
            player.isCharging = false;
            player.chargeTime = 0;
            player.specialCharging = false;
            player.specialChargeTime = 0;
            return;
        }

        // Primary attack: hold to charge, release to fire. Keyboard
        // space / spacebar and the mobile attack button share the
        // same `held` signal so both input paths charge identically.
        // The edge flag on attackButton is consumed regardless so it
        // doesn't leak to other readers.
        const keyHeld = !!(keys[" "] || keys["Spacebar"]);
        const held = keyHeld || attackButton.pressed;
        attackButton.consumeJustPressed();

        if (held && !player.isCharging) {
            // Press edge: begin charging. No shot yet - release fires.
            player.isCharging = true;
            player.chargeTime = 0;
        } else if (held && player.isCharging) {
            // Hold: accumulate up to maxCharge, then hold flat.
            player.chargeTime = Math.min(
                player.maxCharge,
                player.chargeTime + dt
            );
        } else if (!held && player.isCharging) {
            // Release: three-tier charge.
            //   <0.5s  -> tap     (level 0, 1.0x damage)
            //   <1.5s  -> medium  (level 1, 1.6x)
            //   else   -> full    (level 2, 2.6x, plus weapon ult)
            // Sword ult: level 1 wider-arc slash, level 2 360 spin.
            // Energy ult: level 1 medium beam, level 2 massive beam.
            const t = player.chargeTime;
            const level = t < 0.5 ? 0 : t < 1.5 ? 1 : 2;
            const mult = level === 0 ? 1 : level === 1 ? 1.6 : 2.6;
            player.isCharging = false;
            player.chargeTime = 0;

            // Crown Mode multiplies damage and the spin / beam
            // footprint. Applied here in the dispatch so the crown
            // integration is one place, not threaded through each
            // attack module.
            const crownDmg  = crown.attackMult;
            const crownSize = crown.sizeMult;

            // Impact bundles: one cinematicFx.impact call replaces
            // the old scatter of flash / shake / playerTrail.burst
            // at each release site. Scale + color + counts vary so
            // charge level 1 reads as a "charge" while level 2 reads
            // as an "ultimate".
            const pcx = player.x + player.width / 2;
            const pcy = player.y + player.height / 2;
            const wpn = currentWeapon();
            if (wpn === swordWeapon && level >= 1) {
                swordSpin.activate(swordWeapon.damage * mult * crownDmg, level);
                if (crownSize !== 1) swordSpin.radius *= crownSize;
                attack.cooldownTimer = attack.cooldown;
                cinematicFx.impact(pcx, pcy + 10, {
                    scale: level >= 2 ? 1.4 : 1.0,
                    color: "255, 220, 140",
                    flash: level >= 2 ? 0.5 : 0.3,
                    shake: level >= 2 ? 10 : 6,
                    sparks: level >= 2 ? 18 : 10,
                    residue: level >= 2 ? 70 : 45,
                    slowMo: level >= 2 ? 0.1 : 0,
                });
                playerTrail.burst(level >= 2 ? 10 : 6,
                    level >= 2 ? 2.2 : 1.8, level >= 2 ? 0.55 : 0.45);
            } else if (wpn === energyWeapon && level >= 1) {
                energyBeam.activate(
                    energyWeapon.damage * mult * (level >= 2 ? 1.6 : 1.1) * crownDmg,
                    player, level
                );
                if (crownSize !== 1) {
                    energyBeam.length *= crownSize;
                    energyBeam.width  *= crownSize;
                }
                energyWeapon.cooldownTimer = energyWeapon.cooldownMax;
                cinematicFx.impact(pcx, pcy + 10, {
                    scale: level >= 2 ? 1.6 : 1.1,
                    color: "180, 220, 255",
                    flash: level >= 2 ? 0.7 : 0.45,
                    shake: level >= 2 ? 14 : 8,
                    sparks: level >= 2 ? 22 : 12,
                    residue: level >= 2 ? 80 : 48,
                    slowMo: level >= 2 ? 0.15 : 0,
                    zoom: level >= 2 ? 1.08 : 1.0,
                });
                playerTrail.burst(level >= 2 ? 12 : 8,
                    level >= 2 ? 2.4 : 2.0, level >= 2 ? 0.6 : 0.5);
            } else {
                // Tap (level 0) or unhandled weapon - normal fire
                // with the charge multiplier applied uniformly. Crown
                // still boosts tap damage so the mode is always felt.
                wpn.fire(player, mult * crownDmg);
            }
            tutorial.onAttack();
        }

        // Power move (shared across all weapons)
        const keyboardPower = keysJustPressed["q"] || keysJustPressed["Q"];
        const touchPower = powerButton.consumeJustPressed();
        if (keyboardPower || touchPower) {
            powerMove.activate(player);
        }

        // Super power - the "nuke". Longer cooldown, huge AoE +
        // animation. F on keyboard, SUPER button on touch.
        const keyboardSuper = keysJustPressed["f"] || keysJustPressed["F"];
        const touchSuper = superPowerButton.consumeJustPressed();
        if (keyboardSuper || touchSuper) {
            superPower.activate(player);
        }

        // Special attack - magic-gated rather than cooldown-gated.
        // X on keyboard, SPECIAL button on touch. Same press-hold-
        // release contract as the primary attack: held duration picks
        // the tier (0 / 1 / 2). Tap still fires immediately since the
        // release on a sub-0.5s hold maps to level 0. activate() is
        // a no-op if magic is below cost, so mashing fizzles.
        const xHeld = !!(keys["x"] || keys["X"]);
        const specialHeld = xHeld || specialButton.pressed;
        specialButton.consumeJustPressed();  // drain edge flag

        if (specialHeld && !player.specialCharging) {
            player.specialCharging = true;
            player.specialChargeTime = 0;
        } else if (specialHeld && player.specialCharging) {
            player.specialChargeTime = Math.min(
                player.maxCharge,
                player.specialChargeTime + dt
            );
        } else if (!specialHeld && player.specialCharging) {
            const st = player.specialChargeTime;
            const specialLevel = st < 0.5 ? 0 : st < 1.5 ? 1 : 2;
            player.specialCharging = false;
            player.specialChargeTime = 0;
            specialAttack.activate(specialLevel);
        }

        // Battlefield Nova - top-tier screen-wide shockwave. Edge-
        // triggered (no charge) since its cost + cooldown are the
        // gate, not hold duration. V on keyboard, NOVA button on
        // touch.
        const keyboardNova = keysJustPressed["v"] || keysJustPressed["V"];
        const touchNova = novaButton.consumeJustPressed();
        if (keyboardNova || touchNova) {
            battlefieldNova.activate();
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

        // Pause: routes only pause-menu inputs. Toggling is allowed
        // from here (P / Escape) so the player can resume with the
        // same key that opened the menu. Gameplay ticks are skipped
        // entirely while paused.
        if (paused) {
            if (keysJustPressed["p"] || keysJustPressed["P"] ||
                keysJustPressed["Escape"]) {
                pauseMenu.handleAction("resume");
            } else if (keysJustPressed["s"] || keysJustPressed["S"]) {
                pauseMenu.handleAction("save");
            } else if (keysJustPressed["l"] || keysJustPressed["L"]) {
                pauseMenu.handleAction("load");
            }
            // Mobile: tapping the pause icon again resumes.
            if (pauseButton.consumeJustPressed()) {
                pauseMenu.handleAction("resume");
            }
            pauseMenu.tick(dt);
            clearJustPressed();
            return;
        }

        // Enter pause: P key toggles, only in live gameplay. Other
        // modals (cinematic/shop/dialogue) suppress the toggle so
        // typing a P in an input doesn't pause mid-question.
        if (gameState === "playing" &&
            (keysJustPressed["p"] || keysJustPressed["P"]) &&
            !cinematic.isOpen() && !shop.isOpen() && !dialogue.isOpen()) {
            paused = true;
            clearJustPressed();
            return;
        }
        if (gameState === "playing" && pauseButton.consumeJustPressed()) {
            paused = true;
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

        // Cinematic: highest-priority modal. While a sequence is
        // playing the world (including enemies) freezes, and any
        // input advances the text or closes it. Escape closes
        // outright. Tick transient UI timers so toast fade doesn't
        // stall underneath.
        // Scripted dialogue: highest-priority modal above cinematic.
        // ESC skips the whole sequence; any other key/tap advances
        // the current line (or finishes the typewriter in progress).
        if (scriptedDialogue.isOpen()) {
            scriptedDialogue.update(dt);
            let pressed = false;
            for (const k in keysJustPressed) {
                if (keysJustPressed[k]) { pressed = true; break; }
            }
            if (keysJustPressed["Escape"]) {
                scriptedDialogue.skip();
            } else if (pressed) {
                scriptedDialogue.advance();
            }
            attackButton.consumeJustPressed();
            interactButton.consumeJustPressed();
            superPowerButton.consumeJustPressed();
            powerButton.consumeJustPressed();
            specialButton.consumeJustPressed();
            novaButton.consumeJustPressed();
            newMissionBanner.update(dt);
            questLog.update(dt);
            clearJustPressed();
            return;
        }

        if (cinematic.isOpen()) {
            cinematic.update(dt);
            // Any keydown or a new touch advances the sequence.
            let pressed = false;
            for (const k in keysJustPressed) {
                if (keysJustPressed[k]) { pressed = true; break; }
            }
            if (keysJustPressed["Escape"]) {
                cinematic.close();
            } else if (pressed) {
                cinematic.advance();
            }
            // Consume any lingering touch press from the button
            // that triggered the advance (e.g. attack / interact).
            attackButton.consumeJustPressed();
            interactButton.consumeJustPressed();
            superPowerButton.consumeJustPressed();
            powerButton.consumeJustPressed();
            specialButton.consumeJustPressed();
            novaButton.consumeJustPressed();
            newMissionBanner.update(dt);
            questLog.update(dt);
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

        // Keyboard zoom - = / + zoom in, - / _ zoom out. Wheel and
        // pinch are handled via pointer / wheel listeners; these
        // are just a keyboard fallback.
        if (keysJustPressed["="] || keysJustPressed["+"]) {
            camera.zoomIn();
        }
        if (keysJustPressed["-"] || keysJustPressed["_"]) {
            camera.zoomOut();
        }

        // Debug overlay toggle.
        if (keysJustPressed["d"] || keysJustPressed["D"]) {
            debugOverlay = !debugOverlay;
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
            // Prefer NPCs (conversation), then neutral creatures
            // (offer alliance), then lore objects (discovery). Same
            // key, one interact button.
            const npcTarget = nearestNpc();
            if (npcTarget) {
                dialogue.open(npcTarget);
            } else {
                const neutral = nearestNeutralGuardian();
                if (neutral) {
                    allyWithGuardian(neutral);
                } else {
                    // Wild Creatures of the Light take priority over
                    // lore objects - they're rare and have a short
                    // window before they drift off.
                    const wildLight = nearestWildLightCreature();
                    if (wildLight) {
                        reachOutToLightCreature(wildLight);
                    } else if (nearestCityEvent()) {
                        // City event "Watch" - small coin reward,
                        // one-shot per event.
                        cityEvents.watch();
                    } else {
                        const loreTarget = nearestLore();
                        if (loreTarget) openLore(loreTarget);
                    }
                }
            }
        }

        // Tick transient UI state (quest + level toasts + the big
        // NEW MISSION banner so it fades naturally during play).
        questLog.update(dt);
        newMissionBanner.update(dt);
        if (stats.levelUpToast > 0) {
            stats.levelUpToast = Math.max(0, stats.levelUpToast - dt);
        }

        updateMovement(dt);
        updateCombatInput(dt);
        attack.update(dt);
        for (const w of weapons) w.update(dt);
        powerMove.update(dt);
        superPower.update(dt);
        specialAttack.update(dt);
        battlefieldNova.update(dt);
        swordSpin.update(dt);
        energyBeam.update(dt);
        chargeFx.update(dt);
        playerTrail.update(dt);
        ambientParticles.update(dt);
        cinematicFx.update(dt);
        shake.update(dt);
        flash.update(dt);
        corruption.update(dt);
        crown.update(dt);
        updateMusicState(dt);

        // Combat systems only tick in hostile zones. In safe zones
        // (NPC cities) enemy AI, spawning, and contact damage are all
        // disabled. Projectiles still tick so any in-flight shots
        // expire instead of freezing mid-air on a zone transition.
        if (!isSafeZone()) {
            // Slow-mo: the special attack scales enemy tick and
            // spawner pacing down during its brief window. UI + input
            // keep full speed so controls stay responsive.
            const enemyDt = dt * specialAttack.enemyTimeScale();
            updateEnemies(enemyDt);
            updateAttackCollision();
            updatePowerMoveCollision();
            updateSuperPowerCollision();
            updateSpecialAttackCollision();
            updateBattlefieldNovaCollision();
            updateSwordSpinCollision();
            updateEnergyBeamCollision();
            updateEnemyContact();
            spawner.update(enemyDt);
        }
        updateProjectiles(dt);
        updateHostileProjectiles(dt);
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

    // Three-line opening narration played from startGame on a
    // fresh session. Mission 1 ("Speak with the Village Elder") is
    // current at this point; the onDone handler shows the "New
    // Mission" banner so the player knows what to do next.
    const OPENING_LINES = [
        { speaker: null, text: "You arrived in Sunlit Grove..." },
        { speaker: null, text: "But something beneath the world has awakened..." },
        { speaker: null, text: "You can feel it..." },
    ];

    function startGame() {
        gameState = "playing";
        lastTime = performance.now();
        // Clear any held keys that might be stuck from the input
        // that dismissed the intro.
        for (const k in keys) keys[k] = false;

        // Opening intro plays only once per session - a fresh page
        // load starts with the story; respawning from death does
        // not replay it. Flag lives on `story` so it's session-
        // scoped without needing a separate storage entry.
        if (!story.openingShown) {
            story.openingShown = true;
            scriptedDialogue.play(OPENING_LINES, () => {
                const cur = missions.getCurrentMission();
                if (cur) newMissionBanner.show(cur.name);
            });
        }
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

        // Story beats tied to zone entries. Advances no-op if the
        // player already progressed past that chapter. Chapter2 is
        // NOT triggered here - it's driven by quest completion so
        // the "first hunt" beat only fires once the player has
        // actually earned it, not just by walking into the caverns.
        if (id === "shrine")  story.advance("chapter4");
        // Post-boss descent. Chapter6 only advances if chapter5 has
        // already fired (i.e. the Keeper is down), so the cinematic
        // reads as "the deeper dark opens after victory" rather than
        // a spoiler on first shrine entry.
        if (id === "abyss")   story.advance("chapter6");

        // Mission sync. completeById no-ops if the indexed mission
        // isn't current, so re-entering a zone later won't re-fire.
        if (id === "shrine") missions.completeById(5);
        if (id === "abyss")  missions.completeById(7);

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

        // Snap the cloak onto the new anchor so it doesn't stretch
        // across the screen from the previous room's exit.
        cloak.snap();
        aura.snap();
        // Squad comes along to the new zone - snap them onto their
        // formation slots so they don't pop in from the old room.
        snapFollowersToPlayer();

        // Transient combat state - belongs to the previous room.
        enemies.length = 0;
        projectiles.length = 0;
        drops.length = 0;
        // Live light creatures belong to the previous zone (they
        // don't trail across, to keep the rare-encounter feel).
        // Tamed ones rehire next to the player from snapshots so
        // the roster carries over.
        resetLightCreatures();
        for (const snap of player.lightCreatures) rehireLightCreature(snap);
        attack.active = false;
        attack.timer = 0;
        attack.cooldownTimer = 0;
        attack.progress = 0;
        attack.hitEnemies.clear();
        powerMove.reset();
        specialAttack.reset();
        battlefieldNova.reset();
        swordSpin.reset();
        energyBeam.reset();
        chargeFx.reset();
        playerTrail.reset();
        ambientParticles.reset();
        cinematicFx.reset();
        flash.reset();
        camera.resetZoom();

        // Reseed with the new level's enemy config.
        spawner.configure(level);
        spawner.reset();
        spawner.seed();
        animals.spawnAll();
        maybeSpawnWildLightCreature(currentLevel);
        ensureCityClustersFor(currentLevel && currentLevel.id);
        cityChat.reset();
        cityEvents.reset();
        mysticalEvents.reset();

        // Snap the camera to prevent a visible pan from the old spot.
        camera.snap(player);

        // Level-name toast. Reuses the existing quest toast slot
        // since they're never active at the same moment in practice.
        questLog.showToast(`Entering: ${level.name}`, 2.0);

        // Fade the background track to match the new zone without
        // waiting up to 0.75s for the periodic music picker.
        kickMusicForZone();
    }

    // Restart - resets every piece of run-scoped state back to its
    // boot values, including any level-up upgrades. New systems that
    // hold run state (pickups, xp, map seed) reset themselves here
    // so the reset story stays in one obvious place.
    // ---------------------------------------------------------------
    function restartGame() {
        gameState = "playing";
        // Pause shouldn't bleed from a previous session into a fresh
        // run (e.g. if the player paused, died, then hit restart).
        paused = false;
        pauseMenu.statusText = "";
        pauseMenu.statusTimer = 0;
        pauseButton.pressed = false;
        pauseButton.pointerId = null;
        pauseButton.justPressed = false;

        // Stats (score, kills, level, xp)
        stats.reset();

        // Roll back any upgrades applied on previous level-ups.
        player.maxHp = baseStats.playerMaxHp;
        attack.cooldown = baseStats.attackCooldown;
        swordWeapon.damage = baseStats.swordDamage;
        energyWeapon.damage = baseStats.energyDamage;
        energyWeapon.cooldownMax = baseStats.energyCooldown;
        powerMove.damage = baseStats.powerDamage;

        // Player state (position is set *after* we switch zones
        // below so WORLD_W / WORLD_H reflect grove, not whatever
        // zone the player died in).
        player.hp = player.maxHp;
        player.alive = true;
        player.iframes = 0;
        player.vx = 0;
        player.vy = 0;
        player.isCharging = false;
        player.chargeTime = 0;
        player.specialCharging = false;
        player.specialChargeTime = 0;
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
        // world.load runs *before* the player position warp below so
        // WORLD_W / WORLD_H reflect the grove dimensions.
        enemies.length = 0;
        currentLevel = LEVELS.grove;
        world.load(currentLevel);
        spawner.configure(currentLevel);
        spawner.reset();
        spawner.seed();
        animals.spawnAll();
        maybeSpawnWildLightCreature(currentLevel);
        ensureCityClustersFor(currentLevel && currentLevel.id);
        cityChat.reset();
        cityEvents.reset();
        mysticalEvents.reset();

        // Now WORLD_* are grove dims - warp the player to the
        // grove's center (the main plaza tile).
        player.x = WORLD_W / 2 - player.width / 2;
        player.y = WORLD_H / 2 - player.height / 2;

        // Collapse the cloak onto the new anchor - otherwise it
        // stretches from the death point to the plaza on respawn.
        cloak.snap();
        aura.snap();
        // Squad resets below in companions.reset - no need to snap.

        // Inventory / drops / UI state - fresh run has no loot.
        player.inventory.length = 0;
        player.coins = 0;
        player.magic = 0;
        // Squad - fresh run recruits no one by default.
        companions.reset();
        // Light creatures - fresh run = empty roster + no wild
        // creature carryover. Next zone seed re-rolls a spawn.
        player.lightCreatures.length = 0;
        resetLightCreatures();
        drops.length = 0;
        inventoryOpen = false;

        // Quests - fresh run resets the chain back to the start.
        questLog.reset();

        // Corruption - value and peak both rewind. The damage
        // modifier stays on player.damageModifiers (was pushed once
        // at boot) and returns to x1 automatically once value is 0.
        corruption.reset();
        // Crown energy + mode state rewinds on respawn; level will
        // resync to the current story chapter on the next update.
        crown.reset();

        // Story progression - death ends the current campaign run;
        // localStorage is also cleared so the next page load opens
        // on chapter 1, not wherever we died.
        story.reset();
        // Missions track the same campaign beats as story chapters,
        // so a fresh run rewinds them too.
        missions.reset();

        // Lore discoveries - same persistence contract as story.
        loreLog.reset();

        // Cinematic - close any mid-playing sequence so the next
        // run doesn't open on a stale letterbox.
        cinematic.reset();

        // Scripted dialogue + mission banner reset so the respawn
        // frame opens clean. Opening + first-Elder flags stay set
        // so story beats don't replay every time the player dies.
        scriptedDialogue.reset();
        newMissionBanner.reset();

        // Dialogue - close any open box, drop cached option rects.
        dialogue.close();

        // Shop - close any open shop window and roll upgrade
        // prices back to their opening values so a fresh run
        // sees fresh prices.
        shop.close();
        resetShopPrices();

        // Doors - a fresh run means fresh locks.
        unlockedDoors.clear();

        // Bosses - every boss stands again on a fresh run.
        defeatedBosses.clear();

        // Weapons - back to the starting loadout, clear any in-flight
        // projectiles, and reset each weapon's internal timers.
        player.weaponIndex = 0;
        projectiles.length = 0;
        for (const w of weapons) w.reset();

        // Power move - rewind cooldown and clear any active burst.
        powerMove.reset();

        // Super power - same rewind, long cooldown back to 0.
        superPower.reset();

        // Special attack - clear cast / slow-mo / hit-set so a new
        // run doesn't open mid-animation.
        specialAttack.reset();
        battlefieldNova.reset();

        // Sword spin - belongs to the previous run's mid-swing state.
        swordSpin.reset();
        energyBeam.reset();
        chargeFx.reset();
        playerTrail.reset();
        ambientParticles.reset();
        cinematicFx.reset();

        // Screen shake - any mid-cast impulses clear so respawn
        // isn't still rattling.
        shake.reset();

        // Screen flash + camera zoom - drop any mid-cast cinematic
        // effects so the respawn frame opens clean.
        flash.reset();
        camera.resetZoom();

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
        superPowerButton.pressed = false;
        superPowerButton.pointerId = null;
        superPowerButton.justPressed = false;
        specialButton.pressed = false;
        specialButton.pointerId = null;
        specialButton.justPressed = false;
        novaButton.pressed = false;
        novaButton.pointerId = null;
        novaButton.justPressed = false;
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
        // Screen-space safety fill. The camera clamp accounts for
        // zoom, but tiny interiors at high zoom-out may still show
        // a thin band where the world doesn't reach - use a very
        // dark void tone so it reads intentional instead of "UI
        // panel grey".
        ctx.fillStyle = "#08080e";
        ctx.fillRect(0, 0, VIEW_W, VIEW_H);

        // --- World space ---
        // Round the translate to whole pixels to avoid tile-seam
        // shimmering when the camera is sub-pixel offset. Screen
        // shake is added on top; since the HUD draws outside this
        // save/restore, only the world rattles.
        //
        // Zoom is applied around the viewport center so the player
        // (who is already camera-centered by follow()) stays put.
        // The scale branch is gated on scale !== 1 so idle frames
        // skip the extra matrix ops entirely.
        ctx.save();
        const camScale = camera.scale;
        if (camScale !== 1) {
            ctx.translate(VIEW_W / 2, VIEW_H / 2);
            ctx.scale(camScale, camScale);
            ctx.translate(-VIEW_W / 2, -VIEW_H / 2);
        }
        ctx.translate(
            -Math.round(camera.x) + Math.round(shake.offsetX()),
            -Math.round(camera.y) + Math.round(shake.offsetY())
        );

        world.draw(ctx, camera);

        // Drops beneath enemies and player so they can't be obscured
        // by a live enemy standing over the same tile.
        drawDrops(ctx);

        // Buildings - simple world-space boxes with a door, label,
        // and roof. Drawn beneath NPCs and the player so characters
        // read on top when standing in front.
        for (const b of currentLevel.buildings || []) drawBuilding(ctx, b);
        // Night window-glow sits on top of the building faces so
        // the warm light reads against the cooler overall tint.
        worldClock.drawBuildingLights(ctx, currentLevel);
        // Ambient motes drift above buildings but below NPCs / enemies
        // so characters still read clearly against the floating dust.
        ambientParticles.draw(ctx);

        // Padlock icon on any still-locked border gate.
        drawLockIndicators(ctx);

        // NPCs - one per entry in the current level's roster. Drawn
        // beneath the player so the player always reads on top. Each
        // draws its own "E" bubble when the player is in range.
        // View-frustum cull the NPC draw: skip anything clearly
        // offscreen. Padding (64px) gives a generous margin so
        // sprites at the edge don't pop when the camera pans.
        const vx0 = camera.x - 64;
        const vy0 = camera.y - 64;
        const vx1 = camera.x + VIEW_W + 64;
        const vy1 = camera.y + VIEW_H + 64;
        for (const n of activeNpcs()) {
            if (n.x + 32 < vx0 || n.x > vx1 ||
                n.y + 32 < vy0 || n.y > vy1) continue;
            drawNpc(ctx, n);
        }
        // Ambient critters + birds draw below the player layer;
        // the animals module does its own view-rect cull.
        animals.draw(ctx);
        drawLightCreatures(ctx);
        drawChatBubbles(ctx);
        cityEvents.draw(ctx);
        mysticalEvents.drawWorld(ctx);
        // Followers render with the same drawNpc path; they carry
        // the warrior's colors, walk bob, and "E" bubble just like
        // home-zone NPCs so players can still converse with them.
        for (const f of followers) drawNpc(ctx, f);

        // Lore objects - painted above the floor but below
        // enemies / player, so they read as landmarks a moving
        // entity can walk past.
        for (const entry of activeLore()) drawLoreObject(ctx, entry);

        // Enemies beneath the player so the player always reads on top.
        for (const e of enemies) e.draw(ctx);

        // Player - skipped on alternating "blinks" while in iframes
        // to give a classic invulnerability flash.
        drawPlayer();

        // Attack hitbox on top of the player.
        attack.draw(ctx, player);

        // Power move ring - big AoE, goes over the weapon hitbox.
        powerMove.draw(ctx, player);

        // Super power - the nuke. Draws last so its layered rings
        // paint over everything else in the world layer.
        superPower.draw(ctx, player);

        // Special attack - crimson magic wave. Drawn after super so
        // when both fire near each other the special reads on top.
        specialAttack.draw(ctx, player);
        battlefieldNova.draw(ctx, player);

        // Projectiles over everything else in the world layer.
        drawProjectiles(ctx);
        drawHostileProjectiles(ctx);

        // Squad attack VFX (slash rings on melee hits, muzzle flashes
        // on ranged shots) sit above projectiles so they punctuate
        // the shot visibly rather than getting washed out behind one.
        drawSquadFx(ctx);

        ctx.restore();

        // Day/night color overlay - drawn after the world restore so
        // the tint blankets the whole scene, and before the HUD so
        // UI stays readable.
        worldClock.drawOverlay(ctx);
        // Mystical shooting-star streak - screen-space so it moves
        // across the viewport rather than the world.
        mysticalEvents.drawScreen(ctx);

        // --- Screen space (HUD) ---
        drawStatsPanel();
        drawScore();
        drawHealthBar();
        drawMagicBar();
        drawCrownBar();
        drawXpBar();
        drawCorruptionBar();
        drawCooldownBar();
        drawEnemyCounter();
        drawWaveIndicator();
        if (debugOverlay) drawDebugOverlay();
        drawBossHealth();
        joystick.draw(ctx);
        attackButton.draw(ctx);
        weaponSwapButton.draw(ctx);
        powerButton.draw(ctx);
        superPowerButton.draw(ctx);
        specialButton.draw(ctx);
        novaButton.draw(ctx);
        interactButton.draw(ctx);
        if (gameState === "playing") pauseButton.draw(ctx);
        drawQuestPanel();
        drawSquadIndicator();
        drawMinimap();
        drawTutorial();
        drawRecruitHint();
        drawLightCreatureHint();

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

        // Pause overlay - drawn above every gameplay layer but below
        // the flash + cinematic so a special-attack freeze-frame +
        // pause still reads correctly.
        if (paused) drawPauseMenu();

        // Full-screen flash overlay - drawn above the HUD so the
        // impact frame briefly whites out everything. Idle frames
        // early-out before a single fillRect.
        flash.draw(ctx);

        // NEW MISSION banner sits above the world / HUD but below
        // cinematic / scripted dialogue, so a mission completion
        // during a chapter advance doesn't compete with the
        // bigger story overlay.
        newMissionBanner.draw(ctx);

        // Scripted dialogue + cinematic are top of the stack. The
        // scripted box draws over everything (including cinematic
        // letterboxing) because it's the highest-priority modal.
        cinematic.draw(ctx);
        scriptedDialogue.draw(ctx);
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
        roundRectPath(ctx, 8, 8, 280, 92, 8);
        ctx.fillStyle = "rgba(12, 12, 22, 0.62)";
        ctx.fill();
        ctx.strokeStyle = "rgba(255, 209, 102, 0.28)";
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();
    }

    // Top HUD row: SCORE on the left, a coin icon + purse count in
    // the middle, level badge on the right. Everything on one line
    // so the whole stats panel stays compact.
    function drawScore() {
        const x = 16;
        const y = 14;

        ctx.save();
        ctx.textBaseline = "top";
        drawShadowedText("SCORE", x, y, "#a0a0b8", "11px system-ui, sans-serif");
        drawShadowedText(
            String(stats.score).padStart(5, "0"),
            x + 42, y - 2,
            "#ffd166",
            "bold 18px system-ui, sans-serif"
        );

        // Coin icon + purse value - middle of the row.
        drawCoinIcon(132, y + 11, 6);
        drawShadowedText(
            String(player.coins).padStart(4, "0"),
            146, y - 2,
            "#ffd166",
            "bold 18px system-ui, sans-serif"
        );

        // Level badge - lives in the right half of the panel.
        const lvlX = 228;
        drawShadowedText("LVL", lvlX, y, "#a0a0b8", "11px system-ui, sans-serif");
        drawShadowedText(
            String(stats.level),
            lvlX + 28, y - 2,
            "#8ad9ff",
            "bold 18px system-ui, sans-serif"
        );

        ctx.restore();
    }

    // Small gold coin sprite: base circle + rim + tiny highlight.
    // Used by the HUD purse indicator and the shop rows.
    function drawCoinIcon(cx, cy, r) {
        ctx.fillStyle = "#ffd166";
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(80, 50, 0, 0.55)";
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = "#fff0a8";
        ctx.fillRect(cx - r + 2, cy - r + 2, 2, 2);
    }

    // XP progress bar directly below the HP bar. Cyan fill to echo
    // the level badge's color, and a small "XP" label on the left.
    function drawXpBar() {
        const barW = 252;
        const barH = 6;
        const x = 28;
        const y = 74;  // tight stack: below HP (40+14) + MAGIC (58+10) + 6px gap
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

    // Boss health: wide bar at the top-center of the screen with
    // the boss's name. Only rendered while a live boss is in the
    // current level's enemies array. Shares the rounded-rect +
    // shadowed-text helpers with the rest of the HUD so it fits
    // visually without ceremony.
    function drawBossHealth() {
        let boss = null;
        for (const e of enemies) {
            if (e.alive && e.isBoss) { boss = e; break; }
        }
        if (!boss) return;

        const w = Math.min(440, VIEW_W - 32);
        const h = 14;
        const x = Math.floor((VIEW_W - w) / 2);
        const y = 32;

        ctx.save();

        // Panel backdrop
        roundRectPath(ctx, x - 10, y - 22, w + 20, h + 32, 8);
        ctx.fillStyle = "rgba(18, 18, 30, 0.78)";
        ctx.fill();
        ctx.strokeStyle = "rgba(224, 102, 102, 0.55)";
        ctx.lineWidth = 1;
        ctx.stroke();

        // Name banner
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        drawShadowedText(
            boss.name.toUpperCase(),
            x + w / 2, y - 18,
            "#e06666",
            "bold 12px system-ui, sans-serif"
        );

        // HP track
        roundRectPath(ctx, x, y, w, h, 6);
        ctx.fillStyle = "#200808";
        ctx.fill();

        // HP fill - red with a subtle specular like the player HP.
        const frac = Math.max(0, boss.hp / boss.maxHp);
        if (frac > 0) {
            ctx.save();
            ctx.clip();
            ctx.fillStyle = "#e06666";
            ctx.fillRect(x, y, w * frac, h);
            ctx.fillStyle = "rgba(255, 255, 255, 0.22)";
            ctx.fillRect(x, y + 2, w * frac, 2);
            ctx.restore();
        }

        ctx.strokeStyle = "rgba(255, 255, 255, 0.22)";
        ctx.lineWidth = 1;
        roundRectPath(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 6);
        ctx.stroke();

        // Numeric HP right of the bar
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        drawShadowedText(
            `${Math.ceil(boss.hp)} / ${boss.maxHp}`,
            x + w - 4, y + h + 10,
            "#e06666",
            "bold 11px system-ui, sans-serif"
        );
        ctx.textAlign = "left";

        ctx.restore();
    }

    // Quest HUD - a compact panel that sits top-right on wide
    // viewports and drops below the stats panel on narrow (portrait)
    // viewports so the two never overlap. Uses the same dark-glass +
    // shadowed-text style as the rest of the HUD.
    // Small top-right squad readout. Lives below the pause button so
    // touch taps on the pause icon don't graze this text. Hidden
    // entirely when no one has been recruited yet, so normal-campaign
    // players see no new clutter until they bring a warrior along.
    // Tutorial banner - a small bottom-center chip showing the
    // current step plus a SKIP tap target. Hidden during modals
    // (pause, dialogue, shop, cinematic) and on game-over so it
    // doesn't compete with those higher-priority overlays.
    function drawTutorial() {
        if (!tutorial.isActive()) return;
        if (gameState !== "playing") return;
        if (paused || dialogue.isOpen() || shop.isOpen() ||
            cinematic.isOpen()) return;

        const w = Math.min(420, VIEW_W - 40);
        const h = 48;
        const x = Math.floor((VIEW_W - w) / 2);
        // Sits above the mobile interact / attack button rows
        // (those cluster around VIEW_H - 84 and below).
        const y = VIEW_H - 200;

        ctx.save();
        // Panel
        ctx.globalAlpha = 0.92;
        roundRectPath(ctx, x, y, w, h, 8);
        ctx.fillStyle = "rgba(18, 18, 30, 0.92)";
        ctx.fill();
        ctx.strokeStyle = "rgba(255, 209, 102, 0.55)";
        ctx.lineWidth = 1;
        ctx.stroke();

        // Step counter on the left.
        ctx.globalAlpha = 1;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        drawShadowedText(
            `${tutorial.stepNum()}/${tutorial.total()}`,
            x + 12, y + h / 2,
            "#ffd166",
            "bold 14px system-ui, sans-serif"
        );

        // Step text, sized to the panel width minus the skip chip.
        drawShadowedText(
            tutorial.text(),
            x + 46, y + h / 2,
            "#e8e8f0",
            "14px system-ui, sans-serif"
        );

        // SKIP chip on the right. Rect is cached so the pointer
        // handler hit-tests the same coords.
        const skipW = 54;
        const skipH = 26;
        const skipX = x + w - skipW - 10;
        const skipY = y + (h - skipH) / 2;
        tutorial.skipRect.x = skipX;
        tutorial.skipRect.y = skipY;
        tutorial.skipRect.w = skipW;
        tutorial.skipRect.h = skipH;

        roundRectPath(ctx, skipX, skipY, skipW, skipH, 5);
        ctx.fillStyle = "#2a2a38";
        ctx.fill();
        ctx.strokeStyle = "rgba(255, 209, 102, 0.4)";
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.textAlign = "center";
        drawShadowedText(
            "SKIP",
            skipX + skipW / 2, skipY + skipH / 2,
            "#e8e8f0",
            "bold 12px system-ui, sans-serif"
        );

        ctx.restore();
    }

    // Contextual recruit hint. Shows a small chip when the nearest
    // NPC is an unrecruited warrior and the player hasn't learned
    // recruitment yet (squad still empty). Auto-hides once the
    // player has any squadmate, so it never nags the second time.
    // Hidden during modals and game-over so it doesn't stack.
    // Light-creature hint chip. Only shows when a wild creature is
    // near the player, prompting the "Reach out" action. Distinct
    // chrome + tinted by the species color so it reads as a
    // different prompt than the warrior-recruit chip.
    function drawLightCreatureHint() {
        if (gameState !== "playing") return;
        if (paused || dialogue.isOpen() || shop.isOpen() ||
            cinematic.isOpen() || scriptedDialogue.isOpen()) return;

        const wild = nearestWildLightCreature();
        if (!wild) return;

        const label = `Reach out to the ${wild.species.name}`;
        ctx.save();
        ctx.font = "bold 13px system-ui, sans-serif";
        const tw = ctx.measureText(label).width;
        const padX = 16;
        const w = Math.ceil(tw + padX * 2 + 30);  // +30 for E pip
        const h = 34;
        // Float above the mobile action cluster.
        const yBase = tutorial.isActive() ? VIEW_H - 250 : VIEW_H - 220;
        const x = Math.floor((VIEW_W - w) / 2);
        const y = yBase;

        // Panel
        ctx.globalAlpha = 0.94;
        roundRectPath(ctx, x, y, w, h, 7);
        ctx.fillStyle = "rgba(18, 18, 30, 0.92)";
        ctx.fill();
        ctx.strokeStyle = wild.species.color;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.globalAlpha = 1;

        // E pip on the left to echo the world-space bubble.
        ctx.fillStyle = "#1a1a24";
        ctx.beginPath();
        ctx.arc(x + 16, y + h / 2, 10, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = wild.species.color;
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.fillStyle = wild.species.color;
        ctx.font = "bold 11px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("E", x + 16, y + h / 2 + 1);

        // Label
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        drawShadowedText(label, x + 32, y + h / 2,
            "#e8e8f0", "bold 13px system-ui, sans-serif");

        ctx.restore();
    }

    function drawRecruitHint() {
        if (gameState !== "playing") return;
        if (paused || dialogue.isOpen() || shop.isOpen() ||
            cinematic.isOpen()) return;
        // Stop hinting once the player has recruited anyone - the
        // mechanic is learned, continued chips would be clutter.
        if (player.squad.length > 0) return;

        const npc = nearestNpc();
        if (!npc || npc.role !== "warrior") return;
        if (companions.has(npc.id)) return;

        const text = "Press E to speak";
        ctx.save();
        ctx.font = "bold 13px system-ui, sans-serif";
        const padX = 14;
        const tw = ctx.measureText(text).width;
        const w = Math.ceil(tw + padX * 2);
        const h = 30;
        // Sit above the tutorial banner (or alone if tutorial is
        // done). Both are clearly stacked near the bottom center.
        const yBase = tutorial.isActive() ? VIEW_H - 240 : VIEW_H - 200;
        const x = Math.floor((VIEW_W - w) / 2);
        const y = yBase;

        ctx.globalAlpha = 0.92;
        roundRectPath(ctx, x, y, w, h, 6);
        ctx.fillStyle = "rgba(18, 18, 30, 0.92)";
        ctx.fill();
        ctx.strokeStyle = "rgba(138, 217, 255, 0.55)";
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.globalAlpha = 1;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        drawShadowedText(
            text, x + w / 2, y + h / 2,
            "#e8e8f0", "bold 13px system-ui, sans-serif"
        );
        ctx.restore();
    }

    // Compact top-right minimap. Shows the world at a fixed scale
    // with player / followers / hostiles / buildings plotted as
    // coloured dots. Cheap: a few dozen fillRects per frame, all
    // bounded by the screen-size of the map itself.
    //
    // Positioned under the pause button so it doesn't fight any
    // other top-right HUD element. Hidden on the intro + game-
    // over screens to keep those overlays clean.
    function drawMinimap() {
        if (gameState !== "playing") return;
        // Skip tiny interiors - a 15x10 tile shop isn't helpful
        // to map, and the player already sees the whole room.
        if (currentLevel && currentLevel.isInterior) return;

        const mw = 110;
        const mh = 74;
        const mx = VIEW_W - mw - 12;
        // Below the pause button + SQD indicator stack:
        //   pause button y=12 h=36  -> ends 48
        //   SQD          y=54 h=22  -> ends 76
        //   minimap at 82
        const my = 82;

        const scaleX = mw / WORLD_W;
        const scaleY = mh / WORLD_H;

        ctx.save();
        ctx.globalAlpha = 0.86;
        roundRectPath(ctx, mx, my, mw, mh, 5);
        ctx.fillStyle = "rgba(14, 14, 22, 0.88)";
        ctx.fill();
        ctx.strokeStyle = "rgba(138, 217, 255, 0.42)";
        ctx.lineWidth = 1;
        ctx.stroke();

        // Clip all dot draws to the map rect so anything near the
        // map border doesn't spill onto surrounding HUD.
        ctx.save();
        ctx.beginPath();
        ctx.rect(mx, my, mw, mh);
        ctx.clip();

        // Buildings as soft rectangles - structural anchors first.
        const buildings = currentLevel.buildings || [];
        ctx.fillStyle = "rgba(180, 180, 200, 0.55)";
        for (const b of buildings) {
            ctx.fillRect(
                mx + b.x * scaleX,
                my + b.y * scaleY,
                Math.max(1, b.w * scaleX),
                Math.max(1, b.h * scaleY)
            );
        }

        // Exits as faint cyan ticks on the matching edge - shows the
        // player which way they can transition out of the level.
        const exits = currentLevel.exits || {};
        ctx.fillStyle = "rgba(138, 217, 255, 0.85)";
        if (exits.west)  ctx.fillRect(mx + 1, my + mh / 2 - 3, 2, 6);
        if (exits.east)  ctx.fillRect(mx + mw - 3, my + mh / 2 - 3, 2, 6);
        if (exits.north) ctx.fillRect(mx + mw / 2 - 3, my + 1, 6, 2);
        if (exits.south) ctx.fillRect(mx + mw / 2 - 3, my + mh - 3, 6, 2);

        // Drops as small yellow pips - useful on a hostile floor.
        ctx.fillStyle = "rgba(255, 209, 102, 0.9)";
        for (const d of drops) {
            ctx.fillRect(
                mx + d.x * scaleX - 1,
                my + d.y * scaleY - 1,
                2, 2
            );
        }

        // Hostile enemies red. Ally / neutral skipped so the map
        // never misreads a friendly creature as a threat.
        ctx.fillStyle = "#e06666";
        for (const e of enemies) {
            if (!e.alive || e.ally || e.neutral) continue;
            ctx.fillRect(
                mx + (e.x + e.width / 2) * scaleX - 1,
                my + (e.y + e.height / 2) * scaleY - 1,
                2, 2
            );
        }
        // Neutral creatures get a pale green dot to tell them apart.
        ctx.fillStyle = "rgba(180, 220, 160, 0.9)";
        for (const e of enemies) {
            if (!e.alive || !e.neutral || e.ally) continue;
            ctx.fillRect(
                mx + (e.x + e.width / 2) * scaleX - 1,
                my + (e.y + e.height / 2) * scaleY - 1,
                2, 2
            );
        }

        // Followers + allied guardians as brighter green.
        ctx.fillStyle = "#7ad17a";
        for (const f of followers) {
            ctx.fillRect(
                mx + (f.x + f.width / 2) * scaleX - 1,
                my + (f.y + f.height / 2) * scaleY - 1,
                2, 2
            );
        }
        for (const e of enemies) {
            if (!e.alive || !e.ally) continue;
            ctx.fillRect(
                mx + (e.x + e.width / 2) * scaleX - 1,
                my + (e.y + e.height / 2) * scaleY - 1,
                2, 2
            );
        }

        // Player as a bright gold dot on top so it reads first.
        const pcx = mx + (player.x + player.width / 2) * scaleX;
        const pcy = my + (player.y + player.height / 2) * scaleY;
        ctx.fillStyle = "#ffd166";
        ctx.fillRect(pcx - 2, pcy - 2, 4, 4);
        // Small "breadcrumb" pulse ring around the player so even a
        // crowded map keeps them findable.
        const pulse = 0.5 + 0.5 * Math.abs(Math.sin(performance.now() * 0.004));
        ctx.globalAlpha = 0.55 * pulse;
        ctx.strokeStyle = "#fff6d6";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(pcx, pcy, 4, 0, Math.PI * 2);
        ctx.stroke();

        ctx.restore();   // drop clip

        // Label above the map rect.
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.globalAlpha = 0.82;
        drawShadowedText("MAP",
            mx + mw / 2, my - 2,
            "#a0a0b8",
            "bold 9px system-ui, sans-serif");
        ctx.restore();
    }

    function drawSquadIndicator() {
        const max = companions.maxSize();
        const n = player.squad.length;
        if (n === 0 && max <= companions.baseMax) return;

        // Width widens when the player has reserves - an extra
        // "+N res" badge fits inside the same chip.
        const reserves = companions.reserveCount();
        const w = reserves > 0 ? 128 : 84;
        const h = 22;
        // Pause button is at (VIEW_W - 48, 12) with w=36, h=36, so
        // it ends near y=48. Tuck the readout just below.
        const x = VIEW_W - w - 12;
        const y = 54;

        ctx.save();
        ctx.globalAlpha = 0.78;
        roundRectPath(ctx, x, y, w, h, 5);
        ctx.fillStyle = "rgba(20, 20, 30, 0.82)";
        ctx.fill();
        ctx.strokeStyle = "rgba(255, 209, 102, 0.32)";
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.globalAlpha = 1;

        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        drawShadowedText("SQD", x + 8, y + h / 2,
            "#a0a0b8", "bold 10px system-ui, sans-serif");
        ctx.textAlign = "right";
        // Bright gold when you have room to recruit, dim when capped.
        const color = n < max ? "#ffd166" : "#e0a050";
        const activeN = Math.min(n, followers.length);
        // Format: active/cap  [ +res ]  so the player sees both
        // the live follower count and how many skirmishers are
        // queued to join battles.
        drawShadowedText(`${activeN}/${max}`, x + w - 8, y + h / 2,
            color, "bold 13px system-ui, sans-serif");
        if (reserves > 0) {
            // Put the reserve badge left of the n/max readout.
            ctx.textAlign = "right";
            drawShadowedText(`+${reserves}`, x + w - 40, y + h / 2,
                "#7ad17a", "bold 12px system-ui, sans-serif");
        }
        ctx.restore();
    }

    function drawQuestPanel() {
        const w = 240;
        const h = 84;  // taller to fit MISSION row cleanly

        // Stats panel occupies x 8..288 at top. Give it 8px of gap
        // before placing the quest panel alongside.
        const canFitRight = VIEW_W >= 288 + w + 16;
        const x = canFitRight ? VIEW_W - w - 8 : 8;
        // Fallback y below stats panel (y=8, h=92 -> ends 100) with
        // a small gap so they don't visually overlap on portrait.
        const y = canFitRight ? 8 : 108;

        ctx.save();
        roundRectPath(ctx, x, y, w, h, 8);
        ctx.fillStyle = "rgba(12, 12, 22, 0.72)";
        ctx.fill();
        ctx.strokeStyle = "rgba(138, 217, 255, 0.32)";
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.textBaseline = "top";

        // Row 1 - chapter header + lore counter.
        const chapterIdx = story.chapterOrder.indexOf(story.state) + 1;
        drawShadowedText(
            `CH ${chapterIdx}`,
            x + 12, y + 7,
            "#b06bff",
            "bold 10px system-ui, sans-serif"
        );
        // Chapter title gets clipped so it never runs under the
        // LORE counter. Width budget = panel minus label + lore.
        const chapterTitle = story.title();
        const chapterTitleMax = w - 140;
        drawClippedText(
            chapterTitle,
            x + 38, y + 7, chapterTitleMax,
            "#e8e8f0",
            "bold 11px system-ui, sans-serif"
        );
        const loreTotal = loreLog.total();
        if (loreTotal > 0) {
            ctx.textAlign = "right";
            drawShadowedText(
                `LORE  ${loreLog.count()}/${loreTotal}`,
                x + w - 10, y + 7,
                "#ffd166",
                "bold 10px system-ui, sans-serif"
            );
            ctx.textAlign = "start";
        }

        ctx.strokeStyle = "rgba(138, 217, 255, 0.18)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x + 10, y + 22);
        ctx.lineTo(x + w - 10, y + 22);
        ctx.stroke();

        // Row 2 - current mission. Shows the one canonical "what
        // are you doing right now?" step from the missions module,
        // above the finer-grained quest row.
        drawShadowedText(
            "MISSION",
            x + 12, y + 26,
            "#a0a0b8",
            "10px system-ui, sans-serif"
        );
        const curMission = missions.getCurrentMission();
        if (curMission) {
            drawClippedText(
                curMission.name,
                x + 64, y + 26, w - 76,
                "#8ad9ff",
                "bold 11px system-ui, sans-serif"
            );
        } else {
            drawClippedText(
                "(campaign complete)",
                x + 64, y + 26, w - 76,
                "#a0a0b8",
                "bold 11px system-ui, sans-serif"
            );
        }

        // Row 3 - active quest + progress numbers.
        drawShadowedText(
            "QUEST",
            x + 12, y + 44,
            "#a0a0b8",
            "10px system-ui, sans-serif"
        );

        if (!questLog.active) {
            drawClippedText(
                "(none)  talk to the Elder",
                x + 64, y + 44, w - 76,
                "#a0a0b8",
                "bold 11px system-ui, sans-serif"
            );
        } else {
            const tmpl = QUESTS[questLog.active.id];
            const prog = questLog.active.progress;
            const goal = tmpl.target;

            // Reserve room on the right for the "N / M" counter so
            // the title never overlaps it on long names.
            const countText = `${prog} / ${goal}`;
            ctx.font = "bold 11px system-ui, sans-serif";
            const countW = ctx.measureText(countText).width;
            const titleMax = w - 76 - countW - 12;
            drawClippedText(
                tmpl.title,
                x + 64, y + 44, titleMax,
                "#ffd166",
                "bold 11px system-ui, sans-serif"
            );

            ctx.textAlign = "right";
            drawShadowedText(
                countText,
                x + w - 12, y + 45,
                "#8ad9ff",
                "bold 11px system-ui, sans-serif"
            );
            ctx.textAlign = "start";

            // Progress bar along the bottom of the panel.
            const barX = x + 12;
            const barY = y + 66;
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
        }

        ctx.restore();
    }

    // Draws text clipped to a maximum pixel width. Used by the
    // quest panel rows so long titles never leak past their slot
    // into the progress counter / lore counter alongside them.
    function drawClippedText(text, x, y, maxW, color, font) {
        if (!text) return;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y - 2, maxW, 20);
        ctx.clip();
        drawShadowedText(text, x, y, color, font);
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
        const titleFade = Math.min(1, elapsed / 1.2);
        const showPrompt = elapsed >= 1.2;

        // Full-screen dim so the world reads as "not playing yet".
        ctx.fillStyle = "rgba(10, 10, 20, 0.92)";
        ctx.fillRect(0, 0, VIEW_W, VIEW_H);

        ctx.save();
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        // Title - slides up slightly as it fades in.
        const titleY = VIEW_H / 2 - 100 + (1 - titleFade) * 20;
        ctx.globalAlpha = titleFade;
        drawShadowedText(
            "ETHEREON",
            VIEW_W / 2, titleY,
            "#ffd166",
            "bold 64px system-ui, sans-serif"
        );

        // Tagline just below the title.
        ctx.globalAlpha = titleFade * 0.8;
        drawShadowedText(
            "a small action-RPG",
            VIEW_W / 2, titleY + 50,
            "#a0a0b8",
            "14px system-ui, sans-serif"
        );

        // Three-line instruction block - the core controls in plain
        // language, readable on both mobile and desktop since each
        // verb maps to both input modes.
        if (showPrompt) {
            ctx.globalAlpha = Math.min(1, (elapsed - 1.2) / 0.5);
            const instructY = VIEW_H / 2 - 10;
            const lineGap = 22;
            const lines = [
                "Move with joystick or arrows",
                "Attack with button or SPACE",
                "Build your squad and survive",
            ];
            for (let i = 0; i < lines.length; i++) {
                drawShadowedText(
                    lines[i],
                    VIEW_W / 2, instructY + i * lineGap,
                    "#e8e8f0",
                    "15px system-ui, sans-serif"
                );
            }

            // "Tap to Start" button - rounded rect centered below
            // the instructions, gently pulsing so it reads as the
            // primary target. Rect is cached on startButton so the
            // pointer handler can hit-test it precisely; any tap
            // outside still starts the game too for forgiving input.
            const pulse = 0.78 + 0.22 * Math.abs(Math.sin(now * 0.004));
            const btnW = 180;
            const btnH = 48;
            const btnX = Math.round((VIEW_W - btnW) / 2);
            const btnY = Math.round(instructY + lines.length * lineGap + 24);
            startButton.rect.x = btnX;
            startButton.rect.y = btnY;
            startButton.rect.w = btnW;
            startButton.rect.h = btnH;

            ctx.globalAlpha = pulse;
            roundRectPath(ctx, btnX, btnY, btnW, btnH, 10);
            ctx.fillStyle = "#ffd166";
            ctx.fill();
            ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
            ctx.lineWidth = 2;
            ctx.stroke();

            ctx.globalAlpha = 1;
            drawShadowedText(
                "TAP TO START",
                btnX + btnW / 2, btnY + btnH / 2,
                "#1a1a24",
                "bold 18px system-ui, sans-serif"
            );
        }

        ctx.restore();
    }

    function drawPlayer() {
        // Aura and cloak stay visible during hit-flicker so the
        // player never fully disappears - only the body sprite
        // blinks at ~10Hz while invulnerable, which reads as a
        // "spectral" moment rather than a pop-off.
        aura.draw();
        cloak.draw();

        // Charged-sword spin slash - drawn under the sprite so the
        // blade trail reads as swung from the player's hand rather
        // than floating above the head.
        swordSpin.draw(ctx, player);
        // Charged-energy beam - same world-space layer as the spin.
        // Drawn under the sprite so the player's silhouette reads on
        // top of the beam, selling it as emitted from the character.
        energyBeam.draw(ctx);
        // Charge buildup halo + converging motes. Halo composites
        // with "lighter" so it brightens the sprite underneath rather
        // than obscuring it.
        chargeFx.draw(ctx);
        playerTrail.draw(ctx);
        // Cinematic FX (sparks + residues) draw above the player
        // sprite but below the world-transform close, so they're
        // still camera-locked with the world.
        cinematicFx.drawWorld(ctx);

        const blinking = player.iframes > 0 &&
            Math.floor(player.iframes * 20) % 2 === 0;
        if (blinking) return;

        const px = Math.round(player.x);
        const py = Math.round(player.y);
        if (swordSpin.isActive()) {
            // Rotate the sprite through ~1.5 revolutions across the
            // spin's 0.45s window - feels like the player body
            // whipping around with the slash. Transform is local,
            // one save/restore, zero allocations.
            const t = swordSpin.progress();
            const angle = t * Math.PI * 2 * 1.5;
            const cx = px + 16;
            const cy = py + 16;
            ctx.save();
            ctx.translate(cx, cy);
            ctx.rotate(angle);
            ctx.translate(-cx, -cy);
            player.sheet.draw(
                ctx,
                player.animator.col,
                player.animator.row,
                px, py
            );
            ctx.restore();
        } else {
            player.sheet.draw(
                ctx,
                player.animator.col,
                player.animator.row,
                px, py
            );
        }

        // Charge ring - only drawn while actively charging. Thin
        // circle beneath the sprite's feet that fills clockwise as
        // charge grows. Turns gold past the charge threshold so the
        // player sees the moment a tap becomes a charged shot.
        if (player.isCharging && player.chargeTime > 0.05) {
            const cx = Math.round(player.x + player.width / 2);
            const cy = Math.round(player.y + player.height - 2);
            const frac = Math.min(1, player.chargeTime / player.maxCharge);
            const readyToRelease = player.chargeTime >= 1;
            const r = 18;

            ctx.save();
            ctx.lineWidth = 3;
            // Track (dim)
            ctx.strokeStyle = "rgba(0, 0, 0, 0.35)";
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.stroke();

            // Fill arc
            ctx.strokeStyle = readyToRelease ? "#ffd166" : "#8ad9ff";
            ctx.beginPath();
            ctx.arc(cx, cy, r,
                -Math.PI / 2,
                -Math.PI / 2 + frac * Math.PI * 2);
            ctx.stroke();

            // Pulse outline when fully charged so the player notices
            // they can release for max damage.
            if (readyToRelease) {
                const pulse = 0.4 + 0.4 * Math.abs(Math.sin(performance.now() * 0.012));
                ctx.globalAlpha = pulse;
                ctx.lineWidth = 2;
                ctx.strokeStyle = "#fff6d6";
                ctx.beginPath();
                ctx.arc(cx, cy, r + 3, 0, Math.PI * 2);
                ctx.stroke();
            }
            ctx.restore();
        }

        // Crown - last thing drawn so it sits on top of the
        // sprite + charge FX. Its own update clock drives glow /
        // sparkle animation; drawing is cheap (one drawImage + a
        // handful of fillRects).
        crown.draw(ctx);
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

    // Magic meter - red bar below HP. Always visible: magic is a
    // core resource and the empty bar cues players to go hunt for
    // red orbs. Same dimensions as HP would make it read as a
    // Slim gold crown bar under the XP track. Hidden unless the
    // player has gained any crown energy yet, so campaign-newcomers
    // don't see an empty meter before they understand the system.
    // Turns pulsing bright when Crown Mode is burning, so the player
    // always knows the ability is live.
    function drawCrownBar() {
        // Skip if the player has never gained energy (first minutes
        // of the game). Once crown.level > 1 it's always shown, so
        // chapter progression surfaces the bar regardless.
        if (crown.energy <= 0 && !crown.active && crown.level <= 1) return;

        const barW = 180;
        const barH = 6;
        const x = 16;
        const y = 82;  // under the XP bar (y=74, h=6)

        const frac = crown.active
            ? 1
            : Math.max(0, Math.min(1, crown.energy / crown.max));

        ctx.save();
        roundRectPath(ctx, x, y, barW, barH, 3);
        ctx.fillStyle = "#13131c";
        ctx.fill();

        if (frac > 0) {
            // During Crown Mode the bar pulses so the player notices
            // the active window draining down.
            const pulse = crown.active
                ? 0.75 + 0.25 * Math.sin(performance.now() * 0.012)
                : 1;
            const remain = crown.active
                ? crown.activeTimer / crown.activeDuration
                : 1;
            ctx.save();
            ctx.clip();
            ctx.globalAlpha = pulse;
            ctx.fillStyle = crown.active ? "#fff6d6" : "#ffd166";
            ctx.fillRect(x, y, barW * frac * remain, barH);
            ctx.globalAlpha = 1;
            ctx.restore();
        }
        ctx.strokeStyle = "rgba(255, 209, 102, 0.45)";
        ctx.lineWidth = 1;
        roundRectPath(ctx, x + 0.5, y + 0.5, barW - 1, barH - 1, 3);
        ctx.stroke();

        ctx.textBaseline = "middle";
        drawShadowedText(
            crown.active
                ? `CROWN  ACTIVE  L${crown.level}`
                : `CROWN  ${Math.floor(frac * 100)}%  L${crown.level}`,
            x + barW + 10, y + barH / 2,
            crown.active ? "#fff6d6" : "#e0c878",
            "bold 10px system-ui, sans-serif"
        );
        ctx.restore();
    }

    function drawMagicBar() {
        const barW = 180;
        const barH = 10;
        const x = 16;
        const y = 58;  // 4px gap below HP (y=40, h=14)
        const r = 4;

        const frac = Math.max(0, Math.min(1, player.magic / player.maxMagic));

        ctx.save();

        // Track
        roundRectPath(ctx, x, y, barW, barH, r);
        ctx.fillStyle = "#13131c";
        ctx.fill();

        // Fill - deep red → bright crimson. Clipped to the rounded
        // track so the fill honors the corner radius.
        if (frac > 0) {
            ctx.save();
            ctx.clip();
            ctx.fillStyle = "#c5243a";
            ctx.fillRect(x, y, barW * frac, barH);
            // Specular highlight
            ctx.fillStyle = "rgba(255, 255, 255, 0.22)";
            ctx.fillRect(x, y + 1, barW * frac, 2);
            ctx.restore();
        }

        // Rim - faint red tint
        ctx.strokeStyle = "rgba(230, 90, 90, 0.35)";
        ctx.lineWidth = 1;
        roundRectPath(ctx, x + 0.5, y + 0.5, barW - 1, barH - 1, r);
        ctx.stroke();

        // Readout
        ctx.textBaseline = "middle";
        drawShadowedText(
            `MP  ${Math.floor(player.magic)} / ${player.maxMagic}`,
            x + barW + 10, y + barH / 2,
            "#e8b0b0",
            "11px system-ui, sans-serif"
        );

        ctx.restore();
    }

    // Corruption meter - appears beneath HP whenever the player has
    // any corruption at all or is currently in a corrupting zone
    // (so the player sees the bar fill from 0, not pop in later).
    // Hidden otherwise so normal-campaign players never notice it.
    function drawCorruptionBar() {
        const exposed = !!(currentLevel && currentLevel.corrupting);
        if (corruption.value <= 0 && !exposed) return;

        const barW = 180;
        const barH = 8;
        const x = 16;
        // below XP (74+6) + CROWN (82+6) + 6px gap - conditional row.
        const y = 96;
        const r = 4;

        const frac = Math.max(0, Math.min(1, corruption.value / corruption.max));

        ctx.save();

        // Track
        roundRectPath(ctx, x, y, barW, barH, r);
        ctx.fillStyle = "#13131c";
        ctx.fill();

        // Fill - deep violet ramping to bright at high corruption.
        // The pulse amplitude grows with value so a full bar visibly
        // "agitates" without being distracting at low levels.
        if (frac > 0) {
            const pulse = 0.75 + Math.sin(performance.now() * 0.004) * 0.08 * frac;
            ctx.save();
            ctx.clip();
            ctx.fillStyle = frac > 0.66 ? "#b94bdb"
                          : frac > 0.33 ? "#8a2bbb"
                          :               "#5e1a7a";
            ctx.globalAlpha = pulse;
            ctx.fillRect(x, y, barW * frac, barH);
            // Thin lighter band across the top for a bit of depth.
            ctx.fillStyle = "rgba(220, 170, 255, 0.22)";
            ctx.globalAlpha = pulse;
            ctx.fillRect(x, y + 1, barW * frac, 1);
            ctx.restore();
        }

        // Rim
        ctx.strokeStyle = "rgba(160, 110, 200, 0.45)";
        ctx.lineWidth = 1;
        roundRectPath(ctx, x + 0.5, y + 0.5, barW - 1, barH - 1, r);
        ctx.stroke();

        // Label
        ctx.textBaseline = "middle";
        drawShadowedText(
            `CORRUPTION  ${Math.round(frac * 100)}%`,
            x + barW + 10, y + barH / 2,
            "#c8a6e0",
            "10px system-ui, sans-serif"
        );

        ctx.restore();
    }

    // Inventory panel - centered on screen. Aggregates `player.inventory`
    // Shop storefront panel. A centered list of placeholder items
    // with name, effect, and price. Each row is tappable (stored in
    // `shop.itemRects`) and the panel header carries a close button
    // whose hitbox is stashed in `shop.closeRect`.
    // Pause overlay. Dims the world, draws three stacked tap rows
    // (Resume / Save / Load) with keyboard hints, and a small status
    // line fed by pauseMenu.setStatus. Rects are stored on pauseMenu
    // so tap hit-testing can run against the same coords.
    // Static zone-map layout for the pause journal. col / row are
    // grid coordinates inside the map region; positions are computed
    // per-draw so the panel can resize with the viewport.
    const PAUSE_MAP_NODES = [
        { id: "emberhold",  label: "EMBERHOLD",  col: 0, row: 0 },
        { id: "grove",      label: "GROVE",      col: 1, row: 0 },
        { id: "caverns",    label: "CAVERNS",    col: 2, row: 0 },
        { id: "shrine",     label: "SHRINE",     col: 3, row: 0 },
        { id: "abyss",      label: "ABYSS",      col: 4, row: 0 },
        { id: "port_halen", label: "PORT HALEN", col: 1, row: 1 },
    ];
    const PAUSE_MAP_LINKS = [
        ["emberhold", "grove"],
        ["grove",     "caverns"],
        ["caverns",   "shrine"],
        ["shrine",    "abyss"],
        ["grove",     "port_halen"],
    ];

    function drawPauseMenu() {
        // Bigger panel now that it carries the journal + map. Caps
        // at 540x620 so it stays readable on desktop without
        // stretching; clamps to the viewport on mobile.
        const w = Math.min(540, VIEW_W - 16);
        const h = Math.min(640, VIEW_H - 16);
        const x = Math.floor((VIEW_W - w) / 2);
        const y = Math.floor((VIEW_H - h) / 2);

        ctx.fillStyle = "rgba(0, 0, 0, 0.68)";
        ctx.fillRect(0, 0, VIEW_W, VIEW_H);

        ctx.save();
        roundRectPath(ctx, x, y, w, h, 12);
        ctx.fillStyle = "rgba(18, 18, 30, 0.96)";
        ctx.fill();
        ctx.strokeStyle = "rgba(255, 209, 102, 0.55)";
        ctx.lineWidth = 2;
        ctx.stroke();

        // --- Header ------------------------------------------------
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        drawShadowedText("PAUSED", x + w / 2, y + 14,
            "#ffd166", "bold 19px system-ui, sans-serif");
        drawShadowedText(
            `Chapter ${story.chapterOrder.indexOf(story.state) + 1} - ${story.title()}`,
            x + w / 2, y + 38,
            "#a0a0b8", "11px system-ui, sans-serif");

        // --- Section: Chapters timeline ---------------------------
        // Full campaign arc laid out horizontally so the player sees
        // all six beats at once, with past (green) / current (gold)
        // / future (dim) coded by color. Sits above missions so it
        // reads as the top-level "where am I in the story?" map.
        let sy = y + 62;
        ctx.textAlign = "left";
        drawShadowedText("CHAPTERS", x + 20, sy,
            "#8ad9ff", "bold 11px system-ui, sans-serif");
        sy += 18;

        const curChapterIdx = story.chapterOrder.indexOf(story.state);
        const chCount = story.chapterOrder.length;
        const chTrackX = x + 20;
        const chTrackW = w - 40;
        const chTrackY = sy + 14;  // dot centerline

        // Connecting line under the dots.
        ctx.strokeStyle = "rgba(138, 217, 255, 0.35)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(chTrackX + 10, chTrackY);
        ctx.lineTo(chTrackX + chTrackW - 10, chTrackY);
        ctx.stroke();

        for (let i = 0; i < chCount; i++) {
            const chId = story.chapterOrder[i];
            const info = CHAPTERS[chId] || { title: chId };
            const cx = chTrackX + 10 + (i / (chCount - 1)) * (chTrackW - 20);
            const done = i < curChapterIdx;
            const isHere = i === curChapterIdx;
            let fill = done ? "#7ad17a" : isHere ? "#ffd166" : "#555562";
            let rim  = done ? "rgba(122, 209, 122, 0.85)"
                    : isHere ? "#fff6d6"
                    : "rgba(85, 85, 98, 0.8)";
            ctx.fillStyle = fill;
            ctx.beginPath();
            ctx.arc(cx, chTrackY, isHere ? 7 : 5, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = rim;
            ctx.lineWidth = isHere ? 2 : 1.25;
            ctx.beginPath();
            ctx.arc(cx, chTrackY, isHere ? 9 : 6, 0, Math.PI * 2);
            ctx.stroke();

            // Chapter number above the dot.
            ctx.textAlign = "center";
            ctx.textBaseline = "bottom";
            drawShadowedText(String(i + 1),
                cx, chTrackY - 8,
                isHere ? "#ffd166" : done ? "#7ad17a" : "#787888",
                isHere ? "bold 11px system-ui, sans-serif"
                       : "bold 10px system-ui, sans-serif");
        }

        // Current chapter title underneath the track so the player
        // sees the full chapter name, not just a number.
        const curTitle = CHAPTERS[story.state]
            ? CHAPTERS[story.state].title
            : story.title();
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        drawShadowedText(
            `${curChapterIdx + 1}/${chCount} - ${curTitle}`,
            x + w / 2, chTrackY + 14,
            "#e8e8f0", "bold 11px system-ui, sans-serif");

        sy = chTrackY + 34;

        // --- Section: Missions timeline ---------------------------
        ctx.textAlign = "left";
        drawShadowedText("MISSIONS", x + 20, sy,
            "#8ad9ff", "bold 11px system-ui, sans-serif");
        sy += 18;
        const missionRowH = 20;
        for (let i = 0; i < missions.list.length; i++) {
            const m = missions.list[i];
            const isCurrent =
                i === missions.currentMissionIndex && !m.completed;
            const done = m.completed;
            const icon = done ? "[x]" : isCurrent ? "[>]" : "[ ]";
            const color = done ? "#7ad17a"
                        : isCurrent ? "#ffd166"
                        : "#a0a0b8";
            drawShadowedText(
                `${icon}  ${i + 1}. ${m.name}`,
                x + 28, sy + i * missionRowH,
                color,
                isCurrent ? "bold 12px system-ui, sans-serif"
                          : "12px system-ui, sans-serif"
            );
        }
        sy += missions.list.length * missionRowH + 14;

        // --- Section 2: World map ---------------------------------
        drawShadowedText("WORLD MAP", x + 20, sy,
            "#8ad9ff", "bold 11px system-ui, sans-serif");
        sy += 14;

        const mapX = x + 20;
        const mapY = sy;
        const mapW = w - 40;
        const mapH = 140;

        ctx.save();
        // Subtle backdrop for the map area.
        roundRectPath(ctx, mapX, mapY, mapW, mapH, 6);
        ctx.fillStyle = "rgba(10, 12, 22, 0.75)";
        ctx.fill();
        ctx.strokeStyle = "rgba(138, 217, 255, 0.18)";
        ctx.lineWidth = 1;
        ctx.stroke();

        // Compute node screen positions from the grid coords.
        const maxCol = 4, maxRow = 1;
        const nodePositions = {};
        for (const n of PAUSE_MAP_NODES) {
            const nx = mapX + 28 + (n.col / maxCol) * (mapW - 56);
            const ny = mapY + 32 + (n.row / Math.max(1, maxRow)) * (mapH - 64);
            nodePositions[n.id] = { x: nx, y: ny };
        }

        // Links first so the circles draw on top. Known-route links
        // are a bright cyan; locked-by-boss-gate links (shrine ->
        // abyss) go dim until the boss falls.
        ctx.lineWidth = 2;
        for (const [a, b] of PAUSE_MAP_LINKS) {
            const pa = nodePositions[a];
            const pb = nodePositions[b];
            if (!pa || !pb) continue;
            const locked = (a === "shrine" && b === "abyss") &&
                !defeatedBosses.has("shrine");
            ctx.strokeStyle = locked
                ? "rgba(120, 90, 130, 0.45)"
                : "rgba(138, 217, 255, 0.55)";
            ctx.beginPath();
            ctx.moveTo(pa.x, pa.y);
            ctx.lineTo(pb.x, pb.y);
            ctx.stroke();
        }

        // Nodes.
        for (const n of PAUSE_MAP_NODES) {
            const p = nodePositions[n.id];
            const isHere = currentLevel && currentLevel.id === n.id;
            const cleared = defeatedBosses.has(n.id);
            const safeZone = LEVELS[n.id] && LEVELS[n.id].safe;

            // Base fill - bright gold for current, green for zones
            // whose boss fell, cyan for known safe zones, violet for
            // other hostile zones (still reachable but unsubdued).
            let fill = "#8ad9ff";
            let rim  = "rgba(138, 217, 255, 0.7)";
            if (cleared)  { fill = "#7ad17a"; rim = "rgba(122, 209, 122, 0.85)"; }
            else if (safeZone) { fill = "#8ad9ff"; rim = "rgba(138, 217, 255, 0.75)"; }
            else           { fill = "#b06bff"; rim = "rgba(176, 107, 255, 0.75)"; }
            if (isHere)    { fill = "#ffd166"; rim = "#fff6d6"; }

            ctx.fillStyle = fill;
            ctx.beginPath();
            ctx.arc(p.x, p.y, isHere ? 8 : 6, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = rim;
            ctx.lineWidth = isHere ? 2.5 : 1.5;
            ctx.beginPath();
            ctx.arc(p.x, p.y, isHere ? 10 : 7, 0, Math.PI * 2);
            ctx.stroke();

            // "here" pulse ring so the current zone reads at a glance.
            if (isHere) {
                const pulse = 0.5 + 0.5 *
                    Math.abs(Math.sin(performance.now() * 0.004));
                ctx.globalAlpha = pulse * 0.45;
                ctx.strokeStyle = "#fff6d6";
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.arc(p.x, p.y, 14, 0, Math.PI * 2);
                ctx.stroke();
                ctx.globalAlpha = 1;
            }

            // Label under the node.
            ctx.textAlign = "center";
            ctx.textBaseline = "top";
            drawShadowedText(n.label, p.x, p.y + 12,
                isHere ? "#ffd166" : "#e8e8f0",
                isHere ? "bold 10px system-ui, sans-serif"
                       : "10px system-ui, sans-serif");

            // Checkmark marker for cleared bosses.
            if (cleared) {
                drawShadowedText("[x]", p.x + 12, p.y - 4,
                    "#7ad17a", "bold 10px system-ui, sans-serif");
            }
        }
        ctx.restore();

        sy += mapH + 14;

        // --- Section 3: action rows -------------------------------
        const rowW = w - 40;
        const rowH = 34;
        const rowX = x + 20;
        const gap = 8;

        const hasSave = saveGame.exists();
        const rows = [
            { id: "resume", label: "Resume",  hint: "P / Esc", enabled: true },
            { id: "save",   label: "Save",    hint: "S",       enabled: true },
            { id: "load",   label: "Load",    hint: "L",       enabled: hasSave },
        ];

        for (const row of rows) {
            const r = pauseMenu.rects[row.id];
            r.x = rowX; r.y = sy; r.w = rowW; r.h = rowH;

            ctx.globalAlpha = row.enabled ? 1 : 0.45;
            roundRectPath(ctx, rowX, sy, rowW, rowH, 6);
            ctx.fillStyle = "#2a2a38";
            ctx.fill();
            ctx.strokeStyle = "rgba(255, 209, 102, 0.38)";
            ctx.lineWidth = 1;
            ctx.stroke();

            ctx.textAlign = "left";
            ctx.textBaseline = "middle";
            drawShadowedText(row.label, rowX + 14, sy + rowH / 2,
                "#e8e8f0", "bold 14px system-ui, sans-serif");
            ctx.textAlign = "right";
            drawShadowedText(row.hint, rowX + rowW - 14, sy + rowH / 2,
                "#a0a0b8", "11px system-ui, sans-serif");

            sy += rowH + gap;
        }
        ctx.globalAlpha = 1;

        // Status line at the bottom - fades in/out via statusTimer.
        if (pauseMenu.statusText) {
            ctx.textAlign = "center";
            ctx.textBaseline = "bottom";
            ctx.globalAlpha = Math.min(1, pauseMenu.statusTimer / 0.5);
            drawShadowedText(pauseMenu.statusText,
                x + w / 2, y + h - 10,
                "#8ad9ff",
                "12px system-ui, sans-serif");
            ctx.globalAlpha = 1;
        }

        ctx.restore();
    }

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

        // Scale the box to the viewport. Option rows are sized for
        // finger-friendly tapping (44px each with a 6px gap), so the
        // panel needs enough vertical room to fit up to 5 options
        // plus the header + body text without crowding on mobile.
        const boxW = Math.min(640, VIEW_W - 32);
        const boxH = Math.max(260, Math.min(380, Math.round(VIEW_H * 0.55)));
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
            // Row pitch is 50px (44 tall + 6 gap) - big finger-
            // friendly hitboxes so tapping on mobile stays easy.
            const ROW_H = 44;
            const ROW_PITCH = 50;
            const optionsTop = Math.max(
                lineY + 10,
                y + boxH - 14 - d.options.length * ROW_PITCH + (ROW_PITCH - ROW_H)
            );

            // Recruitment hint - only shown to first-time recruiters,
            // pointing at the Fight-with-me option. Auto-hides once
            // the player already has any squadmate so it doesn't nag
            // on subsequent conversations.
            if (d.npc && d.npc.role === "warrior" &&
                !companions.has(d.npc.id) &&
                player.squad.length === 0) {
                ctx.textAlign = "left";
                drawShadowedText(
                    "Select 'Fight with me' to recruit",
                    x + 18, optionsTop - 18,
                    "#8ad9ff",
                    "italic 12px system-ui, sans-serif"
                );
            }

            for (let i = 0; i < d.options.length; i++) {
                const opt = d.options[i];
                const oy = optionsTop + i * ROW_PITCH;
                const oh = ROW_H;
                const ox = x + 16;
                const ow = boxW - 32;

                // Highlight "Goodbye" row with the close accent.
                const isClose = opt.close === true;
                ctx.fillStyle = isClose
                    ? "rgba(110, 110, 130, 0.22)"
                    : "rgba(255, 209, 102, 0.14)";
                roundRectPath(ctx, ox, oy, ow, oh, 8);
                ctx.fill();
                ctx.strokeStyle = isClose
                    ? "rgba(160, 160, 184, 0.45)"
                    : "rgba(255, 209, 102, 0.5)";
                ctx.lineWidth = 1.5;
                ctx.stroke();

                // Number prefix + label, vertically centered in the
                // taller row. Text baseline flips to "middle" only
                // for this block so other panel text stays top-aligned.
                ctx.textBaseline = "middle";
                drawShadowedText(
                    String(i + 1),
                    ox + 14, oy + oh / 2,
                    isClose ? "#a0a0b8" : "#ffd166",
                    "bold 16px system-ui, sans-serif"
                );
                drawShadowedText(
                    opt.label,
                    ox + 38, oy + oh / 2,
                    "#e8e8f0",
                    "15px system-ui, sans-serif"
                );
                ctx.textBaseline = "top";

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

    // Wave readout - only shows in hostile zones when a wave campaign
    // is active or just finished. Hidden in safe zones so the HUD
    // stays clean in the grove / interiors.
    // Debug overlay - press D in gameplay to toggle. Surfaces the
    // mission roster (current vs done), story chapter + missionTag,
    // active quest progress, and squad cap so mission overlap or
    // off-by-one chapter advances are obvious at a glance.
    function drawDebugOverlay() {
        const w = Math.min(360, VIEW_W - 24);
        const lineH = 14;
        const padX = 12;
        const padY = 10;
        const cur = missions.getCurrentMission();
        const aq = questLog.active ? QUESTS[questLog.active.id] : null;

        const lines = [];
        lines.push("--- DEBUG (D to hide) ---");
        lines.push(`Story: ${story.state}`
            + (story.missionTag ? `  tag=${story.missionTag}` : ""));
        lines.push(`Mission: ${cur
            ? `${cur.id} - ${cur.name}`
            : "(all complete)"}`);
        lines.push(`Quest: ${aq
            ? `${aq.title}  ${questLog.active.progress}/${aq.target}`
            : "(none)"}`);
        lines.push(
            `Squad: ${player.squad.length}/${companions.maxSize()}` +
            `   Wave: ${spawner.waveState === "idle"
                ? "-" : `${Math.min(spawner.waveIndex + 1, spawner.totalWaves)}/${spawner.totalWaves}`}`
        );
        lines.push("Missions:");
        for (let i = 0; i < missions.list.length; i++) {
            const m = missions.list[i];
            const mark = m.completed ? "[x]"
                       : i === missions.currentMissionIndex ? "[>]"
                       : "[ ]";
            lines.push(`  ${mark} ${m.id}. ${m.name}`);
        }

        const h = padY * 2 + lines.length * lineH;
        // Sit just under the score panel's right edge to leave the
        // gameplay HUD untouched. Width caps so it fits in portrait.
        const x = 8;
        const y = 100;

        ctx.save();
        ctx.globalAlpha = 0.92;
        roundRectPath(ctx, x, y, w, h, 6);
        ctx.fillStyle = "rgba(8, 10, 16, 0.88)";
        ctx.fill();
        ctx.strokeStyle = "rgba(138, 217, 255, 0.55)";
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.globalAlpha = 1;

        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        let ly = y + padY;
        for (const line of lines) {
            const isHeader = line.startsWith("---") || line.endsWith(":");
            drawShadowedText(
                line, x + padX, ly,
                isHeader ? "#8ad9ff" : "#e8e8f0",
                "12px ui-monospace, Menlo, monospace"
            );
            ly += lineH;
        }
        ctx.restore();
    }

    function drawWaveIndicator() {
        if (isSafeZone()) return;
        if (spawner.waveState === "idle") return;
        const w = 110;
        const h = 26;
        const x = VIEW_W - w - 12;
        const y = VIEW_H - h - 38;  // just above the Enemies counter line

        ctx.save();
        ctx.globalAlpha = 0.82;
        roundRectPath(ctx, x, y, w, h, 5);
        ctx.fillStyle = "rgba(20, 20, 30, 0.85)";
        ctx.fill();
        ctx.strokeStyle = "rgba(255, 209, 102, 0.38)";
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.globalAlpha = 1;

        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        drawShadowedText("WAVE", x + 10, y + h / 2,
            "#a0a0b8", "bold 10px system-ui, sans-serif");

        ctx.textAlign = "right";
        const label = spawner.waveState === "complete"
            ? "DONE"
            : `${Math.min(spawner.waveIndex + 1, spawner.totalWaves)}/${spawner.totalWaves}`;
        const color = spawner.waveState === "complete" ? "#7ad17a" : "#ffd166";
        drawShadowedText(label, x + w - 10, y + h / 2,
            color, "bold 14px system-ui, sans-serif");
        ctx.restore();
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
