/**
 * peerGrab.js - Client Optical QR Stream Receiver & Processor
 * Pinned camera & ACK QR code, 25-char Hex Bitset ACK encoding,
 * robust state preservation across multiple stream passes,
 * and responsive 100-cell progress grid.
 */

(function () {
    'use strict';

    const DEFAULT_TOTAL = 100;

    // State
    const state = {
        totalCount: DEFAULT_TOTAL,
        hasReceivedLastMarker: false,
        receivedMap: new Map(), // index -> { index, tote, rawCode, timestamp }
        isScanning: false,
        currentFacingMode: 'user', // Default to front-facing camera!
        camStream: null,
        scanInterval: null,
        barcodeDetector: null,
        ackDebounceTimer: null,
        isComplete: false
    };

    // DOM Elements
    const elements = {
        // Sections
        receiverSection: document.getElementById('receiverSection'),
        resultsSection: document.getElementById('resultsSection'),
        
        // Camera
        cameraBox: document.getElementById('cameraBox'),
        clientVideo: document.getElementById('clientVideo'),
        clientScanCanvas: document.getElementById('clientScanCanvas'),
        clientScanBox: document.getElementById('clientScanBox'),
        camLoading: document.getElementById('camLoading'),
        camLoadingText: document.getElementById('camLoadingText'),
        flipClientCamBtn: document.getElementById('flipClientCamBtn'),
        lastCapturedCode: document.getElementById('lastCapturedCode'),
        
        // Progress
        capturedCountText: document.getElementById('capturedCountText'),
        targetTotalText: document.getElementById('targetTotalText'),
        progressPercentText: document.getElementById('progressPercentText'),
        progressBarFill: document.getElementById('progressBarFill'),
        clientGrid: document.getElementById('clientGrid'),
        
        // ACK QR
        ackCanvas: document.getElementById('ackCanvas'),
        ackCountBadge: document.getElementById('ackCountBadge'),
        
        // Results
        resultsTotalBadge: document.getElementById('resultsTotalBadge'),
        resultsList: document.getElementById('resultsList'),
        exportJsonBtn: document.getElementById('exportJsonBtn'),
        copyAllBtn: document.getElementById('copyAllBtn'),
        scanAgainBtn: document.getElementById('scanAgainBtn')
    };

    // Web Audio Synthesizer
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
            osc.frequency.setValueAtTime(987.77, now); // B5
            osc.frequency.exponentialRampToValueAtTime(1318.51, now + 0.06); // E6
            gain.gain.setValueAtTime(0.2, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
            osc.start(now);
            osc.stop(now + 0.1);
        } catch (e) {}
    }

    /**
     * Build the 100-cell progress grid and apply existing state
     */
    function buildGridDOM() {
        if (!elements.clientGrid) return;
        elements.clientGrid.innerHTML = '';

        for (let i = 0; i < state.totalCount; i++) {
            const block = document.createElement('div');
            const isCaptured = state.receivedMap.has(i);
            block.className = isCaptured ? 'chunk-block ack' : 'chunk-block missing';
            block.id = `clientBlock_${i}`;
            const item = state.receivedMap.get(i);
            block.title = isCaptured ? `Tote #${i + 1}: ${item.tote}` : `Tote #${i + 1} (Missing)`;
            elements.clientGrid.appendChild(block);
        }
    }

    function setTargetTotal(count) {
        if (count === state.totalCount && state.hasReceivedLastMarker) return;
        state.totalCount = count;
        state.hasReceivedLastMarker = true;

        if (elements.targetTotalText) elements.targetTotalText.textContent = count;
        buildGridDOM();
        updateProgressUI();
        updateAckQRCode();
    }

    // =========================================================================
    // CAMERA CONTROLS (FRONT-FACING CAMERA DEFAULT & CLEAN DESTRUCTION)
    // =========================================================================

    async function stopCamera() {
        if (state.scanInterval) {
            clearInterval(state.scanInterval);
            state.scanInterval = null;
        }

        if (state.camStream) {
            const tracks = state.camStream.getTracks();
            tracks.forEach(track => {
                try { track.stop(); } catch (e) {}
            });
            state.camStream = null;
        }

        if (elements.clientVideo) {
            elements.clientVideo.srcObject = null;
        }

        state.isScanning = false;
        await new Promise(r => setTimeout(r, 200));
    }

    async function startCamera() {
        await stopCamera();

        if (elements.camLoading) {
            if (elements.camLoadingText) {
                elements.camLoadingText.textContent = `Starting ${state.currentFacingMode === 'user' ? 'front' : 'rear'} camera...`;
            }
            elements.camLoading.style.display = 'flex';
        }

        try {
            const constraints = {
                audio: false,
                video: {
                    facingMode: { ideal: state.currentFacingMode },
                    width: { ideal: 640 },
                    height: { ideal: 480 }
                }
            };

            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            state.camStream = stream;

            if (elements.clientVideo) {
                elements.clientVideo.srcObject = stream;
                await elements.clientVideo.play();
            }

            state.isScanning = true;
            if (elements.camLoading) elements.camLoading.style.display = 'none';

            startScanLoop();
        } catch (err) {
            console.error('Client camera error:', err);
            if (elements.camLoadingText) {
                elements.camLoadingText.textContent = 'Camera error: ' + (err.message || err.name || 'Denied');
            }
            showToast('Camera error: ' + (err.message || err.name), 'error');
        }
    }

    function flipCamera() {
        state.currentFacingMode = (state.currentFacingMode === 'user') ? 'environment' : 'user';
        startCamera();
    }

    // =========================================================================
    // QR CODE SCANNING LOOP
    // =========================================================================

    function startScanLoop() {
        if ('BarcodeDetector' in window && !state.barcodeDetector) {
            try {
                state.barcodeDetector = new BarcodeDetector({ formats: ['qr_code'] });
            } catch (e) {}
        }

        const canvas = elements.clientScanCanvas || document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });

        state.scanInterval = setInterval(async () => {
            if (!state.isScanning || !elements.clientVideo || state.isComplete) return;
            if (elements.clientVideo.readyState < 2) return;

            // 1. Native BarcodeDetector
            if (state.barcodeDetector) {
                try {
                    const codes = await state.barcodeDetector.detect(elements.clientVideo);
                    if (codes && codes.length > 0) {
                        for (const item of codes) {
                            if (item.rawValue) processDetectedQrCode(item.rawValue);
                        }
                        return;
                    }
                } catch (e) {}
            }

            // 2. Fallback to jsQR
            if (typeof jsQR !== 'undefined') {
                canvas.width = elements.clientVideo.videoWidth || 640;
                canvas.height = elements.clientVideo.videoHeight || 480;
                ctx.drawImage(elements.clientVideo, 0, 0, canvas.width, canvas.height);
                const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                const result = jsQR(imageData.data, imageData.width, imageData.height);
                if (result && result.data) {
                    processDetectedQrCode(result.data);
                }
            }
        }, 60);
    }

    /**
     * Parse detected QR code string: ts<index>-<tote>(-last)?
     */
    function processDetectedQrCode(text) {
        if (!text || typeof text !== 'string' || state.isComplete) return;
        text = text.trim();

        const match = text.match(/^ts(\d+)-(.+?)(-last)?$/);
        if (!match) return;

        const index = parseInt(match[1], 10);
        const rawTote = match[2];
        const isLast = Boolean(match[3]);

        // Lock total when -last is detected
        if (isLast && !state.hasReceivedLastMarker) {
            setTargetTotal(index + 1);
        }

        // Ignore if already captured
        if (state.receivedMap.has(index)) return;

        // Store new chunk
        const now = new Date().toISOString();
        state.receivedMap.set(index, {
            index: index,
            tote: rawTote,
            rawCode: text,
            timestamp: now
        });

        // Chirp sound and viewfinder flash
        playChirp();
        if (elements.clientScanBox) {
            elements.clientScanBox.classList.add('success');
            setTimeout(() => {
                if (elements.clientScanBox) elements.clientScanBox.classList.remove('success');
            }, 250);
        }

        if (elements.lastCapturedCode) {
            elements.lastCapturedCode.textContent = `[#${index + 1}] ${rawTote}`;
        }

        // Update block in grid
        const block = document.getElementById(`clientBlock_${index}`);
        if (block) {
            block.className = 'chunk-block ack just-added';
            block.title = `Tote #${index + 1}: ${rawTote}`;
            setTimeout(() => {
                if (block) block.classList.remove('just-added');
            }, 400);
        }

        updateProgressUI();
        queueAckQrUpdate();

        // Check if all chunks received
        if (state.receivedMap.size >= state.totalCount) {
            onAllTotesCollected();
        }
    }

    function updateProgressUI() {
        const count = state.receivedMap.size;
        const total = state.totalCount;
        const percent = Math.min(100, Math.round((count / total) * 100));

        if (elements.capturedCountText) elements.capturedCountText.textContent = count;
        if (elements.targetTotalText) elements.targetTotalText.textContent = total;
        if (elements.progressPercentText) elements.progressPercentText.textContent = `${percent}%`;
        if (elements.progressBarFill) elements.progressBarFill.style.width = `${percent}%`;
    }

    // =========================================================================
    // CONSTANT-SIZE 25-CHAR HEX BITSET ACK QR GENERATOR
    // =========================================================================

    /**
     * Encode 100 binary state flags as a static 25-character Hex Bitset string
     * e.g. "ACK:H:3F00000000000000000000000"
     * Produces a fixed Version 2 QR code with large high-contrast modules!
     */
    function encodeAckHexBitset(receivedSet, total = 100) {
        let hex = '';
        const numNibbles = Math.ceil(total / 4); // 25 nibbles for 100 items
        for (let nib = 0; nib < numNibbles; nib++) {
            let val = 0;
            for (let b = 0; b < 4; b++) {
                const idx = nib * 4 + b;
                if (idx < total && receivedSet.has(idx)) {
                    val |= (1 << b);
                }
            }
            hex += val.toString(16);
        }
        return `ACK:H:${hex}`;
    }

    function queueAckQrUpdate() {
        if (state.ackDebounceTimer) clearTimeout(state.ackDebounceTimer);
        state.ackDebounceTimer = setTimeout(() => {
            updateAckQRCode();
        }, 100);
    }

    function updateAckQRCode() {
        if (!elements.ackCanvas) return;

        const count = state.receivedMap.size;
        if (elements.ackCountBadge) {
            elements.ackCountBadge.textContent = `${count} / ${state.totalCount}`;
        }

        if (count === 0) {
            const ctx = elements.ackCanvas.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, 180, 180);
            ctx.fillStyle = '#64748b';
            ctx.font = 'bold 13px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('Awaiting scans...', 90, 95);
            return;
        }

        // Constant 25-character Hex payload
        const payload = encodeAckHexBitset(state.receivedMap, state.totalCount);

        if (window.QRCodeLib && window.QRCodeLib.drawToCanvas) {
            try {
                // Fixed Version 2 QR Code: 25x25 modules, giant chunky pixels, instant scan!
                window.QRCodeLib.drawToCanvas(elements.ackCanvas, payload, {
                    typeNumber: 2,
                    width: 180,
                    height: 180,
                    margin: 1,
                    errorCorrectionLevel: 'L'
                });
            } catch (e) {
                console.warn('ACK QR rendering fallback:', e);
                // Fallback to auto typeNumber
                window.QRCodeLib.drawToCanvas(elements.ackCanvas, payload, {
                    width: 180,
                    height: 180,
                    margin: 1,
                    errorCorrectionLevel: 'L'
                });
            }
        }
    }

    // =========================================================================
    // RESULTS & COMPLETION
    // =========================================================================

    async function onAllTotesCollected() {
        if (state.isComplete) return;
        state.isComplete = true;

        await stopCamera();

        if (elements.receiverSection) elements.receiverSection.style.display = 'none';
        if (elements.resultsSection) elements.resultsSection.style.display = 'block';

        if (elements.resultsTotalBadge) {
            elements.resultsTotalBadge.textContent = `${state.totalCount} Totes Received`;
        }

        renderResultsList();
        showToast('All 100 Totes successfully captured!', 'success', 5000);
    }

    function renderResultsList() {
        if (!elements.resultsList) return;

        const items = [];
        for (let i = 0; i < state.totalCount; i++) {
            const item = state.receivedMap.get(i);
            const tote = item ? item.tote : `TOTE_${i + 1}`;
            const time = item ? new Date(item.timestamp).toLocaleTimeString() : '';
            items.push(`
                <div class="scanned-item">
                    <div class="scanned-item-info">
                        <span class="scanned-item-code">${escapeHtml(tote)}</span>
                        <div class="scanned-item-meta">
                            <span class="scanned-item-badge peer">#${i + 1}</span>
                            <span>${escapeHtml(time)}</span>
                        </div>
                    </div>
                    <div class="scanned-item-actions">
                        <button class="item-action-btn copy-btn" data-code="${escapeHtml(tote)}" title="Copy">📋</button>
                    </div>
                </div>
            `);
        }

        elements.resultsList.innerHTML = items.join('');

        elements.resultsList.querySelectorAll('.copy-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const code = btn.getAttribute('data-code');
                if (code) {
                    navigator.clipboard.writeText(code).then(() => {
                        showToast(`Copied: ${code}`, 'success');
                    });
                }
            });
        });
    }

    function exportJSON() {
        const exportData = [];
        for (let i = 0; i < state.totalCount; i++) {
            const item = state.receivedMap.get(i);
            exportData.push({
                barcode: item ? item.tote : `TOTE_${i + 1}`,
                timestamp: item ? item.timestamp : new Date().toISOString()
            });
        }

        const jsonStr = JSON.stringify(exportData, null, 2);
        const blob = new Blob([jsonStr], { type: 'application/json;charset=utf-8;' });
        const url = URL.createObjectURL(blob);

        const now = new Date();
        const pad = n => String(n).padStart(2, '0');
        const filename = `totes_${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.json`;

        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        showToast(`Exported ${exportData.length} Totes as JSON file`, 'success');
    }

    function copyAllToClipboard() {
        const lines = [];
        for (let i = 0; i < state.totalCount; i++) {
            const item = state.receivedMap.get(i);
            lines.push(item ? item.tote : `TOTE_${i + 1}`);
        }

        navigator.clipboard.writeText(lines.join('\n')).then(() => {
            showToast(`Copied all ${lines.length} Totes to clipboard!`, 'success');
        }).catch(err => {
            showToast('Failed to copy to clipboard', 'error');
        });
    }

    function resetAndScanAgain() {
        state.isComplete = false;
        state.hasReceivedLastMarker = false;
        state.receivedMap.clear();
        
        buildGridDOM();
        updateProgressUI();
        updateAckQRCode();

        if (elements.resultsSection) elements.resultsSection.style.display = 'none';
        if (elements.receiverSection) elements.receiverSection.style.display = 'block';

        startCamera();
    }

    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
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
    // INITIALIZATION
    // =========================================================================

    function bindEvents() {
        if (elements.flipClientCamBtn) {
            elements.flipClientCamBtn.addEventListener('click', flipCamera);
        }

        if (elements.exportJsonBtn) {
            elements.exportJsonBtn.addEventListener('click', exportJSON);
        }

        if (elements.copyAllBtn) {
            elements.copyAllBtn.addEventListener('click', copyAllToClipboard);
        }

        if (elements.scanAgainBtn) {
            elements.scanAgainBtn.addEventListener('click', resetAndScanAgain);
        }

        window.addEventListener('beforeunload', () => {
            stopCamera();
        });
    }

    function init() {
        buildGridDOM();
        bindEvents();
        startCamera();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
