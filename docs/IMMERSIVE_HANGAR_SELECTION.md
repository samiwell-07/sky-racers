In the Sky Racers project, transform the main menu's aircraft selection into a truly immersive tour of a 3D hangar.

## OBJECTIVE
When the player chooses "Select an aircraft," the camera should enter a hangar. Several parked jets are revealed inside, visible in 3D. The player can move visually from jet to jet to examine them, as though touring a real hangar.

## EXPECTED BEHAVIOR
1. When aircraft selection opens, play a smooth transition from the current screen: the camera moves forward toward the hangar entrance, then settles inside, facing the first aircraft.
2. Place the aircraft inside the hangar, each in its own parking bay. Available aircraft must be visible in 3D, with consistent scale and orientation.
3. The left and right arrows allow the player to move to the previous or next jet. The camera moves laterally through the hangar, as though the player were walking or gliding to the neighboring bay. The selected jet should become the focus of attention, without teleportation or abrupt changes.
4. Clearly display the selected aircraft's name and the specifications already available in the game. Highlight its parking bay with lighting or a subtle visual treatment.
5. Also allow the player to select an aircraft using Enter, Space, or the confirmation button already used by the interface. Escape or the back button must return to the previous menu.
6. If a controller is connected, support left/right directions and the confirmation button, following the control conventions already used by the game.
7. Keep the game's existing controls functional, and ensure aircraft selection is usable with both a keyboard and a controller.

## VISUAL DIRECTION
Create a believable, immersive hangar: hangar flooring, parking markings, metal structures, industrial lighting, shadows, and depth. You may add understated decorative elements such as crates, tools, guidance lights, or hangar doors, but they must not obstruct the aircraft or hurt performance. The style must remain consistent with Sky Racers' visual identity.

## TECHNICAL CONSTRAINTS
- Start by examining the existing architecture, particularly the main menu, aircraft selection screen, 3D models, keyboard/controller controls, cameras, and rendering system.
- Reuse the existing aircraft, their models, and their information. Do not replace flight behavior or alter aircraft balance.
- Integrate the hangar into the project's current architecture rather than creating a second independent game scene unless necessary.
- Keep a clear way back to the menu and provide safe behavior if a custom 3D model is missing: use the existing procedural aircraft fallback.
- Verify that camera transitions and movements do not trigger flight controls.
- Follow the repository's existing code and style conventions.

## BEFORE FINISHING
Run the appropriate project checks, including tests and the build/typecheck. Fix any issues introduced by this change, then summarize the files changed, the available controls, and the verification results.

## IMPLEMENTED SELECTION FLOW
- The previous rotating preview/list selector is replaced by one full-screen page, shared by the main menu, multiplayer personal aircraft selection, and the host's Plane rule.
- Three connected hangars contain two parking bays each: two aircraft, two aircraft, then one aircraft and an empty bay. Left/right travel follows the interior aisle and stops at the first/last aircraft.
- Browsing never changes the active aircraft. Confirm applies the choice and returns; Back cancels. Host confirmation changes only the lobby settings draft until Create/Save is pressed, and retains the Pilot's choice rule.
- Keyboard: Left/Right browse; Enter/Space activate the focused control (the initially focused aircraft view confirms); Escape returns. Controller: d-pad/left stick browse, A activates, B returns. Tab navigation remains available.
- Each jet has its own procedural airframe: the swept twin-engine Falcon, clipped-wing Viper, diamond-wing Raptor, canard-delta Kestrel, and forward-swept Specter. They retain their catalog stats, collision envelope and flight configurations.
- The menu preview owns presentation and camera motion; the obscured flight world skips visual updates/rendering while the hangar is open. Input, networking and menu audio state continue normally.
- Reduced-motion preferences skip camera movement. Missing WebGL is reported with a usable text-based selection view. Lobby changes that invalidate a pending choice return safely rather than applying a stale rule.

## Customizing a jet
Open **Select an aircraft**, browse to a jet, and choose **Customize**. Choose a factory, tactical, woodland, or splinter wrap; matte or gloss paint; a canopy tint; and an optional one- or two-digit tail number. Edits preview on the parked jet. **Apply** saves its look on this device without selecting the aircraft. **Cancel** discards the edits. Resetting to factory is also a preview until applied.

The saved look is used in flight and shared with multiplayer pilots, including late joiners. The host's Plane rule chooses an aircraft type, not a paint scheme. Optional GLBs are displayed only with the factory appearance: a customized aircraft uses its paintable procedural model instead.
