import { Quaternion, Vector3, type Object3D } from 'three';
import { getJetDefinition } from '../entities/jet/jetCatalog';
import type { NetClient, RemotePlayerInfo, RemoteSnapshot } from '../net/NetClient';
import { PuppetJet } from './PuppetJet';

/** Renders the other pilots connected to the multiplayer relay. */
export class RemotePlayers {
  private readonly jets = new Map<string, PuppetJet>();
  private readonly snapshot: RemoteSnapshot = { position: new Vector3(), quaternion: new Quaternion(), throttle: 0, afterburner: false };
  private readonly unsubscribe: Array<() => void> = [];

  constructor(private readonly net: NetClient, private readonly parent: Object3D, onMessage: (text: string) => void) {
    this.unsubscribe.push(
      net.onJoin((p) => {
        this.add(p);
        onMessage(`${p.name} joined`);
      }),
      net.onLeave((id) => {
        const name = net.players.get(id)?.name ?? 'A pilot';
        this.remove(id);
        onMessage(`${name} left`);
      }),
      net.onEvent((id, event, data) => {
        const name = net.players.get(id)?.name ?? 'A pilot';
        if (event === 'finish' && typeof data === 'number') onMessage(`${name} finished in ${data.toFixed(2)} s`);
        if (event === 'crash') onMessage(`${name} crashed`);
      }),
    );
    for (const p of net.players.values()) this.add(p);
  }

  private add(p: RemotePlayerInfo): void {
    if (!this.jets.has(p.id)) this.jets.set(p.id, new PuppetJet(getJetDefinition(p.jetId), this.parent));
  }

  private remove(id: string): void {
    this.jets.get(id)?.dispose();
    this.jets.delete(id);
  }

  get count(): number {
    return this.jets.size;
  }

  /** Read-only view of the remote puppets (for audio flyby cues). */
  get puppets(): ReadonlyMap<string, PuppetJet> {
    return this.jets;
  }

  setVisible(visible: boolean): void {
    if (visible) return; // render() decides per jet
    for (const jet of this.jets.values()) jet.visible = false;
  }

  render(now: number, time: number, dt: number): void {
    for (const [id, jet] of this.jets) {
      const s = this.net.getRemoteSnapshot(id, now, this.snapshot);
      jet.visible = !!s;
      if (s) jet.set(s.position, s.quaternion, s.throttle, time, dt);
    }
  }

  /** Unsubscribes and frees every remote jet (safe to call more than once). */
  dispose(): void {
    this.unsubscribe.splice(0).forEach((u) => u());
    for (const id of [...this.jets.keys()]) this.remove(id);
  }
}
