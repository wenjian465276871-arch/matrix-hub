export class ShapeGenerator {
    static getGalaxyPoints(width, height, count) {
        const points = [];
        const cx = width / 2;
        const cy = height / 2;
        // Expanded to cover full screen + corners (diagonal)
        const maxRadius = Math.sqrt(width * width + height * height) * 0.6; 

        for (let i = 0; i < count; i++) {
            // Logarithmic Spiral with more randomness for "Cloud" effect
            // 3 arms, 3-4 turns
            const arms = 3;
            const armIndex = i % arms;
            const spin = Math.random() * Math.PI * 2 * 3; 
            
            // Bias towards center but allow full spread
            // Use power function to concentrate more stars in center but have long tails
            const dist = Math.pow(Math.random(), 0.5) * maxRadius;
            
            const angle = spin + (armIndex * (Math.PI * 2 / arms));
            
            // Random spread increasing with distance
            const spread = (Math.random() - 0.5) * (dist * 0.5 + 50);
            
            const x = cx + Math.cos(angle) * dist + spread;
            const y = cy + Math.sin(angle) * dist + spread;
            
            // Color based on distance from center (Hot center -> Cool edges)
            const distRatio = dist / maxRadius;
            const hue = 200 + distRatio * 100; // Blue -> Purple -> Pink
            const light = 80 - distRatio * 40; // Bright -> Darker
            
            points.push({
                x: x,
                y: y,
                color: `hsla(${hue}, 80%, ${light}%, ${0.5 + Math.random() * 0.5})`,
                // Optional: add initial velocity hint if needed
                isGalaxy: true 
            });
        }
        return points;
    }

    static getHeartPoints(width, height, count) {
        const points = [];
        const cx = width / 2;
        const cy = height / 2;
        // Scale heart to fit
        const scale = Math.min(width, height) / 35; 

        for (let i = 0; i < count; i++) {
            // Parametric Heart Equation:
            // x = 16sin^3(t)
            // y = 13cos(t) - 5cos(2t) - 2cos(3t) - cos(4t)
            const t = Math.random() * Math.PI * 2;
            
            // Random point *inside* the heart? Or just the outline?
            // "聚拢形成爱心形状" usually implies filled or outline. 
            // Let's do a filled heart by scaling the result randomly.
            const r = Math.sqrt(Math.random()); // Sqrt for uniform distribution
            
            // Or just outline looks cleaner for particles. Let's do a thick outline with some spread.
            
            const x = 16 * Math.pow(Math.sin(t), 3);
            const y = -(13 * Math.cos(t) - 5 * Math.cos(2*t) - 2 * Math.cos(3*t) - Math.cos(4*t)); // Invert Y because canvas Y is down
            
            // Add randomness
            const spreadX = (Math.random() - 0.5) * 20;
            const spreadY = (Math.random() - 0.5) * 20;

            points.push({
                x: cx + x * scale + spreadX,
                y: cy + y * scale + spreadY,
                color: `hsla(${330 + Math.random() * 30}, 80%, 60%, ${0.6 + Math.random() * 0.4})` // Pink/Red
            });
        }
        return points;
    }

    static getTextPointsImproved(text, width, height, count) {
        // 1. Create offscreen canvas with high precision
        const offCanvas = document.createElement('canvas');
        offCanvas.width = width;
        offCanvas.height = height;
        const ctx = offCanvas.getContext('2d');

        // FONT STACK CONSTANT
        const FONT_STACK = '"PingFang SC", "Microsoft YaHei", "Source Han Sans SC", "Noto Sans CJK SC", "Heiti SC", sans-serif';

        // 2. Font settings - Adaptive Sizing
        let fontSize = Math.min(width, height) * 0.4;
        ctx.font = `bold ${fontSize}px ${FONT_STACK}`;
        
        // Split text into lines (Manual wrap for punctuation or length)
        let lines = [];
        if (text.includes('，')) {
            lines = text.split('，').map((part, i, arr) => i < arr.length - 1 ? part + '，' : part);
        } else if (text.length > 6) {
             // Simple length based wrap
             const mid = Math.ceil(text.length / 2);
             lines = [text.slice(0, mid), text.slice(mid)];
        } else {
            lines = [text];
        }

        // Measure and shrink if needed (checking the longest line)
        const getMaxWidth = () => Math.max(...lines.map(line => ctx.measureText(line).width));
        
        while ((getMaxWidth() > width * 0.8 || (fontSize * lines.length * 1.2) > height * 0.8) && fontSize > 20) {
            fontSize -= 10;
            ctx.font = `bold ${fontSize}px ${FONT_STACK}`;
        }

        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#FFFFFF';

        // Draw Text with Spacing and Line Height
        const lineHeight = fontSize * 1.4;
        const totalHeight = lines.length * lineHeight;
        const startY = (height - totalHeight) / 2 + lineHeight / 2;

        const letterSpacing = fontSize * 0.1; // 10% spacing

        lines.forEach((line, index) => {
            const y = startY + index * lineHeight;
            
            // Calculate total width with spacing
            let totalWidth = 0;
            for (let char of line) {
                totalWidth += ctx.measureText(char).width + letterSpacing;
            }
            totalWidth -= letterSpacing; // Remove last spacing

            let currentX = (width - totalWidth) / 2;

            for (let char of line) {
                const metrics = ctx.measureText(char);
                // Draw char centered at current position + half width
                ctx.fillText(char, currentX + metrics.width / 2, y);
                currentX += metrics.width + letterSpacing;
            }
        });

        // 3. Get pixel data
        const imageData = ctx.getImageData(0, 0, width, height);
        const data = imageData.data;
        
        const edgePixels = [];
        const innerPixels = [];
        
        // 4. Scan pixels with Edge Detection
        // Use a smaller step for higher detail, but not 1 to save perf
        const step = 2; 
        
        for (let y = step; y < height - step; y += step) {
            for (let x = step; x < width - step; x += step) {
                const index = (y * width + x) * 4;
                const alpha = data[index + 3];

                if (alpha > 50) { // If pixel is visible
                    // Check neighbors to detect edge
                    // We check 4 neighbors at distance 'step'
                    const left = data[(y * width + (x - step)) * 4 + 3];
                    const right = data[(y * width + (x + step)) * 4 + 3];
                    const top = data[((y - step) * width + x) * 4 + 3];
                    const bottom = data[((y + step) * width + x) * 4 + 3];

                    // If any neighbor is transparent, this is an edge
                    if (left < 50 || right < 50 || top < 50 || bottom < 50) {
                        edgePixels.push({x, y});
                    } else {
                        innerPixels.push({x, y});
                    }
                }
            }
        }

        // Fallback if no pixels found
        if (edgePixels.length === 0 && innerPixels.length === 0) {
            return this.getGalaxyPoints(width, height, count);
        }

        // 5. Distribute particles
        // Allocation strategy: 40% to edges (for sharpness), 60% to fill
        const points = [];
        const edgeCount = Math.floor(count * 0.4);
        const innerCount = count - edgeCount;

        // Helper to get random point from array
        const getRandomPoint = (arr) => {
             if (arr.length === 0) return {x: width/2, y: height/2};
             const p = arr[Math.floor(Math.random() * arr.length)];
             // Add slight jitter to prevent grid artifacts (Moiré pattern)
             return {
                 x: p.x + (Math.random() - 0.5) * step,
                 y: p.y + (Math.random() - 0.5) * step
             };
        };

        // Fill edges
        for (let i = 0; i < edgeCount; i++) {
            // If we run out of edge pixels, fallback to inner (or vice versa)
            const p = edgePixels.length > 0 ? getRandomPoint(edgePixels) : getRandomPoint(innerPixels);
            points.push({
                x: p.x,
                y: p.y,
                color: `hsla(${40 + Math.random() * 20}, 100%, 70%, ${0.9 + Math.random() * 0.1})` // Brighter Gold for edges
            });
        }

        // Fill inner
        for (let i = 0; i < innerCount; i++) {
             const p = innerPixels.length > 0 ? getRandomPoint(innerPixels) : getRandomPoint(edgePixels);
             points.push({
                x: p.x,
                y: p.y,
                color: `hsla(${40 + Math.random() * 40}, 80%, 50%, ${0.5 + Math.random() * 0.3})` // Darker/Varied for inner
            });
        }

        return points;
    }

    static getTextPoints(text, width, height, count) {
        // Create offscreen canvas
        const offCanvas = document.createElement('canvas');
        offCanvas.width = width;
        offCanvas.height = height;
        const ctx = offCanvas.getContext('2d');

        // Font settings - Adaptive Sizing
        let fontSize = Math.min(width, height) * 0.4; // Start relative to screen size
        ctx.font = `bold ${fontSize}px Arial`;
        
        // Measure and shrink if needed
        let textMetrics = ctx.measureText(text);
        while ((textMetrics.width > width * 0.8 || fontSize > height * 0.6) && fontSize > 20) {
            fontSize -= 10;
            ctx.font = `bold ${fontSize}px Arial`;
            textMetrics = ctx.measureText(text);
        }

        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        
        ctx.fillStyle = '#FFFFFF';
        ctx.fillText(text, width / 2, height / 2);

        // Get pixel data
        const imageData = ctx.getImageData(0, 0, width, height);
        const data = imageData.data;
        
        const validPixels = [];
        // Scan with a step to improve performance
        const step = 4; 
        for (let y = 0; y < height; y += step) {
            for (let x = 0; x < width; x += step) {
                const alpha = data[(y * width + x) * 4 + 3];
                if (alpha > 128) {
                    validPixels.push({x, y});
                }
            }
        }

        // Now map 'count' particles to these pixels randomly
        const points = [];
        if (validPixels.length === 0) return this.getGalaxyPoints(width, height, count); // Fallback

        for (let i = 0; i < count; i++) {
            const pixel = validPixels[Math.floor(Math.random() * validPixels.length)];
            points.push({
                x: pixel.x,
                y: pixel.y,
                color: `hsla(${40 + Math.random() * 40}, 90%, 60%, ${0.8 + Math.random() * 0.2})` // Gold/Yellow
            });
        }
        return points;
    }
}