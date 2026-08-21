/**
 * peerGrab.js - Client Optical QR Stream Receiver & Processor
 * Defaults to front-facing camera, parses streaming tsX-code items,
 * renders live ACK QR code with complete list of parsed indices,
 * updates 100-cell progress grid, and exports results as JSON.
 */

(function () {
    'use strict';

    const DEFAULT_TOTAL = 100;

    // State
    const state = {
        totalCount: DEFAULT_TOTAL,
        hasReceivedLastMarker: false,
        receivedMap: new Map(), // index -> { index, tote, rawCode, timestamp }
        itemsArray: [],
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
        
        // Camera Viewfinder
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
        
        // Results Screen
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
     * Build the 100-cell progress grid (cells without numbers for a compact square look)
     */
    function buildGridDOM() {
        if (!elements.clientGrid) return;
        elements.clientGrid.innerHTML = '';

        for (let i = 0; i < state.totalCount; i++) {
            const block = document.createElement('div');
            block.className = 'chunk-block missing';
            block.id = `clientBlock_${i}`;
            block.title = `Tote #${i + 1} (Missing)`;
            elements.clientGrid.appendChild(block);
        }
    }

    function initializePlaceholderArray(count) {
        state.totalCount = count;
        state.itemsArray = new Array(count).fill(null).map((_, i) => ({
            index: i,
            tote: null,
            rawCode: null,
            timestamp: null,
            status: 'missing'
        }));

        state.receivedMap.forEach((val, idx) => {
            if (idx < count) {
                state.itemsArray[idx] = {
                    index: idx,
                    tote: val.tote,
                    rawCode: val.rawCode,
                    timestamp: val.timestamp,
                    status: 'captured'
                };
            }
        });

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
        // Hardware release pause
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

            // 1. Try native BarcodeDetector
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
        }, 80);
    }

    /**
     * Process detected QR code string: tsX-tote or tsX-tote-last
     */
    function processDetectedQrCode(text) {
        if (!text || typeof text !== 'string' || state.isComplete) return;
        text = text.trim();

        // Pattern: ts<index>-<tote>(-last)?
        const match = text.match(/^ts(\d+)-(.+?)(-last)?$/);
        if (!match) return;

        const index = parseInt(match[1], 10);
        const rawTote = match[2];
        const isLast = Boolean(match[3]);

        // Lock total when -last marker is found
        if (isLast && !state.hasReceivedLastMarker) {
            state.hasReceivedLastMarker = true;
            const computedTotal = index + 1;
            initializePlaceholderArray(computedTotal);
        }

        // Avoid duplicate reprocessing
        if (state.receivedMap.has(index)) return;

        const now = new Date().toISOString();
        state.receivedMap.set(index, {
            index: index,
            tote: rawTote,
            rawCode: text,
            timestamp: now
        });

        if (state.itemsArray.length > index) {
            state.itemsArray[index] = {
                index: index,
                tote: rawTote,
                rawCode: text,
                timestamp: now,
                status: 'captured'
            };
        }

        // Feedback sound and flash
        playChirp();
        if (elements.clientScanBox) {
            elements.clientScanBox.classList.add('success');
            setTimeout(() => {
                if (elements.clientScanBox) elements.clientScanBox.classList.remove('success');
            }, 300);
        }

        if (elements.lastCapturedCode) {
            elements.lastCapturedCode.textContent = `[#${index + 1}] ${rawTote}`;
        }

        // Light up grid square
        const block = document.getElementById(`clientBlock_${index}`);
        if (block) {
            block.className = 'chunk-block ack just-added';
            block.title = `Tote #${index + 1}: ${rawTote}`;
            setTimeout(() => {
                if (block) block.classList.remove('just-added');
            }, 500);
        }

        updateProgressUI();
        queueAckQrUpdate();

        // Check if all chunks have been collected
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
    // LIVE ACK QR CODE GENERATOR (COMPOSES COMPLETE LIST OF INDEXES)
    // =========================================================================

    function queueAckQrUpdate() {
        if (state.ackDebounceTimer) clearTimeout(state.ackDebounceTimer);
        state.ackDebounceTimer = setTimeout(() => {
            updateAckQRCode();
        }, 150);
    }

    /**
     * Render the ACK QR Code with the complete list of parsed indices
     */
    function updateAckQRCode() {
        if (!elements.ackCanvas) return;

        const count = state.receivedMap.size;
        if (elements.ackCountBadge) {
            elements.ackCountBadge.textContent = `${count} / ${state.totalCount} ACK'd`;
        }

        if (count === 0) {
            const ctx = elements.ackCanvas.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, 200, 200);
            ctx.fillStyle = '#64748b';
            ctx.font = 'bold 14px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('Awaiting scans...', 100, 105);
            return;
        }

        // Build complete list of sorted indexes: "ACK:0,1,2,3,4,5..."
        const sortedIndices = Array.from(state.receivedMap.keys()).sort((a, b) => a - b);
        const payload = `ACK:${sortedIndices.join(',')}`;

        if (window.QRCodeLib && window.QRCodeLib.drawToCanvas) {
            try {
                window.QRCodeLib.drawToCanvas(elements.ackCanvas, payload, {
                    width: 200,
                    height: 200,
                    margin: 1,
                    errorCorrectionLevel: 'L'
                });
            } catch (e) {
                console.warn('ACK QR rendering error:', e);
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

        // Switch to Results Screen
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

    /**
     * Export as JSON array of [{ barcode, timestamp }]
     */
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
        state.itemsArray = [];
        
        initializePlaceholderArray(DEFAULT_TOTAL);

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
    // EVENT LISTENERS & INITIALIZATION
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
