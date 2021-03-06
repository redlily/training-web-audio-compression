// サウンドエンコーダとデコーダの実装

var wamCodec = wamCodec || {};

(function () {

    // マジックナンバー ORPH sound data format
    const MAGIC_NUMBER =
        ("O".charCodeAt(0)) | ("R".charCodeAt(0) << 8) | ("P".charCodeAt(0) << 16) | ("H".charCodeAt(0) << 24);
    // ファイルタイプ、 Simple Modified discrete cosine transform Data
    const FILE_TYPE_SMD0 =
        ("S".charCodeAt(0)) | ("M".charCodeAt(0) << 8) | ("D".charCodeAt(0) << 16) | ("0".charCodeAt(0) << 24);
    // SMD0形式のバージョン
    const SMD0_VERSION = 0;

    // ヘッダオフセット、マジックナンバー
    const HEADER_OFFSET_MAGIC_NUMBER = 0;
    // ヘッダオフセット、データサイズ
    const HEADER_OFFSET_DATA_SIZE = 4;
    // ヘッダオフセット、データタイプ、拡張用
    const HEADER_OFFSET_DATA_TYPE = 8;
    // ヘッダオフセット、バージョン
    const HEADER_OFFSET_VERSION = 12;
    // ヘッダオフセット、サンプリングレート
    const HEADER_OFFSET_SAMPLE_RATE = 16;
    // ヘッダオフセット、サンプル数
    const HEADER_OFFSET_SAMPLE_COUNT = 20;
    // ヘッダオフセット、フレーム数
    const HEADER_OFFSET_FRAME_COUNT = 24;
    // ヘッダオフセット、チャネル数、1がモノラル、2がステレオ
    const HEADER_OFFSET_CHANNEL_SIZE = 28;
    // ヘッダオフセット、周波数レンジ、2のべき乗の値を設定する必要がある
    const HEADER_OFFSET_FREQUENCY_RANGE = 30;
    // ヘッダオフセット、周波数の上限
    const HEADER_OFFSET_FREQUENCY_UPPER_LIMIT = 32;
    // ヘッダオフセット、周波数テーブルサイズ、32で割れる数を指定すると効率が良い
    const HEADER_OFFSET_FREQUENCY_TABLE_SIZE = 34;
    // ヘッダオフセット、データ
    const HEADER_OFFSET_DATA = 36;

    // フレームヘッダ、オフセット、振幅のメインスケール
    const FRAME_OFFSET_MASTER_SCALE = 0;
    // フーレムヘッダ、オフセット、振幅のサブスケール、4bitで8つのメインスケールからのスケール値を対数で保持する
    const FRAME_OFFSET_SUB_SCALE = 4;
    // フレームヘッダ、オフセット、データ
    const FRAME_OFFSET_DATA = 8;

    // 対数による量子化で使用する対数の底
    const BASE_OF_LOGARITHM = 2;

    // アサート
    function assert(test, message) {
        if (!test) throw new Error(message || "Failed to test.");
    }

    // Web Audio Media コーダ
    class WamCoder {

        constructor() {
            this.data = null;
            this.frameCount = 0;
            this.numChannels = 0;
            this.frequencyRange = 0;
            this.frequencyUpperLimit = 0;
            this.frequencyTableSize = 0;
            this.subScales = null;
            this.windowFunction = null;
            this.samples = null;
            this.indexBitSize = 0;
            this.indicesSize = 0;
            this.isIndexMode = false;
        }

        readHalfUbyte(offset, index) {
            return 0xf & (this.data.getUint8(offset) >>> (index << 2));
        }

        writeHalfUbyte(offset, index, value) {
            this.data.setUint8(
                offset,
                (0xff & (this.data.getUint8(offset) & ~(0xf << (index << 2)))) | ((0xf & value) << (index << 2)));
        }

        // 窓関数となる配列を生成、窓の種類はVorbis窓
        setupWindowFunction() {
            this.windowFunction = new Float32Array(this.frequencyRange << 1);
            for (let i = 0; i < this.frequencyRange; ++i) {
                let value = Math.sin(Math.PI / 2 * Math.pow(Math.sin(Math.PI * (i / ((this.frequencyRange << 1) - 1))), 2));
                this.windowFunction[i] = value;
                this.windowFunction[(this.frequencyRange << 1) - 1 - i] = value;
            }
        }

        // 窓関数をサンプルに適用する
        applyWindowFunction() {
            for (let i = 0; i < this.frequencyRange << 1; ++i) {
                this.samples[i] *= this.windowFunction[i];
            }
        }

        getDataOffset(frame, channel) {
            return HEADER_OFFSET_DATA +
                (FRAME_OFFSET_DATA +
                    (this.isIndexMode ? (this.indicesSize / 8) : (this.frequencyUpperLimit / 8)) +
                    (this.frequencyTableSize >>> 1)) *
                (this.numChannels * frame + channel);
        }
    }

    // Web Audio Media エンコーダ
    class WamEncoder extends WamCoder {

        constructor(sampleRate, numChannels, frequencyRange, frequencyUpperLimit, frequencyTableSize, initSampleCount = 4096) {
            super();

            this.sampleRate = sampleRate;
            this.numChannels = numChannels;
            this.frequencyRange = frequencyRange != null ? frequencyRange : 1024;
            this.frequencyUpperLimit = frequencyUpperLimit != null ? frequencyUpperLimit : this.frequencyRange;
            this.frequencyTableSize = frequencyTableSize != null ? frequencyTableSize : this.frequencyRange >>> 2;

            assert(this.sampleRate > 0);
            assert(this.numChannels > 0);
            assert(this.frequencyRange > 0);
            assert(this.frequencyRange % 32 == 0); // 効率を重視して32の倍数である必要がある
            assert(this.frequencyUpperLimit <= frequencyRange);
            assert(this.frequencyTableSize > 0);
            assert(this.frequencyTableSize % 8 == 0); // バイト境界を考慮して8の倍数である必要がある

            let initBufferSize = HEADER_OFFSET_DATA +
                (FRAME_OFFSET_DATA + (this.frequencyRange / 32) * 4 + this.frequencyTableSize) *
                this.numChannels * Math.ceil(initSampleCount / this.frequencyRange);

            this.data = new DataView(new ArrayBuffer(initBufferSize));
            this.data.setUint32(HEADER_OFFSET_MAGIC_NUMBER, MAGIC_NUMBER);
            this.data.setUint32(HEADER_OFFSET_DATA_SIZE, 0);
            this.data.setUint32(HEADER_OFFSET_DATA_TYPE, FILE_TYPE_SMD0);
            this.data.setUint32(HEADER_OFFSET_VERSION, SMD0_VERSION);
            this.data.setUint32(HEADER_OFFSET_SAMPLE_RATE, this.sampleRate);
            this.data.setUint32(HEADER_OFFSET_SAMPLE_COUNT, 0);
            this.data.setUint32(HEADER_OFFSET_FRAME_COUNT, 0);
            this.data.setUint16(HEADER_OFFSET_CHANNEL_SIZE, this.numChannels);
            this.data.setUint16(HEADER_OFFSET_FREQUENCY_RANGE, this.frequencyRange);
            this.data.setUint16(HEADER_OFFSET_FREQUENCY_UPPER_LIMIT, this.frequencyUpperLimit);
            this.data.setUint16(HEADER_OFFSET_FREQUENCY_TABLE_SIZE, this.frequencyTableSize);

            this.setupWindowFunction();

            this.indexBitSize = Math.ceil(Math.log2(this.frequencyUpperLimit));
            this.indicesSize = Math.ceil(this.indexBitSize * this.frequencyTableSize / 32) * 32;
            this.isIndexMode = (1 << this.indexBitSize) > this.indicesSize;
            this.subScales = new Uint8Array(Math.min(this.indexBitSize, 8));
            this.subScaleStart = this.frequencyUpperLimit / (1 << Math.min(Math.ceil(Math.log2(this.frequencyUpperLimit)), 7));
            this.frequencyFlags = new Uint32Array(this.frequencyUpperLimit / 32);
            this.frequencies = new Float32Array(this.frequencyRange);
            this.frequencyPowers = new Float32Array(this.frequencyUpperLimit);
            this.samples = new Float32Array(this.frequencyRange << 1);
            this.prevInputs = new Array(this.numChannels);
            for (let i = 0; i < this.numChannels; ++i) {
                this.prevInputs[i] = new Float32Array(this.frequencyRange);
            }
            this.workBuffers = new Array(this.numChannels);
            for (let i = 0; i < this.numChannels; ++i) {
                this.workBuffers[i] = new Float32Array(this.frequencyRange);
            }
            this.workBufferOffset = 0;
        }

        writeFrame(inputData, start = 0, length = this.frequencyRange) {
            assert(inputData.length >= this.numChannels);
            assert(length <= this.frequencyRange && length >= 0);

            this.nextFrame();
            for (let i = 0; i < this.numChannels; ++i) {
                let input = inputData[i];
                let dataOffset = this.getDataOffset(this.frameCount - 1, i);

                // 前回の入力を処理バッファの前半に充填
                let prevInput = this.prevInputs[i];
                for (let j = 0; j < this.frequencyRange; ++j) {
                    this.samples[j] = prevInput[j];
                }

                // 今回の入力を処理バッファの後半に充填し、次回の処理に備え保存
                for (let j = 0; j < length; ++j) {
                    let value = input[start + j] * ((1 << 16) - 1); // [-1, 1]の数値を16bitの数値にスケール
                    this.samples[this.frequencyRange + j] = value;
                    prevInput[j] = value;
                }
                for (let j = length; j < this.frequencyRange; ++j) {
                    this.samples[this.frequencyRange + j] = 0;
                    prevInput[j] = 0;
                }

                // 窓関数をかける
                this.applyWindowFunction();

                // MDCTをかける
                FastMDCT.mdct(this.frequencyRange, this.samples, this.frequencies);

                // 振幅のマスタスケールを書き出し
                let masterScale = 1;
                for (let j = 0; j < this.frequencyUpperLimit; ++j) {
                    let power = Math.abs(this.frequencies[j]);
                    if (power > masterScale) {
                        masterScale = power;
                    }
                }
                this.data.setUint32(dataOffset + FRAME_OFFSET_MASTER_SCALE, masterScale);

                // 振幅のサブスケールを書き出す
                for (let j = 0; j < this.subScales.length; ++j) {
                    let subScale = 1;
                    for (let k = j == 0 ? 0 : this.subScaleStart << (j - 1); k < this.subScaleStart << j && k < this.frequencyUpperLimit; ++k) {
                        let power = Math.abs(this.frequencies[k]);
                        if (power > subScale) {
                            subScale = power;
                        }
                    }
                    let power = Math.floor(Math.min(-Math.log(subScale / masterScale) / Math.log(BASE_OF_LOGARITHM) * 2, 15));
                    this.subScales[j] = power;
                    this.writeHalfUbyte(dataOffset + FRAME_OFFSET_SUB_SCALE + (j >>> 1), 0x1 & j, power);
                }

                // 各周波数のパワーを計算しておく
                for (let j = 0; j < this.subScales.length; ++j) {
                    let subScale = this.subScales[j];
                    for (let k = j == 0 ? 0 : this.subScaleStart << (j - 1); k < this.subScaleStart << j && k < this.frequencyUpperLimit; ++k) {
                        let power = Math.abs(this.frequencies[k]) / masterScale;
                        this.frequencyPowers[k] = power > Math.pow(BASE_OF_LOGARITHM, -7 - subScale * 0.5) ? power : 0;
                    }
                }

                // 書き出す周波数を選択
                this.frequencyFlags.fill(0);
                let writeCount = 0;
                while (writeCount < this.frequencyTableSize) {
                    let sumPower = 0;
                    for (let j = 0; j < this.frequencyUpperLimit; ++j) {
                        sumPower += this.frequencyPowers[j];
                    }
                    if (sumPower <= 0) {
                        break;
                    }

                    let sum = 0;
                    let maxIndex = this.frequencyUpperLimit - 1;
                    let maxPower = this.frequencyPowers[maxIndex];
                    for (let j = this.frequencyUpperLimit - 1; j >= 0 && writeCount < this.frequencyTableSize; --j) {
                        let power = this.frequencyPowers[j];
                        sum += power;

                        if (power > maxPower) {
                            maxPower = power;
                            maxIndex = j;
                        }

                        if (sum >= sumPower / this.frequencyTableSize) {
                            this.frequencyFlags[Math.floor(maxIndex / 32)] |= 1 << (maxIndex % 32);
                            this.frequencyPowers[maxIndex] = 0;
                            writeCount++;

                            sum = 0;
                            maxIndex = j - 1;
                            maxPower = this.frequencyPowers[maxIndex];
                        }
                    }
                }

                // 周波数フラグを書き出し
                dataOffset += FRAME_OFFSET_DATA;
                if (this.isIndexMode) {
                    // 有効な周波数をインデックスで書き出す
                    let value = 0;
                    let index = 0;
                    for (let j = 0; j < this.frequencyRange; ++j) {
                        if ((this.frequencyFlags[Math.floor(j / 32)] >>> j % 32) & 0x1 != 0) {
                            value |= j << index;
                            index += this.indexBitSize;
                            if (index >= 32) {
                                this.data.setUint32(dataOffset, value);
                                dataOffset += 4;
                                index %= 32;
                                value = j >> (this.indexBitSize - index);
                            }
                        }
                    }
                    if (index != 0) {
                        this.data.setUint32(dataOffset, value);
                        dataOffset += 4;
                    }
                } else {
                    // 有効な周波数を1bitのフラグで書き出す
                    for (let j = 0; j < this.frequencyFlags.length; ++j) {
                        this.data.setUint32(dataOffset, this.frequencyFlags[j]);
                        dataOffset += 4;
                    }
                }

                // MDCT用の周波数配列から必要な分を周波数テーブルへ書き出し
                let frequencyOffset = 0;
                for (let j = 0; j < this.subScales.length; ++j) {
                    let subScale = this.subScales[j];
                    for (let k = j == 0 ? 0 : this.subScaleStart << (j - 1); k < this.subScaleStart << j && k < this.frequencyRange; ++k) {
                        if ((this.frequencyFlags[Math.floor(k / 32)] >>> (k % 32)) & 0x1 != 0) {
                            let value = this.frequencies[k] / masterScale;
                            let signed = value >= 0 ? 0x0 : 0x8;
                            let power = Math.ceil(Math.min(-Math.log(Math.abs(value)) / Math.log(BASE_OF_LOGARITHM) - subScale * 0.5, 7));
                            this.writeHalfUbyte(
                                dataOffset + (frequencyOffset >>> 1),
                                0x1 & frequencyOffset,
                                signed | power);
                            frequencyOffset += 1;
                        }
                    }
                }
            }
            this.sampleCount += length;
        }

        nextFrame() {
            this.frameCount++;
            if (this.getDataSize() > this.data.buffer.byteLength) {
                let buffer = new ArrayBuffer(this.data.buffer.byteLength << 1);
                new Uint8Array(buffer).set(new Uint8Array(this.data.buffer));
                this.data = new DataView(buffer);
            }
        }

        write(inputData, start = 0, length = this.frequencyRange) {
            assert(inputData.length >= this.numChannels);

            // 書き込み出来ていないサンプルを書き込む
            if (this.workBufferOffset > 0) {
                let writeSize = Math.min(this.frequencyRange - this.workBufferOffset, length);
                for (let i = 0; i < this.numChannels; ++i) {
                    let input = inputData[i];
                    let workBuffer = this.workBuffers[i];
                    for (let j = 0; j < writeSize; ++j) {
                        workBuffer[this.workBufferOffset + j] = input[start + j];
                    }
                }
                start += writeSize;
                length -= writeSize;
                this.workBufferOffset += writeSize;
                if (this.workBufferOffset >= this.frequencyRange) {
                    this.writeFrame(this.workBuffers);
                    this.workBufferOffset = 0;
                }
            }

            // 入力バッファをフレーム単位で読み込む
            while (length >= this.frequencyRange) {
                this.writeFrame(inputData, start);
                start += this.frequencyRange;
                length -= this.frequencyRange;
            }

            // まだ入力バッファに書き込むデータが残っている場合
            if (length > 0) {
                for (let i = 0; i < this.numChannels; ++i) {
                    let input = inputData[i];
                    let workBuffer = this.workBuffers[i];
                    for (let j = 0; j < length; ++j) {
                        workBuffer[j] = input[start + j];
                    }
                }
                this.workBufferOffset = length;
            }
        }

        flush() {
            if (this.workBufferOffset > 0) {
                for (let i = 0; i < this.numChannels; ++i) {
                    this.workBuffers[i].fill(0, this.workBufferOffset, this.frequencyRange);
                }
                this.writeFrame(this.workBuffers);
                this.workBufferOffset = 0;
            }
        }

        getDataSize() {
            return this.getDataOffset(this.frameCount, 0);
        }

        getDataBuffer() {
            let dataSize = this.getDataSize();
            this.data.setUint32(HEADER_OFFSET_DATA_SIZE, dataSize);
            this.data.setUint32(HEADER_OFFSET_SAMPLE_COUNT, this.frequencyRange * this.frameCount);
            this.data.setUint32(HEADER_OFFSET_FRAME_COUNT, this.frameCount);
            return this.data.buffer.slice(0, this.getDataSize());
        }
    }

    wamCodec.WamEncoder = WamEncoder;

    // Web Audio Media デコーダ
    class WamDecoder extends WamCoder {

        static isWamData(data) {
            return new DataView(data).getUint32(HEADER_OFFSET_MAGIC_NUMBER) == MAGIC_NUMBER;
        }

        constructor(data) {
            super();

            this.data = new DataView(data);
            this.magicNumber = this.data.getUint32(HEADER_OFFSET_MAGIC_NUMBER);
            this.fileSize = this.data.getUint32(HEADER_OFFSET_DATA_SIZE);
            this.fileType = this.data.getUint32(HEADER_OFFSET_DATA_TYPE);
            this.version = this.data.getUint32(HEADER_OFFSET_VERSION);
            this.sampleRate = this.data.getUint32(HEADER_OFFSET_SAMPLE_RATE);
            this.sampleCount = this.data.getUint32(HEADER_OFFSET_SAMPLE_COUNT);
            this.frameCount = this.data.getUint32(HEADER_OFFSET_FRAME_COUNT);
            this.numChannels = this.data.getUint16(HEADER_OFFSET_CHANNEL_SIZE);
            this.frequencyRange = this.data.getUint16(HEADER_OFFSET_FREQUENCY_RANGE);
            this.frequencyUpperLimit = this.data.getUint16(HEADER_OFFSET_FREQUENCY_UPPER_LIMIT);
            this.frequencyTableSize = this.data.getUint16(HEADER_OFFSET_FREQUENCY_TABLE_SIZE);

            assert(this.magicNumber == MAGIC_NUMBER);
            assert(this.fileSize <= data.byteLength);
            assert(this.fileType == FILE_TYPE_SMD0);
            assert(this.version == 0);
            assert(this.sampleRate > 0);
            assert(this.sampleCount <= this.frequencyRange * this.frameCount);
            assert(this.numChannels > 0);
            assert(this.frequencyRange > 0);
            assert(this.frequencyUpperLimit <= this.frequencyRange);
            assert(this.frequencyTableSize > 0);

            this.setupWindowFunction();

            this.indexBitSize = Math.ceil(Math.log2(this.frequencyUpperLimit));
            this.indicesSize = Math.ceil(this.indexBitSize * this.frequencyTableSize / 32) * 32;
            this.isIndexMode = (1 << this.indexBitSize) > this.indicesSize;
            this.subScales = new Uint8Array(Math.min(this.indexBitSize, 8));
            this.subScaleStart = this.frequencyUpperLimit / (1 << Math.min(Math.ceil(Math.log2(this.frequencyUpperLimit)), 7));
            this.frequencyFlags = new Uint32Array(this.frequencyUpperLimit / 32);
            this.frequencies = new Float32Array(this.frequencyRange);
            this.samples = new Float32Array(this.frequencyRange << 1);
            this.prevOutputs = new Array(this.numChannels);
            for (let i = 0; i < this.numChannels; ++i) {
                this.prevOutputs[i] = new Float32Array(this.frequencyRange);
            }
            this.currentFrame = 0;
            this.workBuffers = new Array(this.numChannels);
            for (let i = 0; i < this.numChannels; ++i) {
                this.workBuffers[i] = new Float32Array(this.frequencyRange);
            }
            this.workBufferOffset = this.frequencyRange;
        }

        read(outputData, start = 0, length = this.frequencyRange) {
            assert(outputData.length >= this.numChannels);

            // 書き込み出来ていないサンプルを出力バッファ書き込む
            if (this.workBufferOffset < this.frequencyRange) {
                let writeSize = Math.min(length, this.frequencyRange - this.workBufferOffset);
                for (let i = 0; i < this.numChannels; ++i) {
                    let output = outputData[i];
                    let workBuffer = this.workBuffers[i];
                    for (let j = 0; j < writeSize; ++j) {
                        output[start + j] = workBuffer[this.workBufferOffset + j];
                    }
                }
                start += writeSize;
                length -= writeSize;
                this.workBufferOffset += writeSize;
            }

            // 出力バッファにフレーム単位で読み込む
            while (length >= this.frequencyRange) {
                this.readFrame(outputData, start);
                start += this.frequencyRange;
                length -= this.frequencyRange;
            }

            // まだ出力バッファに書き込みきれていない場合
            if (length > 0) {
                this.readFrame(this.workBuffers, 0);
                for (let i = 0; i < this.numChannels; ++i) {
                    let output = outputData[i];
                    let workBuffer = this.workBuffers[i];
                    for (let j = 0; j < length; ++j) {
                        output[start + j] = workBuffer[j];
                    }
                }
                this.workBufferOffset = length;
            }
        }

        readFrame(outputData, start = 0, length = this.frequencyRange) {
            assert(outputData.length >= this.numChannels);
            assert(length <= this.frequencyRange && length >= 0);

            for (let i = 0; i < this.numChannels; ++i) {
                let output = outputData[i];
                let dataOffset = this.getDataOffset(this.currentFrame, i);

                // 振幅のマスタボリュームを取得
                let masterVolume = this.data.getUint32(dataOffset + FRAME_OFFSET_MASTER_SCALE);

                // 振幅のサブスケールを取得
                for (let j = 0; j < this.subScales.length; ++j) {
                    this.subScales[j] = this.readHalfUbyte(dataOffset + FRAME_OFFSET_SUB_SCALE + (j >>> 1), 0x1 & j);
                }

                // 周波数フラグを取得
                dataOffset += FRAME_OFFSET_DATA;
                if (this.isIndexMode) {
                    // 有効な周波数をインデックスで判別
                    this.frequencyFlags.fill(0);
                    let index = 0;
                    let mask = (1 << this.indexBitSize) - 1;
                    let value = this.data.getUint32(dataOffset);
                    dataOffset += 4;
                    for (let j = 0; j < this.frequencyTableSize; ++j) {
                        let bitIndex = mask & value;
                        value >>>= this.indexBitSize;
                        index += this.indexBitSize;
                        if (index > 32) {
                            value = this.data.getUint32(dataOffset);
                            dataOffset += 4;
                            index %= 32;
                            bitIndex |= mask & (value << (this.indexBitSize - index));
                            value >>>= index;
                        }
                        this.frequencyFlags[Math.floor(bitIndex / 32)] |= 1 << (bitIndex % 32);
                    }
                } else {
                    // 有効な周波数を1bitのフラグで判別
                    for (let j = 0; j < this.frequencyFlags.length; ++j) {
                        this.frequencyFlags[j] = this.data.getUint32(dataOffset);
                        dataOffset += 4;
                    }
                }

                // 周波数テーブルを取得、MDCT用の周波数配列に書き込み
                this.frequencies.fill(0);
                let frequencyOffset = 0;
                for (let j = 0; j < this.subScales.length; ++j) {
                    let subScale = this.subScales[j];
                    for (let k = j == 0 ? 0 : this.subScaleStart << (j - 1); k < this.subScaleStart << j && k < this.frequencyUpperLimit; ++k) {
                        if ((this.frequencyFlags[Math.floor(k / 32)] >>> k % 32) & 0x1 != 0) {
                            let value = this.readHalfUbyte(dataOffset + (frequencyOffset >>> 1), 0x1 & frequencyOffset);
                            let signed = 0x8 & value;
                            let power = Math.pow(BASE_OF_LOGARITHM, -(0x7 & value) - subScale * 0.5) * masterVolume;
                            this.frequencies[k] = signed == 0 ? power : -power;
                            frequencyOffset += 1;
                        }
                    }
                }

                // 逆MDCTをかける
                FastMDCT.imdct(this.frequencyRange, this.samples, this.frequencies);

                // 窓関数をかける
                this.applyWindowFunction();

                // 前回の後半の計算結果と今回の前半の計算結果をクロスフェードして出力
                let prevOutput = this.prevOutputs[i];
                for (let j = 0; j < length; ++j) {
                    output[start + j] = prevOutput[j] + this.samples[j] / ((1 << 16) - 1); // 16bitの数値を[-1, 1]の数値にスケール
                    prevOutput[j] = this.samples[this.frequencyRange + j] / ((1 << 16) - 1);
                }
                for (let j = length; j < this.frequencyRange; ++j) {
                    prevOutput[j] = this.samples[this.frequencyRange + j] / ((1 << 16) - 1);
                }
            }
            this.nextFrame();
        }

        nextFrame() {
            this.currentFrame = (this.currentFrame + 1) % this.frameCount;
        }
    }

    wamCodec.WamDcoder = WamDecoder;

})();
