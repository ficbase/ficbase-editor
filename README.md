# Ficbase Editor

Simple desktop EPUB editor for metadata, styles, and XHTML content.

## Development

This app uses Tauri 2, React, TypeScript, and the sibling `transmute` crate as the EPUB core.

```bash
npm install
npm run tauri dev
```

The Rust side depends on `transmute` without default features:

```toml
transmute = { path = "../../transmute", default-features = false }
```

## Current MVP

- Open an EPUB from disk
- Inspect EPUB resources grouped by type
- Edit XHTML, CSS, OPF, XML, and navigation resources
- Edit basic metadata fields
- Repackage the current EPUB project through `transmute`

## Checks

```bash
npm run build
cd src-tauri && cargo check
```
