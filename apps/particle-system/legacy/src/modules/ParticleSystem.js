import { ShapeGenerator } from './ShapeGenerator.js';

class Particle {
    constructor(w, h) {
        this.x = Math.random() * w;
        this.y = Math.random() * h;
        this.targetX = this.x;
        this.targetY = this.y;
        this.vx = 0;
        this.vy = 0;
        this.size = 2 + Math.random() * 3;
        
        // Color properties
        this.baseHue = 200; // Default blue-ish
        this.hue = this.baseHue;
        this.saturation = 80;
        this.lightness = 60;
        this.alpha = 0.8;
        this.color = `hsla(${this.hue}, ${this.saturation}%, ${this.lightness}%, ${this.alpha})`;
        
        this.friction = 0.92;
        this.ease = 0.05 + Math.random() * 0.05;
        this.baseEase = this.ease; // Store original ease
        this.baseSize = this.size;
        
        // Explosion/Interaction
        this.explosionVx = 0;
        this.explosionVy = 0;
    }

    update(mouse, gyro, config) {
        // Physics: Move towards target
        const dx = this.targetX - this.x;
        const dy = this.targetY - this.y;
        
        // Dynamic easing based on distance or state
        // If we are far, move faster? Or just use the current ease value.
        // Easing decay to normal
        if (this.ease > this.baseEase) {
             this.ease *= 0.95; // Decay back to normal
        }

        this.vx += dx * this.ease * 0.1;
        this.vy += dy * this.ease * 0.1;
        
        // Mouse Interaction (Repulsion/Attraction)
        if (mouse.active) {
            const mdx = this.x - mouse.x;
            const mdy = this.y - mouse.y;
            // Optimize: Use squared distance to avoid sqrt
            const distSq = mdx * mdx + mdy * mdy;
            const maxDist = 200;
            const maxDistSq = maxDist * maxDist;

            if (distSq < maxDistSq) {
                const distance = Math.sqrt(distSq); // Need actual distance for normalization
                const force = (maxDist - distance) / maxDist;
                // Burst on click, gentle push on move
                const strength = mouse.clicked ? 50 : 2; 
                const dirX = mdx / distance;
                const dirY = mdy / distance;

                this.vx += dirX * force * strength;
                this.vy += dirY * force * strength;
            }
        }

        // Gyro Interaction
        if (gyro && (gyro.beta || gyro.gamma)) {
            // beta: front/back (-180 to 180), gamma: left/right (-90 to 90)
            this.vx += (gyro.gamma || 0) * 0.05;
            this.vy += (gyro.beta || 0) * 0.05;
        }

        // Apply friction
        this.vx *= this.friction;
        this.vy *= this.friction;

        // Update position
        this.x += this.vx;
        this.y += this.vy;

        // Dynamic Color & Size
        // Optimize: Approximation or only calc if needed
        // For size: baseSize + min(speed * 0.5, 3)
        // Speed squared
        const speedSq = this.vx * this.vx + this.vy * this.vy;
        
        // Avoid sqrt if speed is low, or just use approximation
        // If speedSq is small (< 0.1), speed is ~0.
        if (speedSq > 0.1) {
             const speed = Math.sqrt(speedSq);
             this.size = this.baseSize + Math.min(speed * 0.5, 3);
        } else {
             this.size = this.baseSize;
        }
    }
}

export class ParticleSystem {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.particles = [];
        
        this.config = {
            particleCount: 3000,
            trailStrength: 0.2, // Lower = longer trails
            interactionRadius: 200,
            enableImmersive: false
        };

        this.mouse = { x: 0, y: 0, active: false, clicked: false };
        this.gyro = { beta: 0, gamma: 0 };

        this.resize();
        this.initParticles();
        this.initInteraction();
        
        window.addEventListener('resize', () => this.resize());
    }

    resize() {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
    }

    initInteraction() {
        // Mouse / Touch
        const updatePos = (x, y) => {
            this.mouse.x = x;
            this.mouse.y = y;
            this.mouse.active = true;
        };

        window.addEventListener('mousemove', e => updatePos(e.clientX, e.clientY));
        window.addEventListener('mousedown', () => { this.mouse.clicked = true; });
        window.addEventListener('mouseup', () => { this.mouse.clicked = false; });
        
        window.addEventListener('touchmove', e => {
            e.preventDefault();
            updatePos(e.touches[0].clientX, e.touches[0].clientY);
        }, { passive: false });
        window.addEventListener('touchstart', e => {
            updatePos(e.touches[0].clientX, e.touches[0].clientY);
            this.mouse.clicked = true;
        }, { passive: false });
        window.addEventListener('touchend', () => { this.mouse.clicked = false; this.mouse.active = false; });

        // Gyro
        window.addEventListener('deviceorientation', e => {
            this.gyro.beta = e.beta;   // x-axis
            this.gyro.gamma = e.gamma; // y-axis
        });
        
        // Reset mouse active after inactivity
        let timeout;
        window.addEventListener('mousemove', () => {
            clearTimeout(timeout);
            timeout = setTimeout(() => { this.mouse.active = false; }, 2000);
        });
    }

    initParticles() {
        this.adjustParticleCount(this.config.particleCount);
        this.setShape('galaxy');
    }

    adjustParticleCount(newCount) {
        const currentCount = this.particles.length;
        if (newCount > currentCount) {
            for (let i = 0; i < newCount - currentCount; i++) {
                this.particles.push(new Particle(this.canvas.width, this.canvas.height));
            }
        } else if (newCount < currentCount) {
            this.particles.splice(newCount);
        }
        this.config.particleCount = newCount;
    }

    setVisualMode(enabled) {
        this.config.enableImmersive = enabled;
        if (enabled) {
            document.body.classList.add('immersive-mode');
        } else {
            document.body.classList.remove('immersive-mode');
        }
    }

    setShape(type, text = '') {
        let points;
        const w = this.canvas.width;
        const h = this.canvas.height;

        switch (type) {
            case 'heart':
                points = ShapeGenerator.getHeartPoints(w, h, this.config.particleCount);
                break;
            case 'text':
                if (ShapeGenerator.getTextPointsImproved) {
                     points = ShapeGenerator.getTextPointsImproved(text, w, h, this.config.particleCount);
                } else {
                     points = ShapeGenerator.getTextPoints(text, w, h, this.config.particleCount);
                }
                break;
            case 'galaxy':
            default:
                points = ShapeGenerator.getGalaxyPoints(w, h, this.config.particleCount);
                break;
        }

        const isGalaxy = type === 'galaxy';

        this.particles.forEach((p, i) => {
            if (points[i]) {
                p.targetX = points[i].x;
                p.targetY = points[i].y;
                p.color = points[i].color || 'white';
                
                // Boost speed for galaxy diffusion
                if (isGalaxy) {
                    // Set high ease for "explosion" effect (0.15 - 0.25)
                    // This allows covering screen in ~0.5-1s
                    p.ease = 0.15 + Math.random() * 0.1;
                    
                    // Optional: If switching TO galaxy, maybe push particles out?
                    // But just increasing ease is usually enough for "rapid diffusion" if targets are far.
                } else {
                    // Normal ease for precise shapes
                    p.ease = p.baseEase;
                }
            } else {
                p.targetX = w / 2;
                p.targetY = h / 2;
                p.color = 'transparent';
            }
        });
    }

    update() {
        // Trail Effect
        this.ctx.fillStyle = `rgba(0, 0, 0, ${this.config.trailStrength})`;
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

        // Additive blending for glow effect
        this.ctx.globalCompositeOperation = 'lighter';

        for (let i = 0; i < this.particles.length; i++) {
            const p = this.particles[i];
            p.update(this.mouse, this.gyro, this.config);
            
            if (p.color !== 'transparent') {
                this.ctx.fillStyle = p.color;
                this.ctx.beginPath();
                this.ctx.arc(p.x, p.y, p.size * 0.8, 0, Math.PI * 2); 
                this.ctx.fill();
            }
        }
        
        // Reset composite operation for next frame's clear
        this.ctx.globalCompositeOperation = 'source-over';
    }
}