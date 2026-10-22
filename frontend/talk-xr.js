// AR/VR heads-up for SmallTalk: a panel that floats about a metre in front of you and lazily follows your
// gaze, drawn to a canvas so it stays crisp in the headset. Passthrough AR on Quest when available,
// otherwise immersive VR. Holding either trigger marks the lines as yours.
const THREE = await import('https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js');

const W = 1024, H = 640;
// SmallTalk's look: off-black panel, one burnt-orange accent, Geist (already loaded by the page).
const ACCENT = '#f27434', SANS = 'Geist, system-ui, sans-serif', MONO = '"Geist Mono", monospace';
function draw(ctx, view, status = '') {
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(17,16,19,0.88)'; roundRect(ctx, 0, 0, W, H, 40); ctx.fill();
  ctx.fillStyle = ACCENT; ctx.font = `600 26px ${SANS}`; ctx.fillText('SmallTalk', 48, 64);
  if (status) { ctx.fillStyle = '#a7a5ad'; ctx.font = `500 22px ${MONO}`; const w = ctx.measureText(status).width; ctx.fillText(status, W - 48 - w, 62); ctx.fillStyle = ACCENT; ctx.beginPath(); ctx.arc(W - 64 - w, 54, 7, 0, Math.PI * 2); ctx.fill(); }
  const nudges = view?.nudges || [];
  let y = 140;
  if (!nudges.length) { ctx.fillStyle = '#a7a5ad'; ctx.font = `600 40px ${SANS}`; wrap(ctx, 'Listening for what they love.', 48, y, W - 96, 50); }
  nudges.slice(0, 2).forEach((n, i) => {
    ctx.fillStyle = i ? '#d9d6d0' : '#ffffff'; ctx.font = `${i ? 500 : 600} ${i ? 36 : 52}px ${SANS}`;
    y = wrap(ctx, n.say, 48, y, W - 96, i ? 44 : 60) + 6;
    ctx.fillStyle = n.grounded ? ACCENT : '#7a7880'; ctx.font = `500 22px ${MONO}`; ctx.fillText(`${n.about}${n.grounded ? '' : ' (not from Qloo)'}`.slice(0, 70), 48, y); y += 58;
  });
  const row = (label, list, yy) => { if (!list) return; ctx.fillStyle = '#7a7880'; ctx.font = `500 20px ${MONO}`; ctx.fillText(label, 48, yy); ctx.fillStyle = '#f3f2ef'; ctx.font = `500 26px ${SANS}`; ctx.fillText(list.slice(0, 60), 220, yy); };
  row('They love', (view?.them || []).slice(0, 5).map(e => e.name).join(', '), H - 78);
  row('Steer clear', (view?.avoid || []).slice(0, 4).map(e => e.name).join(', '), H - 38);
}
function wrap(ctx, text, x, y, max, lh) {
  let lineText = '';
  for (const word of String(text).split(' ')) {
    const test = lineText ? `${lineText} ${word}` : word;
    if (ctx.measureText(test).width > max && lineText) { ctx.fillText(lineText, x, y); y += lh; lineText = word; } else lineText = test;
  }
  if (lineText) { ctx.fillText(lineText, x, y); y += lh; }
  return y;
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
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.5), new THREE.MeshBasicMaterial({ map: texture, transparent: true }));
  scene.add(panel);
  draw(ctx, view, status); texture.needsUpdate = true;

  const session = await navigator.xr.requestSession(mode, { optionalFeatures: ['local-floor'] });
  await renderer.xr.setSession(session);
  session.addEventListener('selectstart', () => onTalking(true));
  session.addEventListener('selectend', () => onTalking(false));

  // Lazy follow: the panel eases toward a point 1.1 m ahead and 15 cm below eye level.
  const target = new THREE.Vector3(), dir = new THREE.Vector3(), head = new THREE.Vector3();
  let placed = false;
  renderer.setAnimationLoop(() => {
    const cam = renderer.xr.getCamera();
    cam.getWorldPosition(head); cam.getWorldDirection(dir); dir.y = 0; dir.normalize();
    target.copy(head).addScaledVector(dir, 1.1); target.y = head.y - 0.15;
    if (!placed) { panel.position.copy(target); placed = true; } else panel.position.lerp(target, 0.04);
    panel.lookAt(head.x, panel.position.y, head.z);
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
