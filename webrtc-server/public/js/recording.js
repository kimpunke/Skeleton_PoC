const FALL_PREBUFFER_MS = 15000;
const FALL_POSTBUFFER_MS = 5000;
const FALL_CHUNK_MS = 1000;

const createRecordingController = ({
  apiFetch,
  getCurrentMode,
  loadFallClips,
  updateRecordUi,
  getFocusedSenderId
}) => {
  const finalizeManualClipData = async (chunks, senderId, startedAt) => {
    if (!chunks || chunks.length === 0 || !senderId) {
      return;
    }
    const blob = new Blob(chunks, { type: "video/webm" });
    const timestamp = new Date(startedAt || Date.now()).toISOString();
    void uploadClip(blob, senderId, timestamp, "record");
  };

  const startManualRecording = (slot) => {
    if (!slot || slot.manualRecording || !slot.stream || !window.MediaRecorder) {
      return;
    }
    const mimeTypes = [
      "video/webm;codecs=vp8",
      "video/webm;codecs=vp9",
      "video/webm"
    ];
    const mimeType = mimeTypes.find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = mimeType ? new MediaRecorder(slot.stream, { mimeType }) : new MediaRecorder(slot.stream);
    slot.manualRecorder = recorder;
    slot.manualChunks = [];
    slot.manualRecording = true;
    slot.manualStartedAt = Date.now();
    slot.manualSenderId = getFocusedSenderId();
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        slot.manualChunks.push(event.data);
      }
    };
    recorder.onstop = () => {
      const chunks = slot.manualChunks;
      const senderId = slot.manualSenderId;
      const startedAt = slot.manualStartedAt;
      slot.manualRecorder = null;
      slot.manualChunks = [];
      slot.manualRecording = false;
      slot.manualStartedAt = null;
      slot.manualSenderId = null;
      updateRecordUi();
      void finalizeManualClipData(chunks, senderId, startedAt);
    };
    recorder.start(FALL_CHUNK_MS);
    updateRecordUi();
  };

  const stopManualRecording = (slot) => {
    if (!slot || !slot.manualRecorder) {
      return;
    }
    if (slot.manualRecorder.state !== "inactive") {
      slot.manualRecorder.stop();
    }
  };

  const startRecorder = (slot, stream) => {
    if (!slot || !stream || !window.MediaRecorder) {
      return;
    }
    if (slot.streamId === stream.id && slot.recorder) {
      return;
    }
    stopRecorder(slot);
    const mimeTypes = [
      "video/webm;codecs=vp8",
      "video/webm;codecs=vp9",
      "video/webm"
    ];
    const mimeType = mimeTypes.find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    slot.recorder = recorder;
    slot.streamId = stream.id;
    slot.stream = stream;
    slot.recordedChunks = [];
    slot.bufferChunks = [];
    slot.headerChunk = null;
    slot.fallActive = false;
    slot.fallStartedAt = null;
    if (slot.fallStopTimer) {
      clearTimeout(slot.fallStopTimer);
      slot.fallStopTimer = null;
    }
    slot.pendingUpload = false;
    slot.pendingSenderId = null;
    slot.restartAfterStop = false;

    recorder.ondataavailable = (event) => {
      if (!event.data || event.data.size === 0) {
        return;
      }
      const now = Date.now();
      const entry = {
        data: event.data,
        timestamp: now
      };
      if (!slot.headerChunk) {
        slot.headerChunk = entry;
      }
      if (slot.fallActive || slot.pendingUpload) {
        slot.recordedChunks.push(entry);
        return;
      }
      slot.bufferChunks.push(entry);
      const cutoff = now - FALL_PREBUFFER_MS;
      while (slot.bufferChunks.length > 0 && slot.bufferChunks[0].timestamp < cutoff) {
        slot.bufferChunks.shift();
      }
    };

    recorder.onstop = () => {
      const chunks = slot.recordedChunks;
      const senderId = slot.pendingSenderId;
      const fallStartedAt = slot.fallStartedAt;
      const headerChunk = slot.headerChunk;
      const shouldUpload = slot.pendingUpload;
      const shouldRestart = slot.restartAfterStop;
      const nextStream = slot.stream;
      slot.recordedChunks = [];
      slot.pendingUpload = false;
      slot.pendingSenderId = null;
      slot.restartAfterStop = false;
      slot.fallStartedAt = null;
      slot.headerChunk = null;
      if (slot.fallStopTimer) {
        clearTimeout(slot.fallStopTimer);
        slot.fallStopTimer = null;
      }
      slot.recorder = null;
      if (shouldUpload) {
        void finalizeFallClipData(chunks, senderId, fallStartedAt, headerChunk);
      }
      if (shouldRestart && nextStream) {
        startRecorder(slot, nextStream);
      }
    };

    recorder.start(FALL_CHUNK_MS);
    scheduleRecorderRoll(slot);
    updateRecordUi();
  };

  const stopRecorder = (slot) => {
    if (!slot || !slot.recorder) {
      return;
    }
    if (slot.rollTimer) {
      clearTimeout(slot.rollTimer);
      slot.rollTimer = null;
    }
    if (slot.recorder.state !== "inactive") {
      slot.recorder.stop();
    }
    slot.recordedChunks = [];
    slot.bufferChunks = [];
    slot.fallActive = false;
    slot.headerChunk = null;
    if (slot.fallStopTimer) {
      clearTimeout(slot.fallStopTimer);
      slot.fallStopTimer = null;
    }
    slot.streamId = null;
    slot.stream = null;
    slot.pendingUpload = false;
    slot.pendingSenderId = null;
    slot.restartAfterStop = false;
  };

  const scheduleRecorderRoll = (slot) => {
    if (!slot || !slot.recorder) {
      return;
    }
    if (slot.rollTimer) {
      clearTimeout(slot.rollTimer);
    }
    slot.rollTimer = setTimeout(() => {
      if (!slot.fallActive) {
        rollRecorder(slot);
      }
    }, FALL_PREBUFFER_MS);
  };

  const rollRecorder = (slot) => {
    if (!slot || !slot.recorder || slot.recorder.state !== "recording") {
      return;
    }
    slot.pendingUpload = false;
    slot.pendingSenderId = null;
    slot.restartAfterStop = true;
    slot.recordedChunks = [];
    slot.recorder.stop();
  };

  const startFallClip = (slot) => {
    if (!slot || !slot.recorder) {
      return;
    }
    slot.fallActive = true;
    slot.fallStartedAt = Date.now();
    if (slot.fallStopTimer) {
      clearTimeout(slot.fallStopTimer);
      slot.fallStopTimer = null;
    }
    if (slot.bufferChunks && slot.bufferChunks.length > 0) {
      slot.recordedChunks = slot.bufferChunks.slice();
      slot.bufferChunks = [];
    } else {
      slot.recordedChunks = [];
    }
    if (slot.rollTimer) {
      clearTimeout(slot.rollTimer);
      slot.rollTimer = null;
    }
  };

  const finishFallClip = (slot, senderId) => {
    if (!slot) {
      return;
    }
    slot.fallActive = false;
    if (!slot.recorder || slot.recorder.state !== "recording") {
      return;
    }
    slot.pendingUpload = true;
    slot.pendingSenderId = senderId;
    slot.restartAfterStop = true;
    if (slot.fallStopTimer) {
      clearTimeout(slot.fallStopTimer);
    }
    slot.fallStopTimer = setTimeout(() => {
      slot.fallStopTimer = null;
      if (!slot.recorder || slot.recorder.state !== "recording") {
        return;
      }
      if (slot.fallActive) {
        return;
      }
      slot.recorder.stop();
    }, FALL_POSTBUFFER_MS);
  };

  const normalizeFallChunks = (chunks, fallStartedAt, headerChunk) => {
    const data = [];
    let firstTimestamp = null;
    let lastTimestamp = null;
    for (const entry of chunks) {
      if (!entry) {
        continue;
      }
      if (entry.data) {
        data.push(entry.data);
        if (Number.isFinite(entry.timestamp)) {
          if (firstTimestamp === null) {
            firstTimestamp = entry.timestamp;
          }
          lastTimestamp = entry.timestamp;
        }
      } else {
        data.push(entry);
      }
    }
    let durationMs = 0;
    if (firstTimestamp !== null && lastTimestamp !== null) {
      durationMs = Math.max(FALL_CHUNK_MS, lastTimestamp - firstTimestamp + FALL_CHUNK_MS);
    } else if (Number.isFinite(fallStartedAt)) {
      durationMs = Math.max(FALL_CHUNK_MS, Date.now() - fallStartedAt);
    } else {
      durationMs = data.length * FALL_CHUNK_MS;
    }
    if (headerChunk && headerChunk.data && data.length > 0) {
      const headerData = headerChunk.data;
      const headerIndex = data.indexOf(headerData);
      if (headerIndex === 0) {
        return { data, durationMs };
      }
      if (headerIndex > 0) {
        data.splice(headerIndex, 1);
      }
      data.unshift(headerData);
    }
    return { data, durationMs };
  };

  const getVintLength = (firstByte) => {
    let mask = 0x80;
    let length = 1;
    while (length <= 8 && (firstByte & mask) === 0) {
      mask >>= 1;
      length += 1;
    }
    return length <= 8 ? length : null;
  };

  const readVintId = (data, offset) => {
    const length = getVintLength(data[offset]);
    if (!length || offset + length > data.length) {
      return null;
    }
    let value = 0;
    for (let i = 0; i < length; i += 1) {
      value = (value << 8) + data[offset + i];
    }
    return { length, value };
  };

  const readVintSize = (data, offset) => {
    const length = getVintLength(data[offset]);
    if (!length || offset + length > data.length) {
      return null;
    }
    const mask = 0xFF >> length;
    let value = data[offset] & mask;
    for (let i = 1; i < length; i += 1) {
      value = (value << 8) + data[offset + i];
    }
    const max = Math.pow(2, 7 * length) - 1;
    if (value === max) {
      return { length, value: -1 };
    }
    return { length, value };
  };

  const fixWebmDuration = async (blob, durationMs) => {
    if (!blob || !Number.isFinite(durationMs) || durationMs <= 0) {
      return blob;
    }
    const buffer = await blob.arrayBuffer();
    const data = new Uint8Array(buffer);
    let offset = 0;
    let segmentStart = null;
    let segmentEnd = data.length;

    while (offset < data.length) {
      const id = readVintId(data, offset);
      if (!id) {
        break;
      }
      offset += id.length;
      const size = readVintSize(data, offset);
      if (!size) {
        break;
      }
      offset += size.length;
      if (id.value === 0x18538067) {
        segmentStart = offset;
        segmentEnd = size.value === -1 ? data.length : offset + size.value;
        break;
      }
      offset += size.value === -1 ? 0 : size.value;
    }

    if (segmentStart === null) {
      return blob;
    }

    let infoOffset = null;
    let infoSize = null;
    let timecodeScale = 1000000;
    offset = segmentStart;

    while (offset < segmentEnd) {
      const id = readVintId(data, offset);
      if (!id) {
        break;
      }
      offset += id.length;
      const size = readVintSize(data, offset);
      if (!size) {
        break;
      }
      offset += size.length;
      if (id.value === 0x1549A966) {
        infoOffset = offset;
        infoSize = size.value;
        break;
      }
      offset += size.value === -1 ? 0 : size.value;
    }

    if (infoOffset === null || infoSize === null || infoSize === -1) {
      return blob;
    }

    let durationOffset = null;
    let durationSize = null;
    const infoEnd = infoOffset + infoSize;
    offset = infoOffset;

    while (offset < infoEnd) {
      const id = readVintId(data, offset);
      if (!id) {
        break;
      }
      offset += id.length;
      const size = readVintSize(data, offset);
      if (!size) {
        break;
      }
      offset += size.length;
      if (id.value === 0x2AD7B1) {
        let scale = 0;
        for (let i = 0; i < size.value; i += 1) {
          scale = (scale << 8) + data[offset + i];
        }
        if (scale > 0) {
          timecodeScale = scale;
        }
      }
      if (id.value === 0x4489) {
        durationOffset = offset;
        durationSize = size.value;
        break;
      }
      offset += size.value;
    }

    if (durationOffset === null || !durationSize) {
      return blob;
    }

    const duration = (durationMs * 1000000) / timecodeScale;
    const view = new DataView(buffer);
    if (durationSize === 4) {
      view.setFloat32(durationOffset, duration);
    } else {
      view.setFloat64(durationOffset, duration);
    }

    return new Blob([buffer], { type: "video/webm" });
  };

  const finalizeFallClipData = async (chunks, senderId, fallStartedAt, headerChunk) => {
    if (!chunks || chunks.length === 0) {
      return;
    }
    const { data } = normalizeFallChunks(chunks, fallStartedAt, headerChunk);
    if (data.length === 0) {
      return;
    }
    const blob = new Blob(data, { type: "video/webm" });
    const timestamp = new Date(fallStartedAt || Date.now()).toISOString();
    void uploadClip(blob, senderId, timestamp, "fall");
  };

  const uploadClip = async (blob, senderId, timestamp, type = "fall") => {
    try {
      const response = await apiFetch("/api/fall-clips", {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Fall-Sender": senderId,
          "X-Fall-Timestamp": timestamp,
          "X-Clip-Type": type
        },
        body: blob
      });
      if (response.ok && getCurrentMode() === "exception") {
        await loadFallClips();
      }
    } catch (error) {
      // ignore
    }
  };

  return {
    startRecorder,
    stopRecorder,
    scheduleRecorderRoll,
    rollRecorder,
    startFallClip,
    finishFallClip,
    startManualRecording,
    stopManualRecording,
    finalizeFallClipData,
    finalizeManualClipData,
    normalizeFallChunks,
    fixWebmDuration,
    uploadClip
  };
};

export { createRecordingController };
