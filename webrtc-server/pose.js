const MIN_POSE_LANDMARKS = 31;
const CROUCH_KNEE_ANGLE_THRESHOLD = 95;
const CROUCH_KNEE_ANGLE_SOFT = 108;
const SIT_KNEE_ANGLE_THRESHOLD = 140;
const CROUCH_HIP_OFFSET = 0.03;
const CROUCH_HIP_KNEE_SOFT = 0.05;
const CROUCH_HIP_HEEL_THRESHOLD = 0.18;
const CROUCH_HIP_HEEL_X_THRESHOLD = 0.08;
const CROUCH_MIN_CONFIDENCE = 0.6;
const WALKING_SPEED_THRESHOLD = 0.08;
const FALL_UPRIGHT_FRAMES = 12;
const FALL_IMPULSE_FRAMES = 14;
const FALL_POST_FRAMES = 24;
const FALL_POST_STILL_FRAMES = 16;
const FALL_POST_TIMEOUT_FRAMES = 36;
const FALL_RECOVERY_FRAMES = 18;
const FALL_HIP_DROP_THRESHOLD = 0.2;
const FALL_DOWN_SPEED_THRESHOLD = 1.0;
const FALL_STILL_SPEED_THRESHOLD = 0.2;
const FALL_MIN_BBOX_HEIGHT = 0.15;
const FALL_ANGLE_CHANGE_THRESHOLD = 50;
const FALL_ASPECT_CHANGE_THRESHOLD = 0.55;
const FALL_UPRIGHT_ANGLE = 22;
const FALL_LYING_ANGLE = 65;
const FALL_UPRIGHT_ASPECT = 1.4;
const FALL_LYING_ASPECT = 1.05;

const getLandmark = (landmarks, index) => {
  if (!Array.isArray(landmarks) || index < 0 || index >= landmarks.length) {
    return null;
  }
  const entry = landmarks[index];
  if (!Array.isArray(entry) || entry.length < 3) {
    return null;
  }
  const x = Number(entry[0]);
  const y = Number(entry[1]);
  const z = Number(entry[2]);
  const visibility = Number(entry[3] !== undefined ? entry[3] : 0);
  const presence = Number(entry[4] !== undefined ? entry[4] : 0);
  if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z)) {
    return null;
  }
  return { x, y, z, visibility, presence };
};

const isConfident = (landmark, threshold) => {
  if (!landmark) {
    return false;
  }
  const visibility = Number.isNaN(landmark.visibility) ? 0 : landmark.visibility;
  const presence = Number.isNaN(landmark.presence) ? 0 : landmark.presence;
  return Math.max(visibility, presence) >= threshold;
};

const calculateAngle = (first, mid, last) => {
  if (!first || !mid || !last) {
    return 180;
  }
  const ax = first.x - mid.x;
  const ay = first.y - mid.y;
  const bx = last.x - mid.x;
  const by = last.y - mid.y;
  const dot = ax * bx + ay * by;
  const magA = Math.sqrt(ax * ax + ay * ay);
  const magB = Math.sqrt(bx * bx + by * by);
  if (magA < 1e-6 || magB < 1e-6) {
    return 180;
  }
  let cosine = dot / (magA * magB);
  cosine = Math.max(-1, Math.min(1, cosine));
  return Math.acos(cosine) * (180 / Math.PI);
};

const distance = (x1, y1, x2, y2) => {
  const dx = x1 - x2;
  const dy = y1 - y2;
  return Math.sqrt(dx * dx + dy * dy);
};

const isWalking = (landmarks, senderState, kneeAngle) => {
  if (!senderState || kneeAngle < 150) {
    return false;
  }
  const leftAnkle = getLandmark(landmarks, 27);
  const rightAnkle = getLandmark(landmarks, 28);
  if (!leftAnkle || !rightAnkle) {
    return false;
  }
  const now = Date.now();
  if (!senderState.lastAnkleTimestampMs) {
    senderState.lastAnkleTimestampMs = now;
    senderState.lastLeftAnkle = leftAnkle;
    senderState.lastRightAnkle = rightAnkle;
    return false;
  }
  const deltaMs = now - senderState.lastAnkleTimestampMs;
  if (deltaMs <= 0) {
    return false;
  }
  const leftMove = distance(
    leftAnkle.x,
    leftAnkle.y,
    senderState.lastLeftAnkle.x,
    senderState.lastLeftAnkle.y
  );
  const rightMove = distance(
    rightAnkle.x,
    rightAnkle.y,
    senderState.lastRightAnkle.x,
    senderState.lastRightAnkle.y
  );
  const avgMove = (leftMove + rightMove) * 0.5;
  const speed = avgMove / (deltaMs / 1000);
  senderState.lastAnkleTimestampMs = now;
  senderState.lastLeftAnkle = leftAnkle;
  senderState.lastRightAnkle = rightAnkle;
  return speed > WALKING_SPEED_THRESHOLD;
};

const recordFallHistory = (senderState, comY, downSpeed, torsoAngle, aspectRatio) => {
  if (!senderState) {
    return;
  }
  const index = senderState.fallHistoryIndex || 0;
  senderState.comYHistory[index] = comY;
  senderState.downSpeedHistory[index] = downSpeed;
  senderState.angleHistory[index] = torsoAngle;
  senderState.aspectHistory[index] = aspectRatio;
  senderState.fallHistoryIndex = (index + 1) % FALL_IMPULSE_FRAMES;
  senderState.fallHistoryCount = Math.min(
    (senderState.fallHistoryCount || 0) + 1,
    FALL_IMPULSE_FRAMES
  );
};

const isFallImpulse = (senderState, comY, normHeight) => {
  if (!senderState || senderState.fallHistoryCount < FALL_IMPULSE_FRAMES) {
    return false;
  }
  let minComY = senderState.comYHistory[0];
  let minAngle = senderState.angleHistory[0];
  let maxAngle = senderState.angleHistory[0];
  let minAspect = senderState.aspectHistory[0];
  let maxAspect = senderState.aspectHistory[0];
  let maxDownSpeed = senderState.downSpeedHistory[0];
  for (let i = 1; i < senderState.fallHistoryCount; i += 1) {
    minComY = Math.min(minComY, senderState.comYHistory[i]);
    minAngle = Math.min(minAngle, senderState.angleHistory[i]);
    maxAngle = Math.max(maxAngle, senderState.angleHistory[i]);
    minAspect = Math.min(minAspect, senderState.aspectHistory[i]);
    maxAspect = Math.max(maxAspect, senderState.aspectHistory[i]);
    maxDownSpeed = Math.max(maxDownSpeed, senderState.downSpeedHistory[i]);
  }
  const hipDrop = (comY - minComY) / normHeight;
  const angleChange = maxAngle - minAngle;
  const aspectChange = maxAspect - minAspect;
  return hipDrop > FALL_HIP_DROP_THRESHOLD
    && maxDownSpeed > FALL_DOWN_SPEED_THRESHOLD
    && angleChange > FALL_ANGLE_CHANGE_THRESHOLD
    && aspectChange > FALL_ASPECT_CHANGE_THRESHOLD;
};

const updateFallState = (senderState, comX, comY, torsoAngle, aspectRatio, bboxHeight, now) => {
  if (!senderState) {
    return false;
  }
  const normHeight = Math.max(bboxHeight, FALL_MIN_BBOX_HEIGHT);
  let downSpeed = 0;
  let speed = 0;
  if (senderState.lastFallSampleTimestampMs) {
    const dt = (now - senderState.lastFallSampleTimestampMs) / 1000;
    if (dt > 0) {
      const dx = comX - senderState.lastComX;
      const dy = comY - senderState.lastComY;
      speed = Math.hypot(dx, dy) / dt / normHeight;
      downSpeed = dy / dt / normHeight;
    }
  }
  senderState.lastComX = comX;
  senderState.lastComY = comY;
  senderState.lastFallSampleTimestampMs = now;

  recordFallHistory(senderState, comY, downSpeed, torsoAngle, aspectRatio);
  const upright = torsoAngle < FALL_UPRIGHT_ANGLE && aspectRatio > FALL_UPRIGHT_ASPECT;
  const lying = torsoAngle > FALL_LYING_ANGLE && aspectRatio < FALL_LYING_ASPECT;
  const fallImpulse = isFallImpulse(senderState, comY, normHeight);

  switch (senderState.fallState) {
    case "IDLE":
      if (upright) {
        senderState.uprightFrames += 1;
        if (senderState.uprightFrames >= FALL_UPRIGHT_FRAMES) {
          senderState.fallState = "ARMED";
        }
      } else {
        senderState.uprightFrames = 0;
      }
      break;
    case "ARMED":
      if (fallImpulse) {
        senderState.fallState = "POST";
        senderState.postFrames = 0;
        senderState.postTimeoutFrames = 0;
      }
      if (!upright) {
        senderState.uprightFrames = 0;
      }
      break;
    case "POST":
      if (lying) {
        senderState.postFrames += 1;
        if (speed < FALL_STILL_SPEED_THRESHOLD) {
          senderState.postStillFrames += 1;
        } else {
          senderState.postStillFrames = 0;
        }
        senderState.postTimeoutFrames = 0;
      } else {
        senderState.postFrames = 0;
        senderState.postStillFrames = 0;
        senderState.postTimeoutFrames += 1;
      }
      if (senderState.postFrames >= FALL_POST_FRAMES
          && senderState.postStillFrames >= FALL_POST_STILL_FRAMES) {
        senderState.fallState = "FALLEN";
        senderState.recoveryFrames = 0;
      } else if (senderState.postTimeoutFrames >= FALL_POST_TIMEOUT_FRAMES) {
        resetFallState(senderState);
      }
      break;
    case "FALLEN":
      if (upright) {
        senderState.recoveryFrames += 1;
        if (senderState.recoveryFrames >= FALL_RECOVERY_FRAMES) {
          resetFallState(senderState);
        }
      } else {
        senderState.recoveryFrames = 0;
      }
      break;
    default:
      break;
  }

  return senderState.fallState === "FALLEN";
};

const resetFallState = (senderState) => {
  senderState.fallState = "IDLE";
  senderState.uprightFrames = 0;
  senderState.postFrames = 0;
  senderState.postStillFrames = 0;
  senderState.postTimeoutFrames = 0;
  senderState.recoveryFrames = 0;
};

const classifyPose = (landmarks, senderState) => {
  if (!Array.isArray(landmarks) || landmarks.length < MIN_POSE_LANDMARKS) {
    return "Unknown";
  }

  const leftShoulder = getLandmark(landmarks, 11);
  const rightShoulder = getLandmark(landmarks, 12);
  const leftHip = getLandmark(landmarks, 23);
  const rightHip = getLandmark(landmarks, 24);
  const leftKnee = getLandmark(landmarks, 25);
  const rightKnee = getLandmark(landmarks, 26);
  const leftAnkle = getLandmark(landmarks, 27);
  const rightAnkle = getLandmark(landmarks, 28);
  const leftHeel = getLandmark(landmarks, 29);
  const rightHeel = getLandmark(landmarks, 30);

  if (!leftShoulder || !rightShoulder || !leftHip || !rightHip
      || !leftKnee || !rightKnee || !leftAnkle || !rightAnkle
      || !leftHeel || !rightHeel) {
    return "Unknown";
  }

  const shoulderX = (leftShoulder.x + rightShoulder.x) * 0.5;
  const shoulderY = (leftShoulder.y + rightShoulder.y) * 0.5;
  const hipX = (leftHip.x + rightHip.x) * 0.5;
  const hipY = (leftHip.y + rightHip.y) * 0.5;
  const kneeY = (leftKnee.y + rightKnee.y) * 0.5;
  const heelX = (leftHeel.x + rightHeel.x) * 0.5;
  const heelY = (leftHeel.y + rightHeel.y) * 0.5;

  const torsoDx = Math.abs(shoulderX - hipX);
  const torsoDy = Math.abs(shoulderY - hipY);
  const torsoAngle = Math.atan2(torsoDx, torsoDy) * (180 / Math.PI);
  const comX = (shoulderX + hipX) * 0.5;
  const comY = (shoulderY + hipY) * 0.5;
  let minX = 1;
  let maxX = 0;
  let minY = 1;
  let maxY = 0;
  for (const entry of landmarks) {
    if (!Array.isArray(entry) || entry.length < 2) {
      continue;
    }
    const x = Number(entry[0]);
    const y = Number(entry[1]);
    if (Number.isNaN(x) || Number.isNaN(y)) {
      continue;
    }
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const bboxWidth = Math.max(maxX - minX, 1e-6);
  const bboxHeight = Math.max(maxY - minY, 1e-6);
  const aspectRatio = bboxHeight / bboxWidth;
  const torsoHorizontal = torsoDx > torsoDy * 1.2;
  const now = Date.now();
  if (updateFallState(senderState, comX, comY, torsoAngle, aspectRatio, bboxHeight, now)) {
    return "Fallen";
  }
  if (torsoHorizontal) {
    return "Lying";
  }

  const leftKneeAngle = calculateAngle(leftHip, leftKnee, leftAnkle);
  const rightKneeAngle = calculateAngle(rightHip, rightKnee, rightAnkle);
  const kneeAngle = (leftKneeAngle + rightKneeAngle) * 0.5;
  const hipKneeDelta = Math.abs(hipY - kneeY);
  const hipToHeel = Math.abs(heelY - hipY);
  const hipHeelDeltaX = Math.abs(hipX - heelX);
  const crouchReliable = isConfident(leftHip, CROUCH_MIN_CONFIDENCE)
    && isConfident(rightHip, CROUCH_MIN_CONFIDENCE)
    && isConfident(leftKnee, CROUCH_MIN_CONFIDENCE)
    && isConfident(rightKnee, CROUCH_MIN_CONFIDENCE)
    && isConfident(leftHeel, CROUCH_MIN_CONFIDENCE)
    && isConfident(rightHeel, CROUCH_MIN_CONFIDENCE);
  const tightCrouch = crouchReliable
    && kneeAngle < CROUCH_KNEE_ANGLE_THRESHOLD
    && hipKneeDelta < CROUCH_HIP_OFFSET
    && hipHeelDeltaX < CROUCH_HIP_HEEL_X_THRESHOLD;
  const lowHipCrouch = crouchReliable
    && kneeAngle < CROUCH_KNEE_ANGLE_SOFT
    && hipToHeel < CROUCH_HIP_HEEL_THRESHOLD
    && hipKneeDelta < CROUCH_HIP_KNEE_SOFT
    && hipHeelDeltaX < CROUCH_HIP_HEEL_X_THRESHOLD;
  if (tightCrouch || lowHipCrouch) {
    return "Crouching";
  }
  if (kneeAngle < SIT_KNEE_ANGLE_THRESHOLD) {
    return "Sitting";
  }
  if (isWalking(landmarks, senderState, kneeAngle)) {
    return "Walking";
  }
  return "Standing";
};

const createSenderState = () => ({
  lastAnkleTimestampMs: 0,
  lastLeftAnkle: null,
  lastRightAnkle: null,
  comYHistory: new Array(FALL_IMPULSE_FRAMES).fill(0),
  downSpeedHistory: new Array(FALL_IMPULSE_FRAMES).fill(0),
  angleHistory: new Array(FALL_IMPULSE_FRAMES).fill(0),
  aspectHistory: new Array(FALL_IMPULSE_FRAMES).fill(0),
  fallHistoryIndex: 0,
  fallHistoryCount: 0,
  uprightFrames: 0,
  postFrames: 0,
  postStillFrames: 0,
  postTimeoutFrames: 0,
  recoveryFrames: 0,
  lastComX: 0,
  lastComY: 0,
  lastFallSampleTimestampMs: 0,
  fallState: "IDLE"
});

export {
  classifyPose,
  createSenderState
};
