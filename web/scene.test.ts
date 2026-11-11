import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { ImperialScene } from "./scene/ImperialScene";
import type { DeskPhase, SceneSelection } from "./scene/ImperialScene";
import { disposeObject, makeScroll, setUnroll } from "./scene/objects";
import type { ScrollObject } from "./scene/objects";

test("展卷时木轴实际分离，绸面只显露原有 UV 区域", () => {
  const texture = new THREE.Texture();
  const scroll = makeScroll(texture, 8, 4.5);
  const initialUv = Array.from(scroll.silk.geometry.attributes.uv!.array);
  setUnroll(scroll, 0.5);
  assert.equal(scroll.left.position.x, -2);
  assert.equal(scroll.right.position.x, 2);
  const positions = scroll.silk.geometry.attributes.position!;
  for (let index = 0; index < positions.count; index++)
    assert.ok(Math.abs(positions.getX(index)) <= 2);
  assert.deepEqual(
    Array.from(scroll.silk.geometry.attributes.uv!.array),
    initialUv,
  );
  setUnroll(scroll, 1);
  assert.equal(scroll.left.position.x, -4);
  assert.equal(scroll.right.position.x, 4);
  for (let index = 0; index < positions.count; index++)
    assert.equal(positions.getZ(index), 0);
  disposeObject(scroll.group);
  texture.dispose();
});

function sceneWithDeferredAnimation() {
  const phases: { phase: DeskPhase; selection: SceneSelection }[] = [];
  const completions: (() => void)[] = [];
  let cancelled = 0;
  const scrolls: { id: string; object: ScrollObject; target: THREE.Vector3 }[] =
    [];
  const expanded = makeScroll(new THREE.Texture(), 8, 4.5);
  expanded.group.visible = false;
  // Exercise the real transition method without constructing a GPU renderer.
  // Cancelled completions are deliberately retained to reproduce late animation callbacks.
  const scene = Object.create(ImperialScene.prototype) as ImperialScene;
  Object.assign(scene, {
    selection: { channelId: null, promptId: null },
    generation: 0,
    disposed: false,
    canisters: [],
    scrolls,
    expanded,
    phase: "overview",
    unroll: { value: 0 },
    camera: new THREE.PerspectiveCamera(),
    callbacks: {
      onPhase: (phase: DeskPhase, selection: SceneSelection) =>
        phases.push({ phase, selection }),
    },
    cancelAnimations: () => {
      cancelled++;
    },
    layout: () => {},
    render: () => {},
    tween: (
      _target: object,
      _properties: object,
      _duration: number,
      _delay?: number,
      _update?: () => void,
      done?: () => void,
    ) => {
      if (done) completions.push(done);
    },
  });
  return {
    scene,
    phases,
    completions,
    expanded,
    scrolls,
    cancelled: () => cancelled,
  };
}

test("快速选择另一卷后，旧动画完成回调不能覆盖新选择", () => {
  const f = sceneWithDeferredAnimation();
  f.scene.transition({ channelId: "a", promptId: "a/one" });
  f.scene.transition({ channelId: "b", promptId: "b/two" });
  f.completions[0]!();
  assert.equal(
    f.phases.some((item) => item.phase === "editing"),
    false,
  );
  f.completions[1]!();
  assert.deepEqual(f.phases.at(-1), {
    phase: "editing",
    selection: { channelId: "b", promptId: "b/two" },
  });
  disposeObject(f.expanded.group);
});

test("后台目录更新时，相同的已展开条目保持编辑状态", () => {
  const f = sceneWithDeferredAnimation();
  const selected = { channelId: "a", promptId: "a/one" };
  f.scene.transition(selected);
  f.completions[0]!();
  const before = f.cancelled();
  f.scene.transition(selected);
  assert.equal(f.cancelled(), before);
  assert.deepEqual(f.phases.at(-1), { phase: "editing", selection: selected });
  disposeObject(f.expanded.group);
});

test("展卷期间返回全景，迟到的展卷回调保持失效", () => {
  const f = sceneWithDeferredAnimation();
  f.scene.transition({ channelId: "a", promptId: "a/one" });
  f.scene.transition({ channelId: null, promptId: null });
  f.completions[1]!();
  f.completions[0]!();
  assert.deepEqual(f.phases.at(-1), {
    phase: "overview",
    selection: { channelId: null, promptId: null },
  });
  assert.equal(f.expanded.group.visible, false);
  disposeObject(f.expanded.group);
});

test("飞卷途中直接展卷，收卷后恢复卷轴的正常尺寸", () => {
  const f = sceneWithDeferredAnimation();
  const object = makeScroll(new THREE.Texture(), 0.8, 1.35);
  object.group.scale.setScalar(0.4);
  f.scrolls.push({
    id: "a/one",
    object,
    target: new THREE.Vector3(1, 0.65, 4),
  });
  f.scene.transition({ channelId: "a", promptId: "a/one" });
  f.completions[0]!();
  f.scene.transition({ channelId: "a", promptId: null });
  f.completions[1]!();
  assert.deepEqual(object.group.scale.toArray(), [1, 1, 1]);
  assert.deepEqual(object.group.position.toArray(), [1, 0.65, 4]);
  assert.equal(object.group.visible, true);
  disposeObject(object.group);
  disposeObject(f.expanded.group);
});

test("从飞卷当前位置与尺寸连续进入展卷", () => {
  const f = sceneWithDeferredAnimation();
  const object = makeScroll(new THREE.Texture(), 0.8, 1.35);
  object.group.position.set(1, 2, 3);
  object.group.scale.setScalar(0.4);
  f.scrolls.push({
    id: "a/one",
    object,
    target: new THREE.Vector3(3, 0.65, 4),
  });
  f.scene.transition({ channelId: "a", promptId: "a/one" });
  assert.deepEqual(f.expanded.group.position.toArray(), [1, 2, 3]);
  assert.ok(
    Math.abs(f.expanded.group.scale.y * f.expanded.height - 1.35 * 0.4) <
      0.000001,
  );
  disposeObject(object.group);
  disposeObject(f.expanded.group);
});
