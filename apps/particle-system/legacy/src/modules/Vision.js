export const GestureType = {
    NONE: 'none',
    FIST: 'fist',      // Heart
    OPEN: 'open',      // Galaxy (Reset)
    ONE: 'one',        // Text 1
    TWO: 'two',        // Text 2
    THREE: 'three'     // Text 3
};

export class VisionModule {
    constructor(videoElement, canvasElement) {
        this.videoElement = videoElement;
        this.canvasElement = canvasElement;
        this.ctx = canvasElement.getContext('2d');
        this.hands = null;
        this.onGestureChange = null;
        this.lastGesture = GestureType.NONE;
        this.gestureHistory = []; // For smoothing or wave detection
        
        // Wave detection variables
        this.waveQueue = []; 
        this.isWaving = false;
    }

    async initialize() {
        this.hands = new window.Hands({locateFile: (file) => {
            return `https://fastly.jsdelivr.net/npm/@mediapipe/hands/${file}`;
        }});

        this.hands.setOptions({
            maxNumHands: 1,
            modelComplexity: 1,
            minDetectionConfidence: 0.5,
            minTrackingConfidence: 0.5
        });

        this.hands.onResults(this.onResults.bind(this));
    }

    async send(inputVideo) {
        if (this.hands) {
            await this.hands.send({image: inputVideo});
        }
    }

    onResults(results) {
        // 自动调整调试画布大小以匹配视频流
        if (this.canvasElement.width !== results.image.width || this.canvasElement.height !== results.image.height) {
            this.canvasElement.width = results.image.width;
            this.canvasElement.height = results.image.height;
        }

        // Draw debug
        this.ctx.save();
        this.ctx.clearRect(0, 0, this.canvasElement.width, this.canvasElement.height);
        this.ctx.drawImage(results.image, 0, 0, this.canvasElement.width, this.canvasElement.height);
        
        if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
            const landmarks = results.multiHandLandmarks[0];
            
            // Draw skeleton (安全检查，防止 drawing_utils 未加载)
            if (window.drawConnectors && window.HAND_CONNECTIONS) {
                window.drawConnectors(this.ctx, landmarks, window.HAND_CONNECTIONS, {color: '#00FF00', lineWidth: 2});
            }
            if (window.drawLandmarks) {
                window.drawLandmarks(this.ctx, landmarks, {color: '#FF0000', lineWidth: 1});
            }

            // Analyze gesture
            const gesture = this.classifyGesture(landmarks);
            
            // Debounce/Smoothing could go here
            if (gesture !== this.lastGesture) {
                this.lastGesture = gesture;
                if (this.onGestureChange) {
                    this.onGestureChange(gesture);
                }
            }
        } else {
             if (this.lastGesture !== GestureType.NONE) {
                 this.lastGesture = GestureType.NONE;
                 if (this.onGestureChange) this.onGestureChange(GestureType.NONE);
             }
        }
        this.ctx.restore();
    }

    classifyGesture(landmarks) {
        // Landmarks: 0=wrist, 4=thumb_tip, 8=index_tip, 12=middle_tip, 16=ring_tip, 20=pinky_tip
        // Helper to check if finger is extended (tip higher than lower joint)
        // Note: Y coordinates are normalized 0-1, 0 is top. So lower value means higher on screen.
        // But hand orientation matters. Assuming upright hand.
        
        const isFingerExtended = (tipIdx, pipIdx) => {
            return landmarks[tipIdx].y < landmarks[pipIdx].y;
        };

        // Thumb is tricky (x-axis movement), let's check distance to index MCP or simply x-offset relative to wrist
        // Simple check: Tip to MCP distance vs Tip to Wrist? 
        // Or just checking if tip is far from palm.
        // Let's use a simpler "is above" logic for 4 fingers, and specific logic for thumb.
        
        // Pseudo-direction based on Wrist(0) to MiddleMCP(9)
        const wrist = landmarks[0];
        const middleMCP = landmarks[9];
        
        // Fingers: Index(8), Middle(12), Ring(16), Pinky(20)
        // PIP joints: 6, 10, 14, 18
        
        const indexOpen = landmarks[8].y < landmarks[6].y;
        const middleOpen = landmarks[12].y < landmarks[10].y;
        const ringOpen = landmarks[16].y < landmarks[14].y;
        const pinkyOpen = landmarks[20].y < landmarks[18].y;
        
        // Thumb(4) vs IP(3) or MCP(2). 
        // For "Fist", thumb is usually tucked or close to index.
        // Let's count extended fingers.
        
        let extendedCount = 0;
        if (indexOpen) extendedCount++;
        if (middleOpen) extendedCount++;
        if (ringOpen) extendedCount++;
        if (pinkyOpen) extendedCount++;
        
        // Thumb logic: check if thumb tip is to the side of index mcp (depending on hand)
        // or just use y for simplicity if hand is vertical.
        // Let's simplify: Thumb is "open" if it's far from the palm center (9).
        const thumbTip = landmarks[4];
        const palmCenter = landmarks[9];
        const thumbDist = Math.hypot(thumbTip.x - palmCenter.x, thumbTip.y - palmCenter.y);
        
        // Dynamic threshold based on hand size (Wrist to Middle MCP)
        const handSize = Math.hypot(landmarks[0].x - landmarks[9].x, landmarks[0].y - landmarks[9].y);
        const thumbOpen = thumbDist > (handSize * 0.6); // Thumb tip is far from palm center relative to hand size

        if (thumbOpen) extendedCount++;

        // Classification
        // 1. Fist: 0 or 1 finger (thumb might be ambiguous)
        if (!indexOpen && !middleOpen && !ringOpen && !pinkyOpen) {
            return GestureType.FIST;
        }

        // 2. Open Hand: 5 fingers
        if (indexOpen && middleOpen && ringOpen && pinkyOpen && thumbOpen) {
            // Check for wave? For now just return OPEN, handle wave in history?
            // User requirement: "Open hand AND wave". 
            // If just "Open", it might be idle.
            // But let's return OPEN here, and Main logic checks movement.
            return GestureType.OPEN; 
        }

        // 3. "1": Index only
        if (indexOpen && !middleOpen && !ringOpen && !pinkyOpen) {
            return GestureType.ONE;
        }

        // 4. "2": Index + Middle
        if (indexOpen && middleOpen && !ringOpen && !pinkyOpen) {
            return GestureType.TWO;
        }

        // 5. "3": Index + Middle + Ring
        if (indexOpen && middleOpen && ringOpen && !pinkyOpen) {
            return GestureType.THREE;
        }

        return GestureType.NONE;
    }
}