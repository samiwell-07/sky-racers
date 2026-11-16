import { ACESFilmicToneMapping, PCFShadowMap, SRGBColorSpace, WebGLRenderer } from 'three';

export function createRenderer(container: HTMLElement, antialias = true): WebGLRenderer {
  const renderer = new WebGLRenderer({ antialias, powerPreference: 'high-performance', stencil: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  container.appendChild(renderer.domElement);
  return renderer;
}

/** Keeps the renderer sized to its container. Returns a cleanup function. */
export function handleResize(
  renderer: WebGLRenderer,
  container: HTMLElement,
  onAspect: (aspect: number) => void,
): () => void {
  const resize = (): void => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    renderer.setSize(w, h);
    onAspect(w / Math.max(1, h));
  };
  resize();
  window.addEventListener('resize', resize);
  return () => window.removeEventListener('resize', resize);
}
