# Stuadio

**Studio sound from any recording.** A desktop app that turns a voice recording, or the audio in a video, into clean, mastered, studio-quality sound. Everything is processed locally, so nothing is uploaded.

## What it does

Stuadio analyses each file first and switches on only the fixes it needs. You can turn any fix off or adjust it before processing.

| Stage  | Fix                | How                                                                 |
| ------ | ------------------ | ------------------------------------------------------------------- |
| Clean  | Noise removal      | Neural denoiser (RNNoise) + spectral cleanup                        |
|        | Hum removal        | Detects 50/60 Hz mains hum and notches the harmonics                |
|        | Rumble filter      | 24 dB/oct high-pass at 75 Hz                                        |
|        | Echo reduction     | Downward expander that tames room tails between words               |
|        | Clipping repair    | Rebuilds distorted peaks (on automatically when clipping is found)  |
| Shape  | Studio tone        | Adaptive EQ that matches your voice to a studio reference spectrum  |
|        | De-esser           | Softens harsh "s" and "t" sounds                                    |
|        | Voice leveling     | Phrase-by-phrase leveler + compressor                               |
| Edit   | Trim pauses        | Shortens long silences with inaudible crossfades                    |
| Master | Loudness           | Podcast −16, YouTube −14, Audiobook −19 (ACX), Broadcast −23 LUFS, true-peak limited |

Exports: WAV 24-bit, FLAC 24-bit, MP3 320 kbps, AAC 256 kbps. For video files, Stuadio can also export the original video with the new soundtrack (the picture is copied, not re-encoded).

## Development

```bash
npm install
npm start          # run the app
npm test           # engine self-test (generates fixtures, checks loudness/peaks/timing/exports)
npm run enhance -- input.wav output.wav   # process a file from the command line
npm run dist       # build the Windows installer into dist/
```

Other scripts:

- `npm run icons` renders `build/icon.svg` into the app icons.
- `npm run icons:ui` regenerates `src/renderer/icons.js` from [Lucide](https://lucide.dev).

The source is organised like this:

- `src/engine/` is the audio engine: plain Node with no Electron dependency.
- `src/main/` is the Electron main process: window, file access, export and auto-update.
- `src/renderer/` is the UI.

## Releases and automatic updates

Installed copies check GitHub Releases for a newer version. The app works fully offline, and update checks fail silently when there's no connection. Checks run:

- at launch,
- every 4 hours,
- whenever the connection comes back.

When a new version is found, users see an **Update available** dialog with the release notes. They can download, then restart to install.

### One-time setup

Releases are published to [Bertrand-Ir/Stuadio](https://github.com/Bertrand-Ir/Stuadio), which is already configured in `package.json`. Keep the repository public so installed apps can read its releases.

### Shipping a new version

```bash
npm version patch          # e.g. 1.0.0 -> 1.0.1 (updates package.json and creates tag v1.0.1)
git push origin main --tags
```

The `Release` workflow (`.github/workflows/release.yml`) then runs on the tag:

1. Runs the self-test.
2. Builds the installer.
3. Publishes the GitHub Release with `latest.yml`, which installed apps read to find updates.

Write the release notes on the GitHub release page. They're shown in the in-app update dialog.

> **Code signing:** builds are unsigned by default, so Windows SmartScreen will warn on first install. To remove the warning, add a code-signing certificate (`CSC_LINK` / `CSC_KEY_PASSWORD` secrets).

## Notes

- **RNNoise workaround:** the bundled FFmpeg 6.1.1 `arnndn` filter has a memory bug. In roughly half of all processes it runs a corrupted network that removes about 10 dB less noise. Stuadio fingerprints the healthy output on a short probe and restarts the pass instantly if it gets a bad instance (see `_neuralStage` in `src/engine/session.js`). Processing is fully deterministic as a result.
- **FFmpeg licence:** FFmpeg is bundled through `ffmpeg-static`. That build is GPL-licensed, so if you distribute Stuadio, comply with FFmpeg's licence terms.
- **RNNoise model:** `resources/models/cb.rnnn` is from [rnnoise-models](https://github.com/GregorR/rnnoise-models).
