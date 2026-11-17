import type { HudData } from './Hud';
import { flightAttitude } from './flightAttitude';
import './cockpit.css';

/** Seat-fixed cockpit artwork; instruments use the aircraft's attitude, never its ground track. */
export class CockpitPanel {
  readonly root = document.createElement('div');
  readonly radarMount: HTMLElement;
  private readonly el: Record<string, Element> = {};
  private readonly attitude = { pitch: 0, bank: 0, heading: 0 };

  constructor(container: HTMLElement) {
    this.root.className = 'cockpit-view';
    const bankTicks = [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60].map((a) =>
      `<path d="M 0 -71 v ${a % 30 === 0 ? 10 : 5}" transform="rotate(${a})"/>`).join('');
    const pitchTicks = Array.from({ length: 17 }, (_, i) => (i - 8) * 10).filter((a) => a !== 0).map((a) =>
      `<g transform="translate(0 ${-a * 2})"><path d="M -33 0 h 23 m 20 0 h 23" ${a < 0 ? 'stroke-dasharray="4 3"' : ''}/><text x="-40" y="4" text-anchor="end">${Math.abs(a)}</text><text x="40" y="4">${Math.abs(a)}</text></g>`).join('');
    this.root.innerHTML = `
      <svg class="cockpit-canopy" viewBox="0 0 1000 600" preserveAspectRatio="none" aria-hidden="true">
        <path class="canopy-shadow" d="M -20 610 L 90 180 Q 115 45 250 -15 M 1020 610 L 910 180 Q 885 45 750 -15"/>
        <path class="canopy-frame" d="M -20 610 L 90 180 Q 115 45 250 -15 M 1020 610 L 910 180 Q 885 45 750 -15"/>
        <path class="canopy-highlight" d="M -12 610 L 98 180 Q 123 45 258 -15 M 1012 610 L 902 180 Q 877 45 742 -15"/>
      </svg>
      <div class="cockpit-sill"></div>
      <section class="cockpit-dashboard" aria-label="Cockpit instrument panel">
        <div class="cockpit-glareshield"><span>FLIGHT SYSTEMS</span><span>PRIMARY FLIGHT DISPLAY</span><span>NAV / RADAR</span></div>
        <div class="cockpit-panels">
          <section class="cockpit-bezel cockpit-systems" aria-label="Engine and airframe">
            <header>ENGINE / AIRFRAME</header>
            <div class="cockpit-power"><span>THROTTLE</span><b data-cp="throttle">0</b><small>%</small></div>
            <div class="cockpit-power-track"><div data-cp="power"></div></div>
            <div class="cockpit-system-row"><span>AFTERBURNER</span><b data-cp="ab">OFF</b></div>
            <div class="cockpit-system-row"><span>AIRFRAME</span><b><span data-cp="health">100</span>%</b></div>
            <div class="cockpit-system-row"><span>LOAD</span><b><span data-cp="g">1.0</span> G</b></div>
            <div class="cockpit-system-row"><span>AOA</span><b><span data-cp="aoa">0.0</span>&deg;</b></div>
            <div class="cockpit-annunciators"><span data-cp="gear">GEAR DN</span><span data-cp="brake">AIRBRK</span></div>
          </section>
          <section class="cockpit-bezel cockpit-pfd" aria-label="Primary flight instruments">
            <header>ATTITUDE / AIR DATA</header>
            <div class="cockpit-flight-row">
              <div class="cockpit-air-data">
                <label>AIRSPEED<small>km/h</small></label><b class="cockpit-reading" data-cp="speed">0</b>
                <label>RAD ALT<small>m AGL</small></label><b data-cp="agl">0</b>
              </div>
              <svg class="cockpit-attitude" viewBox="-90 -80 180 160" role="img" aria-label="Artificial horizon: pitch and bank">
                <defs><clipPath id="cockpit-horizon-clip"><circle r="75"/></clipPath></defs>
                <g clip-path="url(#cockpit-horizon-clip)">
                  <g data-cp="bank"><g data-cp="pitch">
                    <path fill="#327bac" d="M -400 -400 H 400 V 0 H -400 Z"/>
                    <path fill="#795333" d="M -400 0 H 400 V 400 H -400 Z"/>
                    <path d="M -400 0 H 400" stroke="#fff" stroke-width="2"/>
                    <g class="cockpit-pitch-marks">${pitchTicks}</g>
                  </g><path d="M 0 -65 l -5 9 h 10 Z" fill="white"/></g>
                </g>
                <circle r="76" fill="none" stroke="#65757d" stroke-width="2"/>
                <g fill="none" stroke="white" stroke-width="1.5">${bankTicks}</g>
                <path d="M -55 0 h 25 v 7 M 55 0 H 30 v 7 M -7 0 h 14 M 0 -4 v 8" fill="none" stroke="#ffe082" stroke-width="3"/>
                <path d="M 0 -78 l -4 -6 h 8 Z" fill="#ffe082"/>
              </svg>
              <div class="cockpit-air-data">
                <label>ALTITUDE<small>m MSL</small></label><b class="cockpit-reading" data-cp="altitude">0</b>
                <label>V/S<small>m/s</small></label><b data-cp="vs">+0</b>
              </div>
            </div>
            <div class="cockpit-navigation">
              <span>PITCH <b data-cp="pitchValue">0</b>&deg;</span>
              <span class="cockpit-heading">HDG <b data-cp="heading">000</b>&deg;</span>
              <span>BANK <b data-cp="bankValue">0</b>&deg;</span>
            </div>
          </section>
          <section class="cockpit-bezel cockpit-nav" aria-label="Navigation radar">
            <header>RADAR / HEADING UP</header>
            <div class="cockpit-radar-mount"><span class="cockpit-radar-off">RADAR OFF</span></div>
          </section>
        </div>
        <footer><span>PILOT VIEW</span><span>METRIC FLIGHT INSTRUMENTS</span></footer>
      </section>`;
    this.root.querySelectorAll('[data-cp]').forEach((el) => { this.el[el.getAttribute('data-cp')!] = el; });
    this.radarMount = this.root.querySelector<HTMLElement>('.cockpit-radar-mount')!;
    container.appendChild(this.root);
  }

  setScale(userScale: number): void {
    const portrait = window.innerWidth / window.innerHeight <= 0.75;
    const scale = Math.min(userScale, window.innerWidth / (portrait ? 490 : 940), window.innerHeight * (portrait ? 0.5 / 454 : 0.44 / 254));
    this.root.style.setProperty('--cockpit-scale', String(scale));
  }

  update(d: HudData): void {
    const a = flightAttitude(d.orientation, this.attitude);
    const text = (key: string, value: string | number): void => { this.el[key]!.textContent = String(value); };
    text('speed', Math.round(d.speed * 3.6));
    text('altitude', Math.round(d.altitude));
    text('agl', Math.max(0, Math.round(d.agl)));
    text('vs', `${d.verticalSpeed >= 0 ? '+' : ''}${d.verticalSpeed.toFixed(0)}`);
    text('heading', (Math.round(a.heading) % 360).toString().padStart(3, '0'));
    text('pitchValue', a.pitch.toFixed(0));
    text('bankValue', a.bank.toFixed(0));
    text('throttle', Math.round(d.throttle * 100));
    text('health', Math.round(d.health * 100));
    text('g', d.gLoad.toFixed(1));
    text('aoa', d.aoa.toFixed(1));
    text('ab', d.afterburner ? 'ON' : 'OFF');
    this.el.bank!.setAttribute('transform', `rotate(${-a.bank})`);
    this.el.pitch!.setAttribute('transform', `translate(0 ${a.pitch * 2})`);
    this.el.power!.setAttribute('style', `width: ${d.throttle * 100}%`);
    this.el.ab!.classList.toggle('active', d.afterburner);
    this.el.gear!.classList.toggle('active', d.gearDown);
    this.el.brake!.classList.toggle('active', d.airbrake);
    this.el.health!.classList.toggle('caution', d.health < 0.5);
    this.el.agl!.classList.toggle('caution', d.agl < 30);
  }
}
