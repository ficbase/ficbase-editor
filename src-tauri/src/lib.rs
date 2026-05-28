use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};
use transmute::{
    html_to_text, open_epub_project, open_epub_project_file, write_epub, write_epub_project_file,
    Book, Chapter, EpubProject, EpubResource, ManifestItem, Metadata,
};

struct EditorSession {
    source_path: Option<PathBuf>,
    output_path: Option<PathBuf>,
    project: EpubProject,
    resource_data_url_cache: HashMap<String, String>,
}

#[derive(Default)]
struct EditorState {
    session: Mutex<Option<EditorSession>>,
}

const FICBASE_CHAPTER_STYLE_FILE: &str = "styles/ficbase-chapter.css";
const FICBASE_DEFAULT_CHAPTER_CSS: &str = "/* ficbase chapter format start */\n/* Use the editor to update shared chapter styles. */\n/* ficbase chapter format end */\n";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectSnapshot {
    source_path: Option<String>,
    output_path: Option<String>,
    rootfile_path: String,
    metadata: MetadataDto,
    cover: Option<CoverDto>,
    resources: Vec<ResourceDto>,
    spine_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MetadataDto {
    title: String,
    author: String,
    language: String,
    identifier: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResourceDto {
    path: String,
    name: String,
    media_type: Option<String>,
    kind: String,
    size: usize,
    editable: bool,
    in_spine: bool,
    spine_index: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CoverDto {
    path: String,
    name: String,
    media_type: String,
    size: usize,
    data_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LinkedStyleDto {
    path: String,
    name: String,
    media_type: Option<String>,
    content: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VisualResourceUrlDto {
    data_url: String,
    original: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VisualDocumentDto {
    html: String,
    resource_urls: Vec<VisualResourceUrlDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttributeSnapshotDto {
    name: String,
    value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChapterFormatTemplateDto {
    source_path: String,
    body_style: Vec<AttributeSnapshotDto>,
    title_style: Vec<AttributeSnapshotDto>,
    paragraph_style: Vec<AttributeSnapshotDto>,
    decoration_style: Option<Vec<AttributeSnapshotDto>>,
    decoration_image_style: Option<Vec<AttributeSnapshotDto>>,
    custom_css: Option<String>,
    decoration_html: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedChapterTemplateDto {
    id: String,
    name: String,
    created_at: u64,
    format: ChapterFormatTemplateDto,
}

#[derive(Debug, Clone)]
struct StoredChapterTemplate {
    directory_name: String,
    template: SavedChapterTemplateDto,
}

#[tauri::command]
fn open_epub(
    path: Option<String>,
    state: State<'_, EditorState>,
) -> Result<ProjectSnapshot, String> {
    let Some(path) = path.map(PathBuf::from).or_else(pick_epub_file) else {
        return Err("No EPUB selected".into());
    };

    let project = open_epub_project_file(&path).map_err(|e| e.to_string())?;
    let session = EditorSession {
        source_path: Some(path),
        output_path: None,
        project,
        resource_data_url_cache: HashMap::new(),
    };
    let snapshot = snapshot(&session);

    *state
        .session
        .lock()
        .map_err(|_| "Editor state is unavailable")? = Some(session);
    Ok(snapshot)
}

#[tauri::command]
fn import_book(
    path: Option<String>,
    state: State<'_, EditorState>,
) -> Result<ProjectSnapshot, String> {
    let Some(path) = path.map(PathBuf::from).or_else(pick_book_file) else {
        return Err("No book selected".into());
    };

    let project = import_project_file(&path)?;
    let session = EditorSession {
        source_path: Some(path),
        output_path: None,
        project,
        resource_data_url_cache: HashMap::new(),
    };
    let snapshot = snapshot(&session);

    *state
        .session
        .lock()
        .map_err(|_| "Editor state is unavailable")? = Some(session);
    Ok(snapshot)
}

#[tauri::command]
fn save_epub(
    path: Option<String>,
    state: State<'_, EditorState>,
) -> Result<ProjectSnapshot, String> {
    let mut guard = state
        .session
        .lock()
        .map_err(|_| "Editor state is unavailable")?;
    let session = guard
        .as_mut()
        .ok_or_else(|| "Open an EPUB before saving".to_string())?;

    let output_path = match path.map(PathBuf::from).or_else(|| save_epub_file(session)) {
        Some(path) => path,
        None => return Err("No output path selected".into()),
    };

    write_epub_project_file(&session.project, &output_path).map_err(|e| e.to_string())?;
    session.output_path = Some(output_path);
    Ok(snapshot(session))
}

#[tauri::command]
fn export_book(
    format: Option<String>,
    path: Option<String>,
    state: State<'_, EditorState>,
) -> Result<ProjectSnapshot, String> {
    let format = normalize_export_format(format.as_deref());
    let output_path = if let Some(path) = path.map(PathBuf::from) {
        ensure_extension(path, format)
    } else {
        let default_name = {
            let guard = state
                .session
                .lock()
                .map_err(|_| "Editor state is unavailable")?;
            let session = guard
                .as_ref()
                .ok_or_else(|| "Import a book before exporting".to_string())?;
            default_export_file_name(session, format)
        };
        save_export_file_with_default_name(&default_name, format)
            .map(|path| ensure_extension(path, format))
            .ok_or_else(|| "No output path selected".to_string())?
    };

    let mut guard = state
        .session
        .lock()
        .map_err(|_| "Editor state is unavailable")?;
    let session = guard
        .as_mut()
        .ok_or_else(|| "Import a book before exporting".to_string())?;

    match format {
        "txt" => write_txt_project_file(&session.project, &output_path)?,
        _ => write_epub_project_file(&session.project, &output_path).map_err(|e| e.to_string())?,
    }

    session.output_path = Some(output_path);
    Ok(snapshot(session))
}

#[tauri::command]
fn read_text_resource(path: String, state: State<'_, EditorState>) -> Result<String, String> {
    let guard = state
        .session
        .lock()
        .map_err(|_| "Editor state is unavailable")?;
    let session = guard
        .as_ref()
        .ok_or_else(|| "Open an EPUB before reading resources".to_string())?;

    session
        .project
        .read_text_resource(&path)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn render_preview_resource(
    path: String,
    draft: Option<String>,
    style_drafts: Option<HashMap<String, String>>,
    state: State<'_, EditorState>,
) -> Result<String, String> {
    let mut guard = state
        .session
        .lock()
        .map_err(|_| "Editor state is unavailable")?;
    let session = guard
        .as_mut()
        .ok_or_else(|| "Open an EPUB before previewing resources".to_string())?;

    let source = match draft {
        Some(content) => content,
        None => session
            .project
            .read_text_resource(&path)
            .map_err(|e| e.to_string())?,
    };

    Ok(render_preview_html(
        &session.project,
        &path,
        &source,
        &style_drafts.unwrap_or_default(),
        &mut session.resource_data_url_cache,
    ))
}

#[tauri::command]
fn render_visual_resource(
    path: String,
    draft: Option<String>,
    style_drafts: Option<HashMap<String, String>>,
    state: State<'_, EditorState>,
) -> Result<VisualDocumentDto, String> {
    let mut guard = state
        .session
        .lock()
        .map_err(|_| "Editor state is unavailable")?;
    let session = guard
        .as_mut()
        .ok_or_else(|| "Open an EPUB before previewing resources".to_string())?;

    let source = match draft {
        Some(content) => content,
        None => session
            .project
            .read_text_resource(&path)
            .map_err(|e| e.to_string())?,
    };

    Ok(render_visual_html(
        &session.project,
        &path,
        &source,
        &style_drafts.unwrap_or_default(),
        &mut session.resource_data_url_cache,
    ))
}

#[tauri::command]
fn read_resource_data_url(path: String, state: State<'_, EditorState>) -> Result<String, String> {
    let guard = state
        .session
        .lock()
        .map_err(|_| "Editor state is unavailable")?;
    let session = guard
        .as_ref()
        .ok_or_else(|| "Open an EPUB before previewing resources".to_string())?;

    let resource = session
        .project
        .get_resource(&path)
        .ok_or_else(|| format!("Resource not found: {path}"))?;
    Ok(resource_to_data_url(resource))
}

#[tauri::command]
fn list_chapter_templates(app: tauri::AppHandle) -> Result<Vec<SavedChapterTemplateDto>, String> {
    let root = chapter_templates_root(&app)?;
    load_chapter_templates(&root)
}

#[tauri::command]
fn save_chapter_template(
    app: tauri::AppHandle,
    template: SavedChapterTemplateDto,
) -> Result<Vec<SavedChapterTemplateDto>, String> {
    let root = chapter_templates_root(&app)?;
    let stored_template = store_chapter_template(&root, template)?;
    let mut records = load_stored_chapter_templates(&root)?;
    records.retain(|record| {
        record.template.id == stored_template.id
            || (record.template.id != stored_template.id
                && record.template.name != stored_template.name)
    });
    records.sort_by(|left, right| right.template.created_at.cmp(&left.template.created_at));
    records.truncate(20);
    cleanup_chapter_template_directories(&root, &records)?;
    Ok(rehydrate_stored_chapter_templates(&root, records))
}

#[tauri::command]
fn materialize_chapter_template_assets(
    app: tauri::AppHandle,
    template: SavedChapterTemplateDto,
    state: State<'_, EditorState>,
) -> Result<ChapterFormatTemplateDto, String> {
    let root = chapter_templates_root(&app)?;
    let mut guard = state
        .session
        .lock()
        .map_err(|_| "Editor state is unavailable")?;
    let session = guard
        .as_mut()
        .ok_or_else(|| "Import a book before applying a template".to_string())?;

    let format = materialize_template_assets_for_project(&mut session.project, &root, template)?;
    session.resource_data_url_cache.clear();
    Ok(format)
}

#[tauri::command]
fn update_text_resource(
    path: String,
    content: String,
    state: State<'_, EditorState>,
) -> Result<ProjectSnapshot, String> {
    let mut guard = state
        .session
        .lock()
        .map_err(|_| "Editor state is unavailable")?;
    let session = guard
        .as_mut()
        .ok_or_else(|| "Open an EPUB before editing resources".to_string())?;

    session
        .project
        .set_text_resource(&path, content)
        .map_err(|e| e.to_string())?;
    Ok(snapshot(session))
}

#[tauri::command]
fn update_text_resources(
    edits: HashMap<String, String>,
    state: State<'_, EditorState>,
) -> Result<ProjectSnapshot, String> {
    let mut guard = state
        .session
        .lock()
        .map_err(|_| "Editor state is unavailable")?;
    let session = guard
        .as_mut()
        .ok_or_else(|| "Open an EPUB before editing resources".to_string())?;

    for (path, content) in edits {
        session
            .project
            .set_text_resource(&path, content)
            .map_err(|e| e.to_string())?;
    }

    Ok(snapshot(session))
}

#[tauri::command]
fn update_text_resources_with_style(
    edits: HashMap<String, String>,
    style_path: String,
    style_content: String,
    state: State<'_, EditorState>,
) -> Result<ProjectSnapshot, String> {
    let mut guard = state
        .session
        .lock()
        .map_err(|_| "Editor state is unavailable")?;
    let session = guard
        .as_mut()
        .ok_or_else(|| "Open an EPUB before editing resources".to_string())?;

    ensure_stylesheet_resource(&mut session.project, &style_path, &style_content)?;

    for (path, content) in edits {
        session
            .project
            .set_text_resource(&path, content)
            .map_err(|e| e.to_string())?;
    }

    Ok(snapshot(session))
}

#[tauri::command]
fn list_page_stylesheets(
    path: String,
    draft: Option<String>,
    state: State<'_, EditorState>,
) -> Result<Vec<LinkedStyleDto>, String> {
    let guard = state
        .session
        .lock()
        .map_err(|_| "Editor state is unavailable")?;
    let session = guard
        .as_ref()
        .ok_or_else(|| "Open an EPUB before editing styles".to_string())?;

    let source = match draft {
        Some(content) => content,
        None => session
            .project
            .read_text_resource(&path)
            .map_err(|e| e.to_string())?,
    };

    Ok(linked_stylesheet_paths(&session.project, &path, &source)
        .into_iter()
        .filter_map(|style_path| {
            let resource = session.project.get_resource(&style_path)?;
            let content = resource.text().ok()?;
            Some(LinkedStyleDto {
                path: resource.path.clone(),
                name: resource_name(&resource.path),
                media_type: resource.media_type.clone(),
                content,
            })
        })
        .collect())
}

#[tauri::command]
fn replace_cover_image(
    path: Option<String>,
    state: State<'_, EditorState>,
) -> Result<ProjectSnapshot, String> {
    let image_path = path.map(PathBuf::from).or_else(pick_image_file);
    let Some(image_path) = image_path else {
        return Err("No cover image selected".into());
    };
    let media_type = image_mime_from_path(&image_path)
        .ok_or_else(|| "Unsupported cover image type".to_string())?;
    let data = fs::read(&image_path).map_err(|e| e.to_string())?;

    let mut guard = state
        .session
        .lock()
        .map_err(|_| "Editor state is unavailable")?;
    let session = guard
        .as_mut()
        .ok_or_else(|| "Open an EPUB before replacing the cover".to_string())?;

    let cover_item = cover_manifest_item(&session.project).cloned();
    let (target_path, existing_id) = if let Some(item) = cover_item {
        (item.path, Some(item.id))
    } else {
        (next_cover_path(&session.project, &image_path), None)
    };

    if let Some(resource) = session.project.get_resource_mut(&target_path) {
        resource.data = data;
        resource.media_type = Some(media_type.clone());
    } else {
        session.project.resources.push(EpubResource {
            path: target_path.clone(),
            media_type: Some(media_type.clone()),
            data,
        });
    }

    let mut opf = session
        .project
        .read_text_resource(&session.project.rootfile_path)
        .map_err(|e| e.to_string())?;

    if let Some(id) = existing_id {
        update_manifest_item_media_type(&mut opf, &id, &media_type)?;
    } else {
        let id = next_manifest_id(&session.project, "cover-image");
        let href = href_from_package_dir(&session.project.package_dir, &target_path);
        insert_manifest_item_with_properties(&mut opf, &id, &href, &media_type, "cover-image")?;
    }

    let rootfile_path = session.project.rootfile_path.clone();
    session
        .project
        .set_text_resource(&rootfile_path, opf)
        .map_err(|e| e.to_string())?;
    session.resource_data_url_cache.clear();

    Ok(snapshot(session))
}

#[tauri::command]
fn update_metadata(
    metadata: MetadataDto,
    state: State<'_, EditorState>,
) -> Result<ProjectSnapshot, String> {
    let mut guard = state
        .session
        .lock()
        .map_err(|_| "Editor state is unavailable")?;
    let session = guard
        .as_mut()
        .ok_or_else(|| "Open an EPUB before editing metadata".to_string())?;

    session
        .project
        .set_metadata(Metadata {
            title: metadata.title,
            author: metadata.author,
            language: metadata.language,
            identifier: metadata.identifier,
            extra: HashMap::new(),
        })
        .map_err(|e| e.to_string())?;

    Ok(snapshot(session))
}

#[tauri::command]
fn add_html_resource(
    title: Option<String>,
    after_path: Option<String>,
    state: State<'_, EditorState>,
) -> Result<ProjectSnapshot, String> {
    let mut guard = state
        .session
        .lock()
        .map_err(|_| "Editor state is unavailable")?;
    let session = guard
        .as_mut()
        .ok_or_else(|| "Open an EPUB before adding HTML".to_string())?;

    let title = title
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "New Section".into());
    let path = next_html_path(&session.project, after_path.as_deref());
    let id = next_manifest_id(&session.project, "ficbase-html");
    let href = href_from_package_dir(&session.project.package_dir, &path);
    let after_idref = after_path
        .as_deref()
        .and_then(|path| manifest_id_for_path(&session.project, path));

    let mut opf = session
        .project
        .read_text_resource(&session.project.rootfile_path)
        .map_err(|e| e.to_string())?;
    insert_manifest_item(&mut opf, &id, &href, "application/xhtml+xml")?;
    insert_spine_item(&mut opf, &id, after_idref.as_deref())?;

    session.project.resources.push(EpubResource {
        path: path.clone(),
        media_type: Some("application/xhtml+xml".into()),
        data: default_html_document(&title).into_bytes(),
    });

    let rootfile_path = session.project.rootfile_path.clone();
    session
        .project
        .set_text_resource(&rootfile_path, opf)
        .map_err(|e| e.to_string())?;

    Ok(snapshot(session))
}

#[tauri::command]
fn delete_html_resource(
    path: String,
    state: State<'_, EditorState>,
) -> Result<ProjectSnapshot, String> {
    let mut guard = state
        .session
        .lock()
        .map_err(|_| "Editor state is unavailable")?;
    let session = guard
        .as_mut()
        .ok_or_else(|| "Open an EPUB before deleting HTML".to_string())?;

    let path = normalize_resource_path(&path);
    if path == session.project.rootfile_path {
        return Err("The OPF package file cannot be deleted".into());
    }

    let item = session
        .project
        .manifest
        .iter()
        .find(|item| item.path == path)
        .cloned()
        .ok_or_else(|| format!("Resource is not declared in manifest: {path}"))?;

    if item
        .properties
        .split_whitespace()
        .any(|property| property == "nav")
    {
        return Err("The EPUB navigation document cannot be deleted yet".into());
    }
    if !is_html_manifest_item(&item) {
        return Err("Only HTML/XHTML resources can be deleted here".into());
    }

    let mut opf = session
        .project
        .read_text_resource(&session.project.rootfile_path)
        .map_err(|e| e.to_string())?;
    remove_tag_with_attr(&mut opf, "item", "id", &item.id)?;
    remove_tag_with_attr(&mut opf, "itemref", "idref", &item.id)?;
    session
        .project
        .resources
        .retain(|resource| resource.path != path);

    let rootfile_path = session.project.rootfile_path.clone();
    session
        .project
        .set_text_resource(&rootfile_path, opf)
        .map_err(|e| e.to_string())?;

    Ok(snapshot(session))
}

#[tauri::command]
fn close_project(state: State<'_, EditorState>) -> Result<(), String> {
    *state
        .session
        .lock()
        .map_err(|_| "Editor state is unavailable")? = None;
    Ok(())
}

fn snapshot(session: &EditorSession) -> ProjectSnapshot {
    let spine_paths: Vec<String> = session
        .project
        .spine
        .iter()
        .filter(|item| item.linear)
        .filter_map(|item| item.path.clone())
        .collect();
    let spine_order: HashMap<&str, usize> = spine_paths
        .iter()
        .enumerate()
        .map(|(index, path)| (path.as_str(), index))
        .collect();
    let manifest_by_path: HashMap<&str, &ManifestItem> = session
        .project
        .manifest
        .iter()
        .map(|item| (item.path.as_str(), item))
        .collect();

    let mut resources: Vec<ResourceDto> = session
        .project
        .resources
        .iter()
        .map(|resource| {
            let manifest_item = manifest_by_path.get(resource.path.as_str()).copied();
            let spine_index = spine_order.get(resource.path.as_str()).copied();
            let in_spine = spine_index.is_some();
            let kind = classify_resource(
                resource,
                manifest_item,
                &session.project.rootfile_path,
                in_spine,
            );
            ResourceDto {
                path: resource.path.clone(),
                name: resource_name(&resource.path),
                media_type: resource.media_type.clone(),
                editable: is_editable(&kind),
                kind,
                size: resource.data.len(),
                in_spine,
                spine_index,
            }
        })
        .collect();

    resources.sort_by(|a, b| resource_sort_key(a).cmp(&resource_sort_key(b)));

    ProjectSnapshot {
        source_path: session.source_path.as_ref().map(display_path),
        output_path: session.output_path.as_ref().map(display_path),
        rootfile_path: session.project.rootfile_path.clone(),
        metadata: MetadataDto::from(&session.project.metadata),
        cover: cover_snapshot(&session.project),
        resources,
        spine_paths,
    }
}

fn pick_epub_file() -> Option<PathBuf> {
    rfd::FileDialog::new()
        .add_filter("EPUB", &["epub"])
        .pick_file()
}

fn pick_book_file() -> Option<PathBuf> {
    rfd::FileDialog::new()
        .add_filter("Book", &["epub", "txt"])
        .add_filter("EPUB", &["epub"])
        .add_filter("Text", &["txt"])
        .pick_file()
}

fn pick_image_file() -> Option<PathBuf> {
    rfd::FileDialog::new()
        .add_filter("Image", &["jpg", "jpeg", "png", "gif", "webp", "svg"])
        .pick_file()
}

fn save_epub_file(session: &EditorSession) -> Option<PathBuf> {
    save_export_file(session, "epub").map(|path| ensure_extension(path, "epub"))
}

fn save_export_file(session: &EditorSession, format: &str) -> Option<PathBuf> {
    let format = normalize_export_format(Some(format));
    let default_name = default_export_file_name(session, format);
    save_export_file_with_default_name(&default_name, format)
}

fn default_export_file_name(session: &EditorSession, format: &str) -> String {
    let title = sanitize_file_stem(&session.project.metadata.title);
    let stem = if title.is_empty() {
        session
            .source_path
            .as_ref()
            .and_then(|path| path.file_stem())
            .and_then(|stem| stem.to_str())
            .map(sanitize_file_stem)
            .filter(|stem| !stem.is_empty())
            .unwrap_or_else(|| "ficbase-book".into())
    } else {
        title
    };
    format!("{stem}.{format}")
}

fn save_export_file_with_default_name(default_name: &str, format: &str) -> Option<PathBuf> {
    let format = normalize_export_format(Some(format));
    let mut dialog = rfd::FileDialog::new().set_file_name(default_name);

    dialog = match format {
        "txt" => dialog.add_filter("Text", &["txt"]),
        _ => dialog.add_filter("EPUB", &["epub"]),
    };

    dialog.save_file()
}

fn normalize_export_format(format: Option<&str>) -> &'static str {
    match format.unwrap_or("epub").to_ascii_lowercase().as_str() {
        "txt" | "text" => "txt",
        _ => "epub",
    }
}

fn ensure_extension(path: PathBuf, extension: &str) -> PathBuf {
    if path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case(extension))
        .unwrap_or(false)
    {
        return path;
    }

    let mut path = path;
    path.set_extension(extension);
    path
}

fn import_project_file(path: &Path) -> Result<EpubProject, String> {
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    if extension == "txt" {
        txt_file_to_epub_project(path)
    } else {
        open_epub_project_file(path).map_err(|e| e.to_string())
    }
}

fn txt_file_to_epub_project(path: &Path) -> Result<EpubProject, String> {
    let data = fs::read(path).map_err(|e| e.to_string())?;
    let text = String::from_utf8(data.clone())
        .unwrap_or_else(|_| String::from_utf8_lossy(&data).into_owned())
        .trim_start_matches('\u{feff}')
        .to_string();
    let title = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("Untitled")
        .to_string();
    let chapters = split_txt_chapters(&text, &title);
    let has_preface = chapters.len() > 1
        && chapters
            .first()
            .map(|chapter| is_txt_preface_title(&chapter.title))
            .unwrap_or(false);
    let book = Book {
        metadata: Metadata {
            title,
            author: String::new(),
            language: "zh-CN".into(),
            identifier: String::new(),
            extra: HashMap::new(),
        },
        chapters,
        cover: None,
    };

    let mut cursor = Cursor::new(Vec::new());
    write_epub(&book, &mut cursor).map_err(|e| e.to_string())?;
    let mut project =
        open_epub_project(Cursor::new(cursor.into_inner())).map_err(|e| e.to_string())?;
    if has_preface {
        normalize_txt_import_chapter_paths(&mut project)?;
    }
    ensure_ficbase_chapter_stylesheet(&mut project)?;
    Ok(project)
}

fn split_txt_chapters(text: &str, fallback_title: &str) -> Vec<Chapter> {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut chapters = Vec::new();
    let mut current_title = txt_preface_title(&normalized);
    let mut current_body: Vec<String> = Vec::new();
    let mut saw_heading = false;

    for line in normalized.lines() {
        let trimmed = line.trim();
        if is_txt_chapter_heading(trimmed) {
            if saw_heading || current_body.iter().any(|line| !line.trim().is_empty()) {
                push_txt_chapter(&mut chapters, &current_title, &current_body);
                current_body.clear();
            }
            current_title = trimmed.to_string();
            saw_heading = true;
            continue;
        }

        current_body.push(line.to_string());
    }

    if saw_heading {
        push_txt_chapter(&mut chapters, &current_title, &current_body);
    } else {
        let body = txt_lines_to_body(&current_body);
        if !body.is_empty() {
            chapters.push(Chapter {
                title: fallback_title.to_string(),
                body,
            });
        }
    }
    if chapters.is_empty() {
        chapters.push(Chapter {
            title: fallback_title.to_string(),
            body: txt_lines_to_body(&text.lines().map(str::to_string).collect::<Vec<_>>()),
        });
    }
    chapters
}

fn push_txt_chapter(chapters: &mut Vec<Chapter>, title: &str, lines: &[String]) {
    let body = txt_lines_to_body(lines);
    if body.is_empty() && !chapters.is_empty() {
        return;
    }

    chapters.push(Chapter {
        title: title.trim().to_string(),
        body,
    });
}

fn txt_lines_to_body(lines: &[String]) -> String {
    let Some(start) = lines.iter().position(|line| !line.trim().is_empty()) else {
        return String::new();
    };
    let end = lines
        .iter()
        .rposition(|line| !line.trim().is_empty())
        .map(|index| index + 1)
        .unwrap_or(start);

    lines[start..end].join("\n")
}

fn is_txt_chapter_heading(value: &str) -> bool {
    let char_count = value.chars().count();
    if !(2..=48).contains(&char_count) {
        return false;
    }

    let lower = value.to_ascii_lowercase();
    if lower.starts_with("chapter ") || lower.starts_with("chapter\t") {
        return true;
    }

    value.starts_with('第') && ["章", "节", "回"].iter().any(|unit| value.contains(unit))
}

fn txt_preface_title(text: &str) -> String {
    if text
        .chars()
        .any(|ch| ('\u{4e00}'..='\u{9fff}').contains(&ch))
    {
        "前言".into()
    } else {
        "Preface".into()
    }
}

fn is_txt_preface_title(value: &str) -> bool {
    matches!(value.trim(), "前言" | "Preface")
}

fn normalize_txt_import_chapter_paths(project: &mut EpubProject) -> Result<(), String> {
    let chapter_paths: Vec<String> = project
        .spine
        .iter()
        .filter(|item| item.linear)
        .filter_map(|item| item.path.clone())
        .collect();
    if chapter_paths.is_empty() {
        return Ok(());
    }

    let renames: Vec<TxtChapterRename> = chapter_paths
        .iter()
        .enumerate()
        .filter_map(|(index, old_path)| {
            let old_id = manifest_id_for_path(project, old_path)?;
            let new_stem = if index == 0 {
                "preface".to_string()
            } else {
                format!("chapter{index}")
            };
            let new_path = chapter_path_with_stem(old_path, &new_stem);
            Some(TxtChapterRename {
                old_id,
                new_id: new_stem,
                old_path: old_path.clone(),
                new_path,
            })
        })
        .collect();

    if renames.is_empty() {
        return Ok(());
    }

    let rootfile_path = project.rootfile_path.clone();
    let mut opf = project
        .read_text_resource(&rootfile_path)
        .map_err(|e| e.to_string())?;
    let nav_path = project
        .manifest
        .iter()
        .find(|item| {
            item.properties
                .split_whitespace()
                .any(|property| property == "nav")
        })
        .map(|item| item.path.clone());
    let mut nav = nav_path
        .as_deref()
        .and_then(|path| project.read_text_resource(path).ok());

    for rename in &renames {
        opf = rewrite_txt_chapter_references(&opf, rename, &project.package_dir);
        if let Some(nav_html) = nav.as_mut() {
            *nav_html = rewrite_txt_chapter_references(nav_html, rename, &project.package_dir);
        }
    }

    for resource in &mut project.resources {
        if let Some(rename) = renames
            .iter()
            .find(|rename| rename.old_path == resource.path)
        {
            resource.path = rename.new_path.clone();
        }
    }

    project
        .set_text_resource(&rootfile_path, opf)
        .map_err(|e| e.to_string())?;
    if let (Some(nav_path), Some(nav_html)) = (nav_path, nav) {
        project
            .set_text_resource(&nav_path, nav_html)
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

struct TxtChapterRename {
    old_id: String,
    new_id: String,
    old_path: String,
    new_path: String,
}

fn chapter_path_with_stem(path: &str, stem: &str) -> String {
    let extension = Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("xhtml");
    let directory = Path::new(path)
        .parent()
        .and_then(|parent| parent.to_str())
        .unwrap_or_default();
    if directory.is_empty() {
        format!("{stem}.{extension}")
    } else {
        normalize_resource_path(&format!("{directory}/{stem}.{extension}"))
    }
}

fn rewrite_txt_chapter_references(
    source: &str,
    rename: &TxtChapterRename,
    package_dir: &str,
) -> String {
    let old_href = href_from_package_dir(package_dir, &rename.old_path);
    let new_href = href_from_package_dir(package_dir, &rename.new_path);
    source
        .replace(
            &format!("id=\"{}\"", escape_attr(&rename.old_id)),
            &format!("id=\"{}\"", escape_attr(&rename.new_id)),
        )
        .replace(
            &format!("idref=\"{}\"", escape_attr(&rename.old_id)),
            &format!("idref=\"{}\"", escape_attr(&rename.new_id)),
        )
        .replace(
            &format!("href=\"{}\"", escape_attr(&old_href)),
            &format!("href=\"{}\"", escape_attr(&new_href)),
        )
}

fn write_txt_project_file(project: &EpubProject, path: &Path) -> Result<(), String> {
    fs::write(path, project_to_txt(project)).map_err(|e| e.to_string())
}

fn project_to_txt(project: &EpubProject) -> String {
    let mut sections = Vec::new();

    for resource in project.chapter_resources() {
        let Ok(html) = resource.text() else {
            continue;
        };
        let title = extract_xhtml_title(&html).unwrap_or_else(|| resource_name(&resource.path));
        let body = xhtml_to_plain_text(&html, &title);
        let mut section = String::new();
        if !title.trim().is_empty() {
            section.push_str(title.trim());
            section.push_str("\n\n");
        }
        section.push_str(body.trim());
        sections.push(section.trim().to_string());
    }

    sections
        .into_iter()
        .filter(|section| !section.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn extract_xhtml_title(html: &str) -> Option<String> {
    extract_element_text(html, "title")
        .or_else(|| extract_element_text(html, "h1"))
        .map(|value| html_to_text(&value).trim().to_string())
        .filter(|value| !value.is_empty())
}

fn xhtml_to_plain_text(html: &str, title: &str) -> String {
    let mut body = extract_body_markup(html).unwrap_or_else(|| html.to_string());
    remove_first_element(&mut body, "h1");
    let text = html_to_text(&body).replace('\u{a0}', " ");
    let trimmed_title = title.trim();
    text.strip_prefix(trimmed_title)
        .map(|value| value.trim_start().to_string())
        .unwrap_or(text)
}

fn extract_body_markup(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let body_start = lower.find("<body")?;
    let open_end = lower[body_start..]
        .find('>')
        .map(|offset| body_start + offset + 1)?;
    let body_end = lower[open_end..]
        .find("</body>")
        .map(|offset| open_end + offset)
        .unwrap_or(html.len());
    Some(html[open_end..body_end].to_string())
}

fn extract_element_text(html: &str, tag_name: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let open = format!("<{tag_name}");
    let close = format!("</{tag_name}>");
    let start = lower.find(&open)?;
    let content_start = lower[start..].find('>').map(|offset| start + offset + 1)?;
    let content_end = lower[content_start..]
        .find(&close)
        .map(|offset| content_start + offset)?;
    Some(html[content_start..content_end].to_string())
}

fn remove_first_element(html: &mut String, tag_name: &str) -> bool {
    let lower = html.to_ascii_lowercase();
    let open = format!("<{tag_name}");
    let close = format!("</{tag_name}>");
    let Some(start) = lower.find(&open) else {
        return false;
    };
    let Some(content_end) = lower[start..]
        .find(&close)
        .map(|offset| start + offset + close.len())
    else {
        return false;
    };
    html.replace_range(start..content_end, "");
    true
}

fn classify_resource(
    resource: &EpubResource,
    manifest_item: Option<&ManifestItem>,
    rootfile_path: &str,
    in_spine: bool,
) -> String {
    if resource.path == rootfile_path {
        return "metadata".into();
    }

    let media_type = resource.media_type.as_deref().unwrap_or_default();
    let properties = manifest_item
        .map(|item| item.properties.as_str())
        .unwrap_or_default();
    let extension = Path::new(&resource.path)
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    if properties
        .split_whitespace()
        .any(|property| property == "nav")
    {
        return "navigation".into();
    }
    if in_spine {
        return "chapter".into();
    }
    if media_type.contains("css") || extension == "css" {
        return "style".into();
    }
    if media_type.contains("xhtml") || matches!(extension.as_str(), "xhtml" | "html" | "htm") {
        return "document".into();
    }
    if media_type.starts_with("image/")
        || matches!(
            extension.as_str(),
            "jpg" | "jpeg" | "png" | "svg" | "webp" | "gif"
        )
    {
        return "image".into();
    }
    if media_type.contains("font") || matches!(extension.as_str(), "otf" | "ttf" | "woff" | "woff2")
    {
        return "font".into();
    }
    if resource.path == "META-INF/container.xml"
        || extension == "xml"
        || extension == "opf"
        || extension == "ncx"
    {
        return "metadata".into();
    }

    "other".into()
}

fn is_editable(kind: &str) -> bool {
    matches!(
        kind,
        "chapter" | "style" | "document" | "metadata" | "navigation"
    )
}

fn next_html_path(project: &EpubProject, after_path: Option<&str>) -> String {
    let anchor = after_path
        .and_then(|path| {
            project
                .get_resource(path)
                .map(|resource| resource.path.as_str())
        })
        .or_else(|| project.spine.iter().find_map(|item| item.path.as_deref()));
    let anchor_path = anchor.unwrap_or(&project.rootfile_path);
    let extension = Path::new(anchor_path)
        .extension()
        .and_then(|ext| ext.to_str())
        .filter(|ext| matches!(ext.to_ascii_lowercase().as_str(), "html" | "xhtml" | "htm"))
        .unwrap_or("xhtml");
    let directory = Path::new(anchor_path)
        .parent()
        .and_then(|parent| parent.to_str())
        .filter(|parent| !parent.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| project.package_dir.clone());

    let existing: HashMap<&str, ()> = project
        .resources
        .iter()
        .map(|resource| (resource.path.as_str(), ()))
        .collect();

    for index in 1.. {
        let file_name = format!("new-section-{index}.{extension}");
        let path = if directory.is_empty() {
            file_name
        } else {
            normalize_resource_path(&format!("{directory}/{file_name}"))
        };
        if !existing.contains_key(path.as_str()) {
            return path;
        }
    }

    unreachable!("unbounded loop should always find an available path")
}

fn next_manifest_id(project: &EpubProject, base: &str) -> String {
    let existing: HashMap<&str, ()> = project
        .manifest
        .iter()
        .map(|item| (item.id.as_str(), ()))
        .collect();

    for index in 1.. {
        let id = format!("{base}-{index}");
        if !existing.contains_key(id.as_str()) {
            return id;
        }
    }

    unreachable!("unbounded loop should always find an available id")
}

fn manifest_id_for_path(project: &EpubProject, path: &str) -> Option<String> {
    let path = normalize_resource_path(path);
    project
        .manifest
        .iter()
        .find(|item| item.path == path)
        .map(|item| item.id.clone())
}

fn href_from_package_dir(package_dir: &str, path: &str) -> String {
    if package_dir.is_empty() {
        return normalize_resource_path(path);
    }
    normalize_resource_path(path)
        .strip_prefix(&format!("{package_dir}/"))
        .map(str::to_string)
        .unwrap_or_else(|| normalize_resource_path(path))
}

fn insert_manifest_item(
    opf: &mut String,
    id: &str,
    href: &str,
    media_type: &str,
) -> Result<(), String> {
    let close = opf
        .find("</manifest>")
        .ok_or_else(|| "OPF manifest element not found".to_string())?;
    let item = format!(
        "    <item id=\"{}\" href=\"{}\" media-type=\"{}\"/>\n",
        escape_attr(id),
        escape_attr(href),
        escape_attr(media_type)
    );
    opf.insert_str(close, &item);
    Ok(())
}

fn ensure_ficbase_chapter_stylesheet(project: &mut EpubProject) -> Result<(), String> {
    let style_path = ficbase_chapter_style_path(project);
    ensure_stylesheet_resource(project, &style_path, FICBASE_DEFAULT_CHAPTER_CSS)?;

    let chapter_paths: Vec<String> = project
        .chapter_resources()
        .into_iter()
        .map(|resource| resource.path.clone())
        .collect();

    for path in chapter_paths {
        let html = project
            .read_text_resource(&path)
            .map_err(|e| e.to_string())?;
        let next_html = ensure_chapter_stylesheet_markup(&html, &path, &style_path);
        if next_html != html {
            project
                .set_text_resource(&path, next_html)
                .map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

fn ensure_stylesheet_resource(
    project: &mut EpubProject,
    style_path: &str,
    style_content: &str,
) -> Result<String, String> {
    let style_path = normalize_resource_path(style_path);

    if let Some(resource) = project.get_resource_mut(&style_path) {
        resource.media_type = Some("text/css".into());
        resource.set_text(style_content);
    } else {
        project.resources.push(EpubResource {
            path: style_path.clone(),
            media_type: Some("text/css".into()),
            data: style_content.as_bytes().to_vec(),
        });
    }

    let mut opf = project
        .read_text_resource(&project.rootfile_path)
        .map_err(|e| e.to_string())?;
    let href = href_from_package_dir(&project.package_dir, &style_path);

    if let Some(id) = manifest_id_for_path(project, &style_path) {
        update_manifest_item_media_type(&mut opf, &id, "text/css")?;
    } else {
        let id = next_manifest_id(project, "ficbase-chapter-style");
        insert_manifest_item(&mut opf, &id, &href, "text/css")?;
    }

    let rootfile_path = project.rootfile_path.clone();
    project
        .set_text_resource(&rootfile_path, opf)
        .map_err(|e| e.to_string())?;

    Ok(style_path)
}

fn ficbase_chapter_style_path(project: &EpubProject) -> String {
    let path = if project.package_dir.is_empty() {
        FICBASE_CHAPTER_STYLE_FILE.to_string()
    } else {
        format!("{}/{}", project.package_dir, FICBASE_CHAPTER_STYLE_FILE)
    };
    normalize_resource_path(&path)
}

fn ensure_chapter_stylesheet_markup(html: &str, source_path: &str, style_path: &str) -> String {
    let with_link = ensure_html_stylesheet_link(html, source_path, style_path);
    let with_body = add_class_to_first_tag(&with_link, "body", "ficbase-chapter-body");
    add_class_to_first_tag(&with_body, "h1", "ficbase-chapter-title")
}

fn ensure_html_stylesheet_link(html: &str, source_path: &str, style_path: &str) -> String {
    if html_links_stylesheet(html, source_path, style_path) {
        return html.to_string();
    }

    let href = relative_resource_href(source_path, style_path);
    let link = format!(
        "  <link rel=\"stylesheet\" href=\"{}\"/>\n",
        escape_attr(&href)
    );
    let lower = html.to_ascii_lowercase();

    if let Some(head_end) = lower.find("</head>") {
        let mut output = String::with_capacity(html.len() + link.len());
        output.push_str(&html[..head_end]);
        output.push_str(&link);
        output.push_str(&html[head_end..]);
        return output;
    }

    html.to_string()
}

fn html_links_stylesheet(html: &str, source_path: &str, style_path: &str) -> bool {
    let mut cursor = 0;
    let normalized_style_path = normalize_resource_path(style_path);

    while let Some(relative_start) = html[cursor..].find("<link") {
        let start = cursor + relative_start;
        let Some(relative_end) = html[start..].find('>') else {
            break;
        };
        let end = start + relative_end + 1;
        let tag = &html[start..end];
        let rel = extract_tag_attr(tag, "rel").unwrap_or_default();
        let href = extract_tag_attr(tag, "href");
        let is_stylesheet = rel
            .split_whitespace()
            .any(|part| part.eq_ignore_ascii_case("stylesheet"));

        if is_stylesheet {
            if let Some(href) = href.filter(|href| !is_external_url(href)) {
                if resolve_resource_path(source_path, &href) == normalized_style_path {
                    return true;
                }
            }
        }

        cursor = end;
    }

    false
}

fn add_class_to_first_tag(html: &str, tag_name: &str, class_name: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let marker = format!("<{tag_name}");
    let Some(start) = lower.find(&marker) else {
        return html.to_string();
    };
    let Some(relative_end) = html[start..].find('>') else {
        return html.to_string();
    };
    let end = start + relative_end + 1;
    let tag = &html[start..end];

    if let Some(class_value) = extract_tag_attr(tag, "class") {
        let mut classes: Vec<&str> = class_value.split_whitespace().collect();
        if classes.iter().any(|value| *value == class_name) {
            return html.to_string();
        }
        classes.push(class_name);
        return replace_tag_attr_value(html, start, end, "class", &classes.join(" "));
    }

    let insert_at = if tag.ends_with("/>") {
        end - 2
    } else {
        end - 1
    };
    let mut output = String::with_capacity(html.len() + class_name.len() + 10);
    output.push_str(&html[..insert_at]);
    output.push_str(&format!(" class=\"{}\"", escape_attr(class_name)));
    output.push_str(&html[insert_at..]);
    output
}

fn replace_tag_attr_value(
    html: &str,
    tag_start: usize,
    tag_end: usize,
    attr: &str,
    value: &str,
) -> String {
    let tag = &html[tag_start..tag_end];
    let needle = format!("{attr}=");
    let Some(relative_attr_start) = tag.find(&needle) else {
        return html.to_string();
    };
    let quote_start = tag_start + relative_attr_start + needle.len();
    let Some(quote) = html[quote_start..].chars().next() else {
        return html.to_string();
    };
    if quote != '"' && quote != '\'' {
        return html.to_string();
    }
    let value_start = quote_start + quote.len_utf8();
    let Some(relative_value_end) = html[value_start..tag_end].find(quote) else {
        return html.to_string();
    };
    let value_end = value_start + relative_value_end;

    let mut output = String::with_capacity(html.len() + value.len());
    output.push_str(&html[..value_start]);
    output.push_str(&escape_attr(value));
    output.push_str(&html[value_end..]);
    output
}

fn insert_manifest_item_with_properties(
    opf: &mut String,
    id: &str,
    href: &str,
    media_type: &str,
    properties: &str,
) -> Result<(), String> {
    let close = opf
        .find("</manifest>")
        .ok_or_else(|| "OPF manifest element not found".to_string())?;
    let item = format!(
        "    <item id=\"{}\" href=\"{}\" media-type=\"{}\" properties=\"{}\"/>\n",
        escape_attr(id),
        escape_attr(href),
        escape_attr(media_type),
        escape_attr(properties)
    );
    opf.insert_str(close, &item);
    Ok(())
}

fn update_manifest_item_media_type(
    opf: &mut String,
    id: &str,
    media_type: &str,
) -> Result<(), String> {
    let Some(start) = find_tag_with_attr(opf, "item", "id", id) else {
        return Ok(());
    };
    let end = opf[start..]
        .find('>')
        .map(|offset| start + offset + 1)
        .ok_or_else(|| "Malformed OPF manifest item".to_string())?;
    let tag = &opf[start..end];

    if let Some(attr_start) = tag.find("media-type=") {
        let quote_start = start + attr_start + "media-type=".len();
        let Some(quote) = opf[quote_start..].chars().next() else {
            return Err("Malformed OPF media-type attribute".into());
        };
        if quote != '"' && quote != '\'' {
            return Err("Malformed OPF media-type attribute".into());
        }
        let value_start = quote_start + quote.len_utf8();
        let value_end = opf[value_start..]
            .find(quote)
            .map(|offset| value_start + offset)
            .ok_or_else(|| "Malformed OPF media-type attribute".to_string())?;
        opf.replace_range(value_start..value_end, &escape_attr(media_type));
    } else {
        let insert_at = if opf[..end].ends_with("/>") {
            end - 2
        } else {
            end - 1
        };
        opf.insert_str(
            insert_at,
            &format!(" media-type=\"{}\"", escape_attr(media_type)),
        );
    }

    Ok(())
}

fn insert_spine_item(
    opf: &mut String,
    idref: &str,
    after_idref: Option<&str>,
) -> Result<(), String> {
    let itemref = format!(
        "    <itemref idref=\"{}\" linear=\"yes\"/>\n",
        escape_attr(idref)
    );

    if let Some(after_idref) = after_idref {
        if let Some(pos) = find_tag_with_attr(opf, "itemref", "idref", after_idref) {
            let insert_at = opf[pos..]
                .find('>')
                .map(|offset| pos + offset + 1)
                .ok_or_else(|| "Malformed OPF spine item".to_string())?;
            opf.insert_str(insert_at, &format!("\n{itemref}"));
            return Ok(());
        }
    }

    let close = opf
        .find("</spine>")
        .ok_or_else(|| "OPF spine element not found".to_string())?;
    opf.insert_str(close, &itemref);
    Ok(())
}

fn remove_tag_with_attr(
    xml: &mut String,
    tag_name: &str,
    attr: &str,
    value: &str,
) -> Result<bool, String> {
    let Some(start) = find_tag_with_attr(xml, tag_name, attr, value) else {
        return Ok(false);
    };
    let end = xml[start..]
        .find('>')
        .map(|offset| start + offset + 1)
        .ok_or_else(|| "Malformed XML tag".to_string())?;
    let line_start = xml[..start]
        .rfind('\n')
        .map(|index| index + 1)
        .unwrap_or(start);
    let line_end = xml[end..]
        .find('\n')
        .map(|index| end + index + 1)
        .unwrap_or(end);
    xml.replace_range(line_start..line_end, "");
    Ok(true)
}

fn find_tag_with_attr(xml: &str, tag_name: &str, attr: &str, value: &str) -> Option<usize> {
    let marker = format!("<{tag_name}");
    let mut cursor = 0;

    while let Some(relative_start) = xml[cursor..].find(&marker) {
        let start = cursor + relative_start;
        let after_marker = start + marker.len();
        let is_tag = xml[after_marker..]
            .chars()
            .next()
            .map(|ch| ch.is_whitespace() || ch == '>' || ch == '/')
            .unwrap_or(true);
        if !is_tag {
            cursor = after_marker;
            continue;
        }

        let end = xml[start..].find('>').map(|offset| start + offset + 1)?;
        let tag = &xml[start..end];
        if extract_tag_attr(tag, attr).as_deref() == Some(value) {
            return Some(start);
        }
        cursor = end;
    }

    None
}

fn is_html_manifest_item(item: &ManifestItem) -> bool {
    let extension = Path::new(&item.path)
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    item.media_type.contains("xhtml")
        || item.media_type.contains("html")
        || matches!(extension.as_str(), "html" | "xhtml" | "htm")
}

fn default_html_document(title: &str) -> String {
    let title = escape_xml_text(title);
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <title>{title}</title>
</head>
<body>
  <h1>{title}</h1>
  <p></p>
</body>
</html>"#
    )
}

fn cover_snapshot(project: &EpubProject) -> Option<CoverDto> {
    let cover_path = cover_manifest_item(project)?.path.clone();

    let resource = project.get_resource(&cover_path)?;
    let media_type = resource
        .media_type
        .as_deref()
        .filter(|media_type| !media_type.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| mime_from_path(&resource.path));

    Some(CoverDto {
        path: resource.path.clone(),
        name: resource_name(&resource.path),
        media_type,
        size: resource.data.len(),
        data_url: resource_to_data_url(resource),
    })
}

fn cover_manifest_item(project: &EpubProject) -> Option<&ManifestItem> {
    project
        .manifest
        .iter()
        .find(|item| {
            item.properties
                .split_whitespace()
                .any(|property| property == "cover-image")
        })
        .or_else(|| {
            project
                .manifest
                .iter()
                .find(|item| item.id == "cover-image")
        })
        .or_else(|| {
            project.manifest.iter().find(|item| {
                item.media_type.starts_with("image/")
                    && item.path.to_ascii_lowercase().contains("cover")
            })
        })
}

fn render_preview_html(
    project: &EpubProject,
    source_path: &str,
    html: &str,
    style_drafts: &HashMap<String, String>,
    resource_data_url_cache: &mut HashMap<String, String>,
) -> String {
    let html = inline_stylesheets(
        project,
        source_path,
        html,
        style_drafts,
        resource_data_url_cache,
    );
    let html = rewrite_html_resource_attrs(project, source_path, &html, resource_data_url_cache);
    inject_preview_defaults(&html)
}

fn render_visual_html(
    project: &EpubProject,
    source_path: &str,
    html: &str,
    style_drafts: &HashMap<String, String>,
    resource_data_url_cache: &mut HashMap<String, String>,
) -> VisualDocumentDto {
    let html = inline_stylesheets(
        project,
        source_path,
        html,
        style_drafts,
        resource_data_url_cache,
    );
    let (html, resource_urls) =
        rewrite_html_resource_attrs_with_map(project, source_path, &html, resource_data_url_cache);

    VisualDocumentDto {
        html: inject_preview_defaults(&html),
        resource_urls,
    }
}

fn linked_stylesheet_paths(project: &EpubProject, source_path: &str, html: &str) -> Vec<String> {
    let mut paths = Vec::new();
    let mut seen = HashSet::new();
    let mut cursor = 0;

    while let Some(relative_start) = html[cursor..].find("<link") {
        let start = cursor + relative_start;
        let Some(relative_end) = html[start..].find('>') else {
            break;
        };
        let end = start + relative_end + 1;
        let tag = &html[start..end];
        let rel = extract_tag_attr(tag, "rel").unwrap_or_default();
        let href = extract_tag_attr(tag, "href");
        let is_stylesheet = rel
            .split_whitespace()
            .any(|part| part.eq_ignore_ascii_case("stylesheet"));

        if is_stylesheet {
            if let Some(href) = href.filter(|href| !is_external_url(href)) {
                let css_path = resolve_resource_path(source_path, &href);
                if project.get_resource(&css_path).is_some() && seen.insert(css_path.clone()) {
                    paths.push(css_path);
                }
            }
        }

        cursor = end;
    }

    paths
}

fn inline_stylesheets(
    project: &EpubProject,
    source_path: &str,
    html: &str,
    style_drafts: &HashMap<String, String>,
    resource_data_url_cache: &mut HashMap<String, String>,
) -> String {
    let mut output = String::with_capacity(html.len());
    let mut cursor = 0;

    while let Some(relative_start) = html[cursor..].find("<link") {
        let start = cursor + relative_start;
        output.push_str(&html[cursor..start]);

        let Some(relative_end) = html[start..].find('>') else {
            output.push_str(&html[start..]);
            return output;
        };
        let end = start + relative_end + 1;
        let tag = &html[start..end];

        let rel = extract_tag_attr(tag, "rel").unwrap_or_default();
        let href = extract_tag_attr(tag, "href");
        let is_stylesheet = rel
            .split_whitespace()
            .any(|part| part.eq_ignore_ascii_case("stylesheet"));

        if is_stylesheet {
            if let Some(href) = href {
                let css_path = resolve_resource_path(source_path, &href);
                let css = style_drafts.get(&css_path).cloned().or_else(|| {
                    project
                        .get_resource(&css_path)
                        .and_then(|resource| resource.text().ok())
                });
                if let Some(css) = css {
                    let css = rewrite_css_urls(project, &css_path, &css, resource_data_url_cache);
                    output.push_str(&format!(
                        "<style data-epub-href=\"{}\">\n{}\n</style>",
                        escape_attr(&href),
                        css.replace("</style", "<\\/style")
                    ));
                } else {
                    output.push_str(tag);
                }
            } else {
                output.push_str(tag);
            }
        } else {
            output.push_str(tag);
        }

        cursor = end;
    }

    output.push_str(&html[cursor..]);
    output
}

fn rewrite_html_resource_attrs(
    project: &EpubProject,
    source_path: &str,
    html: &str,
    resource_data_url_cache: &mut HashMap<String, String>,
) -> String {
    let mut output = html.to_string();
    for attr in ["src", "href", "xlink:href", "poster"] {
        output = rewrite_attr_values(&output, attr, |value| {
            resource_data_url_cached(project, source_path, value, resource_data_url_cache)
        });
    }
    output
}

fn rewrite_html_resource_attrs_with_map(
    project: &EpubProject,
    source_path: &str,
    html: &str,
    resource_data_url_cache: &mut HashMap<String, String>,
) -> (String, Vec<VisualResourceUrlDto>) {
    let mut mappings = Vec::new();
    let mut output = html.to_string();

    for attr in ["src", "href", "xlink:href", "poster"] {
        output = rewrite_attr_values(&output, attr, |value| {
            resource_data_url_cached(project, source_path, value, resource_data_url_cache).map(
                |data_url| {
                    mappings.push(VisualResourceUrlDto {
                        data_url: data_url.clone(),
                        original: value.to_string(),
                    });
                    data_url
                },
            )
        });
    }

    (output, mappings)
}

fn rewrite_attr_values(
    input: &str,
    attr: &str,
    mut replacement: impl FnMut(&str) -> Option<String>,
) -> String {
    let mut output = String::with_capacity(input.len());
    let mut cursor = 0;
    let needle = format!("{attr}=");

    while let Some(relative_start) = input[cursor..].find(&needle) {
        let start = cursor + relative_start;
        let value_start = start + needle.len();
        output.push_str(&input[cursor..start]);

        let Some(quote) = input[value_start..].chars().next() else {
            output.push_str(&input[start..]);
            return output;
        };
        if quote != '"' && quote != '\'' {
            output.push_str(&input[start..value_start]);
            cursor = value_start;
            continue;
        }

        let quoted_value_start = value_start + quote.len_utf8();
        let Some(relative_end) = input[quoted_value_start..].find(quote) else {
            output.push_str(&input[start..]);
            return output;
        };
        let value_end = quoted_value_start + relative_end;
        let original_value = &input[quoted_value_start..value_end];
        let new_value = replacement(original_value).unwrap_or_else(|| original_value.to_string());

        output.push_str(&input[start..quoted_value_start]);
        output.push_str(&new_value);
        cursor = value_end;
    }

    output.push_str(&input[cursor..]);
    output
}

fn rewrite_css_urls(
    project: &EpubProject,
    source_path: &str,
    css: &str,
    resource_data_url_cache: &mut HashMap<String, String>,
) -> String {
    let mut output = String::with_capacity(css.len());
    let mut cursor = 0;

    while let Some(relative_start) = css[cursor..].find("url(") {
        let start = cursor + relative_start;
        output.push_str(&css[cursor..start]);

        let value_start = start + 4;
        let Some(relative_end) = css[value_start..].find(')') else {
            output.push_str(&css[start..]);
            return output;
        };
        let value_end = value_start + relative_end;
        let raw_value = css[value_start..value_end].trim();
        let unquoted = raw_value
            .strip_prefix('"')
            .and_then(|v| v.strip_suffix('"'))
            .or_else(|| {
                raw_value
                    .strip_prefix('\'')
                    .and_then(|v| v.strip_suffix('\''))
            })
            .unwrap_or(raw_value);

        if let Some(data_url) =
            resource_data_url_cached(project, source_path, unquoted, resource_data_url_cache)
        {
            output.push_str("url(\"");
            output.push_str(&data_url);
            output.push_str("\")");
        } else {
            output.push_str(&css[start..value_end + 1]);
        }

        cursor = value_end + 1;
    }

    output.push_str(&css[cursor..]);
    output
}

fn inject_preview_defaults(html: &str) -> String {
    let defaults = r#"<style data-ficbase-preview="true">
:root { color-scheme: light; }
html { background: #ffffff; }
body { box-sizing: border-box !important; width: 100% !important; min-height: 100vh; margin: 0 !important; padding: 40px clamp(28px, 5vw, 72px) 64px !important; line-height: 1.72; color: #1d2524; }
img, svg { max-width: 100%; height: auto; }
.ficbase-annotation { --ficbase-annotation-line: #1f8a64; border-bottom: 1.5px dashed var(--ficbase-annotation-line) !important; background: transparent !important; text-decoration: none !important; cursor: help; }
.ficbase-note-ref { --ficbase-annotation-marker: #1f8a64; position: relative !important; display: inline-grid !important; place-items: center !important; box-sizing: border-box !important; width: 14px !important; min-width: 14px !important; max-width: 14px !important; height: 14px !important; min-height: 14px !important; max-height: 14px !important; padding: 0 !important; margin-inline: .12em .08em !important; border-radius: 999px !important; background: var(--ficbase-annotation-marker) !important; color: #fff !important; font: 800 10px/14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important; letter-spacing: 0 !important; word-spacing: normal !important; text-indent: 0 !important; text-align: center !important; text-decoration: none !important; vertical-align: super !important; overflow: visible !important; transform: none !important; cursor: pointer; }
.ficbase-note-ref:focus { outline: 2px solid color-mix(in srgb, var(--ficbase-annotation-marker) 28%, transparent); outline-offset: 2px; }
.ficbase-note-ref::before { content: attr(data-note-index); color: #fff !important; font: 800 10px/14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important; text-indent: 0 !important; }
.ficbase-note-number { display: none !important; pointer-events: none; }
.ficbase-note-ref:not([data-note-index]) .ficbase-note-number { display: block !important; color: #fff !important; font: 800 10px/14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important; text-indent: 0 !important; }
.ficbase-note-popup { box-sizing: border-box !important; position: absolute !important; z-index: 8; top: calc(100% + 6px) !important; left: 50% !important; right: auto !important; display: none; width: max-content; min-width: 0 !important; max-width: min(280px, 72vw); padding: .62em .72em !important; border: 1px solid #cfe0d7; border-radius: 8px; background: #fffefb; color: #20322d !important; box-shadow: 0 12px 32px rgba(24, 48, 40, .18); font: 400 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important; letter-spacing: 0 !important; word-spacing: normal !important; text-align: left !important; text-indent: 0 !important; white-space: normal !important; transform: translateX(-50%) !important; }
.ficbase-note-ref:hover .ficbase-note-popup, .ficbase-note-ref:focus .ficbase-note-popup, .ficbase-note-ref:focus-within .ficbase-note-popup { display: block; }
.ficbase-notes { margin-top: 2.4em; padding-top: 1em; border-top: 1px solid #d7dfd9; font-size: .92em; }
.ficbase-notes h2 { margin: 0 0 .8em; font-size: 1em; }
.ficbase-notes p { margin: .45em 0; }
</style>"#;

    if let Some(head_end) = html.find("</head>") {
        let mut output = String::with_capacity(html.len() + defaults.len());
        output.push_str(&html[..head_end]);
        output.push_str(defaults);
        output.push_str(&html[head_end..]);
        return output;
    }

    if let Some(head_start) = html.find("<head") {
        if let Some(head_tag_end) = html[head_start..].find('>') {
            let insert_at = head_start + head_tag_end + 1;
            let mut output = String::with_capacity(html.len() + defaults.len());
            output.push_str(&html[..insert_at]);
            output.push_str(defaults);
            output.push_str(&html[insert_at..]);
            return output;
        }
    }

    format!("{defaults}\n{html}")
}

fn resource_data_url_cached(
    project: &EpubProject,
    source_path: &str,
    value: &str,
    cache: &mut HashMap<String, String>,
) -> Option<String> {
    if is_external_url(value) {
        return None;
    }

    let resource_path = resolve_resource_path(source_path, value);
    let resource = project.get_resource(&resource_path)?;
    let cache_key = format!(
        "{}:{}:{}",
        resource.path,
        resource.data.len(),
        resource.media_type.as_deref().unwrap_or("")
    );
    if let Some(data_url) = cache.get(&cache_key) {
        return Some(data_url.clone());
    }

    let mime = resource
        .media_type
        .as_deref()
        .filter(|media_type| !media_type.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| mime_from_path(&resource.path));
    let data_url = format!("data:{mime};base64,{}", BASE64.encode(&resource.data));
    if cache.len() > 64 {
        cache.clear();
    }
    cache.insert(cache_key, data_url.clone());
    Some(data_url)
}

fn resource_to_data_url(resource: &EpubResource) -> String {
    let mime = resource
        .media_type
        .as_deref()
        .filter(|media_type| !media_type.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| mime_from_path(&resource.path));

    format!("data:{mime};base64,{}", BASE64.encode(&resource.data))
}

fn resolve_resource_path(source_path: &str, value: &str) -> String {
    let path = value
        .split('#')
        .next()
        .unwrap_or(value)
        .split('?')
        .next()
        .unwrap_or(value);

    if path.starts_with('/') {
        return normalize_resource_path(path.trim_start_matches('/'));
    }

    let base_dir = Path::new(source_path)
        .parent()
        .and_then(|parent| parent.to_str())
        .unwrap_or_default();
    if base_dir.is_empty() {
        normalize_resource_path(path)
    } else {
        normalize_resource_path(&format!("{base_dir}/{path}"))
    }
}

fn relative_resource_href(source_path: &str, target_path: &str) -> String {
    let source_dir = Path::new(source_path)
        .parent()
        .and_then(|parent| parent.to_str())
        .unwrap_or_default();
    let mut from_parts: Vec<&str> = source_dir
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();
    let mut to_parts: Vec<&str> = target_path
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();

    while !from_parts.is_empty() && !to_parts.is_empty() && from_parts[0] == to_parts[0] {
        from_parts.remove(0);
        to_parts.remove(0);
    }

    let mut parts = vec![".."; from_parts.len()];
    parts.extend(to_parts);
    if parts.is_empty() {
        ".".into()
    } else {
        parts.join("/")
    }
}

fn normalize_resource_path(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    let mut parts = Vec::new();

    for part in normalized.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            _ => parts.push(part),
        }
    }

    parts.join("/")
}

fn is_external_url(value: &str) -> bool {
    let value = value.trim();
    if value.is_empty() || value.starts_with('#') {
        return true;
    }
    let lower = value.to_ascii_lowercase();
    lower.starts_with("data:")
        || lower.starts_with("http:")
        || lower.starts_with("https:")
        || lower.starts_with("mailto:")
        || lower.starts_with("javascript:")
        || lower.starts_with("blob:")
        || lower.starts_with("file:")
}

fn extract_tag_attr(tag: &str, attr: &str) -> Option<String> {
    let needle = format!("{attr}=");
    let start = tag.find(&needle)? + needle.len();
    let quote = tag[start..].chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }

    let value_start = start + quote.len_utf8();
    let value_end = tag[value_start..].find(quote)? + value_start;
    Some(unescape_attr(&tag[value_start..value_end]))
}

fn mime_from_path(path: &str) -> String {
    match Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "css" => "text/css",
        "html" | "xhtml" | "htm" => "application/xhtml+xml",
        "svg" => "image/svg+xml",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "otf" => "font/otf",
        "ttf" => "font/ttf",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "xml" | "opf" | "ncx" => "application/xml",
        _ => "application/octet-stream",
    }
    .into()
}

fn image_mime_from_path(path: &Path) -> Option<String> {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => Some("image/jpeg".into()),
        "png" => Some("image/png".into()),
        "gif" => Some("image/gif".into()),
        "webp" => Some("image/webp".into()),
        "svg" => Some("image/svg+xml".into()),
        _ => None,
    }
}

fn next_cover_path(project: &EpubProject, source_path: &Path) -> String {
    let extension = source_path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("jpg")
        .to_ascii_lowercase();
    let directory = if project.package_dir.is_empty() {
        "images".to_string()
    } else {
        format!("{}/images", project.package_dir)
    };
    let existing: HashMap<&str, ()> = project
        .resources
        .iter()
        .map(|resource| (resource.path.as_str(), ()))
        .collect();

    for index in 0.. {
        let file_name = if index == 0 {
            format!("cover.{extension}")
        } else {
            format!("cover-{index}.{extension}")
        };
        let path = normalize_resource_path(&format!("{directory}/{file_name}"));
        if !existing.contains_key(path.as_str()) {
            return path;
        }
    }

    unreachable!("unbounded loop should always find an available path")
}

fn escape_attr(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn escape_xml_text(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn unescape_attr(value: &str) -> String {
    value
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

fn chapter_templates_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("templates");
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    Ok(root)
}

fn load_chapter_templates(root: &Path) -> Result<Vec<SavedChapterTemplateDto>, String> {
    let records = load_stored_chapter_templates(root)?;
    Ok(rehydrate_stored_chapter_templates(root, records))
}

fn load_stored_chapter_templates(root: &Path) -> Result<Vec<StoredChapterTemplate>, String> {
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let mut records = Vec::new();

    for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        if !file_type.is_dir() {
            continue;
        }

        let manifest_path = entry.path().join("template.json");
        let Ok(manifest) = fs::read_to_string(&manifest_path) else {
            continue;
        };
        let Ok(template) = serde_json::from_str::<SavedChapterTemplateDto>(&manifest) else {
            continue;
        };
        records.push(StoredChapterTemplate {
            directory_name: entry.file_name().to_string_lossy().into_owned(),
            template,
        });
    }

    records.sort_by(|left, right| right.template.created_at.cmp(&left.template.created_at));
    records.truncate(20);
    Ok(records)
}

fn store_chapter_template(
    root: &Path,
    template: SavedChapterTemplateDto,
) -> Result<SavedChapterTemplateDto, String> {
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let directory_name = safe_template_directory_name(&template.id);
    let template_dir = root.join(directory_name);
    if template_dir.exists() {
        fs::remove_dir_all(&template_dir).map_err(|e| e.to_string())?;
    }
    fs::create_dir_all(template_dir.join("images")).map_err(|e| e.to_string())?;

    let mut stored_template = template;
    stored_template.format.source_path = "template.xhtml".into();
    stored_template.format.decoration_html =
        persist_template_decoration_images(&template_dir, &stored_template.format.decoration_html)?;

    let manifest = serde_json::to_string_pretty(&stored_template).map_err(|e| e.to_string())?;
    fs::write(template_dir.join("template.json"), manifest).map_err(|e| e.to_string())?;
    fs::write(
        template_dir.join("style.css"),
        chapter_template_css_block(&stored_template.format),
    )
    .map_err(|e| e.to_string())?;

    Ok(stored_template)
}

fn cleanup_chapter_template_directories(
    root: &Path,
    records: &[StoredChapterTemplate],
) -> Result<(), String> {
    let keep: HashSet<&str> = records
        .iter()
        .map(|record| record.directory_name.as_str())
        .collect();

    for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        if !file_type.is_dir() {
            continue;
        }

        let directory_name = entry.file_name().to_string_lossy().into_owned();
        if !keep.contains(directory_name.as_str()) {
            fs::remove_dir_all(entry.path()).map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

fn rehydrate_stored_chapter_templates(
    root: &Path,
    records: Vec<StoredChapterTemplate>,
) -> Vec<SavedChapterTemplateDto> {
    records
        .into_iter()
        .map(|record| {
            let template_dir = root.join(&record.directory_name);
            let mut template = record.template;
            template.format.source_path = "ficbase-template-designer".into();
            template.format.decoration_html = rehydrate_template_decoration_images(
                &template_dir,
                &template.format.decoration_html,
            );
            template
        })
        .collect()
}

fn safe_template_directory_name(id: &str) -> String {
    let value: String = id
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
        .collect();
    if value.is_empty() {
        "template".into()
    } else {
        value
    }
}

fn persist_template_decoration_images(template_dir: &Path, html: &str) -> Result<String, String> {
    replace_src_values(html, |value, image_index| {
        if !value.to_ascii_lowercase().starts_with("data:") {
            return Ok(value.to_string());
        }

        let (mime, data) = decode_data_url(value)?;
        let extension = image_extension_for_mime(&mime);
        let relative_path = format!("images/decoration-{image_index}.{extension}");
        fs::write(template_dir.join(&relative_path), data).map_err(|e| e.to_string())?;
        Ok(relative_path)
    })
}

fn rehydrate_template_decoration_images(template_dir: &Path, html: &str) -> String {
    replace_src_values(html, |value, _image_index| {
        Ok(template_asset_data_url(template_dir, value).unwrap_or_else(|| value.to_string()))
    })
    .unwrap_or_else(|_| html.to_string())
}

fn materialize_template_assets_for_project(
    project: &mut EpubProject,
    root: &Path,
    template: SavedChapterTemplateDto,
) -> Result<ChapterFormatTemplateDto, String> {
    let template_dir = root.join(safe_template_directory_name(&template.id));
    let mut format = template.format;
    let source_path = format.source_path.clone();
    let decoration_html = format.decoration_html.clone();
    let mut materialized_any = false;

    format.decoration_html = replace_src_values(&decoration_html, |value, image_index| {
        if value.to_ascii_lowercase().starts_with("data:") {
            let (mime, data) = decode_data_url(value)?;
            let extension = image_extension_for_mime(&mime);
            let resource_path =
                next_template_image_resource_path(project, &template.id, image_index, extension);
            ensure_binary_resource(project, &resource_path, &mime, data)?;
            materialized_any = true;
            return Ok(resource_path);
        }

        if let Some(path) = template_asset_path(&template_dir, value) {
            if let Ok(data) = fs::read(&path) {
                let mime = mime_from_path(path.to_string_lossy().as_ref());
                let extension = path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .unwrap_or_else(|| image_extension_for_mime(&mime));
                let resource_path = next_template_image_resource_path(
                    project,
                    &template.id,
                    image_index,
                    extension,
                );
                ensure_binary_resource(project, &resource_path, &mime, data)?;
                materialized_any = true;
                return Ok(resource_path);
            }
        }

        Ok(value.to_string())
    })?;

    if materialized_any {
        format.source_path = "template.xhtml".into();
    } else {
        format.source_path = source_path;
    }

    Ok(format)
}

fn ensure_binary_resource(
    project: &mut EpubProject,
    path: &str,
    media_type: &str,
    data: Vec<u8>,
) -> Result<(), String> {
    let path = normalize_resource_path(path);
    if let Some(resource) = project.get_resource_mut(&path) {
        resource.data = data;
        resource.media_type = Some(media_type.into());
    } else {
        project.resources.push(EpubResource {
            path: path.clone(),
            media_type: Some(media_type.into()),
            data,
        });
    }

    let rootfile_path = project.rootfile_path.clone();
    let mut opf = project
        .read_text_resource(&rootfile_path)
        .map_err(|e| e.to_string())?;
    let href = href_from_package_dir(&project.package_dir, &path);

    if let Some(id) = manifest_id_for_path(project, &path) {
        update_manifest_item_media_type(&mut opf, &id, media_type)?;
        if let Some(item) = project.manifest.iter_mut().find(|item| item.id == id) {
            item.media_type = media_type.into();
        }
    } else {
        let id = next_manifest_id(project, "ficbase-template-image");
        insert_manifest_item(&mut opf, &id, &href, media_type)?;
        project.manifest.push(ManifestItem {
            id,
            href,
            media_type: media_type.into(),
            properties: String::new(),
            path: path.clone(),
        });
    }

    project
        .set_text_resource(&rootfile_path, opf)
        .map_err(|e| e.to_string())?;

    Ok(())
}

fn next_template_image_resource_path(
    project: &EpubProject,
    template_id: &str,
    image_index: usize,
    extension: &str,
) -> String {
    let directory = if project.package_dir.is_empty() {
        "images".to_string()
    } else {
        format!("{}/images", project.package_dir)
    };
    let template_id = safe_template_directory_name(template_id);
    let existing: HashSet<&str> = project
        .resources
        .iter()
        .map(|resource| resource.path.as_str())
        .collect();

    for suffix in 0.. {
        let file_name = if suffix == 0 {
            format!("ficbase-template-{template_id}-{image_index}.{extension}")
        } else {
            format!("ficbase-template-{template_id}-{image_index}-{suffix}.{extension}")
        };
        let path = normalize_resource_path(&format!("{directory}/{file_name}"));
        if !existing.contains(path.as_str()) {
            return path;
        }
    }

    unreachable!("unbounded loop should always find an available path")
}

fn replace_src_values<F>(html: &str, mut replace: F) -> Result<String, String>
where
    F: FnMut(&str, usize) -> Result<String, String>,
{
    let mut output = String::new();
    let mut cursor = 0;
    let mut image_index = 1;

    while let Some((start, end, value)) = find_next_src_value(&html[cursor..]) {
        let absolute_start = cursor + start;
        let absolute_end = cursor + end;
        output.push_str(&html[cursor..absolute_start]);
        output.push_str(&replace(value, image_index)?);
        cursor = absolute_end;
        image_index += 1;
    }

    output.push_str(&html[cursor..]);
    Ok(output)
}

fn find_next_src_value(input: &str) -> Option<(usize, usize, &str)> {
    let double = input.find("src=\"");
    let single = input.find("src='");
    let (attr_start, quote) = match (double, single) {
        (Some(double), Some(single)) if single < double => (single, '\''),
        (Some(double), _) => (double, '"'),
        (None, Some(single)) => (single, '\''),
        (None, None) => return None,
    };

    let value_start = attr_start + "src=".len() + quote.len_utf8();
    let value_end = input[value_start..].find(quote)? + value_start;
    Some((value_start, value_end, &input[value_start..value_end]))
}

fn decode_data_url(value: &str) -> Result<(String, Vec<u8>), String> {
    let payload = value
        .strip_prefix("data:")
        .ok_or_else(|| "Invalid template image data".to_string())?;
    let (metadata, encoded) = payload
        .split_once(',')
        .ok_or_else(|| "Invalid template image data".to_string())?;
    let mime = metadata
        .split(';')
        .next()
        .filter(|item| !item.is_empty())
        .unwrap_or("application/octet-stream")
        .to_string();
    if !metadata
        .split(';')
        .any(|item| item.eq_ignore_ascii_case("base64"))
    {
        return Err("Template image data must be base64 encoded".into());
    }

    let data = BASE64.decode(encoded).map_err(|e| e.to_string())?;
    Ok((mime, data))
}

fn image_extension_for_mime(mime: &str) -> &'static str {
    match mime.to_ascii_lowercase().as_str() {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        _ => "bin",
    }
}

fn template_asset_data_url(template_dir: &Path, value: &str) -> Option<String> {
    let path = template_asset_path(template_dir, value)?;
    let data = fs::read(&path).ok()?;
    let mime = mime_from_path(path.to_string_lossy().as_ref());
    Some(format!("data:{mime};base64,{}", BASE64.encode(data)))
}

fn template_asset_path(template_dir: &Path, value: &str) -> Option<PathBuf> {
    let value = value.trim();
    if value.is_empty()
        || is_external_url(value)
        || value.starts_with('/')
        || value.contains('\\')
        || value.split('/').any(|part| part == "..")
    {
        return None;
    }

    Some(template_dir.join(normalize_resource_path(value)))
}

fn chapter_template_css_block(format: &ChapterFormatTemplateDto) -> String {
    let empty: &[AttributeSnapshotDto] = &[];
    let rules = [
        chapter_template_css_rule("body.ficbase-chapter-body", &format.body_style),
        chapter_template_css_rule(
            "body.ficbase-chapter-body .ficbase-chapter-title",
            &format.title_style,
        ),
        chapter_template_css_rule(
            "body.ficbase-chapter-body .ficbase-template-decoration",
            format.decoration_style.as_deref().unwrap_or(empty),
        ),
        chapter_template_css_rule(
            "body.ficbase-chapter-body .ficbase-template-decoration img",
            format.decoration_image_style.as_deref().unwrap_or(empty),
        ),
        chapter_template_css_rule(
            "body.ficbase-chapter-body .ficbase-chapter-content > p, body.ficbase-chapter-body > p",
            &format.paragraph_style,
        ),
    ]
    .into_iter()
    .flatten();

    let mut parts = vec!["/* ficbase chapter format start */".to_string()];
    parts.extend(rules);
    if let Some(custom_css) = &format.custom_css {
        let normalized = normalize_custom_chapter_css(custom_css);
        if !normalized.is_empty() {
            parts.push(normalized);
        }
    }
    parts.push("/* ficbase chapter format end */".into());
    parts.join("\n")
}

fn chapter_template_css_rule(selector: &str, styles: &[AttributeSnapshotDto]) -> Option<String> {
    if styles.is_empty() {
        return None;
    }

    let body = styles
        .iter()
        .map(|style| format!("  {}: {};", style.name, style.value))
        .collect::<Vec<_>>()
        .join("\n");
    Some(format!("{selector} {{\n{body}\n}}"))
}

fn normalize_custom_chapter_css(css: &str) -> String {
    css.replace("/* ficbase chapter format start */", "")
        .replace("/* ficbase chapter format end */", "")
        .trim()
        .to_string()
}

fn resource_sort_key(resource: &ResourceDto) -> (u8, String) {
    let weight = match resource.kind.as_str() {
        "metadata" => 0,
        "navigation" => 1,
        "chapter" => 2,
        "style" => 3,
        "document" => 4,
        "image" => 5,
        "font" => 6,
        _ => 7,
    };
    let chapter_order = if resource.kind == "chapter" {
        format!("{:08}", resource.spine_index.unwrap_or(usize::MAX))
    } else {
        String::new()
    };
    (weight, format!("{chapter_order}{}", resource.path))
}

fn resource_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(path)
        .to_string()
}

fn sanitize_file_stem(value: &str) -> String {
    value
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            _ => ch,
        })
        .collect::<String>()
        .trim()
        .to_string()
}

fn display_path(path: &PathBuf) -> String {
    path.display().to_string()
}

impl From<&Metadata> for MetadataDto {
    fn from(value: &Metadata) -> Self {
        Self {
            title: value.title.clone(),
            author: value.author.clone(),
            language: value.language.clone(),
            identifier: value.identifier.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chapter(path: &str, spine_index: usize) -> ResourceDto {
        ResourceDto {
            path: path.into(),
            name: resource_name(path),
            media_type: Some("application/xhtml+xml".into()),
            kind: "chapter".into(),
            size: 0,
            editable: true,
            in_spine: true,
            spine_index: Some(spine_index),
        }
    }

    #[test]
    fn chapter_resources_sort_by_spine_order_not_path() {
        let mut resources = vec![
            chapter("OEBPS/Text/chapter10.html", 9),
            chapter("OEBPS/Text/chapter2.html", 1),
            chapter("OEBPS/Text/chapter1.html", 0),
        ];

        resources.sort_by(|a, b| resource_sort_key(a).cmp(&resource_sort_key(b)));

        let paths: Vec<&str> = resources
            .iter()
            .map(|resource| resource.path.as_str())
            .collect();
        assert_eq!(
            paths,
            vec![
                "OEBPS/Text/chapter1.html",
                "OEBPS/Text/chapter2.html",
                "OEBPS/Text/chapter10.html"
            ]
        );
    }

    #[test]
    fn opf_helpers_insert_and_remove_html_manifest_spine_items() {
        let mut opf = r#"<package>
  <manifest>
    <item id="chapter1" href="Text/chapter1.html" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="chapter1" linear="yes"/>
  </spine>
</package>"#
            .to_string();

        insert_manifest_item(
            &mut opf,
            "ficbase-html-1",
            "Text/new-section-1.html",
            "application/xhtml+xml",
        )
        .unwrap();
        insert_spine_item(&mut opf, "ficbase-html-1", Some("chapter1")).unwrap();

        assert!(opf.contains("id=\"ficbase-html-1\""));
        assert!(opf.find("chapter1").unwrap() < opf.find("ficbase-html-1").unwrap());

        remove_tag_with_attr(&mut opf, "item", "id", "ficbase-html-1").unwrap();
        remove_tag_with_attr(&mut opf, "itemref", "idref", "ficbase-html-1").unwrap();

        assert!(!opf.contains("ficbase-html-1"));
    }

    #[test]
    fn txt_chapter_split_preserves_first_line_indent() {
        let chapters = split_txt_chapters(
            "第1章 伊恩\n\n　　哈里森港的风雨莫测难料。\n　　第二段。\n\n第2章 灵能\n\n    Four spaces stay too.",
            "高天之上",
        );

        assert_eq!(chapters[0].title, "第1章 伊恩");
        assert!(chapters[0].body.starts_with("　　哈里森港"));
        assert!(chapters[1].body.starts_with("    Four"));
    }

    #[test]
    fn txt_chapter_split_keeps_preface_and_skips_volume_heading() {
        let chapters = split_txt_chapters(
            "内容简介：\n　　这是简介。\n\n第一部 囚星天狱\n\n第1章 伊恩\n　　正文第一段。\n\n第2章 灵能\n　　正文第二段。",
            "高天之上",
        );

        assert_eq!(chapters.len(), 3);
        assert_eq!(chapters[0].title, "前言");
        assert!(chapters[0].body.contains("第一部 囚星天狱"));
        assert_eq!(chapters[1].title, "第1章 伊恩");
        assert_eq!(chapters[2].title, "第2章 灵能");
    }

    #[test]
    fn txt_import_preface_uses_preface_path_not_chapter1() {
        let book = Book {
            metadata: Metadata {
                title: "高天之上".into(),
                author: String::new(),
                language: "zh-CN".into(),
                identifier: String::new(),
                extra: HashMap::new(),
            },
            chapters: vec![
                Chapter {
                    title: "前言".into(),
                    body: "内容简介".into(),
                },
                Chapter {
                    title: "第1章 伊恩".into(),
                    body: "正文一".into(),
                },
                Chapter {
                    title: "第2章 灵能".into(),
                    body: "正文二".into(),
                },
            ],
            cover: None,
        };
        let mut cursor = Cursor::new(Vec::new());
        write_epub(&book, &mut cursor).unwrap();
        let mut project = open_epub_project(Cursor::new(cursor.into_inner())).unwrap();

        normalize_txt_import_chapter_paths(&mut project).unwrap();

        let spine_paths: Vec<String> = project
            .spine
            .iter()
            .filter(|item| item.linear)
            .filter_map(|item| item.path.clone())
            .collect();
        assert_eq!(
            spine_paths,
            vec![
                "OEBPS/preface.xhtml",
                "OEBPS/chapter1.xhtml",
                "OEBPS/chapter2.xhtml"
            ]
        );
        assert!(project.get_resource("OEBPS/preface.xhtml").is_some());
        let nav = project.read_text_resource("OEBPS/nav.xhtml").unwrap();
        assert!(nav.contains("preface.xhtml"));
        assert!(nav.contains("chapter1.xhtml"));
    }

    #[test]
    fn chapter_template_storage_writes_style_and_image_files() {
        let root = std::env::temp_dir().join(format!(
            "ficbase-template-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));

        let template = SavedChapterTemplateDto {
            id: "template-1".into(),
            name: "测试模板".into(),
            created_at: 1,
            format: ChapterFormatTemplateDto {
                source_path: "ficbase-template-designer".into(),
                body_style: vec![AttributeSnapshotDto {
                    name: "background-color".into(),
                    value: "#ffffff".into(),
                }],
                title_style: vec![AttributeSnapshotDto {
                    name: "text-align".into(),
                    value: "center".into(),
                }],
                paragraph_style: vec![AttributeSnapshotDto {
                    name: "line-height".into(),
                    value: "1.8".into(),
                }],
                decoration_style: Some(vec![AttributeSnapshotDto {
                    name: "text-align".into(),
                    value: "center".into(),
                }]),
                decoration_image_style: Some(vec![AttributeSnapshotDto {
                    name: "width".into(),
                    value: "120px".into(),
                }]),
                custom_css: Some(".extra { color: red; }".into()),
                decoration_html: r#"<div class="ficbase-template-decoration"><img src="data:image/png;base64,aGVsbG8=" alt="sample" /></div>"#.into(),
            },
        };

        store_chapter_template(&root, template).unwrap();

        let template_dir = root.join("template-1");
        let manifest = fs::read_to_string(template_dir.join("template.json")).unwrap();
        assert!(manifest.contains("images/decoration-1.png"));
        assert!(!manifest.contains("data:image/png"));
        assert!(template_dir.join("images/decoration-1.png").exists());

        let css = fs::read_to_string(template_dir.join("style.css")).unwrap();
        assert!(css.contains("body.ficbase-chapter-body .ficbase-chapter-title"));
        assert!(css.contains("text-align: center;"));
        assert!(css.contains(".extra { color: red; }"));

        let loaded = load_chapter_templates(&root).unwrap();
        assert_eq!(loaded.len(), 1);
        assert!(loaded[0]
            .format
            .decoration_html
            .contains("data:image/png;base64,aGVsbG8="));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn chapter_template_materializes_data_images_into_project_resources() {
        let root = std::env::temp_dir().join(format!(
            "ficbase-template-materialize-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();

        let book = Book {
            metadata: Metadata {
                title: "模板测试".into(),
                author: String::new(),
                language: "zh-CN".into(),
                identifier: String::new(),
                extra: HashMap::new(),
            },
            chapters: vec![Chapter {
                title: "第1章".into(),
                body: "正文".into(),
            }],
            cover: None,
        };
        let mut cursor = Cursor::new(Vec::new());
        write_epub(&book, &mut cursor).unwrap();
        let mut project = open_epub_project(Cursor::new(cursor.into_inner())).unwrap();

        let template = SavedChapterTemplateDto {
            id: "template-image".into(),
            name: "图片模板".into(),
            created_at: 1,
            format: ChapterFormatTemplateDto {
                source_path: "ficbase-template-designer".into(),
                body_style: vec![],
                title_style: vec![],
                paragraph_style: vec![],
                decoration_style: None,
                decoration_image_style: None,
                custom_css: None,
                decoration_html:
                    r#"<div class="ficbase-template-decoration"><img src="data:image/png;base64,aGVsbG8=" alt="sample" /></div>"#
                        .into(),
            },
        };

        let format =
            materialize_template_assets_for_project(&mut project, &root, template).unwrap();

        assert!(!format.decoration_html.contains("data:image/png"));
        assert!(format
            .decoration_html
            .contains("OEBPS/images/ficbase-template-template-image-1.png"));
        assert!(project
            .get_resource("OEBPS/images/ficbase-template-template-image-1.png")
            .is_some());
        let opf = project.read_text_resource(&project.rootfile_path).unwrap();
        assert!(opf.contains("ficbase-template-template-image-1.png"));
        assert!(opf.contains("media-type=\"image/png\""));

        let _ = fs::remove_dir_all(root);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(EditorState::default())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            open_epub,
            import_book,
            save_epub,
            export_book,
            read_text_resource,
            render_preview_resource,
            render_visual_resource,
            read_resource_data_url,
            list_chapter_templates,
            save_chapter_template,
            materialize_chapter_template_assets,
            update_text_resource,
            update_text_resources,
            update_text_resources_with_style,
            list_page_stylesheets,
            replace_cover_image,
            update_metadata,
            add_html_resource,
            delete_html_resource,
            close_project
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
