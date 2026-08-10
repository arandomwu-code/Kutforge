# Kutforge

A free, user-friendly Windows video editor with export up to 4K/120fps — no watermark, no subscription. Please make sure to read the disclaimer and license terms.

## Disclaimer

This was built with good intentions, not as hardened production software. I haven't had it security audited, and a project this size can have bugs or vulnerabilities I don't know about, including ones in the ffmpeg export path or the file/project handling. Use it at your own risk. I'm not liable for damage, data loss, or security incidents resulting from bugs, vulnerabilities, or anyone using this software maliciously. If you find a real vulnerability, please open an issue or reach out rather than exploiting it.

## License

Licensed under the PolyForm Noncommercial License 1.0.0: free for personal, educational, and noncommercial use. Commercial use requires permission.

## What it does

- Multi-track timeline — drag clips in, trim, split, fade, duplicate, undo/redo
- Real ffmpeg export, not a wrapper around someone else's export button — with automatic hardware encoder detection so you're not stuck on software encoding by default
- Export up to 4K, up to 120fps
- Autosave, so a crash doesn't cost you the last hour of work
- Project save/load

## What it doesn't do (yet)

- Windows only — no macOS or Linux build
- No color grading, no real audio mixing beyond clip-level fades and mute
- No plugin system
