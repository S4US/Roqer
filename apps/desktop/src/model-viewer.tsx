import { useEffect, useRef, useState } from "react";
import {
  Clock, Layers, Loader2, MonitorOff, Pause, Play, Rotate3d, RotateCcw, RotateCw, Ruler, Triangle, TriangleAlert,
} from "lucide-react";
import { ANIMATION_PREVIEW_TITLE, type RunEvidence } from "../shared/run-events";
import { MODEL_OBJECTS_LABEL, MODEL_SIZE_LABEL, MODEL_TRIANGLES_LABEL } from "../shared/model-preview";
import { hasDesktopRuntime, loadModelPreview } from "./platform";
import { EvidencePicture } from "./evidence-picture";

type Status = "loading" | "ready" | "expired" | "failed" | "no-desktop" | "no-webgl";

type Controls = {
  reset(): void;
  turn(steps: number): void;
  /** Present when the model carries an animation. */
  playback?: { play(): void; pause(): void; seek(seconds: number): void };
};

/** What the view knows about the model's animation, for the playback bar. */
type Playback = { duration: number; time: number; playing: boolean };

/** How often the playback bar follows the animation; the 3D view itself draws every frame. */
const PLAYBACK_REPORT_MS = 66;

/** Whether this window can draw 3D at all; the context made to find out is released at once. */
function webglAvailable(): boolean {
  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    context?.getExtension("WEBGL_lose_context")?.loseContext();
    return context !== null;
  } catch {
    return false;
  }
}

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

const fact = (evidence: RunEvidence, label: string) =>
  evidence.metadata?.find((entry) => entry.label === label)?.value;

const AXES = ["x", "y", "z"] as const;

/**
 * A Blender result or an animation in 3D: a GLB Roqer made (its own inspection
 * of a Blender model, or the animation tool's box rig), which the main process
 * hands over by the evidence's id. A GLB that carries an animation plays it,
 * looping, with play/pause and a scrub bar. Opened in the viewer, where the
 * reader asked for it, it plays at once; elsewhere it waits under reduced
 * motion.
 *
 * `compact` is the answer's inline player: no orbit or zoom, so the chat still
 * scrolls under the pointer, and nothing over the model but the playback bar.
 *
 * The model stands on a floor on Roblox's axes, facing the way it will in
 * Studio, and can be orbited, zoomed and panned. three.js loads only when a
 * model is opened, and only one view exists at a time: the viewer mounts it for
 * the picture on screen, and it hands its WebGL context back when it closes or
 * moves on. A preview that has expired, or a window that cannot draw 3D, shows
 * the still picture instead and says why.
 */
export function ModelViewer({ evidence, onShowPicture, compact = false, autoplay }: {
  evidence: RunEvidence;
  onShowPicture: () => void;
  compact?: boolean;
  /** Whether an animation starts playing; by default, unless the reader asks for less motion. */
  autoplay?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const gizmo = useRef<SVGSVGElement>(null);
  const controls = useRef<Controls | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [moved, setMoved] = useState(false);
  const [playback, setPlayback] = useState<Playback | null>(null);
  const id = evidence.modelPreviewId;

  useEffect(() => {
    let disposed = false;
    let release = () => undefined as void;
    setStatus("loading");
    setMoved(false);
    setPlayback(null);
    void (async () => {
      const container = host.current;
      if (id === undefined || container === null) {
        setStatus("failed");
        return;
      }
      if (!hasDesktopRuntime()) {
        setStatus("no-desktop");
        return;
      }
      if (!webglAvailable()) {
        setStatus("no-webgl");
        return;
      }
      const result = await loadModelPreview(id);
      if (disposed) return;
      if (!result.ok) {
        setStatus(result.reason === "expired" ? "expired" : "failed");
        return;
      }
      const [THREE, { GLTFLoader }, { OrbitControls }, { RoomEnvironment }] = await Promise.all([
        import("three"),
        import("three/examples/jsm/loaders/GLTFLoader.js"),
        import("three/examples/jsm/controls/OrbitControls.js"),
        import("three/examples/jsm/environments/RoomEnvironment.js"),
      ]);
      if (disposed) return;

      // Nothing the file names may be fetched: the main process already refused
      // any file that points outside itself, and this is the second line.
      const manager = new THREE.LoadingManager();
      manager.setURLModifier((url) => (url.startsWith("data:") || url.startsWith("blob:") ? url : "data:,"));
      const bytes = result.bytes;
      const gltf = await new GLTFLoader(manager).parseAsync(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        "",
      );
      if (disposed) return;

      const model = gltf.scene;
      // glTF is Y-up with Blender's -Y as +Z; Studio puts Blender (x, y, z) at
      // (-x, z, y). Half a turn about Y takes one to the other, so the scene's
      // axes are Roblox's and the model faces the way it will in Studio.
      model.rotation.y = Math.PI;
      model.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(model);
      if (box.isEmpty()) throw new Error("The preview has nothing to show.");
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      model.position.set(-center.x, -box.min.y, -center.z);
      model.traverse((object) => {
        if ((object as { isMesh?: boolean }).isMesh) {
          object.castShadow = true;
          object.receiveShadow = true;
        }
      });

      const width = Math.max(container.clientWidth, 1);
      const height = Math.max(container.clientHeight, 1);
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(width, height);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      // No tone mapping, so a face turned to the light shows its colour as
      // painted. Neutral tone mapping would take a fixed share off every
      // colour and turn dark ones black under this dim room.
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFShadowMap;
      container.appendChild(renderer.domElement);
      // Until the view is complete, a failure still hands the context back.
      release = () => {
        renderer.dispose();
        renderer.forceContextLoss();
        renderer.domElement.remove();
      };

      const scene = new THREE.Scene();
      scene.add(model);
      // A dim room to reflect, so metal is not black. The light comes from the
      // sky and the sun instead: a brighter room would lay a grey sheen over
      // every colour.
      const environments = new THREE.PMREMGenerator(renderer);
      const room = new RoomEnvironment();
      const environment = environments.fromScene(room, 0.04).texture;
      room.dispose();
      environments.dispose();
      scene.environment = environment;
      scene.environmentIntensity = 0.12;
      scene.add(new THREE.HemisphereLight(0xffffff, 0x999999, 1.8));

      const radius = Math.max(size.length() / 2, 0.05);
      // One stud a square, as far as the model reaches and a little beyond.
      const span = Math.max(4, Math.ceil(Math.max(size.x, size.z) * 1.6));
      const grid = new THREE.GridHelper(span, Math.min(span, 200), 0x4a505d, 0x2a2e37);
      scene.add(grid);
      // The shadow's floor reaches past the grid, so a tall model's shadow is not cut short.
      const floorSpan = Math.max(span, radius * 6);
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(floorSpan, floorSpan), new THREE.ShadowMaterial({ opacity: 0.4 }));
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = 0.001;
      floor.receiveShadow = true;
      scene.add(floor);

      // The key light low over the model's front right, so the shadow falls
      // behind it and the front the first view sees shows its colours as
      // painted, the top a little brighter and the far side in shade.
      const sun = new THREE.DirectionalLight(0xffffff, 3.2);
      sun.position.set(radius * 0.8, radius * 1.6, radius * -1.9);
      sun.castShadow = true;
      sun.shadow.mapSize.set(1024, 1024);
      const reach = radius * 2;
      Object.assign(sun.shadow.camera, { left: -reach, right: reach, top: reach, bottom: -reach, near: 0.01, far: radius * 8 });
      sun.shadow.camera.updateProjectionMatrix();
      sun.shadow.bias = -0.0005;
      sun.shadow.radius = 4;
      scene.add(sun);

      // Roblox's forward is -Z, so the first view is of the front, from the
      // same corner as the still picture's three-quarter view.
      const camera = new THREE.PerspectiveCamera(35, width / height, radius / 100, radius * 60);
      const target = new THREE.Vector3(0, size.y / 2, 0);
      const distance = (radius / Math.sin(THREE.MathUtils.degToRad(35 / 2))) * 1.08;
      const home = new THREE.Vector3(-1.1, 0.62, -1.45).normalize().multiplyScalar(distance).add(target);
      camera.position.copy(home);
      scene.fog = new THREE.Fog(0x0f1115, distance * 1.4, distance * 3.2);

      const orbit = new OrbitControls(camera, renderer.domElement);
      orbit.target.copy(target);
      orbit.enableDamping = true;
      orbit.minDistance = radius * 0.4;
      orbit.maxDistance = distance * 4;
      // Never under the floor: a model seen from below is a model not being checked.
      orbit.maxPolarAngle = Math.PI * 0.495;
      // Inline, a drag or a wheel belongs to the chat, not the camera.
      orbit.enabled = !compact;
      orbit.update();

      let dirty = true;
      let frame = 0;

      // The model's own animation, if it has one: sampled by the mixer each
      // frame while it plays, and reported to the playback bar a few times a
      // second.
      const clip = gltf.animations[0];
      const mixer = clip !== undefined && clip.duration > 0 ? new THREE.AnimationMixer(model) : undefined;
      if (mixer !== undefined && clip !== undefined) mixer.clipAction(clip).setLoop(THREE.LoopRepeat, Infinity).play();
      let playing = mixer !== undefined && (autoplay ?? !reducedMotion());
      let clock = performance.now();
      let reported = 0;
      const report = (force = false) => {
        if (mixer === undefined || clip === undefined) return;
        const now = performance.now();
        if (!force && now - reported < PLAYBACK_REPORT_MS) return;
        reported = now;
        setPlayback({ duration: clip.duration, time: mixer.time % clip.duration, playing });
      };
      if (mixer !== undefined) {
        mixer.setTime(0);
        report(true);
      }

      // Where each of the scene's axes points on screen, redrawn with the view.
      const inverse = new THREE.Quaternion();
      const axis = new THREE.Vector3();
      const drawGizmo = () => {
        const svg = gizmo.current;
        if (svg === null) return;
        inverse.copy(camera.quaternion).invert();
        for (const [index, name] of AXES.entries()) {
          axis.set(index === 0 ? 1 : 0, index === 1 ? 1 : 0, index === 2 ? 1 : 0).applyQuaternion(inverse);
          const group = svg.querySelector(`[data-axis="${name}"]`);
          group?.querySelector("line")?.setAttribute("x2", (24 + axis.x * 15).toFixed(1));
          group?.querySelector("line")?.setAttribute("y2", (24 - axis.y * 15).toFixed(1));
          group?.querySelector("text")?.setAttribute("x", (24 + axis.x * 20).toFixed(1));
          group?.querySelector("text")?.setAttribute("y", (24 - axis.y * 20 + 3).toFixed(1));
          // An axis pointing away from the viewer is drawn fainter.
          group?.setAttribute("opacity", axis.z < -0.2 ? "0.5" : "1");
        }
        svg.dataset.drawn = "true";
      };

      // A turn or a reset glides there, unless the reader asks for less motion.
      let glide: ((now: number) => boolean) | undefined;
      const glideTo = (step: (progress: number) => void) => {
        if (reducedMotion()) {
          step(1);
          orbit.update();
          dirty = true;
          return;
        }
        const start = performance.now();
        glide = (now) => {
          const progress = Math.min((now - start) / 320, 1);
          step(1 - (1 - progress) ** 3);
          return progress < 1;
        };
      };

      const tick = (now: number) => {
        frame = requestAnimationFrame(tick);
        const delta = Math.min((now - clock) / 1000, 0.1);
        clock = now;
        if (mixer !== undefined && playing) {
          mixer.update(delta);
          dirty = true;
          report();
        }
        if (glide !== undefined && !glide(now)) glide = undefined;
        // The gizmo mounts with the ready state, a frame or so after the first render.
        const unmarked = gizmo.current !== null && gizmo.current.dataset.drawn === undefined;
        if (orbit.update() || dirty || glide !== undefined || unmarked) {
          renderer.render(scene, camera);
          drawGizmo();
          dirty = false;
        }
      };
      frame = requestAnimationFrame(tick);
      // A wheel, key or pinch zoom moves the camera inside its own event
      // handler, so the next orbit.update() in the loop reports no change.
      // Every move says so here, whoever made it.
      const redraw = () => { dirty = true; };
      orbit.addEventListener("change", redraw);
      const markMoved = () => setMoved(true);
      renderer.domElement.addEventListener("pointerdown", markMoved);
      renderer.domElement.addEventListener("wheel", markMoved, { passive: true });

      const observer = new ResizeObserver(() => {
        const nextWidth = Math.max(container.clientWidth, 1);
        const nextHeight = Math.max(container.clientHeight, 1);
        renderer.setSize(nextWidth, nextHeight);
        camera.aspect = nextWidth / nextHeight;
        camera.updateProjectionMatrix();
        dirty = true;
      });
      observer.observe(container);

      const up = new THREE.Vector3(0, 1, 0);
      controls.current = {
        reset: () => {
          const fromPosition = camera.position.clone();
          const fromTarget = orbit.target.clone();
          glideTo((progress) => {
            camera.position.lerpVectors(fromPosition, home, progress);
            orbit.target.lerpVectors(fromTarget, target, progress);
          });
        },
        // The view goes round the other way, so a turn to the right swings
        // the model's front to the reader's right.
        turn: (steps) => {
          const pivot = orbit.target.clone();
          const offset = camera.position.clone().sub(pivot);
          glideTo((progress) => {
            camera.position.copy(pivot).add(offset.clone().applyAxisAngle(up, (-steps * progress * Math.PI) / 4));
          });
          setMoved(true);
        },
        ...(mixer !== undefined && clip !== undefined ? {
          playback: {
            play: () => {
              playing = true;
              clock = performance.now();
              report(true);
            },
            pause: () => {
              playing = false;
              report(true);
            },
            seek: (seconds: number) => {
              mixer.setTime(Math.min(Math.max(seconds, 0), clip.duration));
              dirty = true;
              report(true);
            },
          },
        } : {}),
      };

      release = () => {
        cancelAnimationFrame(frame);
        observer.disconnect();
        orbit.removeEventListener("change", redraw);
        orbit.dispose();
        renderer.domElement.removeEventListener("pointerdown", markMoved);
        renderer.domElement.removeEventListener("wheel", markMoved);
        scene.traverse((object) => {
          const mesh = object as { geometry?: { dispose(): void }; material?: unknown };
          mesh.geometry?.dispose();
          const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
          for (const material of materials as Array<Record<string, unknown> & { dispose(): void }>) {
            for (const value of Object.values(material)) {
              if ((value as { isTexture?: boolean } | null)?.isTexture) (value as { dispose(): void }).dispose();
            }
            material.dispose();
          }
        });
        environment.dispose();
        mixer?.stopAllAction();
        if (mixer !== undefined) mixer.uncacheRoot(model);
        renderer.dispose();
        // Hand the context back now, not whenever the collector gets to it:
        // Chromium allows only a handful at once.
        renderer.forceContextLoss();
        renderer.domElement.remove();
        controls.current = null;
      };
      setStatus("ready");
    })().catch(() => {
      release();
      release = () => undefined;
      if (!disposed) setStatus("failed");
    });
    return () => {
      disposed = true;
      release();
    };
  }, [id, compact, autoplay]);

  const size = fact(evidence, MODEL_SIZE_LABEL);
  const triangles = fact(evidence, MODEL_TRIANGLES_LABEL);
  const objects = fact(evidence, MODEL_OBJECTS_LABEL);
  const animation = evidence.title === ANIMATION_PREVIEW_TITLE;
  const notice = status === "expired"
    ? {
      icon: <Clock size={17} />,
      title: "3D preview expired",
      detail: animation
        ? "3D previews are cleared after 7 days, or once 40 newer ones exist. The contact sheet stays with the chat."
        : "Blender job files are cleared after 7 days, or once 40 newer jobs exist. The still picture stays with the chat.",
    }
    : status === "failed"
      ? {
        icon: <TriangleAlert size={17} />,
        title: "The 3D preview could not be shown",
        detail: animation
          ? "The contact sheet shows the same motion, frame by frame."
          : "The still picture shows the same model from four sides.",
      }
      : undefined;
  const note = status === "no-desktop"
    ? "The 3D view needs the desktop app, so this is the still picture."
    : status === "no-webgl"
      ? "3D is off on this device, so this is the still picture."
      : undefined;

  const bar = playback && <div className="model-viewer-playback">
    <button
      type="button"
      onClick={() => (playback.playing ? controls.current?.playback?.pause() : controls.current?.playback?.play())}
      aria-label={playback.playing ? "Pause the animation" : "Play the animation"}
    >
      {playback.playing ? <Pause size={15} /> : <Play size={15} />}
    </button>
    <input
      type="range"
      min={0}
      max={playback.duration}
      step={0.01}
      value={playback.time}
      aria-label="Animation time"
      aria-valuetext={`${playback.time.toFixed(2)} of ${playback.duration.toFixed(2)} seconds`}
      onChange={(event) => controls.current?.playback?.seek(Number(event.currentTarget.value))}
    />
    <span className="model-viewer-time">{playback.time.toFixed(2)} / {playback.duration.toFixed(2)} s</span>
  </div>;

  if (compact) {
    return <div className="model-viewer" data-status={status} data-compact="true">
      <div
        className="model-viewer-canvas"
        ref={host}
        {...(status === "ready" ? { role: "img", "aria-label": `${evidence.title}, playing in 3D` } : {})}
      />
      {status !== "ready" && <EvidencePicture className="model-viewer-still" evidence={evidence} alt={evidence.title} />}
      {status === "ready" && bar}
    </div>;
  }

  return <div className="model-viewer" data-status={status}>
    <div
      className="model-viewer-canvas"
      ref={host}
      {...(status === "ready" ? { role: "img", "aria-label": `${evidence.title}, in 3D` } : {})}
    />
    {status !== "loading" && status !== "ready" && <EvidencePicture className="model-viewer-still" evidence={evidence} alt={evidence.title} />}
    {status === "loading" && <div className="model-viewer-state" role="status">
      <Loader2 className="model-viewer-spinner" size={22} aria-hidden="true" />
      <span>Loading the 3D preview</span>
      <span className="model-viewer-progress" aria-hidden="true"><span /></span>
    </div>}
    {notice && <div className="model-viewer-state" role="status">
      <div className="model-viewer-notice">
        <span className="model-viewer-state-icon" aria-hidden="true">{notice.icon}</span>
        <strong>{notice.title}</strong>
        <span className="model-viewer-detail">{notice.detail}</span>
        <button type="button" onClick={onShowPicture}>Show the picture</button>
      </div>
    </div>}
    {note && <div className="model-viewer-note" role="status"><MonitorOff size={14} aria-hidden="true" /><span>{note}</span></div>}
    {status === "ready" && <>
      {!moved && <span className="model-viewer-hint" aria-hidden="true"><Rotate3d size={14} />Drag to orbit · scroll to zoom · right-drag to pan</span>}
      <div className="model-viewer-facts">
        {size && <span><Ruler size={13} aria-hidden="true" />{size}</span>}
        {triangles && <span><Triangle size={13} aria-hidden="true" />{triangles} triangles</span>}
        {objects && <span><Layers size={13} aria-hidden="true" />{objects === "1" ? "1 object" : `${objects} objects`}</span>}
      </div>
      {bar}
      <div className="model-viewer-actions">
        <button type="button" onClick={() => controls.current?.turn(-1)} aria-label="Turn the model left"><RotateCcw size={15} /></button>
        <button type="button" onClick={() => controls.current?.turn(1)} aria-label="Turn the model right"><RotateCw size={15} /></button>
        <button type="button" className="model-viewer-reset" onClick={() => controls.current?.reset()}>Reset view</button>
        <svg className="model-viewer-gizmo" viewBox="0 0 48 48" ref={gizmo} aria-hidden="true">
          {AXES.map((name) => <g key={name} data-axis={name}>
            <line x1="24" y1="24" x2="24" y2="24" />
            <text x="24" y="24">{name.toUpperCase()}</text>
          </g>)}
          <circle cx="24" cy="24" r="2.5" />
        </svg>
      </div>
    </>}
  </div>;
}
