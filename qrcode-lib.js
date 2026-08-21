//---------------------------------------------------------------------
// QR Code Generator for JavaScript - Official Kazuhiko Arase Implementation
// MIT License
//---------------------------------------------------------------------

(function(root, factory) {
    if (typeof define === 'function' && define.amd) {
        define([], factory);
    } else if (typeof exports === 'object') {
        module.exports = factory();
    } else {
        var lib = factory();
        root.qrcode = lib.qrcode;
        root.QRCodeLib = lib;
    }
}(typeof self !== 'undefined' ? self : this, function() {
    'use strict';

    var QRErrorCorrectionLevel = { L: 1, M: 0, Q: 3, H: 2 };
    var QRMode = { MODE_NUMBER: 1, MODE_ALPHA_NUM: 2, MODE_8BIT_BYTE: 4, MODE_KANJI: 8 };
    var QRMaskPattern = { PATTERN000: 0, PATTERN001: 1, PATTERN010: 2, PATTERN011: 3, PATTERN100: 4, PATTERN101: 5, PATTERN110: 6, PATTERN111: 7 };

    function qr8BitByte(data) {
        var _mode = QRMode.MODE_8BIT_BYTE;
        var _data = data;
        var _bytes = [];
        for (var i = 0; i < _data.length; i++) {
            var c = _data.charCodeAt(i);
            if (c < 128) {
                _bytes.push(c);
            } else if (c < 2048) {
                _bytes.push((c >> 6) | 192);
                _bytes.push((c & 63) | 128);
            } else {
                _bytes.push((c >> 12) | 224);
                _bytes.push(((c >> 6) & 63) | 128);
                _bytes.push((c & 63) | 128);
            }
        }
        return {
            getMode: function() { return _mode; },
            getLength: function() { return _bytes.length; },
            write: function(buffer) {
                for (var i = 0; i < _bytes.length; i++) {
                    buffer.put(_bytes[i], 8);
                }
            }
        };
    }

    var QRPolynomial = function(num, shift) {
        var offset = 0;
        while (offset < num.length && num[offset] === 0) offset++;
        var _num = new Array(num.length - offset + shift);
        for (var i = 0; i < num.length - offset; i++) _num[i] = num[i + offset];
        return {
            getAt: function(i) { return _num[i]; },
            getLength: function() { return _num.length; },
            multiply: function(e) {
                var num = new Array(_num.length + e.getLength() - 1);
                for (var i = 0; i < _num.length; i++) {
                    for (var j = 0; j < e.getLength(); j++) {
                        num[i + j] ^= QRMath.gexp(QRMath.glog(_num[i]) + QRMath.glog(e.getAt(j)));
                    }
                }
                return QRPolynomial(num, 0);
            },
            mod: function(e) {
                if (_num.length - e.getLength() < 0) return QRPolynomial(_num, 0);
                var ratio = QRMath.glog(_num[0]) - QRMath.glog(e.getAt(0));
                var num = new Array(_num.length);
                for (var i = 0; i < _num.length; i++) num[i] = _num[i];
                for (var i = 0; i < e.getLength(); i++) {
                    num[i] ^= QRMath.gexp(QRMath.glog(e.getAt(i)) + ratio);
                }
                return QRPolynomial(num, 0).mod(e);
            }
        };
    };

    var QRMath = {
        glog: function(n) {
            if (n < 1) throw new Error("glog(" + n + ")");
            return QRMath.LOG_TABLE[n];
        },
        gexp: function(n) {
            while (n < 0) n += 255;
            while (n >= 255) n -= 255;
            return QRMath.EXP_TABLE[n];
        },
        EXP_TABLE: new Array(256),
        LOG_TABLE: new Array(256)
    };
    for (var i = 0; i < 8; i++) QRMath.EXP_TABLE[i] = 1 << i;
    for (var i = 8; i < 256; i++) QRMath.EXP_TABLE[i] = QRMath.EXP_TABLE[i - 4] ^ QRMath.EXP_TABLE[i - 5] ^ QRMath.EXP_TABLE[i - 6] ^ QRMath.EXP_TABLE[i - 8];
    for (var i = 0; i < 255; i++) QRMath.LOG_TABLE[QRMath.EXP_TABLE[i]] = i;

    var QRRSBlock = {
        RS_BLOCK_TABLE: [
            [1, 26, 19], [1, 26, 16], [1, 26, 13], [1, 26, 9],
            [1, 44, 34], [1, 44, 28], [1, 44, 22], [1, 44, 16],
            [1, 70, 55], [1, 70, 44], [2, 35, 17], [2, 35, 13],
            [1, 100, 80], [2, 50, 32], [2, 50, 24], [4, 25, 9],
            [1, 134, 108], [2, 67, 43], [2, 33, 15, 2, 34, 16], [2, 33, 11, 2, 34, 12],
            [2, 86, 68], [4, 43, 27], [4, 43, 19], [4, 43, 15],
            [2, 98, 78], [4, 49, 31], [2, 32, 14, 4, 33, 15], [4, 39, 13, 1, 40, 14],
            [2, 121, 97], [2, 60, 38, 2, 61, 39], [4, 40, 18, 2, 41, 19], [4, 40, 14, 2, 41, 15],
            [2, 146, 116], [3, 58, 36, 2, 59, 37], [4, 36, 16, 4, 37, 17], [4, 36, 12, 4, 37, 13],
            [2, 86, 68, 2, 87, 69], [4, 69, 43, 1, 70, 44], [6, 43, 19, 2, 44, 20], [6, 43, 15, 2, 44, 16]
        ],
        getRSBlocks: function(typeNumber, errorCorrectionLevel) {
            var rsBlock = QRRSBlock.getRsBlockTable(typeNumber, errorCorrectionLevel);
            if (rsBlock === undefined) throw new Error("bad rs block @ typeNumber:" + typeNumber + "/errorCorrectionLevel:" + errorCorrectionLevel);
            var length = rsBlock.length / 3;
            var list = [];
            for (var i = 0; i < length; i++) {
                var count = rsBlock[i * 3 + 0];
                var totalCount = rsBlock[i * 3 + 1];
                var dataCount = rsBlock[i * 3 + 2];
                for (var j = 0; j < count; j++) {
                    list.push({ totalCount: totalCount, dataCount: dataCount });
                }
            }
            return list;
        },
        getRsBlockTable: function(typeNumber, errorCorrectionLevel) {
            switch (errorCorrectionLevel) {
                case QRErrorCorrectionLevel.L: return QRRSBlock.RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 0];
                case QRErrorCorrectionLevel.M: return QRRSBlock.RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 1];
                case QRErrorCorrectionLevel.Q: return QRRSBlock.RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 2];
                case QRErrorCorrectionLevel.H: return QRRSBlock.RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 3];
                default: return undefined;
            }
        }
    };

    function qrBitBuffer() {
        var _buffer = [];
        var _length = 0;
        return {
            getBuffer: function() { return _buffer; },
            getAt: function(i) {
                var bufIndex = Math.floor(i / 8);
                return ((_buffer[bufIndex] >>> (7 - i % 8)) & 1) === 1;
            },
            put: function(num, length) {
                for (var i = 0; i < length; i++) {
                    this.putBit(((num >>> (length - i - 1)) & 1) === 1);
                }
            },
            getLengthInBits: function() { return _length; },
            putBit: function(bit) {
                var bufIndex = Math.floor(_length / 8);
                if (_buffer.length <= bufIndex) _buffer.push(0);
                if (bit) _buffer[bufIndex] |= (0x80 >>> (_length % 8));
                _length++;
            }
        };
    }

    var QRUtil = {
        PATTERN_POSITION_TABLE: [
            [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]
        ],
        G15: (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | (1 << 0),
        G15_MASK: (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1),
        getBCHTypeInfo: function(data) {
            var d = data << 10;
            while (QRUtil.getBCHDigit(d) - QRUtil.getBCHDigit(QRUtil.G15) >= 0) {
                d ^= (QRUtil.G15 << (QRUtil.getBCHDigit(d) - QRUtil.getBCHDigit(QRUtil.G15)));
            }
            return ((data << 10) | d) ^ QRUtil.G15_MASK;
        },
        getBCHDigit: function(data) {
            var digit = 0;
            while (data !== 0) { digit++; data >>>= 1; }
            return digit;
        },
        getPatternPosition: function(typeNumber) {
            return QRUtil.PATTERN_POSITION_TABLE[typeNumber - 1] || [];
        },
        getMaskFunction: function(maskPattern) {
            switch (maskPattern) {
                case QRMaskPattern.PATTERN000: return function(i, j) { return (i + j) % 2 === 0; };
                case QRMaskPattern.PATTERN001: return function(i, j) { return i % 2 === 0; };
                case QRMaskPattern.PATTERN010: return function(i, j) { return j % 3 === 0; };
                case QRMaskPattern.PATTERN011: return function(i, j) { return (i + j) % 3 === 0; };
                case QRMaskPattern.PATTERN100: return function(i, j) { return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0; };
                case QRMaskPattern.PATTERN101: return function(i, j) { return (i * j) % 2 + (i * j) % 3 === 0; };
                case QRMaskPattern.PATTERN110: return function(i, j) { return ((i * j) % 2 + (i * j) % 3) % 2 === 0; };
                case QRMaskPattern.PATTERN111: return function(i, j) { return ((i * j) % 3 + (i + j) % 2) % 2 === 0; };
                default: throw new Error("bad maskPattern:" + maskPattern);
            }
        },
        getErrorCorrectPolynomial: function(errorCorrectLength) {
            var a = QRPolynomial([1], 0);
            for (var i = 0; i < errorCorrectLength; i++) {
                a = a.multiply(QRPolynomial([1, QRMath.gexp(i)], 0));
            }
            return a;
        },
        getLengthInBits: function(mode, type) {
            if (1 <= type && type < 10) {
                switch (mode) {
                    case QRMode.MODE_NUMBER: return 10;
                    case QRMode.MODE_ALPHA_NUM: return 9;
                    case QRMode.MODE_8BIT_BYTE: return 8;
                    case QRMode.MODE_KANJI: return 8;
                }
            } else if (type < 27) {
                switch (mode) {
                    case QRMode.MODE_NUMBER: return 12;
                    case QRMode.MODE_ALPHA_NUM: return 11;
                    case QRMode.MODE_8BIT_BYTE: return 16;
                    case QRMode.MODE_KANJI: return 10;
                }
            }
            return 8;
        },
        getLostPoint: function(qrcode) {
            var moduleCount = qrcode.getModuleCount();
            var lostPoint = 0;
            for (var row = 0; row < moduleCount; row++) {
                for (var col = 0; col < moduleCount; col++) {
                    var sameCount = 0;
                    var dark = qrcode.isDark(row, col);
                    for (var r = -1; r <= 1; r++) {
                        if (row + r < 0 || moduleCount <= row + r) continue;
                        for (var c = -1; c <= 1; c++) {
                            if (col + c < 0 || moduleCount <= col + c) continue;
                            if (r === 0 && c === 0) continue;
                            if (dark === qrcode.isDark(row + r, col + c)) sameCount++;
                        }
                    }
                    if (sameCount > 5) lostPoint += (3 + sameCount - 5);
                }
            }
            return lostPoint;
        }
    };

    var qrcode = function(typeNumber, errorCorrectionLevel) {
        var PAD0 = 0xEC;
        var PAD1 = 0x11;
        var _typeNumber = typeNumber || 0;
        var _errorCorrectionLevel = typeof errorCorrectionLevel === 'string' ? QRErrorCorrectionLevel[errorCorrectionLevel] : (errorCorrectionLevel || 0);
        var _modules = null;
        var _moduleCount = 0;
        var _dataCache = null;
        var _dataList = [];

        var _this = {};

        var makeImpl = function(test, maskPattern) {
            _moduleCount = _typeNumber * 4 + 17;
            _modules = new Array(_moduleCount);
            for (var row = 0; row < _moduleCount; row++) {
                _modules[row] = new Array(_moduleCount);
                for (var col = 0; col < _moduleCount; col++) _modules[row][col] = null;
            }
            setupPositionProbePattern(0, 0);
            setupPositionProbePattern(_moduleCount - 7, 0);
            setupPositionProbePattern(0, _moduleCount - 7);
            setupPositionAdjustPattern();
            setupTimingPattern();
            setupTypeInfo(test, maskPattern);
            if (_dataCache == null) _dataCache = createData(_typeNumber, _errorCorrectionLevel, _dataList);
            mapData(_dataCache, maskPattern);
        };

        var setupPositionProbePattern = function(row, col) {
            for (var r = -1; r <= 7; r++) {
                if (row + r <= -1 || _moduleCount <= row + r) continue;
                for (var c = -1; c <= 7; c++) {
                    if (col + c <= -1 || _moduleCount <= col + c) continue;
                    if ((0 <= r && r <= 6 && (c === 0 || c === 6)) || (0 <= c && c <= 6 && (r === 0 || r === 6)) || (2 <= r && r <= 4 && 2 <= c && c <= 4)) {
                        _modules[row + r][col + c] = true;
                    } else {
                        _modules[row + r][col + c] = false;
                    }
                }
            }
        };

        var getBestMaskPattern = function() {
            var minLostPoint = 0;
            var pattern = 0;
            for (var i = 0; i < 8; i++) {
                makeImpl(true, i);
                var lostPoint = QRUtil.getLostPoint(_this);
                if (i === 0 || minLostPoint > lostPoint) {
                    minLostPoint = lostPoint;
                    pattern = i;
                }
            }
            return pattern;
        };

        var setupTimingPattern = function() {
            for (var r = 8; r < _moduleCount - 8; r++) {
                if (_modules[r][6] != null) continue;
                _modules[r][6] = (r % 2 === 0);
            }
            for (var c = 8; c < _moduleCount - 8; c++) {
                if (_modules[6][c] != null) continue;
                _modules[6][c] = (c % 2 === 0);
            }
        };

        var setupPositionAdjustPattern = function() {
            var pos = QRUtil.getPatternPosition(_typeNumber);
            for (var i = 0; i < pos.length; i++) {
                for (var j = 0; j < pos.length; j++) {
                    var row = pos[i];
                    var col = pos[j];
                    if (_modules[row][col] != null) continue;
                    for (var r = -2; r <= 2; r++) {
                        for (var c = -2; c <= 2; c++) {
                            if (r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0)) {
                                _modules[row + r][col + c] = true;
                            } else {
                                _modules[row + r][col + c] = false;
                            }
                        }
                    }
                }
            }
        };

        var setupTypeInfo = function(test, maskPattern) {
            var data = (_errorCorrectionLevel << 3) | maskPattern;
            var bits = QRUtil.getBCHTypeInfo(data);
            for (var i = 0; i < 15; i++) {
                var mod = (!test && ((bits >> i) & 1) === 1);
                if (i < 6) _modules[i][8] = mod;
                else if (i < 8) _modules[i + 1][8] = mod;
                else _modules[_moduleCount - 15 + i][8] = mod;
            }
            for (var i = 0; i < 15; i++) {
                var mod = (!test && ((bits >> i) & 1) === 1);
                if (i < 8) _modules[8][_moduleCount - i - 1] = mod;
                else if (i < 9) _modules[8][15 - i - 1 + 1] = mod;
                else _modules[8][15 - i - 1] = mod;
            }
            _modules[_moduleCount - 8][8] = (!test);
        };

        var mapData = function(data, maskPattern) {
            var inc = -1;
            var row = _moduleCount - 1;
            var bitIndex = 7;
            var byteIndex = 0;
            var maskFunc = QRUtil.getMaskFunction(maskPattern);
            for (var col = _moduleCount - 1; col > 0; col -= 2) {
                if (col === 6) col--;
                while (true) {
                    for (var c = 0; c < 2; c++) {
                        if (_modules[row][col - c] == null) {
                            var dark = false;
                            if (byteIndex < data.length) {
                                dark = (((data[byteIndex] >>> bitIndex) & 1) === 1);
                            }
                            var mask = maskFunc(row, col - c);
                            if (mask) dark = !dark;
                            _modules[row][col - c] = dark;
                            bitIndex--;
                            if (bitIndex === -1) {
                                byteIndex++;
                                bitIndex = 7;
                            }
                        }
                    }
                    row += inc;
                    if (row < 0 || _moduleCount <= row) {
                        row -= inc;
                        inc = -inc;
                        break;
                    }
                }
            }
        };

        var createBytes = function(buffer, rsBlocks) {
            var offset = 0;
            var maxDcCount = 0;
            var maxEcCount = 0;
            var dcdata = new Array(rsBlocks.length);
            var ecdata = new Array(rsBlocks.length);
            for (var r = 0; r < rsBlocks.length; r++) {
                var dcCount = rsBlocks[r].dataCount;
                var ecCount = rsBlocks[r].totalCount - dcCount;
                maxDcCount = Math.max(maxDcCount, dcCount);
                maxEcCount = Math.max(maxEcCount, ecCount);
                dcdata[r] = new Array(dcCount);
                for (var i = 0; i < dcdata[r].length; i++) {
                    dcdata[r][i] = 0xff & buffer.getBuffer()[i + offset];
                }
                offset += dcCount;
                var rsPoly = QRUtil.getErrorCorrectPolynomial(ecCount);
                var rawPoly = QRPolynomial(dcdata[r], rsPoly.getLength() - 1);
                var modPoly = rawPoly.mod(rsPoly);
                ecdata[r] = new Array(rsPoly.getLength() - 1);
                for (var i = 0; i < ecdata[r].length; i++) {
                    var modIndex = i + modPoly.getLength() - ecdata[r].length;
                    ecdata[r][i] = (modIndex >= 0) ? modPoly.getAt(modIndex) : 0;
                }
            }
            var totalCodeCount = 0;
            for (var i = 0; i < rsBlocks.length; i++) totalCodeCount += rsBlocks[i].totalCount;
            var data = new Array(totalCodeCount);
            var index = 0;
            for (var i = 0; i < maxDcCount; i++) {
                for (var r = 0; r < rsBlocks.length; r++) {
                    if (i < dcdata[r].length) {
                        data[index] = dcdata[r][i];
                        index++;
                    }
                }
            }
            for (var i = 0; i < maxEcCount; i++) {
                for (var r = 0; r < rsBlocks.length; r++) {
                    if (i < ecdata[r].length) {
                        data[index] = ecdata[r][i];
                        index++;
                    }
                }
            }
            return data;
        };

        var createData = function(typeNumber, errorCorrectionLevel, dataList) {
            var rsBlocks = QRRSBlock.getRSBlocks(typeNumber, errorCorrectionLevel);
            var buffer = qrBitBuffer();
            for (var i = 0; i < dataList.length; i++) {
                var data = dataList[i];
                buffer.put(data.getMode(), 4);
                buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber));
                data.write(buffer);
            }
            var totalDataCount = 0;
            for (var i = 0; i < rsBlocks.length; i++) totalDataCount += rsBlocks[i].dataCount;
            if (buffer.getLengthInBits() > totalDataCount * 8) {
                throw new Error("code length overflow. (" + buffer.getLengthInBits() + ">" + totalDataCount * 8 + ")");
            }
            if (buffer.getLengthInBits() + 4 <= totalDataCount * 8) buffer.put(0, 4);
            while (buffer.getLengthInBits() % 8 !== 0) buffer.putBit(false);
            while (true) {
                if (buffer.getLengthInBits() >= totalDataCount * 8) break;
                buffer.put(PAD0, 8);
                if (buffer.getLengthInBits() >= totalDataCount * 8) break;
                buffer.put(PAD1, 8);
            }
            return createBytes(buffer, rsBlocks);
        };

        _this.addData = function(data) {
            var newData = qr8BitByte(data);
            _dataList.push(newData);
            _dataCache = null;
        };

        _this.isDark = function(row, col) {
            if (row < 0 || _moduleCount <= row || col < 0 || _moduleCount <= col) throw new Error(row + "," + col);
            return _modules[row][col];
        };

        _this.getModuleCount = function() { return _moduleCount; };

        _this.make = function() {
            if (_typeNumber < 1) {
                var typeNumber = 1;
                for (; typeNumber <= 10; typeNumber++) {
                    var rsBlocks = QRRSBlock.getRSBlocks(typeNumber, _errorCorrectionLevel);
                    var buffer = qrBitBuffer();
                    for (var i = 0; i < _dataList.length; i++) {
                        var data = _dataList[i];
                        buffer.put(data.getMode(), 4);
                        buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber));
                        data.write(buffer);
                    }
                    var totalDataCount = 0;
                    for (var i = 0; i < rsBlocks.length; i++) totalDataCount += rsBlocks[i].dataCount;
                    if (buffer.getLengthInBits() <= totalDataCount * 8) break;
                }
                _typeNumber = typeNumber;
            }
            makeImpl(false, getBestMaskPattern());
        };

        return _this;
    };

    /**
     * Draw QR Code directly to any HTML5 Canvas synchronously
     */
    function drawToCanvas(canvas, text, options) {
        options = options || {};
        var qr = qrcode(0, options.errorCorrectionLevel || 'M');
        qr.addData(text);
        qr.make();

        var moduleCount = qr.getModuleCount();
        var width = options.width || canvas.width || 300;
        var height = options.height || canvas.height || 300;
        canvas.width = width;
        canvas.height = height;

        var margin = options.margin !== undefined ? options.margin : 2;
        var totalCells = moduleCount + margin * 2;
        var cellSize = Math.floor(Math.min(width, height) / totalCells);
        if (cellSize < 1) cellSize = 1;
        var actualMargin = Math.floor((width - cellSize * moduleCount) / 2);

        var ctx = canvas.getContext('2d');
        ctx.fillStyle = (options.color && options.color.light) ? options.color.light : '#ffffff';
        ctx.fillRect(0, 0, width, height);

        ctx.fillStyle = (options.color && options.color.dark) ? options.color.dark : '#000000';
        for (var r = 0; r < moduleCount; r++) {
            for (var c = 0; c < moduleCount; c++) {
                if (qr.isDark(r, c)) {
                    ctx.fillRect(actualMargin + c * cellSize, actualMargin + r * cellSize, cellSize, cellSize);
                }
            }
        }
        return canvas;
    }

    return {
        qrcode: qrcode,
        drawToCanvas: drawToCanvas
    };
}));
