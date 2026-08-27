# Install and use Note

Note is a desktop app for organizing freeform notes on a canvas. Official
downloads are published on the [GitHub Releases page](https://github.com/tyhuang9/note/releases).

## Choose a package

| Platform | Recommended file | Download |
| --- | --- | --- |
| Windows | `Note-Setup.exe` | [Latest installer](https://github.com/tyhuang9/note/releases/latest/download/Note-Setup.exe) |
| macOS | `Note.dmg` | [Latest disk image](https://github.com/tyhuang9/note/releases/latest/download/Note.dmg) |
| Debian/Ubuntu | `Note.deb` | [Latest package](https://github.com/tyhuang9/note/releases/latest/download/Note.deb) |
| Other Linux | `Note.AppImage`, when present | [Latest release files](https://github.com/tyhuang9/note/releases/latest) |

The release page also includes `SHA256SUMS` for checking downloaded files.

## Windows

1. Download and run `Note-Setup.exe`.
2. Accept the installer prompt. It installs Note for the current Windows user;
   administrator privileges are not required.
3. Start **Note** from the Start menu.

When Note is already installed, a newer installer offers **Update** and
**Remove Note**. Running the same version offers **Repair Note** and
**Remove Note**. Choosing Remove runs the existing uninstaller and closes the
setup program; it does not reinstall Note. If the installed version is newer,
setup blocks a downgrade and offers only Remove or Cancel. Updates and repairs
preserve local app data. Removing Note also preserves that data unless you
explicitly select **Delete application data** in the uninstaller.

The installer is unsigned for now. SmartScreen may warn before it starts. Only
continue after verifying that the file came from the official release page.

## macOS

1. Download and open `Note.dmg`.
2. Drag **Note** to **Applications**.
3. Open Note from Applications.

The app is currently unsigned and not notarized, so Gatekeeper can warn or
block the first launch. Confirm the release source before using macOS's normal
Open/allow flow for an app you trust.

## Linux

### Debian and Ubuntu

Download `Note.deb`, then either open it with your package installer or run:

```bash
sudo apt install ./Note.deb
```

### AppImage

Some releases also contain `Note.AppImage`. It is optional because AppImage
packaging can fail in CI. If it is present, make it executable and run it:

```bash
chmod +x Note.AppImage
./Note.AppImage
```

If the AppImage is not present or does not run on your distribution, use the
Debian package when compatible or build from source.

## First use, data, and updates

Create a page from the sidebar, click the canvas to add text, and use the
canvas tools to draw, select, pan, and zoom. Search and theme controls are
available in the app interface.

Note stores its workspace locally in its application-data directory, including
pages, canvas elements, assets, and preferences. There is no cloud sync or
automatic backup, so preserve your own copy before clearing app data, moving to
another device, or performing a risky upgrade.

There is no built-in automatic updater in the current app. To update, download
a newer package from GitHub Releases and run it; the Windows installer presents
an Update action for an older installed version. Back up important local data
before any upgrade.

## Build from source

Install a current Node.js LTS release, Rust stable, and Tauri's platform
prerequisites. Then from the repository root:

```bash
npm --prefix frontend ci
npm run dev
```

For a local installer build:

```bash
npm run tauri:build
```

On Linux, if AppImage packaging fails, a Debian-only bundle can be attempted
with:

```bash
APPIMAGE_EXTRACT_AND_RUN=1 npm run tauri:build -- --bundles deb
```

For release-process details, see [RELEASE.md](RELEASE.md).
