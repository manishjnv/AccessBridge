# Icons — Post-Scaffold Action Required

The icons here are placeholder copies from the browser extension (128x128 PNG scaled down for 32x32).
`icon.ico` is missing — it cannot be generated without ImageMagick or the Tauri CLI's built-in generator.

Run the following command once Rust + `@tauri-apps/cli` are installed to regenerate proper
platform-specific icon sizes (32x32, 128x128, 128x128@2x, icon.ico, icon.png):

```
pnpm exec tauri icon path/to/source.png
```

A 1024x1024 source PNG produces the best results. Until then, `tauri build` will warn
about the missing `.ico` but the app will still launch in dev mode.
