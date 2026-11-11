import * as THREE from "three";
import { bronze, imageTexture, wood } from "./materials";

export interface Canister {
  group: THREE.Group;
  lid: THREE.Group;
  anchor: THREE.Vector3;
  id: string;
}

function lathe(
  profile: [number, number][],
  material: THREE.Material,
  segments = 8,
): THREE.Mesh {
  const geometry = new THREE.LatheGeometry(
    profile.map(([radius, y]) => new THREE.Vector2(radius, y)),
    segments,
  );
  // Lathe's default V follows profile indices, which squeezes art into the shoulder rings.
  const positions = geometry.attributes.position!;
  const uv = geometry.attributes.uv!;
  const minimum = Math.min(...profile.map((point) => point[1]));
  const maximum = Math.max(...profile.map((point) => point[1]));
  for (let index = 0; index < positions.count; index++)
    uv.setY(
      index,
      (positions.getY(index) - minimum) / Math.max(0.001, maximum - minimum),
    );
  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.y = Math.PI / 8;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function band(radius: number, y: number, material: THREE.Material) {
  return lathe(
    [
      [radius - 0.02, y - 0.018],
      [radius, y - 0.018],
      [radius, y + 0.018],
      [radius - 0.02, y + 0.018],
    ],
    material,
  );
}

export function makeCanister(
  id: string,
  index: number,
  source: HTMLImageElement,
): Canister {
  const group = new THREE.Group();
  group.userData = { kind: "channel", id };
  group.scale.set(1.25, 1, 1.25);
  const sourceCenters = [335, 588, 840, 1091, 1342];
  const variant = index % 5;
  const texture = imageTexture(source, [
    sourceCenters[variant]! - 65,
    407,
    130,
    180,
  ]);
  texture.wrapS = THREE.RepeatWrapping;
  texture.repeat.x = 8;
  const lacquer = new THREE.MeshStandardMaterial({
    map: texture,
    roughness: 0.7,
    metalness: 0.13,
  });
  const lidTexture = imageTexture(source, [
    sourceCenters[variant]! - 25,
    341,
    50,
    38,
  ]);
  lidTexture.wrapS = THREE.RepeatWrapping;
  lidTexture.repeat.x = 8;
  const solid = new THREE.MeshStandardMaterial({
    map: lidTexture,
    color: "#c7b9a4",
    roughness: 0.82,
    metalness: 0.1,
  });
  const copper = bronze();
  const interior = new THREE.MeshStandardMaterial({
    color: "#1e1915",
    side: THREE.DoubleSide,
    roughness: 0.95,
  });
  group.add(
    lathe(
      [
        [0.48, 0.16],
        [0.59, 0.24],
        [0.57, 0.37],
        [0.53, 0.47],
        [0.53, 1.94],
        [0.55, 2.05],
        [0.53, 2.14],
      ],
      lacquer,
    ),
  );
  group.add(
    lathe(
      [
        [0, 0],
        [0.65, 0],
        [0.65, 0.12],
        [0.61, 0.2],
        [0.61, 0.29],
        [0.56, 0.34],
      ],
      solid,
    ),
  );
  group.add(
    lathe(
      [
        [0.49, 1.42],
        [0.49, 2.14],
        [0.53, 2.14],
      ],
      interior,
    ),
  );
  for (const y of [0.11, 0.29, 2.13])
    group.add(band(y > 2 ? 0.55 : 0.635, y, copper));
  const lid = new THREE.Group();
  // The hinge is at the rear rim, so rotation clears the mouth physically.
  lid.position.set(0, 2.17, -0.49);
  const shell = lathe(
    [
      [0, 0],
      [0.56, 0],
      [0.58, 0.16],
      [0.55, 0.27],
      [0.32, 0.46 + variant * 0.008],
      [0.26, 0.51],
      [0.3, 0.54],
      [0.3, 0.59],
      [0, 0.62],
    ],
    solid,
  );
  shell.position.z = 0.49;
  lid.add(shell);
  const lidBand = band(0.565, 0.025, copper);
  lidBand.position.z = 0.49;
  lid.add(lidBand);
  const clasp = new THREE.Mesh(
    new THREE.BoxGeometry(0.17, 0.23, 0.055),
    copper,
  );
  clasp.position.set(0, 2.09, 0.505);
  const rivet = new THREE.Mesh(new THREE.SphereGeometry(0.028, 10, 8), copper);
  rivet.position.set(0, 2.07, 0.55);
  group.add(clasp, rivet, lid);
  return { group, lid, anchor: new THREE.Vector3(0, -0.12, 0.65), id };
}

export interface ScrollObject {
  group: THREE.Group;
  silk: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
  left: THREE.Group;
  right: THREE.Group;
  width: number;
  height: number;
}

export function makeScroll(
  texture: THREE.Texture,
  width: number,
  height: number,
): ScrollObject {
  const group = new THREE.Group();
  const silk = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height, 64, 10),
    new THREE.MeshStandardMaterial({
      map: texture,
      side: THREE.DoubleSide,
      roughness: 0.98,
    }),
  );
  silk.castShadow = true;
  silk.receiveShadow = true;
  const left = new THREE.Group();
  const right = new THREE.Group();
  const copper = bronze();
  const timber = wood();
  for (const rod of [left, right]) {
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(0.075, 0.075, height + 0.2, 20),
      timber,
    );
    shaft.castShadow = true;
    rod.add(shaft);
    for (const sign of [-1, 1]) {
      const collar = new THREE.Mesh(
        new THREE.CylinderGeometry(0.097, 0.097, 0.12, 20),
        copper,
      );
      collar.position.y = sign * (height / 2 + 0.06);
      const knob = new THREE.Mesh(
        new THREE.SphereGeometry(0.085, 16, 12),
        timber,
      );
      knob.position.y = sign * (height / 2 + 0.16);
      knob.scale.y = 0.65;
      rod.add(collar, knob);
    }
  }
  group.add(silk, left, right);
  setUnroll({ group, silk, left, right, width, height }, 0);
  return { group, silk, left, right, width, height };
}

export function setUnroll(scroll: ScrollObject, progress: number) {
  const half = Math.max(0.045, (scroll.width / 2) * progress);
  scroll.left.position.x = -half;
  scroll.right.position.x = half;
  const positions = scroll.silk.geometry.attributes.position!;
  const uv = scroll.silk.geometry.attributes.uv!;
  for (let index = 0; index < positions.count; index++) {
    const originalX = (uv.getX(index) - 0.5) * scroll.width;
    const x = THREE.MathUtils.clamp(originalX, -half, half);
    const curl = Math.max(0, Math.abs(x) - half + 0.14);
    positions.setX(index, x);
    positions.setZ(
      index,
      Math.sin(((curl / 0.14) * Math.PI) / 2) * 0.06 * (1 - progress),
    );
  }
  positions.needsUpdate = true;
  scroll.silk.geometry.computeVertexNormals();
  scroll.silk.geometry.computeBoundingSphere();
}

export function disposeObject(object: THREE.Object3D) {
  object.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose();
      for (const material of Array.isArray(child.material)
        ? child.material
        : [child.material])
        material.dispose();
    }
  });
  object.removeFromParent();
}
