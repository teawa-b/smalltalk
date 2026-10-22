// AR/VR heads-up for SmallTalk: a thin bar just below your eye line, like a subtitle, showing the one thing to
// say next and updating as the conversation goes. It lazily follows your gaze and is drawn to a canvas so it stays
// crisp in the headset. Passthrough AR on Quest when available, otherwise immersive VR. Holding either trigger
// marks the lines as yours.
const THREE = await import('https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js');

const W = 1600, H = 200;
// SmallTalk's look: off-black bar, one burnt-orange accent, Geist (already loaded by the page).
const ACCENT = '#f27434', SANS = 'Geist, system-ui, sans-serif', MONO = '"Geist Mono", monospace';
function draw(ctx, view, status = '') {
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(17,16,19,0.8)'; roundRect(ctx, 0, 0, W, H, H / 2); ctx.fill();
  const nudge = (view?.nudges || [])[0], x = 104, max = W - x - 80;
  // A dot that says it is listening, in the accent while a nudge is up.
  ctx.fillStyle = nudge ? ACCENT : '#7a7880'; ctx.beginPath(); ctx.arc(62, H / 2, 11, 0, Math.PI * 2); ctx.fill();
  // One line, as large as fits: the thing to say next.
  const line = nudge ? nudge.say : 'Listening for what they love';
  let size = 56;
  do { ctx.font = `600 ${size}px ${SANS}`; } while (ctx.measureText(line).width > max && --size > 36);
  ctx.fillStyle = nudge ? '#ffffff' : '#a7a5ad';
  ctx.fillText(fit(ctx, line, max), x, 98);
  // Underneath, small: what it is about and where it came from, and what the app is doing.
  ctx.font = `500 26px ${MONO}`;
  if (nudge) { ctx.fillStyle = nudge.grounded ? ACCENT : '#7a7880'; ctx.fillText(fit(ctx, `${nudge.about} · ${nudge.grounded ? 'from Qloo' : 'not from Qloo'}`, max - 320), x, 152); }
  if (status) { ctx.fillStyle = '#7a7880'; const w = ctx.measureText(status).width; ctx.fillText(status, W - 80 - w, 152); }
}
function fit(ctx, text, max) {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}
function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

export async function enterXR({ view, status: initialStatus = 'Listening', onTalking, onEnd }) {
  let status = initialStatus;
  const mode = await navigator.xr.isSessionSupported('immersive-ar') ? 'immersive-ar' : 'immersive-vr';
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(devicePixelRatio); renderer.setSize(innerWidth, innerHeight);
  renderer.xr.enabled = true; renderer.xr.setReferenceSpaceType('local');
  renderer.domElement.style.cssText = 'position:fixed;inset:0;z-index:50;pointer-events:none';
  document.body.append(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 50);
  if (mode === 'immersive-vr') { scene.background = new THREE.Color(0x111013); scene.add(new THREE.GridHelper(20, 40, 0x2c2a30, 0x1c1b1f)); }

  const canvas = Object.assign(document.createElement('canvas'), { width: W, height: H });
  const ctx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(0.84, 0.105), new THREE.MeshBasicMaterial({ map: texture, transparent: true }));
  scene.add(panel);
  draw(ctx, view, status); texture.needsUpdate = true;

  const session = await navigator.xr.requestSession(mode, { optionalFeatures: ['local-floor'] });
  await renderer.xr.setSession(session);
  session.addEventListener('selectstart', () => onTalking(true));
  session.addEventListener('selectend', () => onTalking(false));

  // Lazy follow: the bar eases toward a point a metre ahead and 28 cm below eye level, where subtitles sit.
  const target = new THREE.Vector3(), dir = new THREE.Vector3(), head = new THREE.Vector3();
  let placed = false;
  renderer.setAnimationLoop(() => {
    const cam = renderer.xr.getCamera();
    cam.getWorldPosition(head); cam.getWorldDirection(dir); dir.y = 0; dir.normalize();
    target.copy(head).addScaledVector(dir, 1.0); target.y = head.y - 0.28;
    if (!placed) { panel.position.copy(target); placed = true; } else panel.position.lerp(target, 0.04);
    panel.lookAt(head);
    renderer.render(scene, camera);
  });
  const cleanup = () => { renderer.setAnimationLoop(null); renderer.domElement.remove(); renderer.dispose(); onEnd?.(); };
  session.addEventListener('end', cleanup);
  return {
    update(v) { view = v; draw(ctx, v, status); texture.needsUpdate = true; },
    status(text) { status = text; draw(ctx, view, status); texture.needsUpdate = true; },
    end() { session.end().catch(() => {}); }
  };
}
