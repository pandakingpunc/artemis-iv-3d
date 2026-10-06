# ARTEMIS IV · T+0

**English** · [Türkçe](README.tr.md)

A cinematic 3D mission experience that runs in the browser, built from a research report on NASA's Artemis IV mission dated 3 October 2026.

**Live demo:** https://pandakingpunc.github.io/artemis-iv-3d/ · open directly in Turkish: https://pandakingpunc.github.io/artemis-iv-3d/?lang=tr

![ARTEMIS IV preview](preview.png)

## Running it

The easiest way is the live demo link above. To run it locally:

Double-click `START.cmd` (or the Turkish `BASLAT.cmd`) on Windows. Node.js is required; no package install or internet connection is needed. Alternatively run `node server.cjs` and open http://127.0.0.1:5184/. Because of ES modules, `index.html` cannot be opened directly by double-clicking. Closing the small server window stops the server.

On first launch the GPU shaders are compiled, so the loading screen can take a few seconds (~15–20 s the first time, noticeably shorter afterwards). All scenes are prepared once during this step, so there is no stutter at scene changes while the film plays. When loading finishes, the "Start mission" screen appears; you can start with or without sound.

## Language

English is the default. Switch to Turkish at any time without interrupting playback using the **EN / TR** button in the top bar, the language button on the start screen, or the **T** key; the choice is remembered in the browser. The `?lang=en` / `?lang=tr` URL parameter also works. The interface, scene texts, 3D labels, number formatting and the research report (`report.md` / `rapor.md`) all follow the selected language.

## Controls

| Key / button | Action |
|---|---|
| Space | Play / pause |
| ← → | 2 seconds back / forward |
| 1 … 9, 0 | Go to scene (0 = scene 10) |
| C | Cinema mode (2.39:1 letterbox, interface hidden; Esc to exit) |
| H | Hide / show interface |
| F | Fullscreen |
| M | Sound on / off |
| L | Scene labels |
| T | Switch language (English / Turkish) |
| ? | Shortcuts window |
| Shift + D | Performance readout (FPS, quality tier) |

The timeline can be dragged; hovering shows the scene name and time. Speed 0.1×–4×. Camera: Cinematic or Free (left-drag to orbit, wheel to zoom, right-drag to pan). Camera angle: standard / wide / close. Quality: low / medium / high. Save the scene as PNG. The Report button shows the sources and the representative choices.

## Visual and audio features

- **Image pipeline:** HDR scene, 4× MSAA, physically based bloom, ACES/AgX tone mapping, per-scene color grading, vignette, film grain; an environment (reflection) map for each world.
- **Launch:** LC-39B at dawn; detailed SLS Block 1 (4 RS-25s, 5-segment SRBs, LVSA, ICPS, launch abort tower), moving umbilical arms, water deluge, lightning towers, VAB, shoreline and surf; billowing exhaust, flames with shock diamonds, booster separation.
- **Space:** Earth with night-side city lights, procedural clouds, Sun-aware atmosphere and ocean glint; photometric Moon; colored star field, Milky Way and the Sun.
- **Vehicles:** detailed Orion (heat shield, docking ring, X-configuration solar arrays), a generic representative HLS lander (gold MLI foil, deploying landing legs, ladder), articulated EVA-suited astronauts, the DUSTER and SPSS candidate payloads, orange/white main parachutes, a full-scale recovery ship and boats.
- **Choreography:** RCS thruster puffs and a docking with contact; lunar landing (dust sheet, leg damping); astronauts climbing down the ladder and deploying the flag, SPSS and DUSTER; lunar ascent and rendezvous in orbit; service module separation, plasma sheath and trail; parachute deployment, splashdown, recovery.
- **Sound:** fully procedural (no audio files): per-scene ambient score, launch rumble and SRB crackle, Quindar radio tones, docking latch, landing, plasma roar, ocean. Audio starts only when the user turns it on.

## Relation to the report

T+0 is the crewed launch. 10 scenes animate a sample flow of about 20 days within a 184-second viewing time. The mission clock advances at a different rate in each scene. Day 20 was chosen from the 18–21 day return window; this is a storytelling choice, not NASA's exact T+ flight schedule. The distance/speed values in the telemetry panel are representative and approximate, not real telemetry.

The mission sequence is taken from the report: SLS/Orion launch, vehicle checkouts, transfer to the Moon, docking with a commercial HLS, two crew landing in the south polar region, science, ascent and crew reunion, transfer to Earth, atmospheric entry, Pacific splashdown/recovery. No Gateway stop is included. The HLS is a generic representative model; no provider is chosen. DUSTER and SPSS are not presented as confirmed flight payloads. Landing site, route, orbit, stage separation times, surface activities, vehicle dimensions and camera work are representative for storytelling. This is not a flight dynamics or engineering verification simulator.

Source report: `report.md` (English) and `rapor.md` (Turkish original). Three.js 0.180.0 MIT license: `vendor/LICENSE-three.txt`. Earth and Moon texture files: official three.js examples repository, https://threejs.org/examples/textures/planets/ (earth_atmos_2048.jpg, earth_normal_2048.jpg, earth_specular_2048.jpg, moon_1024.jpg). All other textures, models and sounds are generated procedurally in code.

## Code structure

| File | Purpose |
|---|---|
| `app.js` | Scene list, world setup, choreography, cameras, frame loop, quality tiers |
| `src/timeline.js` | Shared event times (docking, landing, parachutes, splashdown…) and astronaut walking routes |
| `src/post.js`, `src/looks.js` | HDR image pipeline; per-scene lighting, fog, environment map and color |
| `src/space.js` | Stars, Milky Way, Sun, Earth, Moon |
| `src/launchpad.js` | Launch complex and SLS/Orion |
| `src/spacecraft.js` | Orion, HLS, astronauts, payloads, capsule, parachutes, ship and boats |
| `src/effects.js` | Flames, smoke, dust, plasma, RCS, splash and foam |
| `src/terrain.js`, `src/ocean.js`, `src/sky.js` | Lunar terrain, Pacific Ocean, dawn sky |
| `src/ui.js`, `src/boot.js`, `index.html`, `style.css` | Interface, loading screen, shortcuts |
| `src/i18n.js` | English / Turkish strings and live language switching |
| `src/audio.js` | Procedural sound |

## Performance

Medium quality is the default. The frame rate is chosen as an even divisor of the display refresh rate (60 FPS on a 60 Hz display, 72 FPS on 144 Hz). Adaptive quality lowers the tier only on sustained slowness during playback and raises it again once things calm down; it ignores momentary hitches from seeking and scene transitions. Drawing and sound stop in a background tab. All animation is computed from absolute film time and fixed seeds: seeking back to the same moment produces the same frame (apart from at most 1/255 pixel differences from the GPU driver); replaying does not accumulate new geometry or audio nodes.

## License

The code is released under the MIT license (`LICENSE`). Three.js MIT license: `vendor/LICENSE-three.txt`.
