# Ideas – status

For the six selected features planned next, see [GAME_BACKLOG.md](GAME_BACKLOG.md).
This page is the historical idea/status list; some "Next ideas" need rechecking against the current game.

Everything from the original idea list is now in the game. Notes say how each one was done and its limits.

## Racing ✅
- ✅ Full race courses with gates a few meters above the ground, chained through the canyon (`src/race/Course.ts`)
- ✅ Course sections: canyon bends, stone bridges to fly under, carved mountain passes, hilly return leg
- ✅ Start countdown, laps, missed-gate penalty (+3 s, crossing a gate's plane outside it)
- ✅ Race timer, split delta vs best ghost, best-lap ghost replay, local leaderboard (localStorage)
- ❌ Track editor (removed on request)

## World ✅
- ✅ Infinite terrain streamed in 1 km chunks with 3 LOD levels (skirts hide the seams); no border wall
- ✅ Splat-mapped textures (grass, dirt, rock with triplanar mapping, snow) + normal map, river in the valley
- ✅ Trees, rocks, farm buildings, power lines and stone bridges as obstacles (trees = damage, others = crash)
- ✅ Time of day, clouds, wind and turbulence (strongest low in the canyon)

## Jet & feel ✅
- ✅ Optional .glb model (`public/assets/models/<jetId>.glb`), animated ailerons, flaps, airbrake, landing gear + runway takeoff/landing
- ✅ Three jets with different stats
- ✅ Sound: synthesized engine, afterburner, wind rush, stall and PULL UP warnings, gates, crash (no audio files)
- ✅ Wingtip vapor trails at high G, heat haze, dust when flying very low
- ✅ Damage model: wing/tail scrapes and tree strikes damage the jet (less roll/lift, more drag), crash at 0 %
- ✅ G-effects (blackout / redout vignette), speed and low-altitude camera shake

## Controls ✅
- ✅ Gamepad / HOTAS (dead zone + expo curve, absolute throttle lever)
- ✅ Key remapping (Settings > Controls), mouse flight (pointer lock)
- ✅ Sensitivity settings

## Game ✅
- ✅ Main menu, settings (graphics quality, audio, controls, world), pause menu
- ✅ AI opponents racing the same course (with respawn at their last gate)
- ✅ Multiplayer: ghosts + real-time via a LAN WebSocket relay (`npm run server`)
- ✅ Medals per course (gold / silver / bronze from the course length)

## Worlds, races, combat ✅
- ✅ Minecraft-style seeded worlds (`src/world/gen/`): valleys, mountains, rivers, lakes/ocean, roads, towns and cities from any seed; the Classic Canyon is still available
- ✅ Free flight without gates, on any world
- ✅ Per-seed generated race courses (Easy / Medium / Hard, Sprint / Loop), also in multiplayer lobbies
- ✅ Dogfight: online mode for 2–4 pilots (duel or free-for-all, zone 6 km + 2 km per extra pilot) with machine gun, heat-seeking missiles, flares and a bounded combat zone (first to 3 kills)
- ✅ Radar in every flying mode (gates, AI, ghost, players, opponent, missiles, flares, airfield, dogfight zone); replaces the minimap idea

## Next ideas
- Internet multiplayer: host the relay online (needs a server with a public address), synchronized race starts
- Real asset textures / sounds and a detailed .glb jet
- Name tags above other pilots
- Replays from any camera
- Dogfight AI bot (offline dogfight practice) and 2v2 team dogfights
- Power lines and traffic along the generated roads; airports in the bigger cities
- Seed browser: favourite seeds, best times per generated course on the leaderboard
- Terrain shading per biome (river banks use the sea level for wet-bank shading only)
