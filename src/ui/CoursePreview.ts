import type { CourseDef } from '../race/Course';

/** Draws a small top-down map of a course: gate line, gates, start and direction (north up). */
export function drawCoursePreview(canvas: HTMLCanvasElement, def: CourseDef): void {
  const ctx = canvas.getContext?.('2d');
  if (!ctx) return;
  const { width: w, height: hgt } = canvas;
  const pts = def.gates.map((g) => ({ x: g.x, z: g.z }));
  const start = def.start ?? null;
  const all = start ? [...pts, start] : pts;
  if (!all.length) return;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of all) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }
  const pad = 14;
  const scale = Math.min((w - pad * 2) / Math.max(1, maxX - minX), (hgt - pad * 2) / Math.max(1, maxZ - minZ));
  const ox = (w - (maxX - minX) * scale) / 2;
  const oy = (hgt - (maxZ - minZ) * scale) / 2;
  // World -Z is north (up on the map).
  const map = (p: { x: number; z: number }): [number, number] => [ox + (p.x - minX) * scale, oy + (p.z - minZ) * scale];

  ctx.clearRect(0, 0, w, hgt);
  ctx.fillStyle = 'rgba(10, 20, 30, 0.55)';
  ctx.fillRect(0, 0, w, hgt);

  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(120, 200, 255, 0.85)';
  ctx.beginPath();
  if (start) ctx.moveTo(...map(start));
  pts.forEach((p, i) => (i === 0 && !start ? ctx.moveTo(...map(p)) : ctx.lineTo(...map(p))));
  if (def.loop && pts.length > 1) ctx.lineTo(...map(pts[0]!));
  ctx.stroke();

  pts.forEach((p, i) => {
    const [x, y] = map(p);
    ctx.fillStyle = i === 0 ? '#ffd24a' : i === pts.length - 1 && !def.loop ? '#ff6b6b' : '#e8f4ff';
    ctx.beginPath();
    ctx.arc(x, y, i === 0 ? 4 : 2.5, 0, Math.PI * 2);
    ctx.fill();
  });
  if (start) {
    const [x, y] = map(start);
    ctx.fillStyle = '#59e68a';
    ctx.fillRect(x - 4, y - 4, 8, 8);
  }
  ctx.fillStyle = 'rgba(232, 238, 245, 0.8)';
  ctx.font = '10px sans-serif';
  ctx.fillText('N ↑', w - 26, 12);
}
