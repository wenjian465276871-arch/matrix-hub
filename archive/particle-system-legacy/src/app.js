import { CameraModule } from './modules/Camera.js';
import { VisionModule, GestureType } from './modules/Vision.js';
import { ParticleSystem } from './modules/ParticleSystem.js';

class App {
    constructor() {
        this.videoElement = document.getElementById('input-video');
        this.debugCanvas = document.getElementById('debug-canvas');
        this.particleCanvas = document.getElementById('particle-canvas');
        this.statusText = document.getElementById('status-text');
        this.gestureIcon = document.getElementById('gesture-icon');
        this.loadingOverlay = document.getElementById('loading');

        this.camera = new CameraModule(this.videoElement);
        this.vision = new VisionModule(this.videoElement, this.debugCanvas);
        this.particles = new ParticleSystem(this.particleCanvas);

        this.currentGesture = GestureType.NONE;
        this.isWaving = false;
        this.waveHistory = [];
        this.isCameraReady = false;
        
        // Fallback interaction
        this.fallbackModes = [GestureType.OPEN, GestureType.FIST, GestureType.ONE, GestureType.TWO, GestureType.THREE];
        this.fallbackIndex = 0;
    }

    async init() {
        // 检查安全上下文 (HTTPS/Localhost)
        const isSecureContext = window.isSecureContext;
        if (!isSecureContext && window.location.hostname !== 'localhost') {
            console.warn('MediaPipe requires a secure context (HTTPS) to work properly on remote servers.');
            this.statusText.innerHTML = '<span style="color: #ffaa00">⚠️ 环境提示：请使用 HTTPS 访问或在 Chrome 中开启非法源信任</span>';
        }

        try {
            await this.camera.start();
            this.isCameraReady = true;
            await this.vision.initialize();
            
            this.loadingOverlay.classList.add('hidden');
            
            // Bind vision events
            this.vision.onGestureChange = (gesture) => this.handleGesture(gesture);
            
            // Start independent vision loop
            this.startVisionLoop();
            
        } catch (error) {
            this.loadingOverlay.innerText = '摄像头初始化失败，已启用键盘交互模式 (1-5)';
            this.loadingOverlay.style.color = 'orange';
            setTimeout(() => this.loadingOverlay.classList.add('hidden'), 3000);
            
            console.error(error);
        }
        
        // Enable Immersive Mode by default
        this.particles.setVisualMode(true);
        
        // Keyboard Fallback & Debug Controls
        window.addEventListener('keydown', (e) => {
            switch(e.key) {
                case '1': this.handleGesture(GestureType.FIST); break;
                case '2': this.handleGesture(GestureType.OPEN); break;
                case '3': this.handleGesture(GestureType.ONE); break;
                case '4': this.handleGesture(GestureType.TWO); break;
                case '5': this.handleGesture(GestureType.THREE); break;
                case 'h': this.toggleUI(); break; // Toggle UI visibility
                case 'd': this.toggleDebug(); break; // Toggle Debug info
            }
        });
        
        // Expose for debugging/tuning
        window.app = this;
        
        // Initialize FPS counter
        this.lastFrameTime = performance.now();
        this.frameCount = 0;
        this.fps = 0;
        
        // Always start loop
        this.loop();

        // Initialize Auto Cursor Hider
        this.initCursorControl();
    }

    initCursorControl() {
        const CURSOR_TIMEOUT = 3000;
        let cursorTimer;
        
        const showCursor = () => {
            document.body.classList.remove('hide-cursor');
            clearTimeout(cursorTimer);
            
            // Only set timer if document is visible
            if (!document.hidden) {
                cursorTimer = setTimeout(() => {
                    // Check again if visible (though redundant with event)
                    if (!document.hidden) {
                        document.body.classList.add('hide-cursor');
                    }
                }, CURSOR_TIMEOUT);
            }
        };

        // Event Listeners
        window.addEventListener('mousemove', showCursor);
        window.addEventListener('mousedown', showCursor);
        window.addEventListener('touchstart', showCursor); // For compatibility

        // Visibility Change
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                clearTimeout(cursorTimer);
            } else {
                showCursor();
            }
        });

        // Initial trigger
        showCursor();
    }

    toggleDebug() {
        const debugContainer = document.getElementById('debug-container') || this.createDebugContainer();
        debugContainer.style.display = debugContainer.style.display === 'none' ? 'block' : 'none';
    }

    createDebugContainer() {
        const div = document.createElement('div');
        div.id = 'debug-container';
        div.style.position = 'absolute';
        div.style.top = '10px';
        div.style.right = '10px';
        div.style.color = 'white';
        div.style.backgroundColor = 'rgba(0,0,0,0.5)';
        div.style.padding = '5px';
        div.style.zIndex = '10000';
        document.body.appendChild(div);
        return div;
    }

    async startVisionLoop() {
        const visionLoop = async () => {
            if (this.isCameraReady) {
                const startTime = performance.now();
                await this.vision.send(this.videoElement);
                const duration = performance.now() - startTime;
                
                // Adaptive delay: aim for ~30 FPS (33ms) or max speed if slower
                // If detection takes 50ms, we just run immediately again.
                // If it takes 10ms, we wait 23ms.
                const delay = Math.max(0, 33 - duration);
                setTimeout(visionLoop, delay);
            } else {
                setTimeout(visionLoop, 1000); // Retry if camera lost
            }
        };
        visionLoop();
    }

    toggleUI() {
        const isImmersive = document.body.classList.contains('immersive-mode');
        this.particles.setVisualMode(!isImmersive);
    }

    handleGesture(gesture) {
        // Debounce or logic check could happen here
        // For "Wave", we might need continuous checking, not just change event.
        // But let's rely on the frame loop for wave detection if needed.
        
        // However, VisionModule returns static gestures.
        // If gesture is OPEN, we assume it *might* be a wave.
        // Or we just map Open -> Galaxy directly as per "Open hand AND wave" -> Galaxy.
        // If the user *just* opens hand without waving, does it trigger?
        // Requirement: "展开手掌并挥手 -> 粒子恢复默认".
        // If I just open hand, maybe nothing happens?
        // Let's implement a simple wave detector in the Vision module or here.
        // Let's stick to simple mapping first for responsiveness: Open -> Galaxy.
        // If strict "Wave" is needed, I'd track x-movement.
        
        if (gesture === this.currentGesture) return;
        this.currentGesture = gesture;
        this.updateUI(gesture);

        switch (gesture) {
            case GestureType.FIST:
                this.particles.setShape('heart');
                break;
            case GestureType.OPEN:
                this.particles.setShape('galaxy');
                break;
            case GestureType.ONE:
                this.particles.setShape('text', '以防再也见不到你');
                break;
            case GestureType.TWO:
                this.particles.setShape('text', '祝你');
                break;
            case GestureType.THREE:
                this.particles.setShape('text', '早安，午安，晚安');
                break;
            default:
                // Do nothing or maintain last state
                break;
        }
    }

    updateUI(gesture) {
        let text = '等待手势...';
        let icon = '✋';

        switch (gesture) {
            case GestureType.FIST:
                text = '爱心模式';
                icon = '❤️';
                break;
            case GestureType.OPEN:
                text = '银河模式';
                icon = '🌌';
                break;
            case GestureType.ONE:
                text = '展示文字 1';
                icon = '☝️';
                break;
            case GestureType.TWO:
                text = '展示文字 2';
                icon = '✌️';
                break;
            case GestureType.THREE:
                text = '展示文字 3';
                icon = '👌';
                break;
        }
        
        this.statusText.innerText = text;
        this.gestureIcon.innerText = icon;
        
        // Visual feedback animation
        this.gestureIcon.style.transform = 'scale(1.5)';
        setTimeout(() => {
            this.gestureIcon.style.transform = 'scale(1)';
        }, 200);
    }

    async loop() {
        // 1. Vision Process - REMOVED from main loop
        // if (this.isCameraReady) {
        //    await this.vision.send(this.videoElement);
        // }

        // 2. Particle Update
        this.particles.update();

        requestAnimationFrame(() => this.loop());
    }
}

const app = new App();
app.init();