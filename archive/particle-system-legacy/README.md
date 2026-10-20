# Gesture Particle System

> **归档代码，不构建、不服务**（ADR-0003）。依赖 MediaPipe CDN 与在线字体，与本站 CSP `default-src 'self'` 冲突，
> 因此保留源码作历史参考，不进入镜像。线上已不提供入口；如需恢复，先去掉 CDN 依赖并重新做 CSP 评估。

A real-time interactive particle system controlled by hand gestures using MediaPipe and HTML5 Canvas.

## Features
- **Hand Gesture Control**:
  - ✋ **Open Hand**: Galaxy Mode (Spiral diffusion).
  - ✊ **Fist**: Heart Mode (Particles form a heart).
  - ☝️ **One/Two/Three Fingers**: Display custom text messages.
- **Immersive Visuals**: 3000+ particles with glow effects and fluid motion.
- **High Performance**: Decoupled architecture ensuring 60 FPS rendering.

## Installation & Usage
1.  Clone the repository.
2.  Serve the root directory using a local web server (e.g., Live Server, Python `http.server`).
    ```bash
    python -m http.server 8080
    ```
3.  Open `http://localhost:8080` in a browser.
4.  Allow camera access when prompted.

## Documentation

架构与取舍见仓库级 [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) 与 [`docs/adr/0003-legacy-static-not-shipped.md`](../../docs/adr/0003-legacy-static-not-shipped.md)。
原 README 链接的 `docs/PERFORMANCE_REPORT.md` 从未随代码迁移，已移除该链接（死链不如不写）。

## Controls
- **Gestures**: Use hand gestures in front of the camera.
- **Keyboard Fallback**:
  - `1-5`: Simulate gestures.
  - `h`: Toggle UI visibility.
  - `d`: Toggle Camera Debug View.

## License
MIT License
