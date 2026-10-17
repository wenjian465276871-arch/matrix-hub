# Gesture Particle System

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
- [Architecture Design](docs/ARCHITECTURE.md)
- [Performance Report](docs/PERFORMANCE_REPORT.md)

## Controls
- **Gestures**: Use hand gestures in front of the camera.
- **Keyboard Fallback**:
  - `1-5`: Simulate gestures.
  - `h`: Toggle UI visibility.
  - `d`: Toggle Camera Debug View.

## License
MIT License
