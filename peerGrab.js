/**
 * peerGrab.js - Client Optical QR Stream Receiver & Processor
 * Captures 100 streaming QR codes, handles placeholder arrays,
 * chunked progress visualization, client feedback QR generation,
 * safe camera lifecycle, and transition to main scanner.
 */

(function () {
    'use strict';

    const DEFAULT_TOTAL = 100;

    // State
    const state = {
        totalCount: DEFAULT_TOTAL,
        hasReceivedLastMarker: false,
        receivedMap: new Map(), // index -> { index, code, timestamp }
        itemsArray: [], // placeholder array
        isScanning: false,
        isTorchOn: false,
        activeStream: null,
        scanInterval: null,
        barcodeDetector: null,
        feedbackDebounceTimer: null,
        isComplete: false
    };

    // DOM Elements
    const elements = {
        cameraContainer: document.getElementById('cameraContainer'),
        grabVideo: document.getElementById('grabVideo'),
        grabCanvas: document.getElementById('grabCanvas'),
        grabScanBox: document.getElementById('grabScanBox'),
        camLoading: document.getElementById('camLoading'),
        camLoadingText: document.getElementById('camLoadingText'),
        lastGrabbedCode: document.getElementById('lastGrabbedCode'),
        restartCamBtn: document.getElementById('restartCamBtn'),
        grabTorchBtn: document.getElementById('grabTorchBtn'),
        progressPercent: document.getElementById('progressPercent'),
        collectedCount: document.getElementById('collectedCount'),
        totalTargetCount: document.getElementById('totalTargetCount'),
        lastChunkStatusBadge: document.getElementById('lastChunkStatusBadge'),
        progressBarFill: document.getElementById('progressBarFill'),
        chunkedGrid: document.getElementById('chunkedGrid'),
        feedbackQrCanvas: document.getElementById('feedbackQrCanvas'),
        feedbackSummaryText: document.getElementById('feedbackSummaryText'),
        completeModal: document.getElementById('completeModal'),
        countdownSec: document.getElementById('countdownSec'),
        goToScannerBtn: document.getElementById('goToScannerBtn')
    };

    // Web Audio synthesizer for chime
    let audioCtx = null;
    function playChirp() {
        try {
            if (!audioCtx) {
                const AudioContextClass = window.AudioContext || window.webkitAudioContext;
                if (AudioContextClass) audioCtx = new AudioContextClass();
            }
            if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
            if (!audioCtx) return;

            const now = audioCtx.currentTime;
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.connect(gain);
            gain.connect(audioCtx.destination);

            osc.type = 'sine';
            osc.frequency.setValueAtTime(1046.50, now); // C6
            osc.frequency.exponentialRampToValueAtTime(1318.51, now + 0.06); // E6
            gain.gain.setValueAtTime(0.2, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
            osc.start(now);
            osc.stop(now + 0.1);
        } catch (e) {}
    }

    /**
     * Build the chunked 100-cell progress grid
     */
    function buildChunkedGridDOM() {
        if (!elements.chunkedGrid) return;
        elements.chunkedGrid.innerHTML = '';

        for (let i = 0; i < state.totalCount; i++) {
            const block = document.createElement('div');
            block.className = 'chunk-block missing';
            block.id = `chunkBlock_${i}`;
            block.title = `Chunk ${i} (Missing)`;
            block.textContent = `${i}`;
            elements.chunkedGrid.appendChild(block);
        }
    }

    /**
     * Initialize placeholder array for missing codes
     */
    function initializePlaceholderArray(targetTotal) {
        state.totalCount = targetTotal;
        state.itemsArray = new Array(targetTotal).fill(null).map((_, i) => ({
            index: i,
            code: null,
            timestamp: null,
            status: 'missing'
        }));

        // Re-inject any chunks received prior to seeing the -last marker
        state.receivedMap.forEach((val, idx) => {
            if (idx < targetTotal) {
                state.itemsArray[idx] = {
                    index: idx,
                    code: val.code,
                    timestamp: val.timestamp,
                    status: 'captured'
                };
            }
        });

        if (elements.totalTargetCount) elements.totalTargetCount.textContent = targetTotal;
        buildChunkedGridDOM();
        updateProgressUI();
        updateFeedbackQRCode();
    }

    // =========================================================================
    // CAMERA LIFECYCLE MANAGEMENT (SAFE DESTRUCTION)
    // =========================================================================

    /**
     * Completely destroy active camera stream and release hardware before starting another
     */
    async function stopCamera() {
        if (state.scanInterval) {
            clearInterval(state.scanInterval);
            state.scanInterval = null;
        }

        if (state.activeStream) {
            const tracks = state.activeStream.getTracks();
            tracks.forEach(track => {
                try { track.stop(); } catch (e) {}
            });
            state.activeStream = null;
        }

        if (elements.grabVideo) {
            elements.grabVideo.srcObject = null;
        }

        state.isScanning = false;
        state.isTorchOn = false;
        if (elements.grabTorchBtn) {
            elements.grabTorchBtn.classList.remove('active');
            elements.grabTorchBtn.innerHTML = '💡 Torch';
        }

        // Mandatory pause to ensure the OS and hardware release the camera sensor completely
        await new Promise(r => setTimeout(r, 250));
    }

    /**
     * Start the standard environment camera safely
     */
    async function startCamera() {
        // Step 1: Ensure previous camera is completely destroyed
        await stopCamera();

        if (elements.camLoading) {
            if (elements.camLoadingText) elements.camLoadingText.textContent = 'Initializing standard camera...';
            elements.camLoading.style.display = 'flex';
        }

        try {
            // Explicit constraints targeting standard rear/environment camera
            const constraints = {
                audio: false,
                video: {
                    facingMode: { ideal: 'environment' },
                    width: { min: 640, ideal: 1280, max: 1920 },
                    height: { min: 480, ideal: 720, max: 1080 },
                    aspectRatio: { ideal: 1.7777777778 }
                }
            };

            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            state.activeStream = stream;

            if (elements.grabVideo) {
                elements.grabVideo.srcObject = stream;
                await elements.grabVideo.play();
            }

            state.isScanning = true;
            if (elements.camLoading) elements.camLoading.style.display = 'none';

            // Launch scanning loop
            startScannerLoop();
        } catch (err) {
            console.error('Camera initialization failed:', err);
            if (elements.camLoadingText) {
                elements.camLoadingText.textContent = 'Camera error: ' + (err.message || err.name || 'Unavailable');
            }
            showToast('Camera error: ' + (err.message || err.name), 'error');
        }
    }

    /**
     * Toggle camera torch / flashlight
     */
    function toggleTorch() {
        if (!state.isScanning || !state.activeStream) {
            showToast('Start camera to use torch', 'info');
            return;
        }

        const tracks = state.activeStream.getVideoTracks();
        if (tracks.length === 0) return;
        const track = tracks[0];

        const capabilities = track.getCapabilities ? track.getCapabilities() : {};
        if (!capabilities.torch) {
            showToast('Torch not supported on this camera lens', 'info');
            return;
        }

        const nextState = !state.isTorchOn;
        track.applyConstraints({
            advanced: [{ torch: nextState }]
        }).then(() => {
            state.isTorchOn = nextState;
            if (elements.grabTorchBtn) {
                elements.grabTorchBtn.classList.toggle('active', state.isTorchOn);
                elements.grabTorchBtn.innerHTML = state.isTorchOn ? '🔦 Torch ON' : '💡 Torch';
            }
            showToast(state.isTorchOn ? 'Torch ON' : 'Torch OFF', 'info');
        }).catch(err => {
            showToast('Torch toggle failed: ' + err.message, 'error');
        });
    }

    // =========================================================================
    // HIGH-SPEED QR CODE SCANNING LOOP
    // =========================================================================

    function startScannerLoop() {
        // Native BarcodeDetector
        if ('BarcodeDetector' in window && !state.barcodeDetector) {
            try {
                state.barcodeDetector = new BarcodeDetector({ formats: ['qr_code'] });
            } catch (e) {}
        }

        const canvas = elements.grabCanvas || document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });

        state.scanInterval = setInterval(async () => {
            if (!state.isScanning || !elements.grabVideo || state.isComplete) return;
            if (elements.grabVideo.readyState < 2) return;

            // 1. Check with native BarcodeDetector
            if (state.barcodeDetector) {
                try {
                    const codes = await state.barcodeDetector.detect(elements.grabVideo);
                    if (codes && codes.length > 0) {
                        for (const item of codes) {
                            if (item.rawValue) processScannedRawText(item.rawValue);
                        }
                        return;
                    }
                } catch (e) {}
            }

            // 2. Fallback to jsQR
            if (typeof jsQR !== 'undefined') {
                canvas.width = elements.grabVideo.videoWidth || 640;
                canvas.height = elements.grabVideo.videoHeight || 480;
                ctx.drawImage(elements.grabVideo, 0, 0, canvas.width, canvas.height);
                const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                const result = jsQR(imageData.data, imageData.width, imageData.height);
                if (result && result.data) {
                    processScannedRawText(result.data);
                }
            }
        }, 80); // ~12 scans/sec for responsive 10fps stream tracking
    }

    /**
     * Parse and process raw scanned text from QR code
     * Format: tsX-codenumber or tsX-codenumber-last
     */
    function processScannedRawText(text) {
        if (!text || typeof text !== 'string' || state.isComplete) return;
        text = text.trim();

        // Regex to extract ts index, code, and optional -last flag
        // Example: ts42-k9P2aL7x4Q or ts99-zX8v1AbC4-last
        const match = text.match(/^ts(\d+)-([A-Za-z0-9]+)(-last)?$/);
        if (!match) return;

        const index = parseInt(match[1], 10);
        const codeNumber = match[2];
        const isLast = Boolean(match[3]);

        // If this is the last chunk and we haven't locked total count yet:
        if (isLast && !state.hasReceivedLastMarker) {
            state.hasReceivedLastMarker = true;
            const computedTotal = index + 1;
            if (elements.lastChunkStatusBadge) {
                elements.lastChunkStatusBadge.className = 'last-chunk-badge success';
                elements.lastChunkStatusBadge.textContent = `Found -last marker (Total: ${computedTotal})`;
            }
            initializePlaceholderArray(computedTotal);
        }

        // Check if we already have this index
        if (state.receivedMap.has(index)) return;

        // New Chunk Captured!
        const now = new Date().toISOString();
        state.receivedMap.set(index, {
            index: index,
            code: text,
            timestamp: now
        });

        if (state.itemsArray.length > index) {
            state.itemsArray[index] = {
                index: index,
                code: text,
                timestamp: now,
                status: 'captured'
            };
        }

        // Feedback sound and viewfinder flash
        playChirp();
        if (elements.grabScanBox) {
            elements.grabScanBox.classList.add('success');
            setTimeout(() => {
                if (elements.grabScanBox) elements.grabScanBox.classList.remove('success');
            }, 300);
        }

        // Update banner text
        if (elements.lastGrabbedCode) {
            elements.lastGrabbedCode.textContent = `[#${index}] ${text}`;
        }

        // Update visual chunk block
        const block = document.getElementById(`chunkBlock_${index}`);
        if (block) {
            block.className = 'chunk-block ack just-added';
            block.title = `Chunk ${index} (Captured: ${text})`;
            setTimeout(() => {
                if (block) block.classList.remove('just-added');
            }, 600);
        }

        updateProgressUI();
        queueFeedbackQrUpdate();

        // Check if all 100 chunks have been received!
        if (state.receivedMap.size >= state.totalCount) {
            onAllChunksCollected();
        }
    }

    /**
     * Update progress bar and percentage counters
     */
    function updateProgressUI() {
        const count = state.receivedMap.size;
        const total = state.totalCount;
        const percent = Math.min(100, Math.round((count / total) * 100));

        if (elements.collectedCount) elements.collectedCount.textContent = count;
        if (elements.totalTargetCount) elements.totalTargetCount.textContent = total;
        if (elements.progressPercent) elements.progressPercent.textContent = `${percent}%`;
        if (elements.progressBarFill) elements.progressBarFill.style.width = `${percent}%`;
    }

    // =========================================================================
    // CLIENT FEEDBACK QR CODE GENERATOR
    // =========================================================================

    /**
     * Debounced update for feedback QR code to avoid freezing camera render loop
     */
    function queueFeedbackQrUpdate() {
        if (state.feedbackDebounceTimer) clearTimeout(state.feedbackDebounceTimer);
        state.feedbackDebounceTimer = setTimeout(() => {
            updateFeedbackQRCode();
        }, 300);
    }

    /**
     * Generate Feedback QR code containing list/ranges of received indices
     */
    async function updateFeedbackQRCode() {
        if (!elements.feedbackQrCanvas) return;

        const count = state.receivedMap.size;
        if (elements.feedbackSummaryText) {
            elements.feedbackSummaryText.textContent = `${count} / ${state.totalCount} Chunks ACK'd`;
        }

        if (count === 0) {
            const ctx = elements.feedbackQrCanvas.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, elements.feedbackQrCanvas.width, elements.feedbackQrCanvas.height);
            ctx.fillStyle = '#64748b';
            ctx.font = '12px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('Awaiting scans...', elements.feedbackQrCanvas.width / 2, elements.feedbackQrCanvas.height / 2);
            return;
        }

        // Build compact range payload e.g. "ACK_RANGES:0-10,14,18-25"
        const sortedIndices = Array.from(state.receivedMap.keys()).sort((a, b) => a - b);
        const ranges = [];
        let start = sortedIndices[0];
        let prev = start;

        for (let i = 1; i < sortedIndices.length; i++) {
            const curr = sortedIndices[i];
            if (curr === prev + 1) {
                prev = curr;
            } else {
                ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
                start = curr;
                prev = curr;
            }
        }
        if (start !== undefined) {
            ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
        }

        const payload = `ACK_RANGES:${ranges.join(',')}`;

        if (typeof QRCode !== 'undefined' && QRCode.toCanvas) {
            try {
                await QRCode.toCanvas(elements.feedbackQrCanvas, payload, {
                    width: 160,
                    margin: 1,
                    errorCorrectionLevel: 'L',
                    color: {
                        dark: '#000000',
                        light: '#ffffff'
                    }
                });
            } catch (e) {
                console.warn('Feedback QR generation error:', e);
            }
        }
    }

    // =========================================================================
    // COMPLETION & REDIRECT TO MAIN SCANNER
    // =========================================================================

    /**
     * Handler when all 100 chunks are successfully acquired
     */
    async function onAllChunksCollected() {
        if (state.isComplete) return;
        state.isComplete = true;

        // Cleanly stop camera immediately
        await stopCamera();

        // Convert the 100 captured chunks into the main scanner's storage format
        const finalScannedItems = [];
        for (let i = 0; i < state.totalCount; i++) {
            const item = state.receivedMap.get(i);
            const code = item ? item.code : `ts${i}-fallback`;
            const ts = item ? item.timestamp : new Date().toISOString();
            const dateObj = new Date(ts);
            
            finalScannedItems.push({
                id: `optical_${i}_${Date.now()}`,
                barcode: code,
                format: 'QR CODE (OPTICAL STREAM)',
                timestamp: ts,
                timeDisplay: dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
                source: 'optical_stream'
            });
        }

        // Store in localStorage for index.html
        try {
            localStorage.setItem('scannedItems', JSON.stringify(finalScannedItems));
            localStorage.setItem('hasImportedOptical', 'true');
        } catch (e) {
            console.error('LocalStorage write error:', e);
        }

        // Show celebration completion modal
        if (elements.completeModal) {
            elements.completeModal.classList.add('active');
        }

        // 3-second countdown before jumping to main scanner
        let remainingSeconds = 3;
        const countdownTimer = setInterval(() => {
            remainingSeconds--;
            if (elements.countdownSec) elements.countdownSec.textContent = remainingSeconds;
            if (remainingSeconds <= 0) {
                clearInterval(countdownTimer);
                window.location.href = 'index.html';
            }
        }, 1000);

        if (elements.goToScannerBtn) {
            elements.goToScannerBtn.addEventListener('click', () => {
                clearInterval(countdownTimer);
                window.location.href = 'index.html';
            });
        }
    }

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
    // EVENT LISTENERS & INITIALIZATION
    // =========================================================================

    function bindEvents() {
        if (elements.restartCamBtn) {
            elements.restartCamBtn.addEventListener('click', () => {
                startCamera();
            });
        }

        if (elements.grabTorchBtn) {
            elements.grabTorchBtn.addEventListener('click', toggleTorch);
        }

        window.addEventListener('beforeunload', () => {
            stopCamera();
        });
    }

    function init() {
        initializePlaceholderArray(DEFAULT_TOTAL);
        bindEvents();
        startCamera();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
