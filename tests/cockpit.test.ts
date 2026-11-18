import { describe, expect, it } from 'vitest';
import { Euler, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { flightAttitude } from '../src/ui/flightAttitude';
import { CockpitCamera, cockpitEyeFor } from '../src/camera/CockpitCamera';
import { CameraManager } from '../src/camera/CameraManager';
import { createCameraConfig } from '../src/config/cameraConfig';
import { JET_DESIGNS } from '../src/entities/jet/jetDesigns';

const degrees = Math.PI / 180;
const attitude = (q: Quaternion) => flightAttitude(q, { pitch: 0, bank: 0, heading: 0 });

describe('cockpit attitude', () => {
  it('reads pitch, right bank and compass heading from aircraft pose, even without velocity', () => {
    const q = new Quaternion().setFromEuler(new Euler(20 * degrees, -70 * degrees, -35 * degrees, 'YXZ'));
    const a = attitude(q);
    expect(a.pitch).toBeCloseTo(20);
    expect(a.bank).toBeCloseTo(35);
    expect(a.heading).toBeCloseTo(70);
  });

  it('retains the inverted horizon and distinguishes nose-down from nose-up', () => {
    expect(Math.abs(attitude(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI)).bank)).toBeCloseTo(180);
    expect(attitude(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -30 * degrees)).pitch).toBeCloseTo(-30);
  });

  it('keeps the previous heading at vertical without NaN', () => {
    const out = { pitch: 0, bank: 0, heading: 123 };
    flightAttitude(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2), out);
    expect(out.pitch).toBeCloseTo(90);
    expect(out.heading).toBe(123);
    expect(Number.isFinite(out.bank)).toBe(true);
  });
});

describe('separate seat and chase cameras', () => {
  it('places the eye inside every jet canopy, not above it', () => {
    for (const [id, design] of Object.entries(JET_DESIGNS)) {
      const eye = cockpitEyeFor(id);
      const c = design.canopy;
      const normalizedDistance = (eye.x / c.width) ** 2 + ((eye.y - c.y) / c.height) ** 2 + ((eye.z - c.z) / c.length) ** 2;
      expect(normalizedDistance).toBeLessThan(1);
      expect(eye.y).toBeGreaterThan(c.y);
    }
  });

  it('transforms the seated eye with the jet and switches back to an outside chase view', () => {
    const target = { position: new Vector3(20, 1000, -50), quaternion: new Quaternion().setFromEuler(new Euler(0.2, 0.4, -0.5)), speed: 100, cockpitEye: cockpitEyeFor('viper') };
    const camera = new PerspectiveCamera();
    new CockpitCamera().update(camera, target);
    expect(camera.position.distanceTo(target.cockpitEye.clone().applyQuaternion(target.quaternion).add(target.position))).toBeLessThan(1e-8);
    expect(camera.quaternion.angleTo(target.quaternion)).toBeLessThan(1e-7);
    const manager = new CameraManager(createCameraConfig(), () => 0);
    expect(manager.toggle(target)).toBe('cockpit');
    manager.update(target, 1);
    expect(manager.camera.position.distanceTo(camera.position)).toBeLessThan(1e-8);
    expect(manager.toggle(target)).toBe('chase');
    manager.update(target, 1);
    expect(manager.camera.position.distanceTo(target.position)).toBeGreaterThan(15);
  });
});
