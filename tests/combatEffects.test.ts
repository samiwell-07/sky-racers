import { PerspectiveCamera, Quaternion, Vector3, type BufferGeometry, type Material, type Mesh, type Object3D } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { CombatEffects } from '../src/combat/CombatEffects';
import { playCombatEvents } from '../src/combat/combatAudio';
import { NO_WEAPON_INPUT, WeaponSystem } from '../src/combat/WeaponSystem';
import type { Combatant } from '../src/combat/types';
import { AudioEngine } from '../src/audio/AudioEngine';

const DT = 1 / 120;
const me: Combatant = {
  id: 'me',
  position: new Vector3(0, 1000, 0),
  velocity: new Vector3(0, 0, -200),
  orientation: new Quaternion(),
  afterburner: false,
  alive: true,
};

describe('CombatEffects', () => {
  it('shows tracers, missiles and flares, explodes, and disposes every GPU resource', () => {
    const ws = new WeaponSystem('me', { seed: 3 });
    ws.applyRemote('foe', { t: 'missileLaunch', id: 'foe:1', target: 'me', p: [0, 1000, -3000], v: [0, 0, 300] });
    for (let i = 0; i < 30; i++) {
      ws.update(DT, me, [], { ...NO_WEAPON_INPUT, fireGun: true, fireMissile: i === 0, releaseFlares: i === 0 }, () => 0);
    }
    const fx = new CombatEffects();
    const cam = new PerspectiveCamera(60, 1, 1, 1e4);
    for (let i = 0; i < 10; i++) fx.update(1 / 60, ws, cam, 800);
    fx.handleEvents(ws.drainEvents());
    fx.explode(new Vector3(0, 1000, -100));
    fx.update(1 / 60, ws, cam, 800);
    const s = fx.stats;
    expect(s.tracers).toBe(ws.rounds.length);
    expect(s.missiles).toBe(2);
    expect(s.smoke).toBeGreaterThan(0);
    expect(s.glow).toBeGreaterThan(0);

    const disposed = new Set<unknown>();
    const resources = new Set<BufferGeometry | Material>();
    fx.group.traverse((o: Object3D) => {
      const m = o as Mesh;
      if (m.geometry) resources.add(m.geometry);
      if (m.material) resources.add(m.material as Material);
    });
    for (const r of resources) r.addEventListener('dispose', () => disposed.add(r));
    fx.dispose();
    expect(disposed.size).toBe(resources.size);
    expect(fx.group.children).toHaveLength(0);
    expect(() => fx.update(DT, ws, cam)).not.toThrow();
  });
});

describe('combat audio', () => {
  it('maps events to sounds, quieter with distance, and the engine is safe without an AudioContext', () => {
    const audio = {
      playGunBurst: vi.fn(),
      playMissileLaunch: vi.fn(),
      playFlarePop: vi.fn(),
      playHitMarker: vi.fn(),
      playExplosion: vi.fn(),
      playDamage: vi.fn(),
    };
    const at = (z: number) => new Vector3(0, 0, z);
    playCombatEvents(
      audio,
      [
        { type: 'gunFired', local: true, rounds: 2, position: at(0) },
        { type: 'gunFired', local: false, rounds: 1, position: at(1000) },
        { type: 'missileLaunched', local: false, id: 'x', position: at(600) },
        { type: 'flaresReleased', local: true, count: 2, position: at(0) },
        { type: 'hit', target: 'foe', cause: 'gun', damage: 0.05, position: at(300) },
        { type: 'damaged', by: 'foe', cause: 'missile', damage: 0.85 },
        { type: 'explosion', position: at(50), hit: true },
      ],
      at(0),
    );
    expect(audio.playGunBurst.mock.calls[0]).toEqual([2, 1]);
    expect(audio.playGunBurst.mock.calls[1]![1]).toBeLessThan(0.3);
    expect(audio.playMissileLaunch.mock.calls[0]![0]).toBeLessThan(0.5);
    expect(audio.playFlarePop).toHaveBeenCalledWith(2, 1);
    expect(audio.playHitMarker).toHaveBeenCalledOnce();
    expect(audio.playDamage).toHaveBeenCalledOnce();
    expect(audio.playExplosion).toHaveBeenCalledWith(1);

    const engine = new AudioEngine();
    expect(() => {
      engine.playGunBurst(3);
      engine.playMissileLaunch();
      engine.playFlarePop();
      engine.playHitMarker();
      engine.playExplosion();
      engine.updateCombatTones({ lock: 0.5, incomingMissile: true }, 0.1);
      engine.updateCombatTones(null, 0.1);
      engine.dispose();
    }).not.toThrow();
  });
});
