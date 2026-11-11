import * as THREE from "three";
import { animate } from "animejs";
import type { JSAnimation } from "animejs";
import { artPaths, brushTexture, imageTexture, loadImage } from "./materials";
import { disposeObject, makeCanister, makeScroll, setUnroll } from "./objects";
import type { Canister, ScrollObject } from "./objects";

export type DeskPhase =
  | "overview"
  | "opening"
  | "scrolls"
  | "unrolling"
  | "editing"
  | "rolling";
export interface SceneSelection {
  channelId: string | null;
  promptId: string | null;
}
export interface SceneTarget {
  kind: "channel" | "prompt";
  id: string;
}
export interface ScreenPoint {
  x: number;
  y: number;
}
export interface ScreenRect extends ScreenPoint {
  width: number;
  height: number;
}
export interface SceneLayout {
  channels: Record<string, ScreenPoint>;
  prompts: Record<string, ScreenPoint>;
  editor: ScreenRect;
}
interface Callbacks {
  onPick: (kind: "channel" | "prompt", id: string) => void;
  onPhase: (phase: DeskPhase, selection: SceneSelection) => void;
  onHover: (target: SceneTarget | null) => void;
  onLayout: (layout: SceneLayout) => void;
  onFailure: () => void;
}

export class ImperialScene {
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(40, 1, 0.1, 80);
  private renderer: THREE.WebGLRenderer;
  private raycaster = new THREE.Raycaster();
  private canisters: Canister[] = [];
  private scrolls: {
    id: string;
    object: ScrollObject;
    target: THREE.Vector3;
  }[] = [];
  private expanded: ScrollObject;
  private textures = new Set<THREE.Texture>();
  private animations: JSAnimation[] = [];
  private generation = 0;
  private disposed = false;
  private frame = 0;
  private width = 1;
  private height = 1;
  private selection: SceneSelection = { channelId: null, promptId: null };
  private phase: DeskPhase = "overview";
  private hoverTarget: SceneTarget | null = null;
  private unroll = { value: 0 };
  private observer: ResizeObserver;
  private reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  private source: HTMLImageElement;
  private silkTexture: THREE.Texture;
  private brush: THREE.Texture;
  private background: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;

  static async create(
    host: HTMLElement,
    callbacks: Callbacks,
  ): Promise<ImperialScene> {
    const [chamber, source, silk] = await Promise.all([
      loadImage(artPaths.chamber),
      loadImage(artPaths.canisters),
      loadImage(artPaths.silk),
    ]);
    return new ImperialScene(host, callbacks, chamber, source, silk);
  }

  private constructor(
    private host: HTMLElement,
    private callbacks: Callbacks,
    chamber: HTMLImageElement,
    source: HTMLImageElement,
    silk: HTMLImageElement,
  ) {
    this.source = source;
    this.renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      powerPreference: "low-power",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.renderer.domElement.setAttribute("aria-hidden", "true");
    host.append(this.renderer.domElement);
    this.camera.position.set(0, 5.5, 12.5);
    this.camera.lookAt(0, 1.3, 0);
    this.scene.add(this.camera);
    const backdrop = imageTexture(chamber);
    this.silkTexture = imageTexture(silk);
    this.brush = brushTexture();
    for (const texture of [backdrop, this.silkTexture, this.brush])
      this.textures.add(texture);
    this.background = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: backdrop,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    this.background.position.z = -35;
    this.background.renderOrder = -1;
    this.camera.add(this.background);
    this.scene.add(new THREE.HemisphereLight("#fff3d9", "#394047", 2.2));
    const windowLight = new THREE.DirectionalLight("#fff0d4", 2.5);
    windowLight.position.set(-5, 9, 5);
    windowLight.castShadow = true;
    windowLight.shadow.mapSize.set(2048, 2048);
    Object.assign(windowLight.shadow.camera, {
      left: -10,
      right: 10,
      top: 8,
      bottom: -8,
    });
    windowLight.shadow.normalBias = 0.04;
    windowLight.shadow.bias = -0.0002;
    windowLight.shadow.radius = 4;
    this.scene.add(windowLight);
    const fill = new THREE.DirectionalLight("#a1b8c8", 1.1);
    fill.position.set(6, 4, -3);
    this.scene.add(fill);
    const deskTexture = imageTexture(source, [220, 685, 1160, 180]);
    deskTexture.wrapS = deskTexture.wrapT = THREE.RepeatWrapping;
    deskTexture.repeat.set(1, 1);
    this.textures.add(deskTexture);
    const desk = new THREE.Mesh(
      new THREE.BoxGeometry(25, 0.28, 10),
      new THREE.MeshStandardMaterial({
        map: deskTexture,
        color: "#8d8275",
        roughness: 0.82,
      }),
    );
    desk.position.set(0, -0.18, 4.8);
    desk.receiveShadow = true;
    this.scene.add(desk);
    this.expanded = makeScroll(this.silkTexture, 8, 4.5);
    this.expanded.group.visible = false;
    this.expanded.group.position.set(0, -0.1, -8);
    this.camera.add(this.expanded.group);
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(host);
    this.renderer.domElement.addEventListener("click", this.pick);
    this.renderer.domElement.addEventListener("pointermove", this.hover);
    this.renderer.domElement.addEventListener("pointerleave", this.leave);
    this.renderer.domElement.addEventListener(
      "webglcontextlost",
      this.contextLost,
    );
    this.reducedMotion.addEventListener("change", this.motionChanged);
    this.resize();
  }

  setItems(channels: { id: string; index: number }[], promptIds: string[]) {
    if (
      channels.map((item) => item.id).join("|") !==
      this.canisters.map((item) => item.id).join("|")
    ) {
      for (const canister of this.canisters) {
        const owned = new Set<THREE.Texture>();
        canister.group.traverse((child) => {
          if (
            child instanceof THREE.Mesh &&
            child.material instanceof THREE.MeshStandardMaterial &&
            child.material.map
          )
            owned.add(child.material.map);
        });
        for (const texture of owned) {
          texture.dispose();
          this.textures.delete(texture);
        }
        disposeObject(canister.group);
      }
      this.canisters = channels.map((channel, index) => {
        const canister = makeCanister(channel.id, channel.index, this.source);
        canister.group.position.set(
          (index - (channels.length - 1) / 2) * 1.9,
          0,
          0.3,
        );
        if (channel.id === this.selection.channelId) {
          canister.lid.position.y = 2.33;
          canister.lid.rotation.x = -1.15;
        }
        canister.group.traverse((child) => {
          if (
            child instanceof THREE.Mesh &&
            child.material instanceof THREE.MeshStandardMaterial &&
            child.material.map
          )
            this.textures.add(child.material.map);
        });
        this.scene.add(canister.group);
        return canister;
      });
    }
    if (promptIds.join("|") !== this.scrolls.map((item) => item.id).join("|")) {
      for (const scroll of this.scrolls) disposeObject(scroll.object.group);
      this.scrolls = promptIds.map((id, index) => {
        const object = makeScroll(this.silkTexture, 0.8, 1.35);
        object.silk.visible = false;
        object.left.visible = false;
        const barrel = new THREE.Mesh(
          new THREE.CylinderGeometry(0.13, 0.13, 1.12, 24),
          new THREE.MeshStandardMaterial({
            map: this.silkTexture,
            color: "#f1dfb5",
            roughness: 0.95,
          }),
        );
        barrel.position.x = 0.06;
        barrel.castShadow = true;
        object.group.add(barrel);
        object.group.userData = { kind: "prompt", id };
        object.group.visible = false;
        const target = this.scrollPosition(index, promptIds.length);
        this.scene.add(object.group);
        return { id, object, target };
      });
    }
    this.layout();
    this.render();
  }

  transition(selection: SceneSelection) {
    const previous = this.selection;
    const sameSelection =
      previous.channelId === selection.channelId &&
      previous.promptId === selection.promptId;
    if (
      sameSelection &&
      (this.phase === "editing" || this.phase === "unrolling")
    ) {
      this.layout();
      this.render();
      return;
    }
    this.setHoverTarget(null);
    this.selection = { ...selection };
    const generation = ++this.generation;
    this.cancelAnimations();
    const current = () => !this.disposed && generation === this.generation;
    const complete = (phase: DeskPhase) => {
      if (!current()) return;
      this.phase = phase;
      this.layout();
      this.callbacks.onPhase(phase, { ...selection });
      this.render();
    };
    for (const canister of this.canisters) {
      const selected = canister.id === selection.channelId;
      this.tween(
        canister.lid.position,
        { y: selected ? 2.33 : 2.17 },
        100,
        selected ? 0 : 150,
      );
      this.tween(
        canister.lid.rotation,
        { x: selected ? -1.15 : 0 },
        170,
        selected ? 80 : 0,
      );
    }
    const showScrolls = () => {
      if (!current()) return;
      this.expanded.group.visible = false;
      for (const item of this.scrolls) {
        item.object.group.visible = !!selection.channelId;
        item.object.group.position.copy(item.target);
        item.object.group.scale.setScalar(1);
        item.object.group.rotation.set(-0.5, 0, Math.PI / 2);
        setUnroll(item.object, 0.15);
      }
      complete(selection.channelId ? "scrolls" : "overview");
    };
    if (
      !selection.promptId &&
      previous.promptId &&
      this.expanded.group.visible
    ) {
      this.phase = "rolling";
      this.callbacks.onPhase("rolling", selection);
      this.tween(
        this.unroll,
        { value: 0 },
        380,
        0,
        () => {
          if (current()) setUnroll(this.expanded, this.unroll.value);
        },
        showScrolls,
      );
      return;
    }
    if (selection.promptId) {
      this.phase = "unrolling";
      this.callbacks.onPhase("unrolling", selection);
      const selected = this.scrolls.find(
        (item) => item.id === selection.promptId,
      );
      const start = selected?.object.group.visible
        ? selected.object.group.position.clone()
        : (selected?.target.clone() ?? new THREE.Vector3(0, 2.7, 0));
      const rolledHeight =
        (selected?.object.height ?? 1.35) *
        (selected?.object.group.visible ? selected.object.group.scale.y : 1);
      this.expanded.group.scale.setScalar(rolledHeight / this.expanded.height);
      this.camera.updateMatrixWorld();
      this.camera.worldToLocal(start);
      for (const item of this.scrolls) item.object.group.visible = false;
      this.expanded.group.visible = true;
      this.expanded.group.position.copy(start);
      this.expanded.group.rotation.set(0.15, -0.1, Math.PI / 2);
      this.unroll.value = 0;
      setUnroll(this.expanded, 0);
      this.tween(this.expanded.group.position, { x: 0, y: -0.1, z: -8 }, 260);
      this.tween(this.expanded.group.rotation, { x: 0, y: 0, z: 0 }, 260);
      this.tween(this.expanded.group.scale, { x: 1, y: 1, z: 1 }, 260);
      this.tween(
        this.unroll,
        { value: 1 },
        580,
        220,
        () => {
          if (current()) setUnroll(this.expanded, this.unroll.value);
        },
        () => complete("editing"),
      );
      return;
    }
    if (!selection.channelId) {
      this.expanded.group.visible = false;
      for (const item of this.scrolls) item.object.group.visible = false;
      complete("overview");
      return;
    }
    if (previous.channelId === selection.channelId && previous.promptId) {
      showScrolls();
      return;
    }
    this.phase = "opening";
    this.callbacks.onPhase("opening", selection);
    this.expanded.group.visible = false;
    const canister = this.canisters.find(
      (item) => item.id === selection.channelId,
    );
    const start =
      canister?.group.position.clone().add(new THREE.Vector3(0, 2.4, 0)) ??
      new THREE.Vector3(0, 2.4, 0);
    for (const [index, item] of this.scrolls.entries()) {
      const group = item.object.group;
      group.visible = true;
      group.position.copy(start);
      group.scale.setScalar(0.35);
      group.rotation.set(0, 0, 0.8);
      setUnroll(item.object, 0.15);
      const curve = new THREE.CatmullRomCurve3([
        start,
        start
          .clone()
          .add(new THREE.Vector3((item.target.x - start.x) * 0.35, 1.3, 0.6)),
        item.target.clone().add(new THREE.Vector3(0.25, 0.65, -0.8)),
        item.target,
      ]);
      const progress = { value: 0 };
      const trail = this.makeTrail(curve);
      const delay = 230 + index * 80;
      this.tween(
        progress,
        { value: 1 },
        650,
        delay,
        () => {
          if (!current()) return;
          group.position.copy(curve.getPoint(progress.value));
          group.scale.setScalar(0.35 + progress.value * 0.65);
          group.rotation.set(
            -0.5 * progress.value,
            Math.sin(progress.value * Math.PI) * 0.3,
            0.8 + (Math.PI / 2 - 0.8) * progress.value,
          );
          trail.material.opacity = Math.sin(progress.value * Math.PI) * 0.8;
          // Three radial faces contribute 18 indices per segment. Keep a short trailing stroke.
          const firstSegment = Math.floor(
            Math.max(0, progress.value - 0.35) * 96,
          );
          const lastSegment = Math.floor(progress.value * 96);
          trail.geometry.setDrawRange(
            firstSegment * 18,
            (lastSegment - firstSegment) * 18,
          );
        },
        () => {
          disposeObject(trail);
          if (index === this.scrolls.length - 1) complete("scrolls");
        },
      );
    }
    if (!this.scrolls.length) complete("scrolls");
  }

  private tween(
    target: object,
    properties: Record<string, number>,
    duration: number,
    delay = 0,
    update?: () => void,
    done?: () => void,
  ) {
    const animation = animate(target, {
      ...properties,
      duration: this.reducedMotion.matches ? 1 : duration,
      delay: this.reducedMotion.matches ? 0 : delay,
      ease: "inOutCubic",
      onUpdate: () => {
        update?.();
        this.render();
      },
      onComplete: () => {
        update?.();
        done?.();
        this.render();
      },
    });
    this.animations.push(animation);
  }

  private makeTrail(curve: THREE.CatmullRomCurve3) {
    const mesh = new THREE.Mesh(
      new THREE.TubeGeometry(curve, 96, 0.075, 3, false),
      new THREE.MeshBasicMaterial({
        map: this.brush,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    mesh.userData.trail = true;
    this.scene.add(mesh);
    return mesh;
  }

  private cancelAnimations() {
    for (const animation of this.animations) animation.cancel();
    this.animations = [];
    for (const child of [...this.scene.children])
      if (child.userData.trail) disposeObject(child);
  }

  private resize() {
    this.width = this.host.clientWidth;
    this.height = this.host.clientHeight;
    if (!this.width || !this.height) return;
    this.camera.aspect = this.width / this.height;
    // Keep the row inside the viewport on narrow screens. DOM reading width is independent.
    this.camera.fov =
      this.width < 700
        ? 52
        : THREE.MathUtils.clamp(
            THREE.MathUtils.radToDeg(
              2 * Math.atan(5.9 / (13 * this.camera.aspect)),
            ),
            27,
            45,
          );
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(this.width, this.height);
    for (const [index, item] of this.scrolls.entries()) {
      item.target.copy(this.scrollPosition(index, this.scrolls.length));
      if (this.phase === "scrolls")
        item.object.group.position.copy(item.target);
    }
    const viewHeight =
      2 * 8 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const width =
      viewHeight * this.camera.aspect * (this.width < 700 ? 0.97 : 0.92);
    const height = viewHeight * (this.width < 700 ? 0.77 : 0.79);
    this.expanded.width = width;
    this.expanded.height = height;
    // Rebuild at the actual reading aspect ratio. Texture UVs remain fixed through the reveal.
    this.expanded.silk.geometry.dispose();
    this.expanded.silk.geometry = new THREE.PlaneGeometry(
      width,
      height,
      64,
      10,
    );
    for (const rod of [this.expanded.left, this.expanded.right])
      rod.scale.y = height / 4.5;
    setUnroll(this.expanded, this.unroll.value);
    const backgroundHeight =
      2 * 35 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const backgroundWidth =
      backgroundHeight * Math.max(this.camera.aspect, 16 / 9);
    this.background.scale.set(backgroundWidth, backgroundWidth / (16 / 9), 1);
    this.layout();
    this.render();
  }

  private scrollPosition(index: number, count: number): THREE.Vector3 {
    this.camera.updateMatrixWorld();
    const x =
      count === 1
        ? 0
        : (index / (count - 1) - 0.5) * (this.width < 700 ? 0.9 : 1.25);
    const direction = new THREE.Vector3(x, -0.68, 0.5)
      .unproject(this.camera)
      .sub(this.camera.position)
      .normalize();
    return this.camera.position
      .clone()
      .addScaledVector(
        direction,
        (0.65 - this.camera.position.y) / direction.y,
      );
  }

  private project(point: THREE.Vector3): ScreenPoint {
    const projected = point.clone().project(this.camera);
    return {
      x: ((projected.x + 1) / 2) * this.width,
      y: ((1 - projected.y) / 2) * this.height,
    };
  }

  private layout() {
    this.scene.updateMatrixWorld(true);
    const channels = Object.fromEntries(
      this.canisters.map((canister) => [
        canister.id,
        this.project(canister.group.localToWorld(canister.anchor.clone())),
      ]),
    );
    const prompts = Object.fromEntries(
      this.scrolls.map((item) => [
        item.id,
        this.project(
          item.target.clone().add(new THREE.Vector3(0, -0.08, 0.05)),
        ),
      ]),
    );
    const group = this.expanded.group;
    const topLeft = this.project(
      group.localToWorld(
        new THREE.Vector3(
          -this.expanded.width / 2,
          this.expanded.height / 2,
          0,
        ),
      ),
    );
    const bottomRight = this.project(
      group.localToWorld(
        new THREE.Vector3(
          this.expanded.width / 2,
          -this.expanded.height / 2,
          0,
        ),
      ),
    );
    const width = bottomRight.x - topLeft.x;
    const height = bottomRight.y - topLeft.y;
    const margin = this.width < 700 ? 0.055 : 0.195;
    this.callbacks.onLayout({
      channels,
      prompts,
      editor: {
        x: topLeft.x + width * margin,
        y: topLeft.y + height * 0.065,
        width: width * (1 - margin * 2),
        height: height * 0.86,
      },
    });
  }

  private hit(event: MouseEvent) {
    const bounds = this.renderer.domElement.getBoundingClientRect();
    this.raycaster.setFromCamera(
      new THREE.Vector2(
        ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
        (-(event.clientY - bounds.top) / bounds.height) * 2 + 1,
      ),
      this.camera,
    );
    const objects = [
      ...this.canisters.map((item) => item.group),
      ...this.scrolls
        .filter((item) => item.object.group.visible)
        .map((item) => item.object.group),
    ];
    for (const hit of this.raycaster.intersectObjects(objects, true)) {
      let object: THREE.Object3D | null = hit.object;
      while (object && !object.userData.kind) object = object.parent;
      if (object?.userData.kind) return object.userData as SceneTarget;
    }
    return null;
  }

  private pick = (event: MouseEvent) => {
    if (
      this.phase === "editing" ||
      this.phase === "unrolling" ||
      this.phase === "rolling"
    )
      return;
    const hit = this.hit(event);
    if (hit) this.callbacks.onPick(hit.kind, hit.id);
  };
  private setHoverTarget(target: SceneTarget | null) {
    if (
      this.hoverTarget?.kind === target?.kind &&
      this.hoverTarget?.id === target?.id
    )
      return;
    this.hoverTarget = target;
    this.callbacks.onHover(target);
  }
  private hover = (event: MouseEvent) => {
    const hit =
      this.selection.promptId || this.phase === "rolling"
        ? null
        : this.hit(event);
    this.renderer.domElement.style.cursor = hit ? "pointer" : "default";
    this.setHoverTarget(hit);
  };
  private leave = () => {
    this.renderer.domElement.style.cursor = "default";
    this.setHoverTarget(null);
  };
  private contextLost = (event: Event) => {
    event.preventDefault();
    this.callbacks.onFailure();
  };
  private motionChanged = () => {
    if (
      this.reducedMotion.matches &&
      ["opening", "unrolling", "rolling"].includes(this.phase)
    ) {
      this.phase = "overview";
      this.transition(this.selection);
    }
  };
  private render() {
    if (this.disposed || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (!this.disposed) this.renderer.render(this.scene, this.camera);
    });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.cancelAnimations();
    cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    this.reducedMotion.removeEventListener("change", this.motionChanged);
    this.renderer.domElement.removeEventListener("click", this.pick);
    this.renderer.domElement.removeEventListener("pointermove", this.hover);
    this.renderer.domElement.removeEventListener("pointerleave", this.leave);
    this.renderer.domElement.removeEventListener(
      "webglcontextlost",
      this.contextLost,
    );
    disposeObject(this.scene);
    for (const texture of new Set(this.textures)) texture.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
