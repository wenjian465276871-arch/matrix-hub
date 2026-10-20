export class CameraModule {
    constructor(videoElement) {
        this.videoElement = videoElement;
        this.stream = null;
    }

    async start() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            throw new Error('Browser API not supported');
        }

        try {
            this.stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    width: { ideal: 1280 },
                    height: { ideal: 720 },
                    facingMode: 'user'
                },
                audio: false
            });

            this.videoElement.srcObject = this.stream;
            
            return new Promise((resolve) => {
                this.videoElement.onloadedmetadata = () => {
                    this.videoElement.play();
                    resolve(this.videoElement);
                };
            });
        } catch (error) {
            console.error('Camera initialization failed:', error);
            throw error;
        }
    }

    stop() {
        if (this.stream) {
            this.stream.getTracks().forEach(track => track.stop());
            this.stream = null;
        }
    }
}