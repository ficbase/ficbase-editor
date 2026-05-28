import { useEffect, useMemo, useRef, useState } from "react";
import { Extension } from "@tiptap/core";
import Color from "@tiptap/extension-color";
import Highlight from "@tiptap/extension-highlight";
import Image from "@tiptap/extension-image";
import { Italic as TiptapItalic } from "@tiptap/extension-italic";
import Link from "@tiptap/extension-link";
import TextAlign from "@tiptap/extension-text-align";
import { TextStyle } from "@tiptap/extension-text-style";
import Underline from "@tiptap/extension-underline";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  FileText,
  ImageUp,
  Italic,
  Link as LinkIcon,
  PaintBucket,
  Palette,
  Pilcrow,
  Type,
  Underline as UnderlineIcon,
} from "lucide-react";
import type { TranslationParams } from "./i18n";

const richTextFontSizes = ["12px", "14px", "16px", "18px", "22px", "28px", "32px", "40px"];
const richTextLineHeights = ["1.3", "1.5", "1.65", "1.8", "2", "2.2"];
const richTextColors = ["#1d2524", "#b14837", "#1f8a64", "#2d6cdf", "#8a5b00", "#6d3fb2"];
const richTextBackgroundColors = ["#fff1a8", "#d7f5e5", "#dceaff", "#fde2db", "#eadcff", "#f4ead1"];
const imageAlignments = ["left", "center", "right"] as const;

type ImageAlignment = (typeof imageAlignments)[number];

const InlineStyle = Extension.create({
  name: "inlineStyle",
  addGlobalAttributes() {
    return [
      {
        types: ["textStyle"],
        attributes: {
          fontSize: {
            default: null,
            parseHTML: (element) => element.style.fontSize || null,
            renderHTML: (attributes) =>
              attributes.fontSize ? { style: `font-size: ${attributes.fontSize}` } : {},
          },
          backgroundColor: {
            default: null,
            parseHTML: (element) => element.style.backgroundColor || null,
            renderHTML: (attributes) =>
              attributes.backgroundColor ? { style: `background-color: ${attributes.backgroundColor}` } : {},
          },
        },
      },
    ];
  },
});

const BlockStyle = Extension.create({
  name: "blockStyle",
  addGlobalAttributes() {
    return [
      {
        types: ["paragraph", "heading", "blockquote", "listItem"],
        attributes: {
          lineHeight: {
            default: null,
            parseHTML: (element) => element.style.lineHeight || null,
            renderHTML: (attributes) =>
              attributes.lineHeight ? { style: `line-height: ${attributes.lineHeight}` } : {},
          },
        },
      },
    ];
  },
});

const RichImage = Image.extend({
  addAttributes() {
    return {
      ...(this.parent?.() ?? {}),
      imageAlign: {
        default: null,
        parseHTML: (element) => parseImageAlignment(element),
        renderHTML: (attributes) => renderImageAlignmentAttributes(attributes.imageAlign),
      },
    };
  },
});

type RichDocumentEditorProps = {
  className?: string;
  documentHtml: string;
  onDocumentHtmlChange: (html: string) => void;
  t: (key: string, params?: TranslationParams) => string;
  title?: string;
};

export function RichDocumentEditor({
  className,
  documentHtml,
  onDocumentHtmlChange,
  t,
  title,
}: RichDocumentEditorProps) {
  const initialShell = useMemo(() => parseDocumentShell(documentHtml), []);
  const shellRef = useRef(initialShell);
  const lastEmittedHtmlRef = useRef(documentHtml);
  const onDocumentHtmlChangeRef = useRef(onDocumentHtmlChange);
  const bodyStyleRef = useRef(initialShell.bodyStyle);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const [bodyStyle, setBodyStyle] = useState(initialShell.bodyStyle);
  const [textColor, setTextColor] = useState(richTextColors[0]);
  const [backgroundColor, setBackgroundColor] = useState(richTextBackgroundColors[0]);
  const [fontSize, setFontSize] = useState("16px");
  const [lineHeight, setLineHeight] = useState("1.8");

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        italic: false,
      }),
      TextStyle,
      InlineStyle,
      BlockStyle,
      TiptapItalic.configure({ HTMLAttributes: { style: "font-style: italic;" } }),
      Color,
      Highlight.configure({ multicolor: true }),
      TextAlign.configure({ types: ["heading", "paragraph", "blockquote", "listItem"] }),
      RichImage.configure({
        allowBase64: true,
        resize: {
          enabled: true,
          directions: ["bottom-left", "bottom-right", "top-left", "top-right"],
          minWidth: 48,
          minHeight: 48,
          alwaysPreserveAspectRatio: true,
        },
      }),
      Link.configure({ openOnClick: false }),
      Underline,
    ],
    content: initialShell.bodyHtml,
    editorProps: {
      attributes: {
        class: "rich-document-content visual-editor-document",
        spellcheck: "false",
      },
    },
    onUpdate: ({ editor }) => {
      emitChange(editor.getHTML(), bodyStyleRef.current);
    },
  });

  useEffect(() => {
    onDocumentHtmlChangeRef.current = onDocumentHtmlChange;
  }, [onDocumentHtmlChange]);

  useEffect(() => {
    bodyStyleRef.current = bodyStyle;
  }, [bodyStyle]);

  useEffect(() => {
    if (!editor || documentHtml === lastEmittedHtmlRef.current) return;

    const shell = parseDocumentShell(documentHtml);
    shellRef.current = shell;
    bodyStyleRef.current = shell.bodyStyle;
    setBodyStyle(shell.bodyStyle);
    editor.commands.setContent(shell.bodyHtml, { emitUpdate: false });
  }, [documentHtml, editor]);

  const scopedStyleText = useMemo(
    () => shellRef.current.styles.map(scopeVisualEditorCss).join("\n"),
    [documentHtml],
  );

  function emitChange(bodyHtml: string, nextBodyStyle = bodyStyle) {
    const shell = shellRef.current;
    const nextHtml = replaceDocumentBody(shell.sourceHtml, bodyHtml, nextBodyStyle);
    lastEmittedHtmlRef.current = nextHtml;
    onDocumentHtmlChangeRef.current(nextHtml);
  }

  function applyInlineStyle(style: "color" | "backgroundColor" | "fontSize", value: string) {
    if (!editor) return;
    if (style === "color") {
      editor.chain().focus().setColor(value).run();
    } else {
      editor.chain().focus().setMark("textStyle", { [style]: value }).run();
    }
  }

  function setLineHeightForSelection(value: string) {
    if (!editor) return;
    setLineHeight(value);
    editor
      .chain()
      .focus()
      .updateAttributes("paragraph", { lineHeight: value })
      .updateAttributes("heading", { lineHeight: value })
      .updateAttributes("blockquote", { lineHeight: value })
      .run();
  }

  function setPageBackground(value: string) {
    const nextStyle = setStyleProperty(bodyStyle, "background-color", value);
    bodyStyleRef.current = nextStyle;
    setBodyStyle(nextStyle);
    emitChange(editor?.getHTML() ?? shellRef.current.bodyHtml, nextStyle);
  }

  function setSelectionAlignment(value: "left" | "center" | "right" | "justify") {
    if (!editor) return;
    if (editor.isActive("image")) {
      editor
        .chain()
        .focus()
        .updateAttributes("image", { imageAlign: value === "justify" ? "center" : value })
        .run();
      return;
    }

    editor.chain().focus().setTextAlign(value).run();
  }

  async function insertImage(file: File | null) {
    if (!file || !editor) return;
    const dataUrl = await readFileAsDataUrl(file);
    editor.chain().focus().setImage({ src: dataUrl, alt: file.name }).run();
  }

  function setBlockType(value: string) {
    if (!editor) return;
    const chain = editor.chain().focus();
    if (value === "paragraph") {
      chain.setParagraph().run();
      return;
    }
    const level = Number(value.replace("heading-", "")) as 1 | 2 | 3;
    chain.toggleHeading({ level }).run();
  }

  const pageBackground = getStyleProperty(bodyStyle, "background-color") || "#ffffff";
  const currentBlock = editor?.isActive("heading", { level: 1 })
    ? "heading-1"
    : editor?.isActive("heading", { level: 2 })
      ? "heading-2"
      : editor?.isActive("heading", { level: 3 })
        ? "heading-3"
        : "paragraph";

  return (
    <div className={["rich-document-editor", className ?? ""].filter(Boolean).join(" ")}>
      <div className="rich-toolbar">
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => editor?.chain().focus().toggleBold().run()}
          title={t("format.bold")}
        >
          <Bold size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => editor?.chain().focus().toggleItalic().run()}
          title={t("format.italic")}
        >
          <Italic size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => editor?.chain().focus().toggleUnderline().run()}
          title={t("format.underline")}
        >
          <UnderlineIcon size={15} aria-hidden="true" />
        </button>
        <label className="font-size-control">
          <Pilcrow size={15} aria-hidden="true" />
          <select value={currentBlock} onChange={(event) => setBlockType(event.currentTarget.value)}>
            <option value="paragraph">{t("format.paragraph")}</option>
            <option value="heading-1">{t("format.headingOne")}</option>
            <option value="heading-2">{t("format.headingTwo")}</option>
            <option value="heading-3">{t("format.headingThree")}</option>
          </select>
        </label>
        <label className="font-size-control">
          <Type size={15} aria-hidden="true" />
          <select
            value={fontSize}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setFontSize(value);
              applyInlineStyle("fontSize", value);
            }}
            title={t("format.fontSize")}
          >
            {richTextFontSizes.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
        <label className="font-size-control">
          <FileText size={15} aria-hidden="true" />
          <select
            value={lineHeight}
            onChange={(event) => setLineHeightForSelection(event.currentTarget.value)}
            title={t("format.lineHeight")}
          >
            {richTextLineHeights.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setSelectionAlignment("left")}
          title={t("format.alignLeft")}
        >
          <AlignLeft size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setSelectionAlignment("center")}
          title={t("format.alignCenter")}
        >
          <AlignCenter size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setSelectionAlignment("right")}
          title={t("format.alignRight")}
        >
          <AlignRight size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setSelectionAlignment("justify")}
          title={t("format.alignJustify")}
        >
          <AlignJustify size={15} aria-hidden="true" />
        </button>
        <label className="rich-color-control" title={t("format.color")}>
          <Palette size={15} aria-hidden="true" />
          <input
            type="color"
            value={textColor}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setTextColor(value);
              applyInlineStyle("color", value);
            }}
          />
        </label>
        <label className="rich-color-control" title={t("format.backgroundColor")}>
          <PaintBucket size={15} aria-hidden="true" />
          <input
            type="color"
            value={backgroundColor}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setBackgroundColor(value);
              applyInlineStyle("backgroundColor", value);
            }}
          />
        </label>
        <label className="rich-color-control" title={t("format.pageBackgroundColor")}>
          <FileText size={15} aria-hidden="true" />
          <input type="color" value={normalizeColorInput(pageBackground)} onChange={(event) => setPageBackground(event.currentTarget.value)} />
        </label>
        <button type="button" onClick={() => imageInputRef.current?.click()} title={t("action.importImage")}>
          <ImageUp size={15} aria-hidden="true" />
        </button>
        <button type="button" onClick={() => editor?.chain().focus().toggleLink({ href: "" }).run()} title={t("format.link")}>
          <LinkIcon size={15} aria-hidden="true" />
        </button>
        <input
          ref={imageInputRef}
          type="file"
          accept="image/*"
          className="rich-hidden-file-input"
          onChange={(event) => {
            void insertImage(event.currentTarget.files?.[0] ?? null);
            event.currentTarget.value = "";
          }}
        />
      </div>
      <div className="visual-editor-frame rich-document-frame" title={title}>
        {scopedStyleText && <style>{scopedStyleText}</style>}
        <EditorContent editor={editor} style={{ backgroundColor: pageBackground }} />
      </div>
    </div>
  );
}

function parseDocumentShell(sourceHtml: string) {
  const source = sourceHtml.trim() ? sourceHtml : "<!doctype html><html><head></head><body></body></html>";
  const doc = new DOMParser().parseFromString(source, "text/html");
  return {
    sourceHtml: source,
    bodyHtml: doc.body.innerHTML,
    bodyStyle: doc.body.getAttribute("style") ?? "",
    styles: Array.from(doc.head.querySelectorAll("style")).map((style) => style.textContent ?? ""),
  };
}

function parseImageAlignment(element: HTMLElement): ImageAlignment | null {
  const explicitAlign = element.getAttribute("data-align");
  if (isImageAlignment(explicitAlign)) return explicitAlign;

  const parentAlign = element.parentElement?.style.textAlign;
  if (isImageAlignment(parentAlign)) return parentAlign;

  const style = (element.getAttribute("style") ?? "").replace(/\s/g, "").toLowerCase();
  if (style.includes("margin-left:auto") && style.includes("margin-right:auto")) return "center";
  if (style.includes("margin-left:auto") || style.includes("float:right")) return "right";
  if (style.includes("margin-right:auto") || style.includes("float:left")) return "left";

  return null;
}

function renderImageAlignmentAttributes(value: unknown) {
  if (!isImageAlignment(value)) return {};

  const margins =
    value === "center"
      ? "margin-left: auto; margin-right: auto;"
      : value === "right"
        ? "margin-left: auto; margin-right: 0;"
        : "margin-left: 0; margin-right: auto;";

  return {
    "data-align": value,
    style: `display: block; ${margins}`,
  };
}

function isImageAlignment(value: unknown): value is ImageAlignment {
  return typeof value === "string" && imageAlignments.includes(value as ImageAlignment);
}

function replaceDocumentBody(source: string, bodyHtml: string, bodyStyle?: string | null) {
  if (/<body\b[^>]*>/i.test(source) && /<\/body>/i.test(source)) {
    return source.replace(/(<body\b[^>]*>)[\s\S]*?(<\/body>)/i, (_match, openTag, closeTag) => {
      return `${setTagStyle(openTag, bodyStyle)}\n${bodyHtml}\n${closeTag}`;
    });
  }

  return bodyHtml;
}

function setTagStyle(openTag: string, style?: string | null) {
  const normalizedStyle = normalizeStyleAttribute(style);
  if (/style\s*=/i.test(openTag)) {
    return openTag.replace(/\sstyle\s*=\s*(["'])(.*?)\1/i, normalizedStyle ? ` style="${escapeHtmlAttribute(normalizedStyle)}"` : "");
  }

  return normalizedStyle ? openTag.replace(/>$/, ` style="${escapeHtmlAttribute(normalizedStyle)}">`) : openTag;
}

function setStyleProperty(style: string, property: string, value: string) {
  const entries = new Map<string, string>();
  style.split(";").forEach((part) => {
    const [name, ...rest] = part.split(":");
    if (!name || rest.length === 0) return;
    entries.set(name.trim().toLowerCase(), rest.join(":").trim());
  });
  entries.set(property, value);
  return Array.from(entries.entries())
    .filter(([, entryValue]) => entryValue)
    .map(([name, entryValue]) => `${name}: ${entryValue}`)
    .join("; ");
}

function getStyleProperty(style: string, property: string) {
  const needle = property.toLowerCase();
  for (const part of style.split(";")) {
    const [name, ...rest] = part.split(":");
    if (name?.trim().toLowerCase() === needle) return rest.join(":").trim();
  }
  return "";
}

function normalizeColorInput(value: string) {
  if (/^#[0-9a-f]{6}$/i.test(value)) return value;
  return "#ffffff";
}

function normalizeStyleAttribute(style: string | null | undefined) {
  return (style ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .join("; ");
}

function escapeHtmlAttribute(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("Unable to read image data"));
      }
    });
    reader.addEventListener("error", () => reject(reader.error ?? new Error("Unable to read image data")));
    reader.readAsDataURL(file);
  });
}

function scopeVisualEditorCss(css: string) {
  const withoutDocumentRules = css.replace(/@charset\s+[^;]+;/gi, "").replace(/@import\s+[^;]+;/gi, "");
  return scopeCssBlock(withoutDocumentRules);
}

function scopeCssBlock(css: string): string {
  let output = "";
  let cursor = 0;

  while (cursor < css.length) {
    const open = css.indexOf("{", cursor);
    if (open === -1) {
      output += css.slice(cursor);
      break;
    }

    const rawPrelude = css.slice(cursor, open);
    const prelude = rawPrelude.trim();
    const beforePrelude = rawPrelude.match(/^\s*/)?.[0] ?? "";
    const close = findCssBlockEnd(css, open);
    if (close === -1) {
      output += css.slice(cursor);
      break;
    }

    const body = css.slice(open + 1, close);

    if (prelude.startsWith("@font-face")) {
      output += beforePrelude;
    } else if (prelude.startsWith("@media") || prelude.startsWith("@supports") || prelude.startsWith("@container")) {
      output += `${beforePrelude}${prelude}{${scopeCssBlock(body)}}`;
    } else if (prelude.startsWith("@")) {
      output += css.slice(cursor, close + 1);
    } else {
      const scopedSelectors = prelude
        .split(",")
        .map((selector) => scopeVisualEditorSelector(selector.trim()))
        .filter(Boolean)
        .join(", ");
      output += `${beforePrelude}${scopedSelectors || prelude}{${body}}`;
    }

    cursor = close + 1;
  }

  return output;
}

function findCssBlockEnd(css: string, openIndex: number) {
  let depth = 0;
  let quote: string | null = null;

  for (let index = openIndex; index < css.length; index += 1) {
    const char = css[index];
    const previous = css[index - 1];

    if (quote) {
      if (char === quote && previous !== "\\") quote = null;
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

function scopeVisualEditorSelector(selector: string) {
  if (
    !selector ||
    selector.startsWith("@") ||
    selector === "from" ||
    selector === "to" ||
    selector.includes("%")
  ) {
    return selector;
  }

  if (selector === "html" || selector === ":root") return ".rich-document-frame";
  if (selector === "body") return ".visual-editor-document";
  if (selector.startsWith("body.")) return `.visual-editor-document${selector.slice(4)}`;
  if (selector.startsWith("body#")) return `.visual-editor-document${selector.slice(4)}`;
  if (selector.startsWith("body:")) return `.visual-editor-document${selector.slice(4)}`;
  if (selector.startsWith("body[")) return `.visual-editor-document${selector.slice(4)}`;
  if (selector.startsWith("body ")) return `.visual-editor-document ${selector.slice(5)}`;
  if (selector.startsWith("html ")) return `.rich-document-frame ${selector.slice(5)}`;

  return `.visual-editor-document ${selector}`;
}
