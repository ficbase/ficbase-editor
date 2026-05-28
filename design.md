# Ficbase Editor Design Brief

请为 **Ficbase Editor** 重新设计一套现代、轻松、明快的桌面 EPUB 编辑器界面。

这个文档用于交给设计工具或另一个模型继续做 UI 方案。重点不是单纯换颜色，而是重新整理产品体验、布局层级、组件语言和关键交互。

## 1. 产品定位

Ficbase Editor 是一个基于 Tauri 的桌面 EPUB 编辑器，面向需要整理、修复、转换和轻量编辑电子书的人：

- 独立作者和自出版用户
- EPUB 转换工具使用者
- 电子书整理者
- 数字图书管理员
- 需要从 TXT 生成 EPUB 并统一样式的人

它不是营销网站，不是 SaaS 后台，也不是完整 IDE。它更像一个 **bright book workshop**：左边理解书籍结构，中间编辑和阅读，右边按需要查看信息。

## 2. 当前核心能力

应用已经具备这些能力，设计需要把它们纳入信息架构：

- 导入 EPUB。
- 导入 TXT，并按前言、第一章、第二章等拆分为章节。
- 导入时可选择已保存的章节模板。
- 可以新建模板页面，并把模板页面保存为章节模板。
- 模板保存在应用内部模板文件夹中，模板 CSS 和图片资源落盘保存，不依赖 localStorage。
- 按模板导入时会把模板图片物化到当前 EPUB 项目的资源目录，并写入 manifest。
- 导出 EPUB，导出菜单中可选择导出 TXT。
- 解析 EPUB manifest、spine、metadata 和资源文件。
- 左侧显示资源树，支持树状结构和滚动。
- 章节顺序遵守 spine 阅读顺序，不按字典序排序。
- `cover.html` 等封面页面应自动识别为封面。
- 左侧 HTML/XHTML 资源支持添加和删除。
- 中间支持源码编辑、可视化富文本编辑、预览阅读三种模式。
- 默认进入预览模式，用户切换模式后保持偏好，切换章节不应自动跳回预览。
- 可视化编辑基于 Tiptap 富文本编辑器，支持文字颜色、背景颜色、页面背景色、字号、行高、粗体、斜体、下划线、链接、段落对齐和图片插入。
- 可视化编辑中的图片支持四角拖拽缩放，保持比例，并保存 `width` / `height`。
- 图片支持左对齐、居中、右对齐；图片对齐应作用于图片节点本身，而不是段落文本。
- 段落对齐应作用于段落/标题块，而不是选中的单个字。
- 支持选中文字添加注释。
- 注释有两种视觉形式：文字下方虚线，以及右上角圆形角标，点击或悬停显示注释弹窗。
- 注释弹框内可以设置虚线颜色和角标颜色。
- 图片资源可预览，封面可替换。
- 可编辑 metadata：title、author、language、identifier，并展示封面。
- 右侧 inspector 默认收起，可展开。
- 阅读模式下隐藏编辑功能按钮，右侧变成目录。
- 阅读模式支持上一章/下一章按钮，也支持左右方向键切换章节。
- 阅读模式标题应显示章节标题，例如“第一章 伊恩”，不是文件名。
- 目录标题需要格式化，例如 `第4章眠 粉` 显示为 `第四章 眠粉`。
- 标题过长时使用省略号，hover 或选中时可展示完整标题，只有放不下时才滚动展示。
- “应用格式到所有章节”暂时隐藏；后续重新实现时应优先只更新公共章节 CSS，而不是批量重写所有章节 HTML。
- 只有缺少公共样式链接、存在会覆盖公共样式的内联样式、或需要复制标题后的装饰内容时，才修改章节 HTML。
- 固定状态栏已移除。普通状态在左下角短暂浮动显示，严重问题在左上角弹框显示。

## 3. 设计目标

整体感觉：

- 现代、轻松、明快。
- 专业但不沉重。
- 适合长时间阅读和编辑。
- 有电子书工作台的辨识度，而不是普通三栏后台。
- 预览区要像真实阅读页面，不像嵌在工具里的空白 iframe。
- 功能按钮在需要时出现，不要让界面一直充满操作噪音。

必须避免：

- 不要深色 manifest/sidebar。
- 不要黑色代码编辑器作为默认风格。
- 不要普通 dashboard 卡片堆叠。
- 不要做 landing page。
- 不要大面积紫色、蓝紫渐变、玻璃拟态、装饰光球。
- 不要让每个区域都像浮动卡片套卡片。
- 不要写大量说明文字教育用户怎么用。

## 4. 推荐信息架构

### 顶部 Toolbar

用途：全局文件操作和模式入口。

应包含：

- 品牌：Ficbase Editor，配书本图标。
- 导入主按钮：点击直接导入 EPUB/TXT。
- 导入下拉：只包含“按模板导入”和“保存当前为模板”，不再包含普通导入。
- 导出主按钮：点击默认导出 EPUB。
- 导出下拉：选择导出 EPUB 或 TXT。
- 语言切换。
- 阅读模式切换。
- 右侧 inspector 收起/展开。

设计重点：

- Toolbar 不要太高，建议 56 到 64px。
- 导入/导出是全局主操作，要清楚但不抢正文注意力。
- 下拉菜单必须在最上层，不被编辑器或 preview 遮挡。

### 左侧 Book Structure

用途：展示 EPUB manifest 和阅读顺序。

应包含：

- 搜索输入。
- HTML 添加按钮。
- 删除当前 HTML 按钮。
- 树状文件夹和资源节点。
- 当前选中状态。
- 文件夹可折叠。
- 节点右键菜单：添加 HTML、删除 HTML。

设计重点：

- 浅色，不要深色侧栏。
- 树节点要紧凑，但文字不可拥挤。
- 章节标题优先显示格式化后的阅读标题，而不是文件名。
- 文件名、媒体类型、大小可作为次级信息。
- 资源树必须独立滚动，不能被窗口高度卡住。

### 中间 Workbench

用途：核心编辑和预览。

三种模式：

- Preview：阅读器式预览，默认模式。
- Visual：富文本可视化编辑。
- Source：HTML/CSS/XML 源码编辑。

设计重点：

- 模式切换要明显，但不能像一排笨重按钮。
- 可视化编辑工具条只在 visual 模式出现。
- 保存当前资源、更新样式只在有未保存变化时出现。
- 普通状态不占用固定布局行；更新、载入、保存等状态使用左下角浮动提示。
- 严重错误或会阻塞用户继续操作的问题使用左上角可关闭弹框。
- 切换章节不应该闪烁两次，不要用过强的重绘动画。

### 右侧 Inspector / TOC

默认收起。

普通模式展开后显示：

- 当前资源信息：名称、类型、媒体类型、大小、顺序、路径。
- metadata 资源选中时显示 metadata 表单和封面。
- 图片资源选中时可预览图片。
- 封面替换入口。

阅读模式展开后显示：

- 目录列表。
- 上一章/下一章按钮。
- 当前章节高亮。
- 当前章节自动滚动到可见区域。

设计重点：

- Inspector 是辅助面板，不应抢中间阅读区空间。
- 阅读模式下右侧变为目录，不显示资源调试信息。
- 目录不要再显示额外数字，如果章节名已经包含章节号。

## 5. 关键界面状态

### 5.1 Empty / Import

还未打开文件。

布局：

- 顶部 toolbar 保持完整。
- 左侧保留 Book Structure 空壳，可显示轻量空状态。
- 中间显示明确的导入入口。
- 右侧 inspector 默认收起。

视觉：

- 中间可以用纸张感的空白工作台，不要像错误页面。
- 主按钮文案建议“导入 EPUB/TXT”。

### 5.2 Chapter Preview

用户选中章节并预览。

布局：

- 左侧资源树选中章节。
- 中间为阅读页面，宽度吃满可用区域，并保留舒适 padding。
- 右侧 inspector 默认收起，可展开查看资源信息。
- 顶部显示格式化章节标题，而不是文件名。

视觉：

- Preview 不要是普通白框；应像一张阅读纸面。
- 页面背景为暖白或浅纸色。
- 正文排版清晰，图片居中，注释样式可见。

### 5.3 Visual Editing

用户在可视化模式编辑章节。

布局：

- 中间顶部出现富文本工具条。
- 工具条包含：粗体、斜体、下划线、块类型、字号、行高、左对齐、居中、右对齐、两端对齐、文字颜色、背景颜色、页面背景、图片导入、链接。
- 图片被选中时，左/中/右对齐按钮应改变图片节点对齐；正文被选中时，对齐按钮改变段落/标题块对齐。
- 图片被选中时显示可拖拽缩放手柄，拖拽后保存图片尺寸。
- 右键菜单包含：添加注释、左对齐、居中、右对齐、两端对齐。
- 对齐应用到所在段落/标题块。

视觉：

- 富文本工具按钮尽量使用图标，颜色选择放在下拉菜单。
- 编辑时图片尺寸、图片居中、注释、背景应与预览保持接近。
- 输入法输入中文时不应卡顿，界面不应频繁闪烁。

### 5.4 Source Editing

用户编辑 HTML/CSS/XML。

布局：

- 浅色代码编辑区域。
- 未保存状态明确。
- 保存按钮只在内容变化时出现。

视觉：

- 不要黑色终端风格。
- 字体建议使用 `SF Mono`, `Menlo`, `Consolas`。
- 行高适合长时间看代码。

### 5.5 Metadata & Cover

用户选中 OPF 或 metadata。

布局：

- 表单字段：Title、Author、Language、Identifier。
- 封面预览。
- 替换封面按钮。
- 保存 metadata 只在有变化时出现。

视觉：

- Metadata 更像书籍档案，不像后台表单。
- 封面预览要有清晰边界和真实尺寸比例。

### 5.6 Reading Mode

用户进入阅读模式。

布局：

- 隐藏导入、导出、编辑工具、源码切换等功能按钮。
- 中间专注阅读。
- 右侧为目录。
- 支持上一章、下一章和键盘左右键。

视觉：

- 更安静，减少边框和工具感。
- 当前章节标题明显，且持续跟随切换更新。
- 目录项选中态清晰，自动滚动到当前项。

## 6. 视觉方向

### 方向 A：Calm Reading Studio

关键词：

- 暖白纸张
- 柔和绿色
- 安静阅读
- 轻量工具

优点：

- 最适合长时间编辑和阅读。
- 与 EPUB 内容天然匹配。
- 容易落地到现有 React/Tauri。

缺点：

- 如果处理不好，可能显得过于普通。

### 方向 B：Editorial Workshop

关键词：

- 明亮编辑台
- 更强的工具感
- 分区明确
- 轻微出版物气质

优点：

- 适合强调“编辑器”和“制作工具”。
- Manifest、metadata、模板、导出等功能更容易组织。

缺点：

- 需要更细的组件规格，否则容易变成普通后台。

### 推荐

推荐采用 **Calm Reading Studio + Editorial Workshop 的混合方案**：

- Preview 和 Reading Mode 使用 Calm Reading Studio。
- Manifest、Inspector、模板、导入导出使用 Editorial Workshop 的清晰工具语言。
- 整体保持浅色、纸感、绿色主色，并加入少量琥珀色作为目录和提示辅助色。

## 7. 1440 x 900 布局建议

窗口：1440 x 900。

- Toolbar：64px 高。
- 不使用固定 Status strip；状态提示使用浮动层。
- 左侧 Book Structure：300 到 328px 宽。
- 中间 Workbench：自适应，最小 640px。
- 右侧 Inspector：320 到 360px 宽，默认收起为 44 到 52px 图标 rail。
- 主内容间距：12 到 16px。
- 面板圆角：8px。
- Preview 内边距：32 到 72px，随宽度自适应。
- 阅读正文最大行宽：不强制窄列，默认吃满可用区域，但保留 padding。

## 8. Color Tokens

```css
:root {
  --color-app-bg: #f5f8f2;
  --color-paper: #fffef8;
  --color-surface: #ffffff;
  --color-surface-warm: #fffaf1;
  --color-surface-green: #f0f8ef;

  --color-border: #dce8df;
  --color-border-strong: #c8d9ce;

  --color-text: #1f2e2a;
  --color-text-muted: #687873;
  --color-text-soft: #8a9993;

  --color-primary: #1fa477;
  --color-primary-hover: #168863;
  --color-primary-soft: #dff4eb;
  --color-primary-ring: rgba(31, 164, 119, 0.22);

  --color-amber: #d79a24;
  --color-amber-soft: #fff4d8;
  --color-blue-soft: #e8f3ff;
  --color-danger: #b84a3a;
  --color-danger-soft: #fde8e2;

  --shadow-panel: 0 14px 34px rgba(45, 70, 58, 0.08);
  --shadow-popover: 0 18px 44px rgba(28, 48, 40, 0.18);
}
```

## 9. Typography

界面字体：

- macOS 优先：`-apple-system`, `BlinkMacSystemFont`, `Segoe UI`, `sans-serif`
- 正文字号：14px
- 小信息：12px
- 面板标题：14px semibold
- 顶部品牌：17 到 18px semibold

阅读字体：

- 中文阅读：系统宋体或用户 EPUB 自带字体优先。
- 默认正文：16 到 18px。
- 行高：1.72 到 1.9。
- 标题：22 到 28px，视章节层级决定。

代码字体：

- `SF Mono`, `Menlo`, `Consolas`, `monospace`
- 13px 或 14px。
- 行高 1.65。

## 10. 组件规格

### Button

- 高度：34 到 38px。
- 圆角：8px。
- 主按钮背景：primary。
- 次按钮背景：surface。
- 图标尺寸：15 到 17px。
- hover：轻微变深或增加边框色。
- disabled：透明度降低，禁止强对比。

### Icon Button

- 尺寸：34 x 34px。
- 圆角：8px。
- hover 使用 primary-soft。
- selected 使用 primary-soft + primary 边框。

### Split Button

- 主按钮和下拉按钮视觉相连。
- 下拉菜单 z-index 必须高于 editor、preview、inspector。
- 菜单项高度 34 到 38px。

### Manifest Tree Node

- 高度：34 到 40px。
- 缩进：每层 16px。
- 选中态：左侧 3px primary rail + primary-soft 背景。
- hover：surface-green。
- 文件名过长省略，必要时滚动展示。
- cover 资源可显示小标签“封面”。

### Preview Surface

- 背景：paper。
- 边框：1px solid border。
- 圆角：8px。
- padding：clamp(28px, 5vw, 72px)。
- 宽度：吃满可用空间。
- 内部滚动条风格轻。

### Visual Editor Toolbar

- 高度：44 到 48px。
- 图标按钮为主。
- 颜色选择使用 popover，不直接占 toolbar 宽度。
- 页面背景色按钮与文字背景色按钮要有不同图标。
- 图片操作沿用同一套工具条，不单独增加笨重属性面板。
- 图片 resize 手柄只在 hover、选中或拖拽时显示。
- 图片对齐状态通过图片节点属性保存，例如 `data-align="center"`，并输出可被 EPUB 阅读器理解的 block + margin 样式。

### Status / Alert

- 不保留固定状态栏，避免压缩主要工作区。
- 左下角 floating status 用于短暂反馈：载入、保存、导入、导出、模板应用完成等。
- floating status 不应阻挡编辑，不接受鼠标交互，自动消失。
- 左上角 critical alert 用于严重或阻塞问题：导入失败、保存失败、切换资源时保存失败等。
- critical alert 需要可关闭，并支持长错误文本换行。

### Annotation

- 下划线：1.5px dashed，自定义颜色。
- 角标：14 到 16px 圆形，右上角或文字后上标。
- 弹窗：宽度自适应内容，最大 280px。
- 弹窗左侧不要留异常空白。

### Inspector

- 默认收起。
- 展开宽度 320 到 360px。
- detail row 使用 label/value 两列。
- path 可换行或中间截断。

## 11. Motion

需要动画，但不要过度。

- 面板展开/收起：160 到 220ms。
- 目录选中滚动：smooth scroll。
- 下拉菜单：opacity + translateY，120ms。
- 模式切换：轻微 crossfade，不要闪两次。
- 阅读章节切换：内容可轻微 fade，标题必须及时更新。
- hover 动画：120ms。

## 12. React 结构建议

```tsx
<AppShell>
  <TopToolbar />
  <MainLayout>
    <BookStructurePanel />
    <Workbench>
      <ResourceHeader />
      <ModeSwitcher />
      <SourceEditor />
      <VisualEditor />
      <PreviewReader />
      <EditorActions />
    </Workbench>
    <InspectorPanel />
    <ReaderTocPanel />
  </MainLayout>
  <ContextMenus />
  <Dialogs />
</AppShell>
```

建议将这些区域拆成组件：

- `TopToolbar`
- `ImportSplitButton`
- `ExportSplitButton`
- `BookStructurePanel`
- `ResourceTreeNode`
- `WorkbenchHeader`
- `ModeSegmentedControl`
- `VisualEditorToolbar`
- `PreviewReader`
- `InspectorPanel`
- `ReaderToc`
- `MetadataEditor`
- `CoverPanel`
- `AnnotationMenu`
- `ColorPopover`

## 13. 设计判断

这个应用最重要的不是“看起来功能多”，而是让用户相信：

- 这本书的结构是清楚的。
- 当前章节正在被安全编辑。
- 预览效果足够接近真实 EPUB。
- 模板和公共 CSS 能让大量章节共享样式，而不是每章手动修。
- 阅读模式真的适合读，不只是编辑器的另一个标签页。

所以最终 UI 应该让“书”成为中心，而不是让文件树、按钮和表单成为中心。
