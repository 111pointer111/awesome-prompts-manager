import * as THREE from "three";

export const artPaths = {
  chamber: "/art/chamber.webp",
  canisters: "/art/canisters-source.webp",
  silk: "/art/silk.webp",
};

export async function loadImage(url: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = url;
  await image.decode();
  return image;
}

/** Sample source artwork into UV textures. Picking and motion remain independent geometry. */
export function imageTexture(
  image: HTMLImageElement,
  crop?: [number, number, number, number],
): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = crop ? Math.min(1024, crop[2]) : image.width;
  canvas.height = crop
    ? Math.max(1, Math.round((canvas.width * crop[3]) / crop[2]))
    : image.height;
  const context = canvas.getContext("2d")!;
  const [x, y, width, height] = crop ?? [0, 0, image.width, image.height];
  context.drawImage(
    image,
    x,
    y,
    width,
    height,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

export function brushTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const context = canvas.getContext("2d")!;
  const pigment = context.createLinearGradient(0, 0, 256, 0);
  pigment.addColorStop(0, "rgba(169,140,83,0.5)");
  pigment.addColorStop(0.65, "rgba(205,178,112,0.6)");
  pigment.addColorStop(0.9, "rgba(79,93,84,0.2)");
  pigment.addColorStop(1, "rgba(79,93,84,0)");
  // Deterministic broken bristles keep the transient trail sparse and reproducible.
  for (let index = 0; index < 40; index++) {
    const y = 12 + ((index * 17) % 42);
    context.strokeStyle = pigment;
    context.globalAlpha = 0.4 + (index % 5) * 0.15;
    context.lineWidth = 0.4 + (index % 3) * 0.4;
    context.beginPath();
    context.moveTo((index * 13) % 60, y);
    context.bezierCurveTo(80, y - 5, 160, y + 3, 256 - ((index * 7) % 90), y);
    context.stroke();
  }
  return new THREE.CanvasTexture(canvas);
}

export const bronze = () =>
  new THREE.MeshStandardMaterial({
    color: "#887552",
    roughness: 0.65,
    metalness: 0.65,
  });
export const wood = () =>
  new THREE.MeshStandardMaterial({
    color: "#30251f",
    roughness: 0.6,
    metalness: 0.08,
  });
