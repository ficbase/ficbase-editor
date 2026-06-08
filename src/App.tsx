import { useEffect, useMemo, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent,
  TouchEvent as ReactTouchEvent,
  UIEvent as ReactUIEvent,
  WheelEvent as ReactWheelEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertTriangle,
  BookOpen,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Code2,
  Download,
  FileCode2,
  FileImage,
  FileText,
  Folder,
  FolderOpen,
  ImageUp,
  Info,
  Languages,
  LoaderCircle,
  PanelRightClose,
  PanelRightOpen,
  Palette,
  Plus,
  Search,
  Trash2,
  Type,
  Upload,
  X,
} from "lucide-react";
import "./App.css";
import { RichDocumentEditor } from "./RichDocumentEditor";
import {
  createTranslator,
  getInitialLocale,
  getLocaleLabel,
  getNextLocale,
  type Locale,
  type TranslationParams,
} from "./i18n";

type ResourceKind =
  | "metadata"
  | "navigation"
  | "chapter"
  | "style"
  | "document"
  | "image"
  | "font"
  | "other";

type MetadataDraft = {
  title: string;
  author: string;
  language: string;
  identifier: string;
};

type ResourceItem = {
  path: string;
  name: string;
  mediaType?: string | null;
  kind: ResourceKind;
  size: number;
  editable: boolean;
  inSpine: boolean;
  spineIndex?: number | null;
};

type CoverInfo = {
  path: string;
  name: string;
  mediaType: string;
  size: number;
  dataUrl: string;
};

type LinkedStyle = {
  path: string;
  name: string;
  mediaType?: string | null;
  content: string;
};

type VisualResourceUrl = {
  dataUrl: string;
  original: string;
};

type VisualDocument = {
  html: string;
  resourceUrls: VisualResourceUrl[];
};

type ReaderCacheEntry = {
  content: string;
  previewHtml: string;
  styleKey: string;
};

type ProjectSnapshot = {
  sourcePath?: string | null;
  outputPath?: string | null;
  rootfilePath: string;
  metadata: MetadataDraft;
  cover?: CoverInfo | null;
  resources: ResourceItem[];
  spinePaths: string[];
};

type ViewMode = "source" | "visual" | "preview";
type ExportFormat = "epub" | "txt";

type StatusMessage = {
  key: string;
  params?: TranslationParams;
};

type ManifestContextMenu = {
  x: number;
  y: number;
  targetPath: string | null;
};

type ImagePreview = {
  src: string;
  title: string;
};

type AttributeSnapshot = {
  name: string;
  value: string;
};

type ChapterFormatTemplate = {
  sourcePath: string;
  bodyStyle: AttributeSnapshot[];
  titleStyle: AttributeSnapshot[];
  paragraphStyle: AttributeSnapshot[];
  decorationStyle?: AttributeSnapshot[];
  decorationImageStyle?: AttributeSnapshot[];
  customCss?: string;
  decorationHtml: string;
};

type SavedChapterTemplate = {
  id: string;
  name: string;
  createdAt: number;
  format: ChapterFormatTemplate;
};

type TemplateDesignerDraft = {
  name: string;
  html: string;
  customCss: string;
};

type PendingTemplateSave = {
  format: ChapterFormatTemplate;
};

type ResourceTreeNode =
  | {
      type: "folder";
      key: string;
      name: string;
      path: string;
      children: ResourceTreeNode[];
      spineIndex: number | null;
    }
  | {
      type: "resource";
      key: string;
      resource: ResourceItem;
      spineIndex: number | null;
    };

type MutableResourceTreeNode =
  | {
      type: "folder";
      key: string;
      name: string;
      path: string;
      children: Map<string, MutableResourceTreeNode>;
    }
  | {
      type: "resource";
      key: string;
      resource: ResourceItem;
    };

const treeCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

const defaultTemplateDesignerHtml = `<!doctype html>
<html>
<head>
  <title>Ficbase Template</title>
</head>
<body style="background-color: #ffffff; color: #1d2524; font-size: 16px; line-height: 1.8;">
  <h1 class="ficbase-chapter-title" style="text-align: center; font-size: 32px; font-weight: 700;">第1章 模板预览</h1>
  <div class="ficbase-chapter-content">
    <p>铅灰色的云层压过城市边缘，远处的灯火一点点亮起。</p>
    <p>他停在窗前，听见雨声落在屋檐上，像旧纸页被轻轻翻过。</p>
    <p>新的章节从这里展开，标题、正文和页面底色都会写入公共样式。</p>
  </div>
</body>
</html>`;
const defaultTemplateDesignerDraft: TemplateDesignerDraft = {
  name: "",
  html: defaultTemplateDesignerHtml,
  customCss: "",
};
const PREVIEW_AUTO_ADVANCE_THRESHOLD_PX = 28;
const PREVIEW_AUTO_ADVANCE_COOLDOWN_MS = 900;
const PREVIEW_SCROLL_INTENT_WINDOW_MS = 1400;
const PREVIEW_AUTO_ADVANCE_SETTLE_MS = 1200;

function App() {
  const [locale, setLocale] = useState<Locale>(() => getInitialLocale());
  const [project, setProject] = useState<ProjectSnapshot | null>(null);
  const [metadata, setMetadata] = useState<MetadataDraft>({
    title: "",
    author: "",
    language: "",
    identifier: "",
  });
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [previewHtml, setPreviewHtml] = useState("");
  const [linkedStyles, setLinkedStyles] = useState<LinkedStyle[]>([]);
  const [selectedStylePath, setSelectedStylePath] = useState<string | null>(null);
  const [styleDrafts, setStyleDrafts] = useState<Record<string, string>>({});
  const [savedStyleDrafts, setSavedStyleDrafts] = useState<Record<string, string>>({});
  const [stylesBusy, setStylesBusy] = useState(false);
  const [stylesPanelOpen, setStylesPanelOpen] = useState(false);
  const [visualEditorHtml, setVisualEditorHtml] = useState("");
  const [visualResourceUrls, setVisualResourceUrls] = useState<VisualResourceUrl[]>([]);
  const [imagePreviewDataUrl, setImagePreviewDataUrl] = useState("");
  const [imagePreviewBusy, setImagePreviewBusy] = useState(false);
  const [imagePreview, setImagePreview] = useState<ImagePreview | null>(null);
  const [previewDocumentHtml, setPreviewDocumentHtml] = useState("");
  const [previewBusy, setPreviewBusy] = useState(false);
  const [readerTitles, setReaderTitles] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState("");
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  const [manifestMenu, setManifestMenu] = useState<ManifestContextMenu | null>(null);
  const [importMenuOpen, setImportMenuOpen] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [chapterTemplates, setChapterTemplates] = useState<SavedChapterTemplate[]>([]);
  const [templateDesignerOpen, setTemplateDesignerOpen] = useState(false);
  const [templateDesignerDraft, setTemplateDesignerDraft] = useState<TemplateDesignerDraft>(
    defaultTemplateDesignerDraft,
  );
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [pendingTemplateSave, setPendingTemplateSave] = useState<PendingTemplateSave | null>(null);
  const [templateSaveDraftName, setTemplateSaveDraftName] = useState("");
  const [preferredViewMode, setPreferredViewMode] = useState<ViewMode>("preview");
  const [viewMode, setViewMode] = useState<ViewMode>("preview");
  const [readingMode, setReadingMode] = useState(false);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<StatusMessage>({ key: "status.ready" });
  const [statusToastVisible, setStatusToastVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const t = useMemo(() => createTranslator(locale), [locale]);
  const statusText = useMemo(() => t(status.key, status.params), [status, t]);
  const showStatusToast = busy || statusToastVisible;
  const statusToastText = busy && status.key === "status.ready" ? t("state.loading") : statusText;

  const selectedResource = useMemo(
    () => project?.resources.find((resource) => resource.path === selectedPath) ?? null,
    [project, selectedPath],
  );
  const contentDirty =
    selectedResource?.editable === true && isResourceDraftDirty(content, savedContent, viewMode);
  const selectedLinkedStyle = linkedStyles.find((style) => style.path === selectedStylePath) ?? null;
  const selectedStyleContent = selectedStylePath ? styleDrafts[selectedStylePath] ?? "" : "";
  const stylesDirty = linkedStyles.some((style) => isStyleDraftDirty(style.path, styleDrafts, savedStyleDrafts));
  const showLinkedStylesPanel = !readingMode && stylesPanelOpen && !!selectedResource && canPreview(selectedResource);
  const metadataDirty = project ? !sameMetadata(project.metadata, metadata) : false;
  const showMetadataPanel = selectedResource?.kind === "metadata";
  const showApplyChapterFormatAction = false;
  const showEditorActions = !templateDesignerOpen && !readingMode && (contentDirty || stylesDirty);
  const canSaveChapterTemplate = !!project && viewMode === "visual" && isDocumentFormatResource(selectedResource);
  const previewScrollRef = useRef<HTMLDivElement | null>(null);
  const visualResourceUrlsRef = useRef<VisualResourceUrl[]>([]);
  const readerCacheRef = useRef<Map<string, ReaderCacheEntry>>(new Map());
  const readerPrefetchingRef = useRef<Set<string>>(new Set());
  const resourceLoadIdRef = useRef(0);
  const selectedPathRef = useRef<string | null>(null);
  const selectedResourceRef = useRef<ResourceItem | null>(null);
  const nextReaderResourceRef = useRef<ResourceItem | null>(null);
  const viewModeRef = useRef<ViewMode>("preview");
  const previewBusyRef = useRef(false);
  const previewTouchStartYRef = useRef<number | null>(null);
  const previewDownScrollIntentAtRef = useRef(0);
  const previewLastScrollTopRef = useRef(0);
  const previewAutoAdvanceLockedRef = useRef(false);
  const previewAutoAdvanceRef = useRef<{ key: string; time: number } | null>(null);
  const navigateReaderResourceRef = useRef<(path: string) => Promise<void>>(async () => {});
  const previewRenderKeyRef = useRef("");
  const visualRenderKeyRef = useRef("");
  const manifestMenuResource = useMemo(
    () => project?.resources.find((resource) => resource.path === manifestMenu?.targetPath) ?? null,
    [manifestMenu?.targetPath, project],
  );
  const manifestMenuCanDeleteHtml = canDeleteHtml(manifestMenuResource);

  const resourceTree = useMemo(
    () => buildResourceTree(project?.resources ?? [], filter),
    [filter, project?.resources],
  );
  const filterActive = filter.trim().length > 0;
  const readerResources = useMemo(() => getReaderResources(project), [project]);
  const readerResourceIndex = readerResources.findIndex((resource) => resource.path === selectedPath);
  const previousReaderResource = readerResourceIndex > 0 ? readerResources[readerResourceIndex - 1] : null;
  const nextReaderResource =
    readerResourceIndex >= 0 && readerResourceIndex < readerResources.length - 1
      ? readerResources[readerResourceIndex + 1]
      : null;
  const readerTitle = useMemo(
    () => getReaderTitle(selectedResource, content, t("empty.noResourceSelected"), t("label.cover")),
    [content, selectedResource, t],
  );
  const styleCacheKey = useMemo(() => createStyleDraftCacheKey(styleDrafts), [styleDrafts]);
  const readerStyleKey = readingMode ? "" : styleCacheKey;

  useEffect(() => {
    window.localStorage.setItem("ficbase.locale", locale);
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    if (status.key === "status.ready") {
      setStatusToastVisible(false);
      return;
    }

    setStatusToastVisible(true);
    const timer = window.setTimeout(() => setStatusToastVisible(false), 2800);
    return () => window.clearTimeout(timer);
  }, [status]);

  useEffect(() => {
    let cancelled = false;
    invoke<SavedChapterTemplate[]>("list_chapter_templates")
      .then((templates) => {
        if (!cancelled) setChapterTemplates(templates);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    visualResourceUrlsRef.current = visualResourceUrls;
  }, [visualResourceUrls]);

  useEffect(() => {
    selectedPathRef.current = selectedPath;
  }, [selectedPath]);

  useEffect(() => {
    selectedResourceRef.current = selectedResource;
    nextReaderResourceRef.current = nextReaderResource;
    viewModeRef.current = viewMode;
    previewBusyRef.current = previewBusy;
  }, [nextReaderResource, previewBusy, selectedResource, viewMode]);

  useEffect(() => {
    navigateReaderResourceRef.current = navigateReaderResource;
  });

  useEffect(() => {
    const scrollElement = previewScrollRef.current;
    if (scrollElement) {
      scrollElement.scrollTo({ top: 0, left: 0, behavior: "auto" });
    }

    previewAutoAdvanceRef.current = null;
    previewTouchStartYRef.current = null;
    previewDownScrollIntentAtRef.current = 0;
    previewLastScrollTopRef.current = 0;

    const timer = window.setTimeout(() => {
      previewAutoAdvanceLockedRef.current = false;
      previewDownScrollIntentAtRef.current = 0;
    }, PREVIEW_AUTO_ADVANCE_SETTLE_MS);

    return () => window.clearTimeout(timer);
  }, [previewDocumentHtml, selectedPath]);

  useEffect(() => {
    setReaderTitles({});
    readerCacheRef.current.clear();
    readerPrefetchingRef.current.clear();
  }, [project?.rootfilePath, project?.sourcePath]);

  useEffect(() => {
    if (!selectedResource || !content) return;
    refreshReaderTitle(selectedResource, content);
  }, [content, selectedResource, t]);

  useEffect(() => {
    if (!project || !readingMode || readerResources.length === 0) return;

    let cancelled = false;
    const missingResources = prioritizeReaderResources(readerResources, selectedPath)
      .filter((resource) => {
        const title = readerTitles[resource.path];
        return !title || title === getReaderFallbackTitle(resource, t("label.cover"));
      })
      .slice(0, 16);
    if (missingResources.length === 0) return;

    async function loadReaderTitles() {
      const entries = await Promise.all(missingResources.map(async (resource) => {
        const cached = readerCacheRef.current.get(resource.path);
        let html = cached?.content ?? "";
        if (!html) {
          try {
            html = await invoke<string>("read_text_resource", { path: resource.path });
          } catch {
            return [resource.path, getReaderFallbackTitle(resource, t("label.cover"))] as [string, string];
          }
        }

        const title = getReaderTitle(resource, html, "", t("label.cover"));
        return title ? ([resource.path, title] as [string, string]) : null;
      }));

      if (cancelled) return;
      const nextTitles = Object.fromEntries(
        entries.filter((entry): entry is [string, string] => entry !== null),
      );

      if (cancelled || Object.keys(nextTitles).length === 0) return;
      setReaderTitles((current) => {
        let changed = false;
        const next = { ...current };
        Object.entries(nextTitles).forEach(([path, title]) => {
          if (next[path] === title) return;
          next[path] = title;
          changed = true;
        });
        return changed ? next : current;
      });
    }

    const timer = window.setTimeout(() => {
      void loadReaderTitles();
    }, Object.keys(readerTitles).length === 0 ? 0 : 80);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [project, readerResources, readerTitles, readingMode, selectedPath, t]);

  useEffect(() => {
    if (!project || !readingMode) return;

    [previousReaderResource, selectedResource, nextReaderResource].forEach((resource) => {
      if (resource && canPreview(resource)) {
        void prefetchReaderResource(resource);
      }
    });
  }, [nextReaderResource, previousReaderResource, project, readingMode, selectedResource, readerStyleKey]);

  useEffect(() => {
    if (!manifestMenu) return;

    function closeMenu() {
      setManifestMenu(null);
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") closeMenu();
    }

    window.addEventListener("click", closeMenu);
    window.addEventListener("blur", closeMenu);
    window.addEventListener("keydown", closeOnEscape);

    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("blur", closeMenu);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [manifestMenu]);

  useEffect(() => {
    if (!importMenuOpen) return;

    function closeMenu() {
      setImportMenuOpen(false);
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") closeMenu();
    }

    window.addEventListener("click", closeMenu);
    window.addEventListener("blur", closeMenu);
    window.addEventListener("keydown", closeOnEscape);

    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("blur", closeMenu);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [importMenuOpen]);

  useEffect(() => {
    if (!exportMenuOpen) return;

    function closeMenu() {
      setExportMenuOpen(false);
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") closeMenu();
    }

    window.addEventListener("click", closeMenu);
    window.addEventListener("keydown", closeOnEscape);

    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [exportMenuOpen]);

  useEffect(() => {
    function handleChapterNavigation(event: KeyboardEvent) {
      if (event.defaultPrevented || event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return;
      if (isTextInputTarget(event.target)) return;

      if (readingMode && event.key === "Escape") {
        event.preventDefault();
        setReadingMode(false);
        return;
      }

      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;

      const target = event.key === "ArrowLeft" ? previousReaderResource : nextReaderResource;
      if (!target) return;

      event.preventDefault();
      void navigateReaderResource(target.path);
    }

    window.addEventListener("keydown", handleChapterNavigation);
    return () => window.removeEventListener("keydown", handleChapterNavigation);
  }, [nextReaderResource, previousReaderResource, readingMode]);

  useEffect(() => {
    setMetadata(project?.metadata ?? { title: "", author: "", language: "", identifier: "" });
  }, [project]);

  useEffect(() => {
    setCollapsedFolders(new Set());
  }, [project?.rootfilePath, project?.sourcePath]);

  useEffect(() => {
    if (!selectedPath) return;
    const ancestors = getPathAncestors(selectedPath);
    if (ancestors.length === 0) return;

    setCollapsedFolders((current) => {
      let changed = false;
      const next = new Set(current);
      ancestors.forEach((ancestor) => {
        if (next.delete(ancestor)) changed = true;
      });
      return changed ? next : current;
    });
  }, [selectedPath]);

  useEffect(() => {
    setStylesPanelOpen(false);
  }, [selectedPath]);

  useEffect(() => {
    if (!selectedResource || viewMode !== "preview" || !canPreview(selectedResource)) {
      setPreviewHtml("");
      setPreviewBusy(false);
      previewRenderKeyRef.current = "";
      return;
    }

    const renderKey = createResourceRenderKey(selectedResource.path, content, styleDrafts);
    if (previewRenderKeyRef.current === renderKey && previewHtml) {
      setPreviewBusy(false);
      return;
    }

    if (readingMode) {
      const cached = readerCacheRef.current.get(selectedResource.path);
      if (cached?.styleKey === readerStyleKey && cached.content === content) {
        setPreviewHtml(cached.previewHtml);
        setPreviewBusy(false);
        return;
      }
    }

    let cancelled = false;
    setPreviewBusy(true);

    const timer = window.setTimeout(() => {
      invoke<string>("render_preview_resource", {
        path: selectedResource.path,
        draft: content,
        styleDrafts,
      })
        .then((html) => {
          if (!cancelled) {
            previewRenderKeyRef.current = renderKey;
            setPreviewHtml(html);
          }
        })
        .catch(() => {
          if (!cancelled) {
            previewRenderKeyRef.current = renderKey;
            setPreviewHtml(content);
          }
        })
        .finally(() => {
          if (!cancelled) setPreviewBusy(false);
        });
    }, 120);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [content, previewHtml, readerStyleKey, readingMode, selectedResource?.kind, selectedResource?.path, styleDrafts, viewMode]);

  useEffect(() => {
    const html = previewHtml || content;
    if (!html || !selectedResource || viewMode !== "preview" || !canPreview(selectedResource)) {
      setPreviewDocumentHtml("");
      return;
    }

    setPreviewDocumentHtml(preparePreviewHtml(html));
  }, [content, previewHtml, selectedResource?.kind, selectedResource?.path, viewMode]);

  useEffect(() => {
    if (templateDesignerOpen || viewMode !== "visual" || !selectedResource || !canVisualEdit(selectedResource)) return;

    const renderKey = createResourceRenderKey(selectedResource.path, content, styleDrafts);
    if (visualRenderKeyRef.current === renderKey && visualEditorHtml) return;

    const timer = window.setTimeout(() => {
      void renderVisualDocument(selectedResource.path, content, styleDrafts);
    }, 120);

    return () => window.clearTimeout(timer);
  }, [content, selectedResource?.path, styleDrafts, templateDesignerOpen, viewMode, visualEditorHtml]);

  useEffect(() => {
    if (!selectedResource || !canPreview(selectedResource)) {
      setLinkedStyles([]);
      setSelectedStylePath(null);
      setStylesBusy(false);
      return;
    }

    let cancelled = false;
    setStylesBusy(true);

    const timer = window.setTimeout(() => {
      invoke<LinkedStyle[]>("list_page_stylesheets", {
        path: selectedResource.path,
        draft: savedContent,
      })
        .then((styles) => {
          if (cancelled) return;

          setLinkedStyles(styles);
          setStyleDrafts((currentDrafts) => {
            const nextDrafts = { ...currentDrafts };
            styles.forEach((style) => {
              const currentDraft = currentDrafts[style.path];
              const savedDraft = savedStyleDrafts[style.path];
              if (currentDraft === undefined || currentDraft === savedDraft) {
                nextDrafts[style.path] = style.content;
              }
            });
            return nextDrafts;
          });
          setSavedStyleDrafts((currentSaved) => {
            const nextSaved = { ...currentSaved };
            styles.forEach((style) => {
              nextSaved[style.path] = style.content;
            });
            return nextSaved;
          });
          setSelectedStylePath((current) =>
            current && styles.some((style) => style.path === current) ? current : styles[0]?.path ?? null,
          );
        })
        .catch((err) => {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (!cancelled) setStylesBusy(false);
        });
    }, 140);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [savedContent, selectedResource?.kind, selectedResource?.path]);

  useEffect(() => {
    if (selectedResource?.kind !== "image") {
      setImagePreviewDataUrl("");
      setImagePreviewBusy(false);
      return;
    }

    let cancelled = false;
    setImagePreviewDataUrl("");
    setImagePreviewBusy(true);

    invoke<string>("read_resource_data_url", { path: selectedResource.path })
      .then((dataUrl) => {
        if (!cancelled) setImagePreviewDataUrl(dataUrl);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setImagePreviewBusy(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedResource?.kind, selectedResource?.path]);

  async function run<T>(action: () => Promise<T>): Promise<T | null> {
    setBusy(true);
    setError(null);
    try {
      return await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function importBook(template?: SavedChapterTemplate) {
    setImportMenuOpen(false);
    setTemplatePickerOpen(false);
    setTemplateDesignerOpen(false);
    const snapshot = await run(() => invoke<ProjectSnapshot>("import_book", { path: null }));
    if (!snapshot) return;

    let nextSnapshot = snapshot;
    let openStatus: StatusMessage = { key: "status.opened" };
    if (template) {
      const templatedSnapshot = await applySavedChapterTemplateToSnapshot(snapshot, template);
      if (templatedSnapshot) {
        nextSnapshot = templatedSnapshot;
        openStatus = { key: "status.openedWithTemplate", params: { name: template.name } };
      } else {
        openStatus = { key: "status.openedTemplateFailed", params: { name: template.name } };
      }
    }

    setProject(nextSnapshot);
    const firstEditable =
      nextSnapshot.resources.find((resource) => resource.kind === "chapter" && resource.editable) ??
      nextSnapshot.resources.find((resource) => resource.editable) ??
      null;
    if (firstEditable) {
      await loadResource(firstEditable.path, nextSnapshot, { force: true });
    } else {
      setSelectedPath(null);
      setContent("");
      setSavedContent("");
      setPreviewHtml("");
    }
    setStatus(openStatus);
  }

  function importBookWithTemplate() {
    openTemplatePicker();
  }

  async function importBookWithSavedTemplate(template: SavedChapterTemplate) {
    setTemplatePickerOpen(false);
    await importBook(template);
  }

  async function applySavedChapterTemplateToSnapshot(
    snapshot: ProjectSnapshot,
    template: SavedChapterTemplate,
  ) {
    const targets = snapshot.resources.filter(isDocumentFormatResource);
    if (targets.length === 0) return snapshot;

    setStatus({ key: "status.applyingTemplate", params: { name: template.name } });
    const materializedFormat = await run(() =>
      invoke<ChapterFormatTemplate>("materialize_chapter_template_assets", { template }),
    );
    if (!materializedFormat) return null;

    const materializedTemplate: SavedChapterTemplate = {
      ...template,
      format: materializedFormat,
    };
    const stylePath = getSharedChapterStylePath(snapshot);
    const styleContent = replaceFicbaseChapterStyleBlock("", createChapterCssBlock(materializedTemplate.format));

    const result = await run(async () => {
      const edits: Record<string, string> = {};
      for (const [index, resource] of targets.entries()) {
        const targetContent = await invoke<string>("read_text_resource", { path: resource.path });
        edits[resource.path] = applyChapterFormatTemplate(
          materializedTemplate.format,
          targetContent,
          resource.path,
          stylePath,
        );
        if (index % 20 === 19) {
          await waitForUiTick();
        }
      }

      return await invoke<ProjectSnapshot>("update_text_resources_with_style", {
        edits,
        stylePath,
        styleContent,
      });
    });
    if (!result) return null;

    targets.forEach((resource) => readerCacheRef.current.delete(resource.path));
    return result;
  }

  function openTemplatePicker() {
    setImportMenuOpen(false);
    if (chapterTemplates.length === 0) {
      setStatus({ key: "status.noChapterTemplates" });
      return;
    }

    setTemplatePickerOpen(true);
  }

  function saveCurrentChapterAsTemplate() {
    setImportMenuOpen(false);
    if (!selectedResource || !isDocumentFormatResource(selectedResource)) {
      setStatus({ key: "status.noChapterFormatTemplate" });
      return;
    }

    const draft = content;
    const format = createCurrentChapterFormatTemplate(draft, selectedResource.path);
    if (!format) {
      setStatus({ key: "status.noChapterFormatTemplate" });
      return;
    }

    const fallbackName = `${readerTitle || selectedResource.name} ${t("label.template")}`;
    openTemplateSaveDialog(fallbackName, format);
  }

  async function storeChapterTemplate(template: SavedChapterTemplate) {
    const nextTemplates = await run(() => invoke<SavedChapterTemplate[]>("save_chapter_template", { template }));
    if (!nextTemplates) return false;

    setChapterTemplates(nextTemplates);
    return true;
  }

  function openTemplateDesigner() {
    setImportMenuOpen(false);
    setExportMenuOpen(false);
    setReadingMode(false);
    setInspectorCollapsed(true);
    setTemplateDesignerOpen(true);
    setStatus({ key: "status.templateDesignerReady" });
  }

  function openTemplateSaveDialog(name: string, format: ChapterFormatTemplate) {
    setImportMenuOpen(false);
    setPendingTemplateSave({ format });
    setTemplateSaveDraftName(name);
  }

  function cancelTemplateSaveDialog() {
    setPendingTemplateSave(null);
    setTemplateSaveDraftName("");
  }

  async function confirmTemplateSaveDialog() {
    if (!pendingTemplateSave) return;
    const name = templateSaveDraftName.trim();
    if (!name) return;

    const template: SavedChapterTemplate = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      createdAt: Date.now(),
      format: pendingTemplateSave.format,
    };

    if (!(await storeChapterTemplate(template))) return;
    setPendingTemplateSave(null);
    setTemplateSaveDraftName("");
    setStatus({ key: "status.savedTemplate", params: { name } });
  }

  function updateTemplateDesignerDraft(field: keyof TemplateDesignerDraft, value: string) {
    setTemplateDesignerDraft((current) => ({ ...current, [field]: value }));
  }

  async function saveDesignedChapterTemplate() {
    const name = templateDesignerDraft.name.trim();
    if (!name) {
      setStatus({ key: "status.templateNameRequired" });
      return;
    }

    const template: SavedChapterTemplate = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      createdAt: Date.now(),
      format: createTemplateDesignerFormat(templateDesignerDraft),
    };

    if (!(await storeChapterTemplate(template))) return;
    setTemplateDesignerDraft((current) => ({ ...current, name }));
    setTemplateDesignerOpen(false);
    setStatus({ key: "status.savedTemplate", params: { name } });
  }

  async function loadResource(
    path: string,
    currentProject = project,
    options: { force?: boolean; preferredMode?: ViewMode } = {},
  ) {
    if (!currentProject) return;
    if (!options.force && path === selectedPath) return;
    let projectForLoad = currentProject;
    if (!options.force) {
      const savedProject = await savePendingChangesForResourceSwitch();
      if (!savedProject) return;
      projectForLoad = savedProject;
    }

    const loadId = resourceLoadIdRef.current + 1;
    resourceLoadIdRef.current = loadId;
    const resource = projectForLoad.resources.find((item) => item.path === path);
    const nextMode = resolveViewModeForResource(resource ?? null, options.preferredMode ?? preferredViewMode);

    if (!resource?.editable) {
      setSelectedPath(path);
      setLinkedStyles([]);
      setSelectedStylePath(null);
      setStyleDrafts({});
      setSavedStyleDrafts({});
      setViewMode(nextMode);
      setContent("");
      setSavedContent("");
      setPreviewHtml("");
      setVisualEditorHtml("");
      setVisualResourceUrls([]);
      return;
    }

    const text = await run(() => invoke<string>("read_text_resource", { path }));
    if (text === null) return;
    if (resourceLoadIdRef.current !== loadId) return;

    let nextVisualDocument: VisualDocument | null = null;

    if (nextMode === "visual" && canVisualEdit(resource)) {
      nextVisualDocument = await readVisualDocument(resource.path, text, {});
      if (resourceLoadIdRef.current !== loadId) return;
    }

    setSelectedPath(path);
    setLinkedStyles([]);
    setSelectedStylePath(null);
    setStyleDrafts({});
    setSavedStyleDrafts({});
    setViewMode(nextMode);
    setContent(text);
    setSavedContent(text);
    setPreviewHtml("");
    previewRenderKeyRef.current = "";
    if (nextVisualDocument) {
      visualRenderKeyRef.current = createResourceRenderKey(resource.path, text, {});
      setVisualEditorHtml(nextVisualDocument.html);
      setVisualResourceUrls(nextVisualDocument.resourceUrls);
    } else {
      visualRenderKeyRef.current = "";
      setVisualEditorHtml("");
      setVisualResourceUrls([]);
    }
    setStatus({ key: "status.loaded", params: { name: resource.name } });
  }

  async function saveCurrentResource() {
    const nextContent = content;
    if (!selectedResource || !selectedResource.editable || nextContent === savedContent) return project;
    const snapshot = await run(() =>
      invoke<ProjectSnapshot>("update_text_resource", {
        path: selectedResource.path,
        content: nextContent,
      }),
    );
    if (!snapshot) return null;

    setProject(snapshot);
    setContent(nextContent);
    setSavedContent(nextContent);
    setStatus({ key: "status.updatedResource", params: { name: selectedResource.name } });
    return snapshot;
  }

  async function saveLinkedStyles() {
    if (!stylesDirty) return project;

    const edits = Object.fromEntries(
      linkedStyles
        .filter((style) => isStyleDraftDirty(style.path, styleDrafts, savedStyleDrafts))
        .map((style) => [style.path, styleDrafts[style.path] ?? ""]),
    );
    if (Object.keys(edits).length === 0) return project;

    const snapshot = await run(() =>
      invoke<ProjectSnapshot>("update_text_resources", {
        edits,
      }),
    );
    if (!snapshot) return null;

    setProject(snapshot);
    setSavedStyleDrafts((current) => {
      const next = { ...current };
      Object.entries(edits).forEach(([path, value]) => {
        next[path] = value;
      });
      return next;
    });
    setStatus({ key: "status.updatedStyles", params: { count: Object.keys(edits).length } });
    return snapshot;
  }

  async function savePendingChangesForResourceSwitch() {
    if (!hasUnsavedResourceChanges() && !stylesDirty) return project;
    if (!window.confirm(t("confirm.saveChangesBeforeSwitch"))) {
      setStatus({ key: "status.switchCanceledUnsaved" });
      return null;
    }

    let snapshot = project;
    if (hasUnsavedResourceChanges()) {
      snapshot = await saveCurrentResource();
      if (!snapshot) {
        setStatus({ key: "status.switchBlockedSaveFailed" });
        return null;
      }
    }

    if (stylesDirty) {
      snapshot = await saveLinkedStyles();
      if (!snapshot) {
        setStatus({ key: "status.switchBlockedSaveFailed" });
        return null;
      }
    }

    return snapshot;
  }

  async function saveMetadata() {
    if (!metadataDirty) return project;
    const snapshot = await run(() => invoke<ProjectSnapshot>("update_metadata", { metadata }));
    if (!snapshot) return null;

    setProject(snapshot);
    setStatus({ key: "status.updatedMetadata" });
    return snapshot;
  }

  async function replaceCoverImage() {
    if (!project) return;
    const snapshot = await run(() => invoke<ProjectSnapshot>("replace_cover_image", { path: null }));
    if (!snapshot) return;

    setProject(snapshot);
    setStatus({ key: "status.updatedCover" });
    if (imagePreview?.title === project.cover?.name && snapshot.cover) {
      setImagePreview({ src: snapshot.cover.dataUrl, title: snapshot.cover.name });
    }
  }

  async function exportBook(format: ExportFormat = "epub") {
    setExportMenuOpen(false);
    const resourceSnapshot = await saveCurrentResource();
    if (resourceSnapshot === null) return;

    const stylesSnapshot = await saveLinkedStyles();
    if (stylesSnapshot === null) return;

    const metadataSnapshot = await saveMetadata();
    if (metadataSnapshot === null) return;

    const snapshot = await run(() => invoke<ProjectSnapshot>("export_book", { path: null, format }));
    if (!snapshot) return;

    setProject(snapshot);
    setStatus({ key: format === "txt" ? "status.exportedTxt" : "status.exportedEpub" });
  }

  async function addHtmlResource(afterPath = selectedPath) {
    if (!project || !canLeaveCurrentResource()) return;
    const oldPaths = new Set(project.resources.map((resource) => resource.path));
    const snapshot = await run(() =>
      invoke<ProjectSnapshot>("add_html_resource", {
        title: t("resource.newSection"),
        afterPath,
      }),
    );
    if (!snapshot) return;

    setProject(snapshot);
    setStatus({ key: "status.addedHtml" });
    const added =
      snapshot.resources.find((resource) => !oldPaths.has(resource.path) && canDeleteHtml(resource)) ??
      snapshot.resources.find((resource) => resource.kind === "chapter" && resource.editable);
    if (added) {
      await loadResource(added.path, snapshot);
    }
  }

  async function deleteHtmlResource(path = selectedPath) {
    if (!project || !path) return;
    const targetResource = project.resources.find((resource) => resource.path === path) ?? null;
    if (!targetResource || !canDeleteHtml(targetResource)) return;
    if (
      !window.confirm(
        t("confirm.deleteHtml", { name: targetResource.name }),
      )
    ) {
      return;
    }

    const oldOrder = targetResource.spineIndex ?? 0;
    const deletingSelectedResource = targetResource.path === selectedPath;
    const snapshot = await run(() =>
      invoke<ProjectSnapshot>("delete_html_resource", {
        path: targetResource.path,
      }),
    );
    if (!snapshot) return;

    setProject(snapshot);
    setManifestMenu(null);
    setStatus({ key: "status.deleted", params: { name: targetResource.name } });

    if (!deletingSelectedResource) return;

    const nextResource = findNextEditableResource(snapshot, oldOrder);
    if (nextResource) {
      setSelectedPath(null);
      setContent("");
      setSavedContent("");
      setPreviewHtml("");
      await loadResource(nextResource.path, snapshot);
    } else {
      setSelectedPath(null);
      setContent("");
      setSavedContent("");
      setPreviewHtml("");
    }
  }

  function canLeaveCurrentResource() {
    if (!hasUnsavedResourceChanges() && !stylesDirty) return true;
    return window.confirm(t("confirm.discardResourceChanges"));
  }

  function hasUnsavedResourceChanges() {
    if (selectedResource?.editable !== true) return false;
    return isResourceDraftDirty(content, savedContent, viewMode);
  }

  function updateStyleDraft(path: string, value: string) {
    setStyleDrafts((current) => ({ ...current, [path]: value }));
  }

  async function renderVisualDocument(
    path: string,
    draft: string,
    drafts: Record<string, string>,
  ) {
    const renderKey = createResourceRenderKey(path, draft, drafts);
    const visual = await readVisualDocument(path, draft, drafts);
    if (!visual || selectedPathRef.current !== path) return false;

    visualRenderKeyRef.current = renderKey;
    setVisualResourceUrls(visual.resourceUrls);
    setVisualEditorHtml(visual.html);
    return true;
  }

  async function readVisualDocument(
    path: string,
    draft: string,
    drafts: Record<string, string>,
  ) {
    try {
      return await invoke<VisualDocument>("render_visual_resource", {
        path,
        draft,
        styleDrafts: drafts,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  function selectViewMode(mode: ViewMode) {
    setPreferredViewMode(mode);
    const currentContent = content;
    const nextMode = resolveViewModeForResource(selectedResource, mode);
    setViewMode(nextMode);
    if (nextMode === "visual" && selectedResource) {
      void renderVisualDocument(selectedResource.path, currentContent, styleDrafts);
    }
  }

  async function enterReadingMode() {
    if (!project || readerResources.length === 0) return;
    setReadingMode(true);
    setInspectorCollapsed(false);
    setStylesPanelOpen(false);
    setPreferredViewMode("preview");
    setLinkedStyles([]);
    setSelectedStylePath(null);
    setStyleDrafts({});
    setSavedStyleDrafts({});

    const currentReaderResource =
      selectedResource && canPreview(selectedResource) ? selectedResource : readerResources[0];
    if (currentReaderResource.path === selectedPath) {
      setViewMode(resolveViewModeForResource(currentReaderResource, "preview"));
      return;
    }

    await loadResource(currentReaderResource.path, project, { preferredMode: "preview" });
  }

  function toggleReadingMode() {
    if (readingMode) {
      setReadingMode(false);
      return;
    }

    void enterReadingMode();
  }

  async function navigateReaderResource(path: string) {
    if (!project) return;
    if (!readingMode) {
      await loadResource(path, project, { preferredMode: preferredViewMode });
      return;
    }

    const resource = project.resources.find((item) => item.path === path);
    if (!resource || !canPreview(resource) || !resource.editable) return;
    if (path === selectedPath) return;
    if (!canLeaveCurrentResource()) return;

    setPreferredViewMode("preview");
    setViewMode("preview");
    setStylesPanelOpen(false);

    const cached = readerCacheRef.current.get(path);
    if (cached && cached.styleKey === readerStyleKey) {
      applyReaderResource(resource, cached);
      return;
    }

    setPreviewBusy(true);
    setSelectedPath(path);
    setLinkedStyles([]);
    setSelectedStylePath(null);
    setStyleDrafts({});
    setSavedStyleDrafts({});
    setVisualEditorHtml("");
    setVisualResourceUrls([]);

    const entry = await loadReaderCacheEntry(resource);
    if (!entry) {
      setPreviewBusy(false);
      return;
    }

    applyReaderResource(resource, entry);
    setPreviewBusy(false);
  }

  async function advanceToNextReaderResourceFromScroll() {
    if (previewAutoAdvanceLockedRef.current) return false;

    const currentPath = selectedPathRef.current;
    const currentResource = selectedResourceRef.current;
    const nextResource = nextReaderResourceRef.current;
    if (!currentPath || !currentResource || viewModeRef.current !== "preview" || !canPreview(currentResource)) {
      return false;
    }
    if (!nextResource || previewBusyRef.current) return false;

    const key = `${currentPath}->${nextResource.path}`;
    const now = Date.now();
    const previousAdvance = previewAutoAdvanceRef.current;
    if (previousAdvance?.key === key && now - previousAdvance.time < PREVIEW_AUTO_ADVANCE_COOLDOWN_MS) {
      return true;
    }

    previewAutoAdvanceRef.current = { key, time: now };
    previewAutoAdvanceLockedRef.current = true;
    previewDownScrollIntentAtRef.current = 0;
    previewTouchStartYRef.current = null;
    await navigateReaderResourceRef.current(nextResource.path);
    window.setTimeout(() => {
      previewAutoAdvanceLockedRef.current = false;
      previewDownScrollIntentAtRef.current = 0;
    }, PREVIEW_AUTO_ADVANCE_SETTLE_MS);
    return true;
  }

  function applyReaderResource(resource: ResourceItem, entry: ReaderCacheEntry) {
    setSelectedPath(resource.path);
    setContent(entry.content);
    setSavedContent(entry.content);
    setPreviewHtml(entry.previewHtml);
    setLinkedStyles([]);
    setSelectedStylePath(null);
    setStyleDrafts({});
    setSavedStyleDrafts({});
    setVisualEditorHtml("");
    setVisualResourceUrls([]);
    setStatus({ key: "status.loaded", params: { name: resource.name } });
  }

  function refreshReaderTitle(resource: ResourceItem, html: string) {
    const title = getReaderTitle(resource, html, "", t("label.cover"));
    if (!title) return;

    setReaderTitles((current) =>
      current[resource.path] === title ? current : { ...current, [resource.path]: title },
    );
  }

  async function loadReaderCacheEntry(resource: ResourceItem) {
    const cached = readerCacheRef.current.get(resource.path);
    if (cached && cached.styleKey === readerStyleKey) {
      refreshReaderTitle(resource, cached.content);
      return cached;
    }

    try {
      const text = await invoke<string>("read_text_resource", { path: resource.path });
      const preview = await invoke<string>("render_preview_resource", {
        path: resource.path,
        draft: text,
        styleDrafts: readingMode ? {} : styleDrafts,
      });
      const entry = { content: text, previewHtml: preview, styleKey: readerStyleKey };
      readerCacheRef.current.set(resource.path, entry);

      refreshReaderTitle(resource, text);

      return entry;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  async function prefetchReaderResource(resource: ResourceItem) {
    const cached = readerCacheRef.current.get(resource.path);
    if (cached?.styleKey === readerStyleKey || readerPrefetchingRef.current.has(resource.path)) return;

    readerPrefetchingRef.current.add(resource.path);
    try {
      await loadReaderCacheEntry(resource);
    } finally {
      readerPrefetchingRef.current.delete(resource.path);
    }
  }

  function updateRichEditorDocument(html: string) {
    const nextContent = restoreVisualResourceUrls(html, visualResourceUrlsRef.current);
    if (selectedResource) {
      visualRenderKeyRef.current = createResourceRenderKey(selectedResource.path, nextContent, styleDrafts);
    }
    setContent((current) => (current === nextContent ? current : nextContent));
  }

  async function applyChapterFormatToAll() {
    if (!project || !selectedResource || !isDocumentFormatResource(selectedResource)) return;

    const targets = project.resources.filter(isDocumentFormatResource);
    const otherTargets = targets.filter((resource) => resource.path !== selectedResource.path);
    if (otherTargets.length === 0) {
      setStatus({ key: "status.noChapterFormatTargets" });
      return;
    }

    const draft = content;
    const template = createCurrentChapterFormatTemplate(draft, selectedResource.path);
    if (!template) {
      setStatus({ key: "status.noChapterFormatTemplate" });
      return;
    }

    if (!window.confirm(t("confirm.applyChapterFormat", { count: otherTargets.length }))) return;

    const result = await run(async () => {
      const stylePath = getSharedChapterStylePath(project);
      const baseStyleContent = await readStyleContent(stylePath);
      const styleContent = documentFormatTemplateHasStyleDeclarations(template)
        ? replaceFicbaseChapterStyleBlock(baseStyleContent, createChapterCssBlock(template))
        : baseStyleContent;
      const edits: Record<string, string> = {};
      const selectedContent = applyChapterFormatTemplate(template, draft, selectedResource.path, stylePath);

      if (selectedContent !== savedContent) {
        edits[selectedResource.path] = selectedContent;
      }

      for (const [index, resource] of otherTargets.entries()) {
        const targetContent = await invoke<string>("read_text_resource", { path: resource.path });
        if (chapterNeedsFormatRewrite(template, targetContent, resource.path, stylePath)) {
          edits[resource.path] = applyChapterFormatTemplate(template, targetContent, resource.path, stylePath);
        }
        if (index % 3 === 2) {
          await waitForUiTick();
        }
      }

      const snapshot = await invoke<ProjectSnapshot>("update_text_resources_with_style", {
        edits,
        stylePath,
        styleContent,
      });
      return { snapshot, editedPaths: Object.keys(edits), selectedContent, stylePath, styleContent };
    });
    if (!result) return;

    readerCacheRef.current.clear();
    readerPrefetchingRef.current.clear();
    const nextStyleDrafts = { ...styleDrafts, [result.stylePath]: result.styleContent };
    setProject(result.snapshot);
    setStyleDrafts(nextStyleDrafts);
    setSavedStyleDrafts((current) => ({ ...current, [result.stylePath]: result.styleContent }));
    if (stylesPanelOpen) {
      setSelectedStylePath(result.stylePath);
    }
    setContent(result.selectedContent);
    setSavedContent(result.selectedContent);
    previewRenderKeyRef.current = "";
    visualRenderKeyRef.current = "";
    if (selectedResource && viewMode === "visual") {
      void renderVisualDocument(selectedResource.path, result.selectedContent, nextStyleDrafts);
    } else if (viewMode === "preview") {
      setPreviewHtml("");
    }
    setStatus({ key: "status.appliedChapterFormat", params: { count: otherTargets.length } });
  }

  async function readStyleContent(path: string) {
    const draft = styleDrafts[path];
    if (draft !== undefined) return draft;
    if (!project?.resources.some((resource) => resource.path === path)) return "";

    try {
      return await invoke<string>("read_text_resource", { path });
    } catch {
      return "";
    }
  }

  function createCurrentChapterFormatTemplate(draft: string, sourcePath: string) {
    return createChapterFormatTemplate(draft, sourcePath);
  }

  function updateMetadataField(field: keyof MetadataDraft, value: string) {
    setMetadata((current) => ({ ...current, [field]: value }));
  }

  function toggleFolder(path: string) {
    setCollapsedFolders((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }

  function toggleLocale() {
    setLocale((current) => getNextLocale(current));
  }

  function openImagePreview(src: string, title: string) {
    setImagePreview({ src, title });
  }

  function openManifestContextMenu(event: MouseEvent, targetPath: string | null = null) {
    event.preventDefault();
    event.stopPropagation();

    const width = 208;
    const height = 94;
    setManifestMenu({
      x: Math.min(event.clientX, window.innerWidth - width - 8),
      y: Math.min(event.clientY, window.innerHeight - height - 8),
      targetPath,
    });
  }

  async function addHtmlFromContextMenu() {
    const afterPath = manifestMenu?.targetPath ?? selectedPath;
    setManifestMenu(null);
    await addHtmlResource(afterPath);
  }

  async function deleteHtmlFromContextMenu() {
    if (!manifestMenuResource) return;
    await deleteHtmlResource(manifestMenuResource.path);
  }

  function markPreviewDownScrollIntent() {
    previewDownScrollIntentAtRef.current = Date.now();
  }

  function checkPreviewAutoAdvance() {
    const scrollElement = previewScrollRef.current;
    if (!scrollElement) return;
    if (previewAutoAdvanceLockedRef.current) return;
    if (Date.now() - previewDownScrollIntentAtRef.current > PREVIEW_SCROLL_INTENT_WINDOW_MS) return;

    const metrics = getPreviewElementScrollMetrics(scrollElement);
    const hasScrollableContent = metrics.scrollHeight > metrics.clientHeight + PREVIEW_AUTO_ADVANCE_THRESHOLD_PX;
    const reachedEnd =
      metrics.scrollTop + metrics.clientHeight >= metrics.scrollHeight - PREVIEW_AUTO_ADVANCE_THRESHOLD_PX;

    if (!hasScrollableContent || !reachedEnd) return;
    void advanceToNextReaderResourceFromScroll();
  }

  function handlePreviewScroll(event: ReactUIEvent<HTMLDivElement>) {
    const metrics = getPreviewElementScrollMetrics(event.currentTarget);
    if (metrics.scrollTop > previewLastScrollTopRef.current + 1) {
      markPreviewDownScrollIntent();
    }
    previewLastScrollTopRef.current = metrics.scrollTop;
    checkPreviewAutoAdvance();
  }

  function handlePreviewWheel(event: ReactWheelEvent<HTMLDivElement>) {
    if (event.deltaY > 0) markPreviewDownScrollIntent();
    window.setTimeout(checkPreviewAutoAdvance, 0);
  }

  function handlePreviewTouchStart(event: ReactTouchEvent<HTMLDivElement>) {
    previewTouchStartYRef.current = event.touches[0]?.clientY ?? null;
  }

  function handlePreviewTouchMove(event: ReactTouchEvent<HTMLDivElement>) {
    const touchStartY = previewTouchStartYRef.current;
    const currentY = event.touches[0]?.clientY ?? null;
    if (touchStartY != null && currentY != null && touchStartY - currentY > 3) {
      markPreviewDownScrollIntent();
    }
    window.setTimeout(checkPreviewAutoAdvance, 0);
  }

  function handlePreviewKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.defaultPrevented || event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return;
    if (isTextInputTarget(event.target)) return;

    if (readingMode && event.key === "Escape") {
      event.preventDefault();
      setReadingMode(false);
      return;
    }

    if (event.key === "ArrowLeft" && previousReaderResource) {
      event.preventDefault();
      void navigateReaderResource(previousReaderResource.path);
      return;
    }

    if (event.key === "ArrowRight" && nextReaderResource) {
      event.preventDefault();
      void navigateReaderResource(nextReaderResource.path);
      return;
    }

    if (["ArrowDown", "PageDown", "End", " "].includes(event.key)) {
      markPreviewDownScrollIntent();
      window.setTimeout(checkPreviewAutoAdvance, 0);
    }
  }

  function handlePreviewClick(event: MouseEvent<HTMLDivElement>) {
    if (!(event.target instanceof Element)) return;

    const anchor = event.target.closest("a[href]");
    if (!(anchor instanceof HTMLAnchorElement)) return;

    const rawHref = anchor.getAttribute("href") ?? "";
    if (!rawHref.startsWith("#") || rawHref.length <= 1) return;

    const targetId = safeDecodeHash(rawHref.slice(1));
    const target = findPreviewTargetById(previewScrollRef.current, targetId);
    if (!target) return;

    event.preventDefault();
    event.stopPropagation();
    scrollPreviewTargetIntoView(target);
  }

  function scrollPreviewTargetIntoView(target: HTMLElement) {
    if (!previewScrollRef.current) return;

    target.scrollIntoView({
      block: "center",
      inline: "nearest",
      behavior: "smooth",
    });

    const previousTabIndex = target.getAttribute("tabindex");
    target.setAttribute("tabindex", "-1");
    target.focus({ preventScroll: true });
    if (previousTabIndex === null) {
      target.removeAttribute("tabindex");
    } else {
      target.setAttribute("tabindex", previousTabIndex);
    }
  }

  return (
    <main className={readingMode ? "shell is-reading" : "shell"}>
      <header className="toolbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span>Ficbase Editor</span>
        </div>
        <div className="toolbar-actions">
          {!readingMode && (
            <>
              <div className="action-shelf">
                <div className="split-control import-control">
                  <button
                    type="button"
                    className="split-main"
                    onClick={() => importBook()}
                    disabled={busy}
                    title={t("action.importBook")}
                  >
                    <span className="action-icon">
                      <Download size={15} aria-hidden="true" />
                    </span>
                    <span className="action-main">{t("action.import")}</span>
                    <span className="action-format">EPUB/TXT</span>
                  </button>
                  <button
                    type="button"
                    className="split-toggle"
                    onClick={(event) => {
                      event.stopPropagation();
                      setImportMenuOpen((value) => !value);
                    }}
                    disabled={busy}
                    title={t("action.chooseImportMode")}
                  >
                    <ChevronDown size={14} aria-hidden="true" strokeWidth={2.3} />
                  </button>
                  {importMenuOpen && (
                    <div className="toolbar-menu import-menu" onClick={(event) => event.stopPropagation()}>
                      <button type="button" onClick={importBookWithTemplate}>
                        <FileText size={14} aria-hidden="true" />
                        {t("action.importWithTemplate")}
                      </button>
                      <button type="button" onClick={openTemplateDesigner} disabled={busy}>
                        <Palette size={14} aria-hidden="true" />
                        {t("action.newTemplate")}
                      </button>
                      {chapterTemplates.length > 0 && (
                        <>
                          <div className="toolbar-menu-separator" />
                          <div className="toolbar-menu-label">{t("label.savedTemplates")}</div>
                          {chapterTemplates.map((template) => (
                            <button
                              type="button"
                              key={template.id}
                              className="template-menu-item"
                              onClick={() => void importBookWithSavedTemplate(template)}
                              title={template.name}
                            >
                              <Palette size={14} aria-hidden="true" />
                              <span>{template.name}</span>
                            </button>
                          ))}
                        </>
                      )}
                      <button type="button" onClick={saveCurrentChapterAsTemplate} disabled={!canSaveChapterTemplate}>
                        <Plus size={14} aria-hidden="true" />
                        {t("action.saveAsTemplate")}
                      </button>
                    </div>
                  )}
                </div>
                <div className="split-control export-control">
                  <button
                    type="button"
                    className="split-main export-main"
                    onClick={() => {
                      setExportMenuOpen(false);
                      void exportBook("epub");
                    }}
                    disabled={!project || busy}
                    title={t("action.exportEpub")}
                  >
                    <span className="action-icon">
                      <Upload size={15} aria-hidden="true" />
                    </span>
                    <span className="action-main">{t("action.export")}</span>
                    <span className="action-format">EPUB</span>
                  </button>
                  <button
                    type="button"
                    className="split-toggle export-toggle"
                    onClick={(event) => {
                      event.stopPropagation();
                      setExportMenuOpen((value) => !value);
                    }}
                    disabled={!project || busy}
                    title={t("action.chooseExportFormat")}
                  >
                    <ChevronDown size={14} aria-hidden="true" strokeWidth={2.3} />
                  </button>
                  {exportMenuOpen && (
                    <div className="toolbar-menu export-menu" onClick={(event) => event.stopPropagation()}>
                      <button type="button" onClick={() => void exportBook("epub")}>
                        {t("format.epub")}
                      </button>
                      <button type="button" onClick={() => void exportBook("txt")}>
                        {t("format.txt")}
                      </button>
                    </div>
                  )}
                </div>
              </div>
              <button
                type="button"
                className="button language-button"
                onClick={toggleLocale}
                title={t("label.language")}
              >
                <Languages size={16} aria-hidden="true" />
                {getLocaleLabel(locale)}
              </button>
            </>
          )}
          {project && (
            <button
              type="button"
              className={readingMode ? "icon-button is-active" : "icon-button"}
              onClick={toggleReadingMode}
              disabled={templateDesignerOpen || readerResources.length === 0 || busy}
              title={readingMode ? t("action.exitReadingMode") : t("action.readingMode")}
            >
              <BookOpen size={16} aria-hidden="true" />
            </button>
          )}
        </div>
      </header>

      <section
        className={[
          "workspace",
          templateDesignerOpen ? "is-template-designer" : "",
          project || templateDesignerOpen ? "" : "is-empty",
          inspectorCollapsed ? "inspector-collapsed" : "",
          readingMode ? "is-reading" : "",
        ].filter(Boolean).join(" ")}
      >
        {templateDesignerOpen ? (
          <TemplateDesigner
            draft={templateDesignerDraft}
            onChange={updateTemplateDesignerDraft}
            onSave={saveDesignedChapterTemplate}
            onClose={() => setTemplateDesignerOpen(false)}
            t={t}
          />
        ) : (
          <>
        <aside className="sidebar" onContextMenu={(event) => openManifestContextMenu(event)}>
          <div className="sidebar-header">
            <div className="sidebar-title">
              <span>{t("label.manifest")}</span>
              <small>
                {project ? t("label.resourceCount", { count: project.resources.length }) : t("label.noEpub")}
              </small>
            </div>
            <div className="search">
              <Search size={15} aria-hidden="true" />
              <input
                value={filter}
                onChange={(event) => setFilter(event.currentTarget.value)}
                onContextMenu={(event) => event.stopPropagation()}
                placeholder={t("label.filterResources")}
                disabled={!project}
              />
            </div>
            <div className="resource-actions">
              <button
                type="button"
                onClick={() => addHtmlResource()}
                disabled={!project || busy}
                title={t("action.addHtml")}
              >
                <Plus size={15} aria-hidden="true" />
                {t("action.addHtml")}
              </button>
            </div>
          </div>

          <div className="resource-list">
            {resourceTree.length > 0 ? (
              <div className="resource-tree">
                {resourceTree.map((node) => (
                  <ResourceTreeNodeView
                    key={node.key}
                    node={node}
                    depth={0}
                    selectedPath={selectedPath}
                    collapsedFolders={collapsedFolders}
                    forceExpanded={filterActive}
                    contextPath={manifestMenu?.targetPath ?? null}
                    onToggleFolder={toggleFolder}
                    onSelectResource={loadResource}
                    onOpenContextMenu={openManifestContextMenu}
                  />
                ))}
              </div>
            ) : (
              <div className="resource-empty">
                {project ? t("empty.noMatchingManifest") : t("empty.openForManifest")}
              </div>
            )}
          </div>
        </aside>

        <section className={showEditorActions ? "editor has-actions" : "editor"}>
          {!project ? (
            <div className="empty-state empty-workbench">
              <div className="empty-paper">
                <div className="empty-glyph" aria-hidden="true" />
                <h2>{t("empty.importTitle")}</h2>
                <p>{t("empty.importDescription")}</p>
                <div className="empty-actions">
                  <button type="button" className="button primary large hero-action" onClick={() => importBook()} disabled={busy}>
                    <FolderOpen size={18} aria-hidden="true" />
                    {t("action.importBook")}
                  </button>
                  <button
                    type="button"
                    className="button large hero-action secondary"
                    onClick={importBookWithTemplate}
                    disabled={busy}
                  >
                    <Palette size={18} aria-hidden="true" />
                    {t("action.importWithTemplate")}
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <>
              <div className="editor-head">
                <div className="selection">
                  <ResourceIcon kind={selectedResource?.kind ?? "other"} />
                  <span className="selection-title" key={readingMode ? readerTitle : selectedPath ?? "empty"}>
                    {readingMode ? readerTitle : selectedResource?.path ?? t("empty.noResourceSelected")}
                  </span>
                  {contentDirty && <em>{t("state.unsaved")}</em>}
                  {stylesDirty && <em>{t("state.stylesUnsaved")}</em>}
                  {previewBusy && viewMode === "preview" && <em>{t("state.rendering")}</em>}
                </div>
                {!readingMode && <div className="editor-head-actions">
                  <button
                    type="button"
                    className={[
                      "icon-button",
                      stylesPanelOpen ? "is-active" : "",
                      stylesDirty ? "has-dot" : "",
                    ].filter(Boolean).join(" ")}
                    onClick={() => setStylesPanelOpen((value) => !value)}
                    disabled={!canPreview(selectedResource)}
                    title={t("action.toggleStyles")}
                  >
                    <Palette size={16} aria-hidden="true" />
                  </button>
                  <div className="segmented">
                    <button
                      type="button"
                      className={viewMode === "source" ? "is-selected" : ""}
                      onClick={() => selectViewMode("source")}
                      title={t("action.source")}
                    >
                      <Code2 size={15} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className={viewMode === "visual" ? "is-selected" : ""}
                      onClick={() => selectViewMode("visual")}
                      disabled={!canVisualEdit(selectedResource)}
                      title={t("action.visualEdit")}
                    >
                      <Type size={15} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className={viewMode === "preview" ? "is-selected" : ""}
                      onClick={() => selectViewMode("preview")}
                      disabled={!canPreview(selectedResource)}
                      title={t("action.preview")}
                    >
                      <FileText size={15} aria-hidden="true" />
                    </button>
                  </div>
                </div>}
              </div>

              <div className={showLinkedStylesPanel ? "editor-body has-style-panel" : "editor-body"}>
                <div className="resource-surface">
                  {selectedResource?.editable ? (
                    viewMode === "source" ? (
                      <textarea
                        className="code-editor"
                        value={content}
                        onChange={(event) => setContent(event.currentTarget.value)}
                        spellCheck={false}
                      />
                    ) : viewMode === "visual" ? (
                      <RichDocumentEditor
                        documentHtml={visualEditorHtml || content}
                        onDocumentHtmlChange={updateRichEditorDocument}
                        title={t("title.visualEditor")}
                        t={t}
                      />
                    ) : (
                      <div
                        ref={previewScrollRef}
                        className="preview-scroll"
                        tabIndex={0}
                        role="document"
                        aria-label={t("title.previewFrame")}
                        onClick={handlePreviewClick}
                        onKeyDown={handlePreviewKeyDown}
                        onScroll={handlePreviewScroll}
                        onTouchMove={handlePreviewTouchMove}
                        onTouchStart={handlePreviewTouchStart}
                        onWheel={handlePreviewWheel}
                        dangerouslySetInnerHTML={{ __html: previewDocumentHtml }}
                      />
                    )
                  ) : selectedResource?.kind === "image" ? (
                    <div className="image-preview-panel">
                      {imagePreviewBusy ? (
                        <span>{t("empty.loadingPreview")}</span>
                      ) : imagePreviewDataUrl ? (
                        <button
                          type="button"
                          className="image-preview-button"
                          onClick={() => openImagePreview(imagePreviewDataUrl, selectedResource.name)}
                          title={t("action.previewImage")}
                        >
                          <img src={imagePreviewDataUrl} alt={selectedResource.name} />
                        </button>
                      ) : (
                        <span>{t("empty.imagePreviewUnavailable")}</span>
                      )}
                    </div>
                  ) : (
                    <div className="empty-state">
                      <ResourceIcon kind={selectedResource?.kind ?? "other"} />
                      <span>
                        {selectedResource ? t("empty.binaryResource") : t("empty.noResourceSelected")}
                      </span>
                    </div>
                  )}
                </div>

                {showLinkedStylesPanel && (
                  <aside className="linked-styles-panel">
                    <div className="linked-styles-head">
                      <div>
                        <Palette size={15} aria-hidden="true" />
                        <strong>{t("label.linkedStyles")}</strong>
                      </div>
                      {stylesBusy ? (
                        <small>{t("state.loading")}</small>
                      ) : stylesDirty ? (
                        <em>{t("state.unsaved")}</em>
                      ) : (
                        <small>{t("label.styleCount", { count: linkedStyles.length })}</small>
                      )}
                    </div>

                    {linkedStyles.length === 0 ? (
                      <div className="style-empty">{t("empty.noLinkedStyles")}</div>
                    ) : (
                      <>
                        <div className="style-tabs">
                          {linkedStyles.map((style) => {
                            const dirty = isStyleDraftDirty(style.path, styleDrafts, savedStyleDrafts);
                            return (
                              <button
                                type="button"
                                key={style.path}
                                className={style.path === selectedStylePath ? "is-selected" : ""}
                                onClick={() => setSelectedStylePath(style.path)}
                                title={style.path}
                              >
                                <span>{style.name}</span>
                                {dirty && <em>{t("state.unsaved")}</em>}
                              </button>
                            );
                          })}
                        </div>

                        <textarea
                          className="code-editor style-code-editor"
                          value={selectedStyleContent}
                          onChange={(event) => {
                            if (selectedLinkedStyle) {
                              updateStyleDraft(selectedLinkedStyle.path, event.currentTarget.value);
                            }
                          }}
                          spellCheck={false}
                          disabled={!selectedLinkedStyle}
                        />

                        {stylesDirty && (
                          <button type="button" className="button" onClick={saveLinkedStyles} disabled={busy}>
                            <Check size={16} aria-hidden="true" />
                            {t("action.updateStyles")}
                          </button>
                        )}
                      </>
                    )}
                  </aside>
                )}
              </div>

              {showEditorActions && (
                <div className="editor-actions">
                  {contentDirty && (
                    <button type="button" className="button" onClick={saveCurrentResource} disabled={busy}>
                      <Check size={16} aria-hidden="true" />
                      {t("action.updateResource")}
                    </button>
                  )}
                  {stylesDirty && (
                    <button type="button" className="button" onClick={saveLinkedStyles} disabled={busy}>
                      <Check size={16} aria-hidden="true" />
                      {t("action.updateStyles")}
                    </button>
                  )}
                  {showApplyChapterFormatAction && (
                    <button type="button" className="button primary" onClick={applyChapterFormatToAll} disabled={busy}>
                      <Check size={16} aria-hidden="true" />
                      {t("action.applyChapterFormat")}
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </section>

        {inspectorCollapsed && !templateDesignerOpen && (
          <aside className="inspector-rail" aria-label={t("label.inspector")}>
            <button
              type="button"
              className="toolbar-icon-button rail-toggle"
              onClick={() => setInspectorCollapsed(false)}
              title={t("action.showInspector")}
            >
              <PanelRightOpen size={16} aria-hidden="true" />
            </button>
            <span className="rail-label">{t("label.inspector")}</span>
          </aside>
        )}

        {!inspectorCollapsed && (readingMode ? (
          <ReaderToc
            resources={readerResources}
            titles={readerTitles}
            selectedPath={selectedPath}
            previousResource={previousReaderResource}
            nextResource={nextReaderResource}
            onSelectResource={navigateReaderResource}
            onClose={() => setInspectorCollapsed(true)}
            t={t}
          />
        ) : (
        <aside className="inspector">
          <div className="panel-head">
            <Info size={16} aria-hidden="true" />
            <h2>{t("label.inspector")}</h2>
            <button
              type="button"
              className="icon-button subtle"
              onClick={() => setInspectorCollapsed(true)}
              title={t("action.hideInspector")}
            >
              <PanelRightClose size={15} aria-hidden="true" />
            </button>
          </div>

          <div className="details">
            <h2>{t("inspector.resource")}</h2>
            <dl>
              <dt>{t("inspector.name")}</dt>
              <dd>{selectedResource?.name ?? "-"}</dd>
              <dt>{t("inspector.kind")}</dt>
              <dd>{selectedResource ? t(`resourceKind.${selectedResource.kind}`) : "-"}</dd>
              <dt>{t("inspector.media")}</dt>
              <dd>{selectedResource?.mediaType ?? "-"}</dd>
              <dt>{t("inspector.size")}</dt>
              <dd>{selectedResource ? formatSize(selectedResource.size) : "-"}</dd>
              <dt>{t("inspector.order")}</dt>
              <dd>{selectedResource?.spineIndex != null ? selectedResource.spineIndex + 1 : "-"}</dd>
              <dt>{t("inspector.path")}</dt>
              <dd>{selectedResource?.path ?? "-"}</dd>
            </dl>
          </div>

          {showMetadataPanel && project ? (
            <section className="metadata-panel">
              <div className="panel-head compact">
                <BookOpen size={16} aria-hidden="true" />
                <h2>{t("label.metadata")}</h2>
                {metadataDirty && <em>{t("state.unsaved")}</em>}
              </div>

              {project.cover ? (
                <button
                  type="button"
                  className="cover-preview cover-preview-button"
                  onClick={() => openImagePreview(project.cover!.dataUrl, project.cover!.name)}
                  title={t("action.previewImage")}
                >
                  <img src={project.cover.dataUrl} alt={project.cover.name} />
                  <div>
                    <strong>{project.cover.name}</strong>
                    <small>{project.cover.mediaType}</small>
                    <small>{formatSize(project.cover.size)}</small>
                  </div>
                </button>
              ) : (
                <div className="cover-empty">{t("empty.noCover")}</div>
              )}
              <button type="button" className="button" onClick={replaceCoverImage} disabled={busy}>
                <ImageUp size={16} aria-hidden="true" />
                {t("action.replaceCover")}
              </button>

              <label>
                <span>{t("field.title")}</span>
                <input
                  value={metadata.title}
                  onChange={(event) => updateMetadataField("title", event.currentTarget.value)}
                  disabled={!project}
                />
              </label>
              <label>
                <span>{t("field.author")}</span>
                <input
                  value={metadata.author}
                  onChange={(event) => updateMetadataField("author", event.currentTarget.value)}
                  disabled={!project}
                />
              </label>
              <label>
                <span>{t("field.language")}</span>
                <input
                  value={metadata.language}
                  onChange={(event) => updateMetadataField("language", event.currentTarget.value)}
                  disabled={!project}
                />
              </label>
              <label>
                <span>{t("field.identifier")}</span>
                <input
                  value={metadata.identifier}
                  onChange={(event) => updateMetadataField("identifier", event.currentTarget.value)}
                  disabled={!project}
                />
              </label>
              <button type="button" className="button" onClick={saveMetadata} disabled={!metadataDirty || busy}>
                <Check size={16} aria-hidden="true" />
                {t("action.updateMetadata")}
              </button>
            </section>
          ) : (
            <div className="inspector-empty">{t("empty.selectMetadata")}</div>
          )}
        </aside>
        ))}
          </>
        )}
      </section>
      {manifestMenu && (
        <div
          className="context-menu"
          style={{ left: manifestMenu.x, top: manifestMenu.y }}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div className="context-menu-title">
            {manifestMenuResource?.name ?? t("context.targetManifest")}
          </div>
          <button type="button" onClick={addHtmlFromContextMenu} disabled={!project || busy}>
            <Plus size={14} aria-hidden="true" />
            {t("action.addHtml")}
          </button>
          <button
            type="button"
            onClick={deleteHtmlFromContextMenu}
            disabled={!manifestMenuCanDeleteHtml || busy}
          >
            <Trash2 size={14} aria-hidden="true" />
            {t("action.deleteHtml")}
          </button>
        </div>
      )}
      {templatePickerOpen && (
        <div className="template-dialog" role="dialog" aria-modal="true" aria-label={t("action.importWithTemplate")}>
          <button
            type="button"
            className="template-dialog-backdrop"
            onClick={() => setTemplatePickerOpen(false)}
          />
          <div className="template-dialog-card template-picker-card">
            <div className="template-dialog-heading">
              <Palette size={16} aria-hidden="true" />
              <strong>{t("label.savedTemplates")}</strong>
            </div>
            <div className="template-picker-list">
              {chapterTemplates.map((template) => (
                <button
                  type="button"
                  key={template.id}
                  onClick={() => void importBookWithSavedTemplate(template)}
                  title={template.name}
                >
                  <Palette size={14} aria-hidden="true" />
                  <span>{template.name}</span>
                </button>
              ))}
            </div>
            <div className="template-dialog-actions">
              <button type="button" className="button secondary" onClick={() => setTemplatePickerOpen(false)}>
                {t("action.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}
      {pendingTemplateSave && (
        <div className="template-dialog" role="dialog" aria-modal="true" aria-label={t("prompt.templateName")}>
          <button type="button" className="template-dialog-backdrop" onClick={cancelTemplateSaveDialog} />
          <form
            className="template-dialog-card"
            onSubmit={(event) => {
              event.preventDefault();
              void confirmTemplateSaveDialog();
            }}
          >
            <label>
              <span>{t("prompt.templateName")}</span>
              <input
                type="text"
                value={templateSaveDraftName}
                onChange={(event) => setTemplateSaveDraftName(event.currentTarget.value)}
                autoFocus
              />
            </label>
            <div className="template-dialog-actions">
              <button type="button" className="button secondary" onClick={cancelTemplateSaveDialog}>
                {t("action.cancel")}
              </button>
              <button type="submit" className="button primary" disabled={busy || !templateSaveDraftName.trim()}>
                <Check size={16} aria-hidden="true" />
                {t("action.saveTemplate")}
              </button>
            </div>
          </form>
        </div>
      )}
      {error && (
        <div className="critical-alert" role="alert">
          <AlertTriangle size={17} aria-hidden="true" />
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} title={t("action.close")}>
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}
      {showStatusToast && (
        <div className="floating-status" aria-live="polite">
          <span className={busy ? "status busy" : "status"}>
            {busy ? <LoaderCircle size={14} aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
            {statusToastText}
          </span>
        </div>
      )}
      {imagePreview && (
        <div className="image-lightbox" role="dialog" aria-modal="true" aria-label={t("title.imagePreview")}>
          <button type="button" className="image-lightbox-backdrop" onClick={() => setImagePreview(null)} />
          <div className="image-lightbox-content">
            <div className="image-lightbox-head">
              <strong>{imagePreview.title}</strong>
              <button type="button" className="icon-button" onClick={() => setImagePreview(null)} title={t("action.close")}>
                <X size={16} aria-hidden="true" />
              </button>
            </div>
            <img src={imagePreview.src} alt={imagePreview.title} />
          </div>
        </div>
      )}
    </main>
  );
}

function TemplateDesigner({
  draft,
  onChange,
  onSave,
  onClose,
  t,
}: {
  draft: TemplateDesignerDraft;
  onChange: (field: keyof TemplateDesignerDraft, value: string) => void;
  onSave: () => void;
  onClose: () => void;
  t: (key: string, params?: TranslationParams) => string;
}) {
  return (
    <section className="template-designer rich-template-designer" aria-label={t("label.templateDesigner")}>
      <aside className="template-controls">
        <div className="template-controls-head">
          <div>
            <Palette size={16} aria-hidden="true" />
            <strong>{t("label.templateDesigner")}</strong>
          </div>
          <button type="button" className="icon-button subtle" onClick={onClose} title={t("action.close")}>
            <X size={15} aria-hidden="true" />
          </button>
        </div>

        <div className="template-form">
          <label className="template-field">
            <span>{t("label.templateName")}</span>
            <input
              value={draft.name}
              onChange={(event) => onChange("name", event.currentTarget.value)}
              placeholder={t("label.template")}
            />
          </label>

          <section className="template-form-section">
            <h2>
              <Code2 size={15} aria-hidden="true" />
              {t("label.publicCss")}
            </h2>
            <textarea
              className="template-css-editor"
              value={draft.customCss}
              onChange={(event) => onChange("customCss", event.currentTarget.value)}
              spellCheck={false}
              placeholder="body.ficbase-chapter-body { }"
            />
          </section>
        </div>

        <div className="template-designer-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            <X size={16} aria-hidden="true" />
            {t("action.close")}
          </button>
          <button type="button" className="button primary" onClick={onSave}>
            <Check size={16} aria-hidden="true" />
            {t("action.saveTemplate")}
          </button>
        </div>
      </aside>

      <RichDocumentEditor
        className="template-rich-editor"
        documentHtml={draft.html}
        onDocumentHtmlChange={(html) => onChange("html", html)}
        title={t("label.templateDesigner")}
        t={t}
      />
    </section>
  );
}

function ReaderToc({
  resources,
  titles,
  selectedPath,
  previousResource,
  nextResource,
  onSelectResource,
  onClose,
  t,
}: {
  resources: ResourceItem[];
  titles: Record<string, string>;
  selectedPath: string | null;
  previousResource: ResourceItem | null;
  nextResource: ResourceItem | null;
  onSelectResource: (path: string) => void;
  onClose: () => void;
  t: (key: string, params?: TranslationParams) => string;
}) {
  const activeItemRef = useRef<HTMLButtonElement | null>(null);
  const titleMeasureRefs = useRef<Map<string, HTMLSpanElement>>(new Map());
  const [tooltip, setTooltip] = useState<{ title: string; left: number; top: number } | null>(null);
  const [overflowingTitlePaths, setOverflowingTitlePaths] = useState<Set<string>>(new Set());

  useEffect(() => {
    const activeItem = activeItemRef.current;
    activeItem?.scrollIntoView({ block: "center" });
    const title = activeItem?.dataset.readerTitle;
    const titleOverflows = activeItem?.dataset.readerOverflow === "true";
    if (!activeItem || !title || !titleOverflows) return;

    showTitleTooltip(activeItem, title);
    const timer = window.setTimeout(() => setTooltip(null), 1800);
    return () => window.clearTimeout(timer);
  }, [selectedPath]);

  useEffect(() => {
    let frame = 0;

    function measureTitleOverflow() {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const nextOverflowingPaths = new Set<string>();
        titleMeasureRefs.current.forEach((element, path) => {
          if (element.scrollWidth > element.clientWidth + 2) {
            nextOverflowingPaths.add(path);
          }
        });

        setOverflowingTitlePaths((current) =>
          sameStringSet(current, nextOverflowingPaths) ? current : nextOverflowingPaths,
        );
      });
    }

    measureTitleOverflow();
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measureTitleOverflow);
    titleMeasureRefs.current.forEach((element) => resizeObserver?.observe(element));
    window.addEventListener("resize", measureTitleOverflow);

    return () => {
      window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", measureTitleOverflow);
    };
  }, [resources, titles, selectedPath, t]);

  function setTitleMeasureRef(path: string, element: HTMLSpanElement | null) {
    if (element) {
      titleMeasureRefs.current.set(path, element);
    } else {
      titleMeasureRefs.current.delete(path);
    }
  }

  function showTitleTooltip(element: HTMLElement, title: string) {
    const rect = element.getBoundingClientRect();
    const maxWidth = 360;
    const left = Math.min(Math.max(12, rect.left), Math.max(12, window.innerWidth - maxWidth - 12));
    const top = Math.max(12, rect.top - 42);
    setTooltip({ title, left, top });
  }

  return (
    <aside className="inspector reader-toc">
      <div className="panel-head">
        <BookOpen size={16} aria-hidden="true" />
        <h2>{t("label.readerToc")}</h2>
        <button
          type="button"
          className="icon-button subtle"
          onClick={onClose}
          title={t("action.hideInspector")}
        >
          <PanelRightClose size={15} aria-hidden="true" />
        </button>
      </div>

      <div className="reader-toc-hint">
        <ChevronLeft size={14} aria-hidden="true" />
        <span>{t("hint.readerKeys")}</span>
        <ChevronRight size={14} aria-hidden="true" />
      </div>

      <div className="reader-nav-pair">
        <button
          type="button"
          onClick={() => previousResource && onSelectResource(previousResource.path)}
          disabled={!previousResource}
          title={previousResource?.path ?? t("action.previousChapter")}
        >
          <ChevronLeft size={15} aria-hidden="true" />
          <span>{t("action.previousChapter")}</span>
        </button>
        <button
          type="button"
          onClick={() => nextResource && onSelectResource(nextResource.path)}
          disabled={!nextResource}
          title={nextResource?.path ?? t("action.nextChapter")}
        >
          <span>{t("action.nextChapter")}</span>
          <ChevronRight size={15} aria-hidden="true" />
        </button>
      </div>

      <div className="reader-toc-list">
        {resources.map((resource) => {
          const displayTitle = titles[resource.path] || getReaderFallbackTitle(resource, t("label.cover"));
          const titleOverflows = overflowingTitlePaths.has(resource.path);
          const className = [
            "reader-toc-item",
            resource.path === selectedPath ? "is-active" : "",
            titleOverflows ? "has-overflow" : "",
          ]
            .filter(Boolean)
            .join(" ");

          return (
            <button
              type="button"
              ref={resource.path === selectedPath ? activeItemRef : null}
              key={resource.path}
              className={className}
              onClick={() => onSelectResource(resource.path)}
              onPointerEnter={(event) => titleOverflows && showTitleTooltip(event.currentTarget, displayTitle)}
              onPointerLeave={() => setTooltip(null)}
              onFocus={(event) => titleOverflows && showTitleTooltip(event.currentTarget, displayTitle)}
              onBlur={() => setTooltip(null)}
              data-reader-title={displayTitle}
              data-reader-overflow={titleOverflows ? "true" : "false"}
            >
              <span className="reader-toc-title">
                <span className="reader-toc-title-static" ref={(element) => setTitleMeasureRef(resource.path, element)}>
                  {displayTitle}
                </span>
                <span className="reader-toc-title-track" aria-hidden="true">
                  <span>{displayTitle}</span>
                  <span>{displayTitle}</span>
                </span>
              </span>
            </button>
          );
        })}
      </div>
      {tooltip && <div className="reader-toc-tooltip" style={{ left: tooltip.left, top: tooltip.top }}>{tooltip.title}</div>}
    </aside>
  );
}

function ResourceTreeNodeView({
  node,
  depth,
  selectedPath,
  collapsedFolders,
  forceExpanded,
  contextPath,
  onToggleFolder,
  onSelectResource,
  onOpenContextMenu,
}: {
  node: ResourceTreeNode;
  depth: number;
  selectedPath: string | null;
  collapsedFolders: Set<string>;
  forceExpanded: boolean;
  contextPath: string | null;
  onToggleFolder: (path: string) => void;
  onSelectResource: (path: string) => void;
  onOpenContextMenu: (event: MouseEvent, targetPath?: string | null) => void;
}) {
  if (node.type === "folder") {
    const collapsed = !forceExpanded && collapsedFolders.has(node.path);
    return (
      <div className="tree-branch">
        <button
          type="button"
          className={collapsed ? "tree-row tree-folder is-collapsed" : "tree-row tree-folder"}
          onClick={() => onToggleFolder(node.path)}
          onContextMenu={(event) => onOpenContextMenu(event, null)}
          title={node.path}
          style={{ paddingLeft: 8 + depth * 14 }}
        >
          {collapsed ? (
            <ChevronRight size={14} aria-hidden="true" />
          ) : (
            <ChevronDown size={14} aria-hidden="true" />
          )}
          <Folder size={15} aria-hidden="true" />
          <span>{node.name}</span>
          <small>{node.children.length}</small>
        </button>
        {!collapsed &&
          node.children.map((child) => (
            <ResourceTreeNodeView
              key={child.key}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              collapsedFolders={collapsedFolders}
              forceExpanded={forceExpanded}
              contextPath={contextPath}
              onToggleFolder={onToggleFolder}
              onSelectResource={onSelectResource}
              onOpenContextMenu={onOpenContextMenu}
            />
          ))}
      </div>
    );
  }

  const { resource } = node;
  const detail =
    resource.spineIndex != null
      ? `#${resource.spineIndex + 1} / ${formatSize(resource.size)}`
      : formatSize(resource.size);

  return (
    <button
      type="button"
      className={[
        "tree-row tree-resource",
        resource.path === selectedPath ? "is-active" : "",
        resource.path === contextPath ? "is-menu-target" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onClick={() => onSelectResource(resource.path)}
      onContextMenu={(event) => onOpenContextMenu(event, resource.path)}
      title={resource.path}
      style={{ paddingLeft: 28 + depth * 14 }}
    >
      <ResourceIcon kind={resource.kind} />
      <span>
        <strong>{resource.name}</strong>
        <small>{detail}</small>
      </span>
    </button>
  );
}

function ResourceIcon({ kind }: { kind: ResourceKind }) {
  if (kind === "style") return <Palette size={15} aria-hidden="true" />;
  if (kind === "image") return <FileImage size={15} aria-hidden="true" />;
  if (kind === "chapter") return <FileText size={15} aria-hidden="true" />;
  if (kind === "metadata" || kind === "navigation") return <FileCode2 size={15} aria-hidden="true" />;
  return <Code2 size={15} aria-hidden="true" />;
}

function sameMetadata(left: MetadataDraft, right: MetadataDraft) {
  return (
    left.title === right.title &&
    left.author === right.author &&
    left.language === right.language &&
    left.identifier === right.identifier
  );
}

function sameStringSet(left: Set<string>, right: Set<string>) {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

function canPreview(resource: ResourceItem | null) {
  return resource?.kind === "chapter" || resource?.kind === "document" || resource?.kind === "navigation";
}

function getReaderResources(project: ProjectSnapshot | null) {
  if (!project) return [];

  const byPath = new Map(project.resources.map((resource) => [resource.path, resource]));
  const spineResources = project.spinePaths
    .map((path) => byPath.get(path) ?? null)
    .filter((resource): resource is ResourceItem => !!resource && canPreview(resource));

  if (spineResources.length > 0) return spineResources;

  return project.resources
    .filter((resource) => canPreview(resource))
    .sort((left, right) => {
      if (left.spineIndex != null && right.spineIndex != null) return left.spineIndex - right.spineIndex;
      if (left.spineIndex != null) return -1;
      if (right.spineIndex != null) return 1;
      return treeCollator.compare(left.name, right.name);
    });
}

function getReaderTitle(resource: ResourceItem | null, html: string, fallback: string, coverLabel: string) {
  if (!resource) return fallback;
  const extractedTitle = canPreview(resource) ? extractReaderTitleFromHtml(html) : "";
  return extractedTitle || getReaderFallbackTitle(resource, coverLabel);
}

function getReaderFallbackTitle(resource: ResourceItem, coverLabel: string) {
  if (isCoverHtmlResource(resource)) return coverLabel;
  return resource.name || resource.path;
}

function isCoverHtmlResource(resource: ResourceItem) {
  if (!canPreview(resource)) return false;
  const name = resource.name.toLowerCase();
  const path = resource.path.toLowerCase();
  return (
    /(^|[/\\])cover\.(xhtml|html|htm)$/.test(path) ||
    name === "cover.xhtml" ||
    name === "cover.html" ||
    name === "cover.htm"
  );
}

function prioritizeReaderResources(resources: ResourceItem[], selectedPath: string | null) {
  if (resources.length === 0) return [];

  const selectedIndex = resources.findIndex((resource) => resource.path === selectedPath);
  const indexes = new Set<number>();

  if (selectedIndex >= 0) {
    for (
      let index = Math.max(0, selectedIndex - 12);
      index <= Math.min(resources.length - 1, selectedIndex + 12);
      index += 1
    ) {
      indexes.add(index);
    }
  }

  for (let index = 0; index < Math.min(resources.length, 24); index += 1) {
    indexes.add(index);
  }

  const priorityIndexes = Array.from(indexes)
    .sort((left, right) => left - right)
    .map((index) => resources[index]);
  const priorityPaths = new Set(priorityIndexes.map((resource) => resource.path));
  return [
    ...priorityIndexes,
    ...resources.filter((resource) => !priorityPaths.has(resource.path)),
  ];
}

function extractReaderTitleFromHtml(html: string) {
  if (!html.trim()) return "";

  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script, style, svg, .ficbase-notes").forEach((node) => node.remove());

  const headingCandidates = Array.from(doc.body.querySelectorAll("h1, h2, h3, h4, h5, h6"))
    .flatMap((element) => textCandidatesFromElement(element))
    .filter((value) => isLikelyReaderTitleCandidate(value, 80));

  const titleFromHeadings = composeReaderTitle(headingCandidates);
  if (titleFromHeadings) return titleFromHeadings;

  const blockCandidates = Array.from(
    doc.body.querySelectorAll("p, div, section, article, header, center, span, strong, b"),
  )
    .flatMap((element) => textCandidatesFromElement(element))
    .filter((value) => isLikelyReaderTitleCandidate(value, 40));

  return composeReaderTitle(dedupeTexts(blockCandidates));
}

function textCandidatesFromElement(element: Element) {
  return (element.textContent ?? "")
    .split(/\n+|\r+/)
    .map(normalizeReaderTitleText)
    .filter(Boolean);
}

function normalizeReaderTitleText(value: string) {
  return value
    .replace(/[\u200b-\u200f\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .replace(/([\u3400-\u9fff])\s+([\u3400-\u9fff])/g, "$1$2")
    .trim();
}

function isLikelyReaderTitleCandidate(value: string, maxLength: number) {
  if (!value || Array.from(value).length > maxLength) return false;
  if (/^[\[\(（【]?\d+[\]\)）】]?$/.test(value)) return false;
  return true;
}

function composeReaderTitle(candidates: string[]) {
  const values = dedupeTexts(candidates);
  if (values.length === 0) return "";

  const firstChapterTitle = formatChapterTitle(values[0]);
  if (firstChapterTitle) return firstChapterTitle;

  if (values.length > 1 && isChapterLabel(values[0]) && isLikelySubtitle(values[1])) {
    return `${formatChapterLabel(values[0])} ${normalizeReaderTitleText(values[1])}`;
  }

  return values[0];
}

function formatChapterTitle(value: string) {
  const normalized = normalizeReaderTitleText(value);
  const match = normalized.match(/^(第\s*([零〇一二两三四五六七八九十百千万\d]+)\s*([章节卷部回]))(?:[\s:：\-—]*(.*))?$/);
  if (!match) return "";

  const label = formatChapterLabel(match[1]);
  const title = normalizeReaderTitleText(match[4] ?? "").replace(/^[\s:：\-—]+/, "");
  return title ? `${label} ${title}` : label;
}

function formatChapterLabel(value: string) {
  const normalized = normalizeReaderTitleText(value);
  return normalized.replace(
    /^第\s*([零〇一二两三四五六七八九十百千万\d]+)\s*([章节卷部回])$/,
    (_match, numberText: string, unit: string) => `第${formatChapterNumber(numberText)}${unit}`,
  );
}

function formatChapterNumber(value: string) {
  if (!/^\d+$/.test(value)) return value.replace(/两/g, "二");

  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) return value;
  return integerToChinese(number);
}

function integerToChinese(value: number) {
  const digits = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  const units = ["", "十", "百", "千"];
  const chars = String(value).split("").map(Number);
  let output = "";
  let pendingZero = false;

  chars.forEach((digit, index) => {
    const unitIndex = chars.length - index - 1;
    if (digit === 0) {
      pendingZero = output.length > 0 && unitIndex > 0;
      return;
    }

    if (pendingZero) {
      output += "零";
      pendingZero = false;
    }
    output += `${digits[digit]}${units[unitIndex] ?? ""}`;
  });

  return output.replace(/^一十/, "十") || digits[value] || String(value);
}

function isChapterLabel(value: string) {
  return /^第\s*[零〇一二两三四五六七八九十百千万\d]+\s*[章节卷部回]$/.test(value);
}

function isLikelySubtitle(value: string) {
  return value.length > 0 && value.length <= 24;
}

function dedupeTexts(values: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];

  values.forEach((value) => {
    if (seen.has(value)) return;
    seen.add(value);
    result.push(value);
  });

  return result;
}

function isTextInputTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toLowerCase();
  return (
    tagName === "input" ||
    tagName === "textarea" ||
    tagName === "select" ||
    target.isContentEditable
  );
}

function canVisualEdit(resource: ResourceItem | null) {
  return resource?.kind === "chapter" || resource?.kind === "document";
}

function canDeleteHtml(resource: ResourceItem | null) {
  return resource?.kind === "chapter" || resource?.kind === "document";
}

function isDocumentFormatResource(resource: ResourceItem | null) {
  if (!resource || !canVisualEdit(resource) || isCoverHtmlResource(resource)) return false;

  const name = resource.name.toLowerCase();
  const path = resource.path.toLowerCase();
  if (/(^|[/\\])(nav|toc|preface|foreword)\.(xhtml|html|htm)$/.test(path)) return false;
  if (/^(nav|toc|preface|foreword)$/i.test(name)) return false;
  if (name === "前言" || /(^|[/\\])前言\.(xhtml|html|htm)$/.test(resource.path)) return false;
  return true;
}

function resolveViewModeForResource(resource: ResourceItem | null, preferredMode: ViewMode): ViewMode {
  if (!resource) return "source";
  if (preferredMode === "visual" && canVisualEdit(resource)) return "visual";
  if (preferredMode === "preview" && canPreview(resource)) return "preview";
  if (preferredMode === "source" && resource.editable) return "source";
  if (canPreview(resource)) return "preview";
  return "source";
}

function isStyleDraftDirty(
  path: string,
  drafts: Record<string, string>,
  savedDrafts: Record<string, string>,
) {
  return (drafts[path] ?? "") !== (savedDrafts[path] ?? "");
}

function isResourceDraftDirty(draft: string, saved: string, viewMode: ViewMode) {
  if (draft === saved) return false;
  if (viewMode !== "visual") return true;
  return normalizeVisualComparableContent(draft) !== normalizeVisualComparableContent(saved);
}

function normalizeVisualComparableContent(html: string) {
  const doc = new DOMParser().parseFromString(html || "<body></body>", "text/html");
  normalizeComparableVisualTree(doc.body);
  const bodyStyle = normalizeStyleAttribute(doc.body.getAttribute("style"));
  return JSON.stringify({
    style: bodyStyle,
    content: doc.body.innerHTML.trim(),
  });
}

function normalizeComparableVisualTree(root: HTMLElement) {
  root.classList.remove("visual-editor-document");
  if (root.getAttribute("class")?.trim() === "") root.removeAttribute("class");
  normalizeStyleAttributeOnElement(root);

  root.querySelectorAll<HTMLElement>("[style]").forEach(normalizeStyleAttributeOnElement);
}

function normalizeStyleAttributeOnElement(element: HTMLElement) {
  const normalized = normalizeStyleAttribute(element.getAttribute("style"));
  if (normalized) {
    element.setAttribute("style", normalized);
  } else {
    element.removeAttribute("style");
  }
}

function normalizeStyleAttribute(style: string | null) {
  return (style ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .sort()
    .join("; ");
}

function createStyleDraftCacheKey(drafts: Record<string, string>) {
  return Object.keys(drafts)
    .sort()
    .map((path) => `${path}:${drafts[path].length}:${hashString(drafts[path])}`)
    .join("|");
}

function createResourceRenderKey(path: string, draft: string, drafts: Record<string, string>) {
  return `${path}:${draft.length}:${hashString(draft)}:${createStyleDraftCacheKey(drafts)}`;
}

function hashString(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return hash.toString(36);
}

function waitForUiTick() {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

function createChapterFormatTemplate(html: string, sourcePath: string): ChapterFormatTemplate | null {
  const doc = new DOMParser().parseFromString(html || "<body></body>", "text/html");
  const title = findChapterTitleElement(doc.body);
  const firstParagraph = findBodyParagraph(doc.body, title);
  if (!title && !firstParagraph) return null;

  return {
    sourcePath,
    bodyStyle: getChapterBodyStyleSnapshot(doc.body),
    titleStyle: title ? mergeStyleSnapshots(getElementStyleSnapshot(title), extractDominantTextStyle(title)) : [],
    paragraphStyle: firstParagraph
      ? mergeStyleSnapshots(getElementStyleSnapshot(firstParagraph), extractDominantTextStyle(firstParagraph))
      : [],
    decorationHtml: title ? getTitleDecorationHtml(doc, title, firstParagraph) : "",
  };
}

function applyChapterFormatTemplate(
  template: ChapterFormatTemplate,
  html: string,
  targetPath: string,
  stylePath: string,
) {
  const doc = new DOMParser().parseFromString(html || "<body></body>", "text/html");
  const title = findChapterTitleElement(doc.body);

  ensureChapterStylesheetLink(doc, targetPath, stylePath);
  addTokenToAttribute(doc.body, "class", "ficbase-chapter-body");
  stripInlineStylesIncludingRoot(doc.body, uniqueStyleProperties([...template.bodyStyle.map((style) => style.name), "text-align"]));

  doc.body.querySelectorAll("[data-ficbase-format-decoration='true']").forEach((element) => element.remove());
  const content = ensureChapterContentWrapper(doc.body, title);
  splitChapterContentLineParagraphs(content);
  const firstParagraph = findBodyParagraph(doc.body, title);

  if (title) {
    addTokenToAttribute(title, "class", "ficbase-chapter-title");
    stripInlineStylesIncludingRoot(title, templateStyleProperties(template.titleStyle));
    normalizeInlineSpans(title);
  }

  if (title && template.decorationHtml.trim()) {
    insertTemplateDecorations(doc, template, targetPath, title, findBodyParagraph(doc.body, title) ?? firstParagraph);
  }

  findBodyParagraphs(doc.body, title).forEach((paragraph) => {
    stripInlineStylesIncludingRoot(paragraph, templateStyleProperties(template.paragraphStyle));
    normalizeInlineSpans(paragraph);
  });

  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}

function chapterNeedsFormatRewrite(
  template: ChapterFormatTemplate,
  html: string,
  targetPath: string,
  stylePath: string,
) {
  if (template.decorationHtml.trim()) return true;

  const doc = new DOMParser().parseFromString(html || "<body></body>", "text/html");
  const title = findChapterTitleElement(doc.body);
  const styleProperties = {
    body: uniqueStyleProperties([...template.bodyStyle.map((style) => style.name), "text-align"]),
    title: templateStyleProperties(template.titleStyle),
    paragraph: templateStyleProperties(template.paragraphStyle),
  };
  const paragraphs = findBodyParagraphs(doc.body, title);

  if (!chapterLinksStylesheet(doc, targetPath, stylePath)) return true;
  if (!attributeHasToken(doc.body, "class", "ficbase-chapter-body")) return true;
  if (title && !attributeHasToken(title, "class", "ficbase-chapter-title")) return true;
  if (paragraphs.length > 0 && !findChapterContentElement(doc.body)) return true;
  if (doc.body.querySelector("[data-ficbase-format-decoration='true']")) return true;
  if (hasInlineStyleProperties(doc.body, styleProperties.body)) return true;
  if (title && hasInlineStyleProperties(title, styleProperties.title)) return true;

  return paragraphs.some((paragraph) => hasInlineStyleProperties(paragraph, styleProperties.paragraph));
}

function chapterLinksStylesheet(doc: Document, sourcePath: string, stylePath: string) {
  const normalizedStylePath = normalizeResourcePath(stylePath);
  return Array.from(doc.head.querySelectorAll<HTMLLinkElement>("link[rel]")).some((link) => {
    const rel = (link.getAttribute("rel") ?? "")
      .split(/\s+/)
      .some((item) => item.toLowerCase() === "stylesheet");
    const rawHref = link.getAttribute("href") ?? "";
    return rel && shouldRewriteResourceHref(rawHref) && resolveResourceHref(sourcePath, rawHref) === normalizedStylePath;
  });
}

function createChapterCssBlock(template: ChapterFormatTemplate) {
  const rules = [
    createCssRule("body.ficbase-chapter-body", template.bodyStyle),
    createCssRule("body.ficbase-chapter-body .ficbase-chapter-title", template.titleStyle),
    createCssRule("body.ficbase-chapter-body .ficbase-template-decoration", template.decorationStyle ?? []),
    createCssRule("body.ficbase-chapter-body .ficbase-template-decoration img", template.decorationImageStyle ?? []),
    createCssRule(
      "body.ficbase-chapter-body .ficbase-chapter-content > p, body.ficbase-chapter-body > p",
      template.paragraphStyle,
    ),
  ].filter(Boolean);

  return [
    "/* ficbase chapter format start */",
    ...rules,
    normalizeCustomChapterCss(template.customCss ?? ""),
    "/* ficbase chapter format end */",
  ].filter(Boolean).join("\n");
}

function createTemplateDesignerFormat(draft: TemplateDesignerDraft): ChapterFormatTemplate {
  const template = createChapterFormatTemplate(draft.html, "ficbase-template-designer");
  return {
    sourcePath: "ficbase-template-designer",
    bodyStyle: template?.bodyStyle ?? [],
    titleStyle: template?.titleStyle ?? [],
    paragraphStyle: template?.paragraphStyle ?? [],
    decorationStyle: template?.decorationStyle ?? [],
    decorationImageStyle: template?.decorationImageStyle ?? [],
    decorationHtml: template?.decorationHtml ?? "",
    customCss: normalizeCustomChapterCss(draft.customCss),
  };
}

function normalizeCustomChapterCss(css: string) {
  return css
    .replace(/\/\* ficbase chapter format start \*\//g, "")
    .replace(/\/\* ficbase chapter format end \*\//g, "")
    .trim();
}

function documentFormatTemplateHasStyleDeclarations(template: ChapterFormatTemplate) {
  return (
    template.bodyStyle.length > 0 ||
    template.titleStyle.length > 0 ||
    template.paragraphStyle.length > 0 ||
    (template.decorationStyle?.length ?? 0) > 0 ||
    (template.decorationImageStyle?.length ?? 0) > 0 ||
    (template.customCss?.trim().length ?? 0) > 0
  );
}

function createCssRule(selector: string, styles: AttributeSnapshot[]) {
  if (styles.length === 0) return "";
  const body = styles.map((style) => `  ${style.name}: ${style.value};`).join("\n");
  return `${selector} {\n${body}\n}`;
}

function getChapterBodyStyleSnapshot(element: HTMLElement) {
  const allowedProperties = new Set([
    "background-color",
    "color",
    "font-family",
    "font-size",
    "line-height",
  ]);

  return getElementStyleSnapshot(element).filter((style) => allowedProperties.has(style.name));
}

function replaceFicbaseChapterStyleBlock(css: string, block: string) {
  const pattern = /\/\* ficbase chapter format start \*\/[\s\S]*?\/\* ficbase chapter format end \*\//;
  if (pattern.test(css)) return css.replace(pattern, block);

  const trimmed = css.trimEnd();
  return trimmed ? `${trimmed}\n\n${block}\n` : `${block}\n`;
}

function getSharedChapterStylePath(project: ProjectSnapshot | null) {
  const existing = project?.resources.find((resource) =>
    /(^|\/)ficbase-chapter\.css$/i.test(resource.path) || /(^|\/)chapter-style\.css$/i.test(resource.path),
  );
  if (existing) return existing.path;

  const packageDir = getResourceDir(project?.rootfilePath ?? "");
  return normalizeResourcePath(packageDir ? `${packageDir}/styles/ficbase-chapter.css` : "styles/ficbase-chapter.css");
}

function findChapterTitleElement(body: HTMLElement) {
  return body.querySelector<HTMLElement>("h1, h2, h3, h4, h5, h6");
}

function findBodyParagraph(body: HTMLElement, title: Element | null) {
  return findBodyParagraphs(body, title)[0] ?? null;
}

function findBodyParagraphs(body: HTMLElement, title: Element | null) {
  const content = findChapterContentElement(body);
  const scope = content ?? body;

  return Array.from(scope.querySelectorAll<HTMLParagraphElement>("p")).filter((paragraph) => {
    if (paragraph.closest(".ficbase-notes")) return false;
    if (content) return true;
    if (!title) return true;
    return !!(title.compareDocumentPosition(paragraph) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
}

function findChapterContentElement(body: HTMLElement) {
  return (
    Array.from(body.querySelectorAll<HTMLElement>(".ficbase-chapter-content")).find(
      (element) => !element.closest(".ficbase-notes"),
    ) ?? null
  );
}

function ensureChapterContentWrapper(body: HTMLElement, title: Element | null) {
  const existing = findChapterContentElement(body);
  if (existing) return existing;

  const doc = body.ownerDocument;
  const wrapper = doc.createElement("div");
  wrapper.className = "ficbase-chapter-content";
  const firstParagraph = findBodyParagraph(body, title);

  if (firstParagraph && firstParagraph.parentElement && firstParagraph.parentElement !== body) {
    addTokenToAttribute(firstParagraph.parentElement, "class", "ficbase-chapter-content");
    return firstParagraph.parentElement;
  }

  if (firstParagraph && firstParagraph.parentNode === body) {
    body.insertBefore(wrapper, firstParagraph);
    moveFollowingSiblingsInto(firstParagraph, wrapper);
    return wrapper;
  }

  if (title && title.parentNode === body) {
    title.after(wrapper);
    moveFollowingSiblingsInto(wrapper.nextSibling, wrapper);
    return wrapper;
  }

  body.prepend(wrapper);
  moveFollowingSiblingsInto(wrapper.nextSibling, wrapper);
  return wrapper;
}

function moveFollowingSiblingsInto(startNode: Node | null, target: HTMLElement) {
  let current = startNode;
  while (current) {
    const next = current.nextSibling;
    target.append(current);
    current = next;
  }
}

function splitChapterContentLineParagraphs(content: HTMLElement) {
  const doc = content.ownerDocument;
  const paragraphs = Array.from(content.children).filter(
    (element): element is HTMLParagraphElement => element.tagName.toLowerCase() === "p",
  );

  paragraphs.forEach((paragraph) => {
    if (!Array.from(paragraph.childNodes).some(isLineBreakNode)) return;

    const chunks: Node[][] = [[]];
    paragraph.childNodes.forEach((node) => {
      if (isLineBreakNode(node)) {
        chunks.push([]);
      } else {
        chunks[chunks.length - 1].push(node.cloneNode(true));
      }
    });

    const replacements = chunks
      .filter((chunk) => chunk.some(nodeHasTextContent))
      .map((chunk) => {
        const nextParagraph = doc.createElement("p");
        Array.from(paragraph.attributes).forEach((attribute) => {
          nextParagraph.setAttribute(attribute.name, attribute.value);
        });
        nextParagraph.append(...chunk);
        return nextParagraph;
      });

    if (replacements.length > 0) {
      paragraph.replaceWith(...replacements);
    }
  });
}

function isLineBreakNode(node: Node) {
  return node instanceof Element && node.tagName.toLowerCase() === "br";
}

function nodeHasTextContent(node: Node) {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? "").trim().length > 0;
  if (node instanceof Element && node.tagName.toLowerCase() === "br") return false;
  return (node.textContent ?? "").trim().length > 0;
}

function getTitleDecorationHtml(doc: Document, title: Element, firstParagraph: Element | null) {
  const beforeTitle = getSiblingDecorationHtml(doc, title.parentNode, title.parentNode?.firstChild ?? null, title, "before-title");
  if (beforeTitle) return beforeTitle;

  const content = findChapterContentElement(doc.body);
  const endNode = content && content.parentNode === title.parentNode ? content : firstParagraph;
  if (!endNode || title.parentNode !== endNode.parentNode) return "";

  return getSiblingDecorationHtml(doc, title.parentNode, title.nextSibling, endNode, "after-title");
}

function getSiblingDecorationHtml(
  doc: Document,
  parent: Node | null,
  startNode: Node | null,
  endNode: Node | null,
  placement: "before-title" | "after-title",
) {
  if (!parent || !startNode || !endNode || parent !== endNode.parentNode) return "";
  const fragment = doc.createDocumentFragment();
  let current: Node | null = startNode;
  while (current && current !== endNode) {
    const nextNode: Node | null = current.nextSibling;
    if (current.nodeType === Node.ELEMENT_NODE || (current.textContent ?? "").trim()) {
      fragment.append(current.cloneNode(true));
    }
    current = nextNode;
  }

  const holder = doc.createElement("div");
  holder.append(fragment);
  holder.firstElementChild?.setAttribute("data-ficbase-decoration-placement", placement);
  return holder.innerHTML;
}

function insertTemplateDecorations(
  doc: Document,
  template: ChapterFormatTemplate,
  targetPath: string,
  title: Element,
  firstParagraph: Element | null,
) {
  const holder = doc.createElement("template");
  holder.innerHTML = template.decorationHtml;
  rewriteDecorationResourceHrefs(holder.content, template.sourcePath, targetPath);
  const placement = getTemplateDecorationPlacement(holder.content);
  Array.from(holder.content.children).forEach((element) => {
    element.setAttribute("data-ficbase-format-decoration", "true");
    element.removeAttribute("data-ficbase-decoration-placement");
  });

  if (placement === "before-title" && title.parentNode) {
    title.before(holder.content);
    return;
  }

  const content = firstParagraph?.closest(".ficbase-chapter-content");
  if (content && content.parentNode) {
    content.before(holder.content);
    return;
  }

  if (firstParagraph && firstParagraph.parentNode) {
    firstParagraph.before(holder.content);
  } else {
    title.after(holder.content);
  }
}

function getTemplateDecorationPlacement(fragment: DocumentFragment) {
  const placement = fragment.firstElementChild?.getAttribute("data-ficbase-decoration-placement") ?? "";
  return placement === "before-title" ? "before-title" : "after-title";
}

function extractDominantTextStyle(element: HTMLElement) {
  const dominant = findDominantStyledTextElement(element);
  if (!dominant) return [];

  return getTextStyleSnapshot(dominant);
}

function findDominantStyledTextElement(element: HTMLElement) {
  const textLength = normalizeReaderTitleText(element.textContent ?? "").length;
  if (textLength === 0) return null;

  const styledElements = Array.from(element.querySelectorAll<HTMLElement>("[style]"));
  return styledElements.find((element) => {
    const childTextLength = normalizeReaderTitleText(element.textContent ?? "").length;
    return childTextLength >= textLength * 0.6;
  }) ?? null;
}

function getTextStyleSnapshot(element: HTMLElement) {
  const properties = [
    "background-color",
    "color",
    "font-family",
    "font-size",
    "font-style",
    "font-weight",
    "line-height",
    "text-align",
    "text-decoration",
  ];

  return properties
    .map((name) => ({ name, value: element.style.getPropertyValue(name) }))
    .filter((item) => item.value.trim().length > 0);
}

function getElementStyleSnapshot(element: HTMLElement) {
  const styles: AttributeSnapshot[] = [];
  for (let index = 0; index < element.style.length; index += 1) {
    const name = element.style.item(index);
    const value = element.style.getPropertyValue(name);
    if (name && value.trim()) {
      styles.push({ name, value });
    }
  }
  return styles;
}

function mergeStyleSnapshots(...snapshots: AttributeSnapshot[][]) {
  const merged = new Map<string, string>();
  snapshots.forEach((snapshot) => {
    snapshot.forEach((style) => {
      merged.set(style.name, style.value);
    });
  });
  return Array.from(merged.entries()).map(([name, value]) => ({ name, value }));
}

function stripInlineStylesIncludingRoot(root: HTMLElement, properties: string[]) {
  if (properties.length === 0) return;

  uniqueStyleProperties(properties).forEach((property) => root.style.removeProperty(property));
  removeEmptyStyleAttribute(root);
  stripInlineStyles(root, uniqueStyleProperties(properties));
}

function templateStyleProperties(styles: AttributeSnapshot[]) {
  const properties = styles.map((style) => style.name);
  if (properties.includes("text-align")) {
    properties.push("display");
  }
  return uniqueStyleProperties(properties);
}

function uniqueStyleProperties(properties: string[]) {
  return Array.from(new Set(properties.filter(Boolean)));
}

function attributeHasToken(element: Element, name: string, token: string) {
  return (element.getAttribute(name) ?? "").split(/\s+/).includes(token);
}

function addTokenToAttribute(element: Element, name: string, token: string) {
  const tokens = new Set((element.getAttribute(name) ?? "").split(/\s+/).filter(Boolean));
  tokens.add(token);
  element.setAttribute(name, Array.from(tokens).join(" "));
}

function hasInlineStyleProperties(root: HTMLElement, properties: string[]) {
  if (properties.length === 0) return false;
  const propertySet = new Set(properties);
  const hasProperty = (element: HTMLElement) =>
    Array.from(propertySet).some((property) => element.style.getPropertyValue(property).trim().length > 0);

  if (hasProperty(root)) return true;
  return Array.from(root.querySelectorAll<HTMLElement>("[style]")).some(hasProperty);
}

function ensureChapterStylesheetLink(doc: Document, sourcePath: string, stylePath: string) {
  const href = createRelativeResourceHref(sourcePath, stylePath);
  const existing = Array.from(doc.head.querySelectorAll<HTMLLinkElement>("link[rel]")).find((link) => {
    const rel = (link.getAttribute("rel") ?? "").split(/\s+/).some((item) => item.toLowerCase() === "stylesheet");
    const rawHref = link.getAttribute("href") ?? "";
    return rel && shouldRewriteResourceHref(rawHref) && resolveResourceHref(sourcePath, rawHref) === normalizeResourcePath(stylePath);
  });
  if (existing) {
    existing.setAttribute("href", href);
    return;
  }

  const link = doc.createElement("link");
  link.setAttribute("rel", "stylesheet");
  link.setAttribute("href", href);
  doc.head.append(doc.createTextNode("\n  "), link, doc.createTextNode("\n"));
}

function rewriteDecorationResourceHrefs(root: ParentNode, sourcePath: string, targetPath: string) {
  const attributes = ["href", "src", "poster", "xlink:href"];
  root.querySelectorAll<Element>("*").forEach((element) => {
    attributes.forEach((attribute) => {
      const value = element.getAttribute(attribute);
      if (!value || !shouldRewriteResourceHref(value)) return;

      const absolute = resolveResourceHref(sourcePath, value);
      element.setAttribute(attribute, createRelativeResourceHref(targetPath, absolute));
    });
  });
}

function shouldRewriteResourceHref(value: string) {
  return (
    !value.startsWith("#") &&
    !value.startsWith("//") &&
    !/^[a-z][a-z0-9+.-]*:/i.test(value)
  );
}

function resolveResourceHref(sourcePath: string, href: string) {
  const { path, suffix } = splitResourceHref(href);
  const base = path.startsWith("/") ? path.slice(1) : `${getResourceDir(sourcePath)}/${path}`;
  return `${normalizeResourcePath(base)}${suffix}`;
}

function createRelativeResourceHref(targetPath: string, absoluteHref: string) {
  const { path: resourcePath, suffix } = splitResourceHref(absoluteHref);
  const fromParts = getResourceDir(targetPath).split("/").filter(Boolean);
  const toParts = normalizeResourcePath(resourcePath).split("/").filter(Boolean);

  while (fromParts.length > 0 && toParts.length > 0 && fromParts[0] === toParts[0]) {
    fromParts.shift();
    toParts.shift();
  }

  const prefix = fromParts.map(() => "..");
  const relativePath = [...prefix, ...toParts].join("/");
  return relativePath ? `${relativePath}${suffix}` : `.${suffix}`;
}

function splitResourceHref(href: string) {
  const match = href.match(/^([^?#]*)([?#].*)?$/);
  return {
    path: match?.[1] ?? href,
    suffix: match?.[2] ?? "",
  };
}

function getResourceDir(path: string) {
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index === -1 ? "" : normalized.slice(0, index);
}

function normalizeResourcePath(path: string) {
  const parts: string[] = [];
  path.replace(/\\/g, "/").split("/").forEach((part) => {
    if (!part || part === ".") return;
    if (part === "..") {
      parts.pop();
      return;
    }
    parts.push(part);
  });
  return parts.join("/");
}

function restoreVisualResourceUrls(html: string, resourceUrls: VisualResourceUrl[]) {
  let output = html;
  const seen = new Set<string>();
  const urls = resourceUrls
    .filter((item) => {
      if (seen.has(item.dataUrl)) return false;
      seen.add(item.dataUrl);
      return true;
    })
    .sort((a, b) => b.dataUrl.length - a.dataUrl.length);

  urls.forEach((item) => {
    output = output.split(item.dataUrl).join(item.original);
  });

  return output;
}

function safeDecodeHash(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function getPreviewElementScrollMetrics(element: HTMLElement) {
  return {
    scrollTop: element.scrollTop,
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  };
}

function findPreviewTargetById(container: HTMLElement | null, id: string) {
  if (!container) return null;
  return Array.from(container.querySelectorAll<HTMLElement>("[id]")).find((element) => element.id === id) ?? null;
}

function preparePreviewHtml(html: string) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script").forEach((script) => script.remove());
  doc.querySelectorAll("*").forEach((element) => {
    Array.from(element.attributes).forEach((attribute) => {
      if (attribute.name.toLowerCase().startsWith("on")) element.removeAttribute(attribute.name);
    });
  });

  const wrapper = doc.createElement("div");
  wrapper.className = ["preview-document", ...Array.from(doc.body.classList)].filter(Boolean).join(" ");
  copyBodyPreviewAttribute(doc.body, wrapper, "id");
  copyBodyPreviewAttribute(doc.body, wrapper, "dir");
  copyBodyPreviewAttribute(doc.body, wrapper, "lang");
  copyBodyPreviewAttribute(doc.body, wrapper, "style");

  Array.from(doc.querySelectorAll("style")).forEach((style) => {
    const scopedStyle = doc.createElement("style");
    Array.from(style.attributes).forEach((attribute) => {
      if (attribute.name.toLowerCase().startsWith("on")) return;
      scopedStyle.setAttribute(attribute.name, attribute.value);
    });
    scopedStyle.textContent = scopePreviewCss(style.textContent ?? "");
    wrapper.append(scopedStyle);
    style.remove();
  });

  Array.from(doc.body.childNodes).forEach((node) => {
    wrapper.append(node);
  });

  return wrapper.outerHTML;
}

function copyBodyPreviewAttribute(source: HTMLElement, target: HTMLElement, name: string) {
  const value = source.getAttribute(name);
  if (value) target.setAttribute(name, value);
}

function scopePreviewCss(css: string): string {
  let output = "";
  let cursor = 0;

  while (cursor < css.length) {
    const openIndex = css.indexOf("{", cursor);
    if (openIndex === -1) {
      output += css.slice(cursor);
      break;
    }

    const closeIndex = findMatchingCssBrace(css, openIndex);
    if (closeIndex === -1) {
      output += css.slice(cursor);
      break;
    }

    const selector = css.slice(cursor, openIndex);
    const block = css.slice(openIndex + 1, closeIndex);
    const trimmedSelector = selector.trim().toLowerCase();

    if (trimmedSelector.startsWith("@")) {
      const scopedBlock =
        trimmedSelector.startsWith("@media") ||
        trimmedSelector.startsWith("@supports") ||
        trimmedSelector.startsWith("@container") ||
        trimmedSelector.startsWith("@layer")
          ? scopePreviewCss(block)
          : block;
      output += `${selector}{${scopedBlock}}`;
    } else {
      output += `${scopePreviewSelectorList(selector)}{${block}}`;
    }

    cursor = closeIndex + 1;
  }

  return output;
}

function findMatchingCssBrace(css: string, openIndex: number) {
  let depth = 0;
  let quote: string | null = null;
  let inComment = false;

  for (let index = openIndex; index < css.length; index += 1) {
    const char = css[index];
    const next = css[index + 1];

    if (inComment) {
      if (char === "*" && next === "/") {
        inComment = false;
        index += 1;
      }
      continue;
    }

    if (quote) {
      if (char === "\\") {
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "/" && next === "*") {
      inComment = true;
      index += 1;
      continue;
    }

    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }

    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

function scopePreviewSelectorList(selectorList: string) {
  return splitCssSelectorList(selectorList)
    .map((selector) => scopePreviewSelector(selector))
    .join(", ");
}

function splitCssSelectorList(selectorList: string) {
  const selectors: string[] = [];
  let cursor = 0;
  let depth = 0;
  let quote: string | null = null;

  for (let index = 0; index < selectorList.length; index += 1) {
    const char = selectorList[index];

    if (quote) {
      if (char === "\\") {
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }

    if (char === "(" || char === "[") {
      depth += 1;
    } else if (char === ")" || char === "]") {
      depth = Math.max(0, depth - 1);
    } else if (char === "," && depth === 0) {
      selectors.push(selectorList.slice(cursor, index));
      cursor = index + 1;
    }
  }

  selectors.push(selectorList.slice(cursor));
  return selectors;
}

function scopePreviewSelector(selector: string) {
  const trimmed = selector.trim();
  if (!trimmed) return selector;

  let scoped = trimmed
    .replace(/:root\b/g, ".preview-document")
    .replace(/\bhtml\b/g, ".preview-document")
    .replace(/\bbody\b/g, ".preview-document")
    .replace(/\.preview-document\s+\.preview-document/g, ".preview-document");

  if (!scoped.startsWith(".preview-document")) {
    scoped = `.preview-document ${scoped}`;
  }

  return scoped;
}

function stripInlineStyles(root: ParentNode, properties: string[]) {
  Array.from(root.querySelectorAll<HTMLElement>("[style]")).forEach((element) => {
    properties.forEach((property) => element.style.removeProperty(property));
    removeEmptyStyleAttribute(element);
  });
}

function normalizeInlineSpans(root: ParentNode) {
  let changed = true;
  let pass = 0;

  while (changed && pass < 8) {
    changed = false;
    pass += 1;

    Array.from(root.querySelectorAll<HTMLSpanElement>("span")).forEach((span) => {
      removeEmptyStyleAttribute(span);

      if (!span.isConnected) return;

      if (span.childNodes.length === 0) {
        span.remove();
        changed = true;
        return;
      }

      if (isPlainFormattingSpan(span) && !span.getAttribute("style")) {
        unwrapElement(span);
        changed = true;
        return;
      }

      if (!isPlainFormattingSpan(span) || span.childNodes.length !== 1) return;

      const child = span.firstElementChild;
      if (!child || child.tagName.toLowerCase() !== "span" || span.firstChild !== child) return;
      const childSpan = child as HTMLSpanElement;
      if (!isPlainFormattingSpan(childSpan)) return;

      copyMissingInlineStyles(span, childSpan);
      span.replaceWith(childSpan);
      changed = true;
    });
  }
}

function isPlainFormattingSpan(span: HTMLSpanElement) {
  return Array.from(span.attributes).every((attribute) => attribute.name === "style");
}

function copyMissingInlineStyles(source: HTMLElement, target: HTMLElement) {
  for (let index = 0; index < source.style.length; index += 1) {
    const property = source.style.item(index);
    if (!property || target.style.getPropertyValue(property)) continue;
    target.style.setProperty(property, source.style.getPropertyValue(property));
  }
  removeEmptyStyleAttribute(target);
}

function removeEmptyStyleAttribute(element: HTMLElement) {
  if (element.getAttribute("style")?.trim() === "") {
    element.removeAttribute("style");
  }
}

function unwrapElement(element: HTMLElement) {
  const parent = element.parentNode;
  if (!parent) return;

  while (element.firstChild) {
    parent.insertBefore(element.firstChild, element);
  }
  element.remove();
}

function findNextEditableResource(snapshot: ProjectSnapshot, oldOrder: number) {
  return (
    snapshot.resources.find(
      (resource) => resource.kind === "chapter" && (resource.spineIndex ?? 0) >= oldOrder,
    ) ??
    [...snapshot.resources]
      .reverse()
      .find((resource) => resource.kind === "chapter" && (resource.spineIndex ?? 0) < oldOrder) ??
    snapshot.resources.find((resource) => resource.editable)
  );
}

function buildResourceTree(resources: ResourceItem[], filter: string): ResourceTreeNode[] {
  const needle = filter.trim().toLowerCase();
  const root: Extract<MutableResourceTreeNode, { type: "folder" }> = {
    type: "folder",
    key: "folder:",
    name: "",
    path: "",
    children: new Map(),
  };

  resources
    .filter((resource) => matchesResourceFilter(resource, needle))
    .forEach((resource) => {
      const parts = resource.path.split("/").filter(Boolean);
      const fileName = parts.pop() ?? resource.name;
      let currentPath = "";
      let folder = root;

      parts.forEach((part) => {
        currentPath = currentPath ? `${currentPath}/${part}` : part;
        const mapKey = `folder:${part}`;
        const existing = folder.children.get(mapKey);
        if (existing?.type === "folder") {
          folder = existing;
          return;
        }

        const nextFolder: Extract<MutableResourceTreeNode, { type: "folder" }> = {
          type: "folder",
          key: `folder:${currentPath}`,
          name: part,
          path: currentPath,
          children: new Map(),
        };
        folder.children.set(mapKey, nextFolder);
        folder = nextFolder;
      });

      folder.children.set(`resource:${fileName}`, {
        type: "resource",
        key: `resource:${resource.path}`,
        resource,
      });
    });

  return Array.from(root.children.values()).map(finalizeTreeNode).sort(compareTreeNodes);
}

function matchesResourceFilter(resource: ResourceItem, needle: string) {
  if (!needle) return true;
  return (
    resource.path.toLowerCase().includes(needle) ||
    resource.name.toLowerCase().includes(needle) ||
    resource.kind.toLowerCase().includes(needle) ||
    (resource.mediaType?.toLowerCase().includes(needle) ?? false)
  );
}

function finalizeTreeNode(node: MutableResourceTreeNode): ResourceTreeNode {
  if (node.type === "resource") {
    return {
      type: "resource",
      key: node.key,
      resource: node.resource,
      spineIndex: node.resource.spineIndex ?? null,
    };
  }

  const children = Array.from(node.children.values()).map(finalizeTreeNode).sort(compareTreeNodes);
  const spineIndexes = children
    .map((child) => child.spineIndex)
    .filter((spineIndex): spineIndex is number => spineIndex != null);

  return {
    type: "folder",
    key: node.key,
    name: node.name,
    path: node.path,
    children,
    spineIndex: spineIndexes.length > 0 ? Math.min(...spineIndexes) : null,
  };
}

function compareTreeNodes(left: ResourceTreeNode, right: ResourceTreeNode) {
  if (left.spineIndex != null && right.spineIndex != null) {
    return left.spineIndex - right.spineIndex;
  }

  if (left.spineIndex != null) return -1;
  if (right.spineIndex != null) return 1;

  if (left.type !== right.type) {
    return left.type === "folder" ? -1 : 1;
  }

  return treeCollator.compare(getTreeNodeName(left), getTreeNodeName(right));
}

function getTreeNodeName(node: ResourceTreeNode) {
  return node.type === "folder" ? node.name : node.resource.name;
}

function getPathAncestors(path: string) {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  const ancestors: string[] = [];
  let current = "";

  parts.forEach((part) => {
    current = current ? `${current}/${part}` : part;
    ancestors.push(current);
  });

  return ancestors;
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default App;
