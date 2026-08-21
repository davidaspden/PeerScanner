/**
 * random.js - Host Optical QR Stream Generator & Controller
 * Generates 100 tsX-codenumber items (ts99-...-last),
 * animates them at 10 FPS, and handles feedback QR code scanning.
 */

(function () {
    'use strict';

    const TOTAL_CODES = 100;
    
    // State
    const state = {
        codes: [], // array of string codes
        qrCanvases: [], // pre-rendered canvas elements
        activeIndices: [], // list of indices still playing
        currentIndexInActive: 0,
        isPlaying: true,
        fps: 10,
        timerId: null,
        ackIndices: new Set(),
        
        // Feedback camera state
        isFeedbackCamActive: false,
        feedbackStream: null,
        feedbackDetector: null,
        feedbackScanInterval: null
    };

    // DOM Elements
    const elements = {
        qrCanvas: document.getElementById('qrCanvas'),
        qrLoading: document.getElementById('qrLoading'),
        chunkIndexDisplay: document.getElementById('chunkIndexDisplay'),
        chunkCodeDisplay: document.getElementById('chunkCodeDisplay'),
        playPauseBtn: document.getElementById('playPauseBtn'),
        playPauseIcon: document.getElementById('playPauseIcon'),
        playPauseText: document.getElementById('playPauseText'),
        prevBtn: document.getElementById('prevBtn'),
        nextBtn: document.getElementById('nextBtn'),
        regenerateBtn: document.getElementById('regenerateBtn'),
        speedSlider: document.getElementById('speedSlider'),
        fpsValue: document.getElementById('fpsValue'),
        intervalValue: document.getElementById('intervalValue'),
        statTotal: document.getElementById('statTotal'),
        statActive: document.getElementById('statActive'),
        statAck: document.getElementById('statAck'),
        chunkMatrix: document.getElementById('chunkMatrix'),
        toggleFeedbackCamBtn: document.getElementById('toggleFeedbackCamBtn'),
        feedbackCamContainer: document.getElementById('feedbackCamContainer'),
        feedbackVideo: document.getElementById('feedbackVideo'),
        feedbackCanvas: document.getElementById('feedbackCanvas'),
        feedbackScanStatus: document.getElementById('feedbackScanStatus')
    };

    /**
     * Generate a random alphanumeric string with mixed upper/lower/numbers
     */
    function generateRandomCode(length = 10) {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let result = '';
        for (let i = 0; i < length; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    }

    /**
     * Generate 100 items:
     * - ts0-code ... ts98-code
     * - ts99-code-last
     */
    function generateCodeSet() {
        const list = [];
        for (let i = 0; i < TOTAL_CODES; i++) {
            const randomCode = generateRandomCode(10);
            const isLast = (i === TOTAL_CODES - 1);
            const itemCode = `ts${i}-${randomCode}${isLast ? '-last' : ''}`;
            list.push(itemCode);
        }
        return list;
    }

    /**
     * Pre-render QR codes to canvas objects in memory for ultra-smooth 10+ FPS playback
     */
    function preRenderQRCodes() {
        if (elements.qrLoading) elements.qrLoading.style.display = 'flex';

        state.codes = generateCodeSet();
        state.qrCanvases = [];
        state.activeIndices = [];
        state.ackIndices.clear();

        for (let i = 0; i < TOTAL_CODES; i++) {
            state.activeIndices.push(i);
        }

        const size = 300;

        for (let i = 0; i < TOTAL_CODES; i++) {
            const offscreenCanvas = document.createElement('canvas');
            offscreenCanvas.width = size;
            offscreenCanvas.height = size;

            if (window.QRCodeLib && window.QRCodeLib.drawToCanvas) {
                window.QRCodeLib.drawToCanvas(offscreenCanvas, state.codes[i], {
                    width: size,
                    height: size,
                    margin: 2,
                    errorCorrectionLevel: 'M'
                });
            }

            state.qrCanvases.push(offscreenCanvas);
        }

        if (elements.qrLoading) elements.qrLoading.style.display = 'none';
        
        state.currentIndexInActive = 0;
        updateMatrixUI();
        updateStatsUI();
        renderCurrentFrame();
        startPlayback();
    }

    /**
     * Draw the current frame onto the main visible QR canvas
     */
    function renderCurrentFrame() {
        if (!elements.qrCanvas || state.qrCanvases.length === 0) return;
        if (state.activeIndices.length === 0) {
            const ctx = elements.qrCanvas.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, elements.qrCanvas.width, elements.qrCanvas.height);
            ctx.fillStyle = '#10b981';
            ctx.font = 'bold 20px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('All 100 Chunks ACK\'d! 🎉', elements.qrCanvas.width / 2, elements.qrCanvas.height / 2);
            if (elements.chunkIndexDisplay) elements.chunkIndexDisplay.textContent = 'All Chunks Delivered!';
            if (elements.chunkCodeDisplay) elements.chunkCodeDisplay.textContent = 'Transmission Complete';
            return;
        }

        const realIndex = state.activeIndices[state.currentIndexInActive];
        const sourceCanvas = state.qrCanvases[realIndex];

        if (elements.qrCanvas) {
            elements.qrCanvas.width = 300;
            elements.qrCanvas.height = 300;
            const ctx = elements.qrCanvas.getContext('2d');
            if (sourceCanvas) {
                ctx.drawImage(sourceCanvas, 0, 0, 300, 300);
            } else if (window.QRCodeLib && window.QRCodeLib.drawToCanvas) {
                window.QRCodeLib.drawToCanvas(elements.qrCanvas, state.codes[realIndex], {
                    width: 300,
                    height: 300,
                    margin: 2,
                    errorCorrectionLevel: 'M'
                });
            }
        }

        const codeStr = state.codes[realIndex] || '';
        if (elements.chunkIndexDisplay) {
            elements.chunkIndexDisplay.textContent = `Frame: ${realIndex + 1} / ${TOTAL_CODES} (${state.activeIndices.length} in loop)`;
        }
        if (elements.chunkCodeDisplay) {
            elements.chunkCodeDisplay.textContent = codeStr;
        }

        highlightActiveMatrixCell(realIndex);
    }

    /**
     * Advance to the next frame in the active queue
     */
    function stepNext() {
        if (state.activeIndices.length === 0) return;
        state.currentIndexInActive = (state.currentIndexInActive + 1) % state.activeIndices.length;
        renderCurrentFrame();
    }

    /**
     * Step to previous frame
     */
    function stepPrev() {
        if (state.activeIndices.length === 0) return;
        state.currentIndexInActive = (state.currentIndexInActive - 1 + state.activeIndices.length) % state.activeIndices.length;
        renderCurrentFrame();
    }

    /**
     * Start animation playback timer at state.fps
     */
    function startPlayback() {
        stopPlayback();
        state.isPlaying = true;
        updatePlayPauseButton();

        const intervalMs = Math.round(1000 / state.fps);
        state.timerId = setInterval(() => {
            stepNext();
        }, intervalMs);
    }

    /**
     * Stop animation playback timer
     */
    function stopPlayback() {
        if (state.timerId) {
            clearInterval(state.timerId);
            state.timerId = null;
        }
        state.isPlaying = false;
        updatePlayPauseButton();
    }

    /**
     * Toggle Play / Pause
     */
    function togglePlayPause() {
        if (state.isPlaying) {
            stopPlayback();
        } else {
            startPlayback();
        }
    }

    function updatePlayPauseButton() {
        if (!elements.playPauseBtn) return;
        if (state.isPlaying) {
            elements.playPauseIcon.textContent = '⏸️';
            elements.playPauseText.textContent = 'Pause';
            elements.playPauseBtn.classList.remove('btn-secondary');
            elements.playPauseBtn.classList.add('btn-primary');
        } else {
            elements.playPauseIcon.textContent = '▶️';
            elements.playPauseText.textContent = 'Play';
            elements.playPauseBtn.classList.remove('btn-primary');
            elements.playPauseBtn.classList.add('btn-secondary');
        }
    }

    /**
     * Set playback FPS
     */
    function setFps(newFps) {
        state.fps = Math.max(1, Math.min(20, newFps));
        const interval = Math.round(1000 / state.fps);
        if (elements.fpsValue) elements.fpsValue.textContent = `${state.fps} FPS`;
        if (elements.intervalValue) elements.intervalValue.textContent = `${interval}ms`;
        if (state.isPlaying) {
            startPlayback();
        }
    }

    // =========================================================================
    // CHUNK TRANSMISSION MATRIX & STATS
    // =========================================================================

    /**
     * Build the 100-cell visual transmission matrix
     */
    function buildMatrixDOM() {
        if (!elements.chunkMatrix) return;
        elements.chunkMatrix.innerHTML = '';

        for (let i = 0; i < TOTAL_CODES; i++) {
            const cell = document.createElement('div');
            cell.className = 'matrix-cell active';
            cell.id = `matrixCell_${i}`;
            cell.title = `Chunk ${i}`;
            cell.textContent = `${i}`;
            elements.chunkMatrix.appendChild(cell);
        }
    }

    /**
     * Update classes on matrix cells
     */
    function updateMatrixUI() {
        for (let i = 0; i < TOTAL_CODES; i++) {
            const cell = document.getElementById(`matrixCell_${i}`);
            if (!cell) continue;

            if (state.ackIndices.has(i)) {
                cell.className = 'matrix-cell ack';
            } else {
                cell.className = 'matrix-cell active';
            }
        }
    }

    function highlightActiveMatrixCell(activeIdx) {
        document.querySelectorAll('.matrix-cell.playing').forEach(el => {
            const idx = parseInt(el.textContent, 10);
            if (state.ackIndices.has(idx)) {
                el.className = 'matrix-cell ack';
            } else {
                el.className = 'matrix-cell active';
            }
        });

        const activeCell = document.getElementById(`matrixCell_${activeIdx}`);
        if (activeCell) {
            activeCell.classList.add('playing');
        }
    }

    function updateStatsUI() {
        if (elements.statTotal) elements.statTotal.textContent = TOTAL_CODES;
        if (elements.statActive) elements.statActive.textContent = state.activeIndices.length;
        if (elements.statAck) elements.statAck.textContent = state.ackIndices.size;
    }

    /**
     * Process feedback received from client (drop ACK'd items from activeIndices)
     */
    function processClientFeedback(ackArray) {
        if (!Array.isArray(ackArray) || ackArray.length === 0) return;

        let newlyAckCount = 0;
        ackArray.forEach(idx => {
            if (typeof idx === 'number' && idx >= 0 && idx < TOTAL_CODES) {
                if (!state.ackIndices.has(idx)) {
                    state.ackIndices.add(idx);
                    newlyAckCount++;
                }
            }
        });

        if (newlyAckCount > 0) {
            // Rebuild activeIndices excluding ACK'd ones
            state.activeIndices = [];
            for (let i = 0; i < TOTAL_CODES; i++) {
                if (!state.ackIndices.has(i)) {
                    state.activeIndices.push(i);
                }
            }

            if (state.currentIndexInActive >= state.activeIndices.length) {
                state.currentIndexInActive = 0;
            }

            updateMatrixUI();
            updateStatsUI();
            renderCurrentFrame();

            showToast(`ACK received! Dropped ${newlyAckCount} chunks. Remaining: ${state.activeIndices.length}`, 'success');
        }
    }

    // =========================================================================
    // CLIENT FEEDBACK SCANNER (CAMERA)
    // =========================================================================

    /**
     * Safely destroy feedback camera stream before starting a new one
     */
    async function stopFeedbackCamera() {
        if (state.feedbackScanInterval) {
            clearInterval(state.feedbackScanInterval);
            state.feedbackScanInterval = null;
        }

        if (state.feedbackStream) {
            const tracks = state.feedbackStream.getTracks();
            tracks.forEach(t => {
                try { t.stop(); } catch (e) {}
            });
            state.feedbackStream = null;
        }

        if (elements.feedbackVideo) {
            elements.feedbackVideo.srcObject = null;
        }

        await new Promise(r => setTimeout(r, 200));

        state.isFeedbackCamActive = false;
        if (elements.feedbackCamContainer) elements.feedbackCamContainer.style.display = 'none';
        if (elements.toggleFeedbackCamBtn) {
            elements.toggleFeedbackCamBtn.textContent = '📷 Start Camera';
            elements.toggleFeedbackCamBtn.classList.remove('btn-primary');
            elements.toggleFeedbackCamBtn.classList.add('btn-secondary');
        }
    }

    /**
     * Start feedback camera with clean lifecycle
     */
    async function startFeedbackCamera() {
        await stopFeedbackCamera();

        if (elements.feedbackCamContainer) elements.feedbackCamContainer.style.display = 'block';
        if (elements.feedbackScanStatus) elements.feedbackScanStatus.textContent = 'Requesting camera access...';

        try {
            const constraints = {
                video: {
                    facingMode: { ideal: 'environment' },
                    width: { ideal: 640 },
                    height: { ideal: 480 }
                }
            };

            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            state.feedbackStream = stream;
            state.isFeedbackCamActive = true;

            if (elements.feedbackVideo) {
                elements.feedbackVideo.srcObject = stream;
                await elements.feedbackVideo.play();
            }

            if (elements.toggleFeedbackCamBtn) {
                elements.toggleFeedbackCamBtn.textContent = '🛑 Stop Camera';
                elements.toggleFeedbackCamBtn.classList.remove('btn-secondary');
                elements.toggleFeedbackCamBtn.classList.add('btn-primary');
            }

            if (elements.feedbackScanStatus) elements.feedbackScanStatus.textContent = 'Scanning for client ACK QR code...';

            startFeedbackScanLoop();
        } catch (err) {
            console.error('Feedback camera error:', err);
            showToast('Camera error: ' + (err.message || err), 'error');
            await stopFeedbackCamera();
        }
    }

    function toggleFeedbackCamera() {
        if (state.isFeedbackCamActive) {
            stopFeedbackCamera();
        } else {
            startFeedbackCamera();
        }
    }

    /**
     * Scanner loop for feedback camera using native BarcodeDetector or jsQR
     */
    function startFeedbackScanLoop() {
        if ('BarcodeDetector' in window && !state.feedbackDetector) {
            try {
                state.feedbackDetector = new BarcodeDetector({ formats: ['qr_code'] });
            } catch (e) {}
        }

        const scanCanvas = elements.feedbackCanvas || document.createElement('canvas');
        const scanCtx = scanCanvas.getContext('2d', { willReadFrequently: true });

        state.feedbackScanInterval = setInterval(async () => {
            if (!state.isFeedbackCamActive || !elements.feedbackVideo) return;
            if (elements.feedbackVideo.readyState < 2) return;

            // 1. Try native BarcodeDetector
            if (state.feedbackDetector) {
                try {
                    const barcodes = await state.feedbackDetector.detect(elements.feedbackVideo);
                    if (barcodes && barcodes.length > 0) {
                        handleFeedbackRawText(barcodes[0].rawValue);
                        return;
                    }
                } catch (e) {}
            }

            // 2. Fallback to jsQR
            if (typeof jsQR !== 'undefined') {
                scanCanvas.width = elements.feedbackVideo.videoWidth || 320;
                scanCanvas.height = elements.feedbackVideo.videoHeight || 240;
                scanCtx.drawImage(elements.feedbackVideo, 0, 0, scanCanvas.width, scanCanvas.height);
                const imageData = scanCtx.getImageData(0, 0, scanCanvas.width, scanCanvas.height);
                const qrCode = jsQR(imageData.data, imageData.width, imageData.height);
                if (qrCode && qrCode.data) {
                    handleFeedbackRawText(qrCode.data);
                }
            }
        }, 200);
    }

    /**
     * Parse feedback string from client ACK QR
     */
    function handleFeedbackRawText(text) {
        if (!text || typeof text !== 'string') return;
        text = text.trim();

        try {
            if (text.startsWith('ACK:')) {
                const parts = text.substring(4).split(',').map(n => parseInt(n.trim(), 10)).filter(n => !isNaN(n));
                processClientFeedback(parts);
            } else if (text.startsWith('ACK_RANGES:')) {
                const rangeStr = text.substring(11);
                const list = [];
                rangeStr.split(',').forEach(token => {
                    if (token.includes('-')) {
                        const [start, end] = token.split('-').map(n => parseInt(n, 10));
                        for (let k = start; k <= end; k++) list.push(k);
                    } else {
                        const n = parseInt(token, 10);
                        if (!isNaN(n)) list.push(n);
                    }
                });
                processClientFeedback(list);
            } else if (text.startsWith('{')) {
                const json = JSON.parse(text);
                if (Array.isArray(json.ack)) {
                    processClientFeedback(json.ack);
                }
            }
        } catch (e) {
            console.warn('Could not parse feedback QR:', e);
        }
    }

    /**
     * Floating toast alert
     */
    function showToast(message, type = 'info', duration = 3000) {
        let container = document.querySelector('.toast-container');
        if (!container) {
            container = document.createElement('div');
            container.className = 'toast-container';
            document.body.appendChild(container);
        }

        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.textContent = message;
        container.appendChild(toast);

        setTimeout(() => {
            toast.classList.add('hiding');
            setTimeout(() => {
                if (toast.parentNode) toast.parentNode.removeChild(toast);
            }, 300);
        }, duration);
    }

    // =========================================================================
    // EVENT LISTENERS & BOOTSTRAP
    // =========================================================================

    function bindEvents() {
        if (elements.playPauseBtn) elements.playPauseBtn.addEventListener('click', togglePlayPause);
        if (elements.nextBtn) elements.nextBtn.addEventListener('click', stepNext);
        if (elements.prevBtn) elements.prevBtn.addEventListener('click', stepPrev);
        if (elements.regenerateBtn) elements.regenerateBtn.addEventListener('click', () => {
            if (confirm('Regenerate 100 new codes and restart broadcast?')) {
                preRenderQRCodes();
            }
        });

        if (elements.speedSlider) {
            elements.speedSlider.addEventListener('input', (e) => {
                setFps(parseInt(e.target.value, 10));
            });
        }

        if (elements.toggleFeedbackCamBtn) {
            elements.toggleFeedbackCamBtn.addEventListener('click', toggleFeedbackCamera);
        }

        window.addEventListener('beforeunload', () => {
            stopPlayback();
            stopFeedbackCamera();
        });
    }

    function init() {
        buildMatrixDOM();
        bindEvents();
        preRenderQRCodes();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
