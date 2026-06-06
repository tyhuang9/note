# Note

Note is a lightweight desktop note-taking app for freeform thinking. It uses a canvas-style page where notes are represented as movable, resizable textboxes instead of a traditional linear document.

The app is local-first: folders, pages, textboxes, images, layout, and preferences are saved to a local JSON file through the Tauri desktop shell.

## Technologies

- Tauri 2 for the desktop application shell
- React 19 for the frontend UI
- TypeScript for frontend type safety
- Vite for frontend development and builds
- Rust for Tauri commands and local persistence
- Serde and serde_json for JSON serialization
- npm for frontend/workspace scripts
- Cargo for Rust/Tauri checks and builds

## Local Development

Install dependencies from the frontend folder if they are not installed yet:

```bash
cd frontend
npm install
```

Run the full desktop app from the repo root:

```bash
npm run tauri:dev
```

Run the web frontend only:

```bash
npm run dev
```

Build the frontend:

```bash
npm run build
```

Check the Tauri backend:

```bash
cd backend/src-tauri
cargo check
```

Build the Tauri app:

```bash
npm run tauri:build
```

## Features

- Folder and page organization
- Inline folder, page, and page-title renaming
- Freeform canvas per page
- Textbox creation from canvas insertion point
- Plain-text editing
- Textbox selection and multi-selection
- Header-based textbox dragging
- Right-edge textbox resizing
- Autosizing textbox height with fixed-width behavior after manual resize
- Canvas selection rectangle
- Shift-drag canvas panning
- Zoom controls with keyboard and mouse shortcuts
- Text search with highlighted occurrences and Enter navigation
- Paste support for text and images
- Offscreen textbox indicators with click-to-pan navigation
- Light/dark mode toggle with persisted preference
- Local JSON autosave and restore

## Project Structure

```text
frontend/
  src/
    App.tsx
    components/
    appTypes.ts
    constants.ts
    editorUtils.ts
    types.ts
backend/
  src-tauri/
    src/lib.rs
    tauri.conf.json
```

`frontend/src/App.tsx` owns application-level state and canvas orchestration. Textbox-specific direct manipulation behavior lives in `frontend/src/components/TextBlockView.tsx`.
