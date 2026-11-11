# 水墨御案界面

管理员登录后可以点击渠道圣旨筒取卷，再点击卷轴展开现有提示词编辑器。正文与备注分别保存，正文版本与回读确认继续由既有平台 API 处理。关闭卷轴、切换渠道与搜索跳转会保留本次页面会话里的未保存输入，刷新或退出页面会提示草稿尚未保存。

## 场景与业务协作

- `web/App.tsx` 管理登录、定期同步、手动同步、平台目录、按渠道与提示词 ID 隔离的草稿及保存合并。
- `web/ImperialDesk.tsx` 管理渠道分页、卷轴分页、跨渠道搜索、配置入口、键盘焦点与场景阶段。同步只更新名称、数量、版本和连接状态，已展开的编辑器保持挂载。
- `web/scene/ImperialScene.ts` 管理相机、窗光、桌面、拾取、动画取消、飞行曲线和卷面投影。每次选择都有独立的动画序号，迟到的旧回调会失效。窗口缩放后重新计算卷面留白与 DOM 编辑区的位置。
- `web/scene/objects.ts` 使用参数化几何体生成八棱筒身、独立筒盖、木轴与绸面。盖子的枢轴位于后沿。展卷时木轴左右移动，绸面的几何范围逐步显露，纹理 UV 保持原位。
- `web/Editor.tsx` 沿用现有正文与备注表单、默认值、变量与组合关系、冲突比较和恢复默认流程。只有正文保存接口返回业务回读确认结果，且编辑器仍显示该版本时，才显示朱印。

远景使用水墨环境贴图，近景桌面、筒、盖、卷轴、木轴与绸面均有独立几何体。模型由代码生成，可直接调整尺寸、材质与开合位置。

## 操作与回退

桌面端每批展示五个渠道、四条提示词。小于 700px 的视口每批展示三个渠道、两条提示词，可翻页浏览完整目录。寻卷弹层每页展示二十条搜索结果，可以直接打开任意匹配条目。

- Tab 在渠道、卷轴和工具入口之间移动，方向键在相邻名牌之间移动，Enter 展开。
- Esc 先收卷，再返回全景。弹层打开时由弹层处理 Esc。
- `⌘ K` 或 `Ctrl K` 打开跨渠道搜索。
- 系统开启减少动效时，状态转换立即完成。
- 场景初始化失败或 WebGL 上下文丢失时，渠道、搜索、配置、目录和编辑表单继续通过 DOM 操作。

## 卷面文字与表单

卷面正文、标题、备注和操作文字使用加粗霞鹜文楷，正文为 18px。正文与备注直接写在绸面上，输入区保持透明，用光标与标签颜色反馈编辑焦点。配置与搜索弹层采用大圆角纸面，输入项使用下划线，场景入口采用透明文字按钮。

字体由 `lxgw-wenkai-webfont` 的加粗字重提供，随构建在本站按字符分片加载。更换字体时调整 `web/main.tsx` 的字体样式导入及 `web/styles.css` 中的 `LXGW WenKai` 字体声明。字体授权为 SIL Open Font License 1.1，随页面保留[授权文本](../web/public/fonts/OFL.txt)。[字体来源](https://github.com/lxgw/LxgwWenKai)、[网页字体包](https://github.com/chawyehsu/lxgw-wenkai-webfont)。

## 美术资产与替换

素材位于 `web/public/art/`，随 Vite 构建复制到静态目录。当前文件可以直接用于运行，均有明确来源。筒盖与铜扣采用简化的参数化造型。

| 文件 | 来源和用途 | 替换方式 |
| --- | --- | --- |
| `chamber.webp` | 使用内置 imagegen 工具，以用户提供的《墨染帝室，五匣诏卷》为参考，移除五只筒并补出山影与空桌，作为远景环境 | 用同构图的 16∶9 图片替换，中央保持空桌，避免贴图中的固定筒与实际几何体重复 |
| `canisters-source.webp` | 用户提供的《墨染帝室，五匣诏卷》，转为 WebP 后作为漆面纹样、筒盖与木桌的取样源 | 保持原图 1672×941 的布局，或同步调整 `materials.ts` 与 `objects.ts` 中的取样区域 |
| `silk.webp` | 使用内置 imagegen 工具，以用户提供的《龙凤环护的空白诏书》为参考，生成正视、无木轴与房间背景的龙凤绸面纹理 | 替换为宽高约 2.2∶1 的平面绸纹图，龙凤留在两侧，中央留给文字 |

淡金飞白笔刷由 `materials.ts` 的 Canvas 纹理生成，随每条飞行曲线短暂显露并消散。替换可集中修改 `artPaths` 中的资源地址。若调整龙凤占用范围，需要一起调整 `ImperialScene.layout()` 的编辑留白比例，并在窄屏复查。

### 生成环境贴图使用的提示词

```text
Use case: precise-object-edit. Asset type: wide scenic background plate for a Three.js Chinese ink-fantasy imperial desk UI. Edit the reference to REMOVE ALL FIVE CANISTERS completely, reconstructing misty mountains and the empty desk behind them. Preserve the beautiful lattice window on left, plum blossom branch, layered distant blue-gray ink mountains and pavilions, sheer curtains on right, inkstone and calligraphy brush far lower left, incense burner and books at far right. The entire central desktop is EMPTY. Keep the same first-person viewpoint, 16:9 wide framing, painterly ink-wash depth, subdued slate indigo, pine green, ivory, softly worn ebony wood and window light. No text, no canisters, no scrolls, no additional decorative foreground. Output a clean environmental background only, intended to sit BEHIND separate real-time 3D modeled objects.
```

### 生成绸面贴图使用的提示词

```text
Use case: precise-object-edit. Asset type: flat unlit texture for the SILK SURFACE ONLY of an interactive 3D imperial Chinese scroll. Extract and reconstruct the ivory silk rectangle from the reference as a flat perfectly front-on rectangular texture, width to height about 2.2:1. Gold dragon facing inward along the LEFT 17 percent, vermilion phoenix facing inward along the RIGHT 17 percent, restrained gray ink clouds and thin worn antique copper border at top and bottom. The CENTRAL TWO THIRDS are completely EMPTY ivory silk, softly textured with fibers, usable for black UI text. No wooden rods, no desk, no background room, no perspective, no shadows, no text, no letters, no seal. The whole output is ONLY the rectangular silk, edge to edge. Preserve intricate elegant dragon scales, antlers, feathers and the subdued gold and cinnabar colors from the reference. This texture will be mapped to a cloth mesh that is revealed during unrolling. No stretching or painted wooden rods.
```
