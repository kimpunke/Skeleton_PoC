package com.example.mediapipepose;

import android.Manifest;
import android.content.pm.PackageManager;
import android.graphics.Canvas;
import android.os.Bundle;
import android.util.Log;
import android.util.Size;
import androidx.camera.core.AspectRatio;
import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.Preview;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import android.widget.Button;
import android.widget.TextView;
import com.google.common.util.concurrent.ListenableFuture;
import com.google.mediapipe.framework.image.BitmapImageBuilder;
import com.google.mediapipe.framework.image.MPImage;
import com.google.mediapipe.tasks.core.BaseOptions;
import com.google.mediapipe.tasks.vision.core.ImageProcessingOptions;
import com.google.mediapipe.tasks.vision.core.RunningMode;
import com.google.mediapipe.tasks.vision.facelandmarker.FaceLandmarker;
import com.google.mediapipe.tasks.vision.facelandmarker.FaceLandmarker.FaceLandmarkerOptions;
import com.google.mediapipe.tasks.vision.facelandmarker.FaceLandmarkerResult;
import com.google.mediapipe.tasks.vision.handlandmarker.HandLandmarker;
import com.google.mediapipe.tasks.vision.handlandmarker.HandLandmarker.HandLandmarkerOptions;
import com.google.mediapipe.tasks.vision.handlandmarker.HandLandmarkerResult;
import com.google.mediapipe.tasks.components.containers.NormalizedLandmark;
import com.google.mediapipe.tasks.vision.poselandmarker.PoseLandmarker;
import com.google.mediapipe.tasks.vision.poselandmarker.PoseLandmarker.PoseLandmarkerOptions;
import com.google.mediapipe.tasks.vision.poselandmarker.PoseLandmarkerResult;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.webrtc.EglBase;
import org.webrtc.SurfaceViewRenderer;
import org.webrtc.VideoFrame;

public class MainActivity extends AppCompatActivity {
    private static final int REQUEST_CODE_CAMERA = 1001;
    private static final String MODEL_ASSET_PATH = "pose_landmarker_full.task";
    private static final String FACE_MODEL_ASSET_PATH = "face_landmarker.task";
    private static final String HAND_MODEL_ASSET_PATH = "hand_landmarker.task";
    private static final long CLASSIFY_INTERVAL_MS = 200;
    private static final float CROUCH_KNEE_ANGLE_THRESHOLD = 95f;
    private static final float CROUCH_KNEE_ANGLE_SOFT = 108f;
    private static final float SIT_KNEE_ANGLE_THRESHOLD = 140f;
    private static final float CROUCH_HIP_OFFSET = 0.03f;
    private static final float CROUCH_HIP_KNEE_SOFT = 0.05f;
    private static final float CROUCH_HIP_HEEL_THRESHOLD = 0.18f;
    private static final float CROUCH_MIN_CONFIDENCE = 0.6f;
    private static final float CROUCH_HIP_HEEL_X_THRESHOLD = 0.08f;
    private static final float WALKING_SPEED_THRESHOLD = 0.08f;
    private static final String TAG = "PoseTracking";

    private enum RenderMode {
        POSE,
        POSE_HAND,
        FACE,
        HAND
    }

    private PreviewView previewView;
    private PoseOverlayView overlayView;
    private TextView modeText;
    private TextView poseClassText;
    private SurfaceViewRenderer remoteView;
    private EglBase eglBase;
    private ExecutorService cameraExecutor;
    private PoseLandmarker poseLandmarker;
    private FaceLandmarker faceLandmarker;
    private HandLandmarker handLandmarker;
    private WebRtcStreamer webRtcStreamer;
    private ProcessCameraProvider cameraProvider;
    private CameraSelector currentCameraSelector = CameraSelector.DEFAULT_FRONT_CAMERA;
    private RenderMode currentMode = RenderMode.POSE;
    private long lastPoseLogTimestampMs = 0;
    private long lastClassificationTimestampMs = 0;
    private long lastPoseSendTimestampMs = 0;
    private String signalingUrl;
    private long lastAnkleTimestampMs = 0;
    private float lastLeftAnkleX = Float.NaN;
    private float lastLeftAnkleY = Float.NaN;
    private float lastRightAnkleX = Float.NaN;
    private float lastRightAnkleY = Float.NaN;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        previewView = findViewById(R.id.preview_view);
        overlayView = findViewById(R.id.overlay_view);
        overlayView.setMirror(true);
        modeText = findViewById(R.id.text_mode);
        poseClassText = findViewById(R.id.text_pose_class);
        remoteView = findViewById(R.id.remote_view);
        eglBase = EglBase.create();
        remoteView.init(eglBase.getEglBaseContext(), null);
        remoteView.setEnableHardwareScaler(true);
        Button switchButton = findViewById(R.id.button_switch_camera);
        switchButton.setOnClickListener(view -> switchCamera());
        Button modeButton = findViewById(R.id.button_switch_mode);
        modeButton.setOnClickListener(view -> switchMode());
        cameraExecutor = Executors.newSingleThreadExecutor();

        setupPoseLandmarker();
        signalingUrl = getString(R.string.signaling_url);
        webRtcStreamer = new WebRtcStreamer(this);
        webRtcStreamer.setRemoteRenderer(remoteView);
        webRtcStreamer.setPoseLabelListener(this::handleServerPoseLabel);
        webRtcStreamer.start(signalingUrl);

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
                == PackageManager.PERMISSION_GRANTED) {
            startCamera();
        } else {
            ActivityCompat.requestPermissions(
                    this,
                    new String[]{Manifest.permission.CAMERA},
                    REQUEST_CODE_CAMERA
            );
        }
    }

    private void setupPoseLandmarker() {
        PoseLandmarkerOptions options = PoseLandmarkerOptions.builder()
                .setBaseOptions(
                        BaseOptions.builder()
                                .setModelAssetPath(MODEL_ASSET_PATH)
                                .build())
                .setRunningMode(RunningMode.LIVE_STREAM)
                .setResultListener(this::onPoseResult)
                .setNumPoses(1)
                .build();

        poseLandmarker = PoseLandmarker.createFromOptions(this, options);

        FaceLandmarkerOptions faceOptions = FaceLandmarkerOptions.builder()
                .setBaseOptions(
                        BaseOptions.builder()
                                .setModelAssetPath(FACE_MODEL_ASSET_PATH)
                                .build())
                .setRunningMode(RunningMode.LIVE_STREAM)
                .setResultListener(this::onFaceResult)
                .setNumFaces(1)
                .build();

        faceLandmarker = FaceLandmarker.createFromOptions(this, faceOptions);

        HandLandmarkerOptions handOptions = HandLandmarkerOptions.builder()
                .setBaseOptions(
                        BaseOptions.builder()
                                .setModelAssetPath(HAND_MODEL_ASSET_PATH)
                                .build())
                .setRunningMode(RunningMode.LIVE_STREAM)
                .setResultListener(this::onHandResult)
                .setNumHands(2)
                .build();

        handLandmarker = HandLandmarker.createFromOptions(this, handOptions);
    }

    private void startCamera() {
        ListenableFuture<ProcessCameraProvider> cameraProviderFuture =
                ProcessCameraProvider.getInstance(this);

        cameraProviderFuture.addListener(() -> {
            try {
                cameraProvider = cameraProviderFuture.get();
                bindUseCases(currentCameraSelector);
            } catch (Exception exception) {
                Log.e(TAG, "Failed to get camera provider", exception);
            }
        }, ContextCompat.getMainExecutor(this));
    }

    private void bindUseCases(CameraSelector cameraSelector) {
        if (cameraProvider == null) {
            return;
        }

        Preview preview = new Preview.Builder().build();
        preview.setSurfaceProvider(previewView.getSurfaceProvider());

        ImageAnalysis imageAnalysis = new ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_RGBA_8888)
                .setTargetAspectRatio(AspectRatio.RATIO_4_3)
                .build();

        imageAnalysis.setAnalyzer(cameraExecutor, imageProxy -> {
            if (poseLandmarker == null || faceLandmarker == null || handLandmarker == null) {
                imageProxy.close();
                return;
            }

            int rotationDegrees = imageProxy.getImageInfo().getRotationDegrees();
            try {
                android.graphics.Bitmap bitmap =
                        ImageUtils.imageProxyToBitmap(imageProxy, rotationDegrees);
                if (bitmap == null) {
                    imageProxy.close();
                    return;
                }
                if (webRtcStreamer != null) {
                    android.graphics.Bitmap streamBitmap = bitmap.copy(android.graphics.Bitmap.Config.ARGB_8888, true);
                    if (streamBitmap != null) {
                        Canvas canvas = new Canvas(streamBitmap);
                        overlayView.drawOverlay(canvas, streamBitmap.getWidth(), streamBitmap.getHeight(), false);
                    }

                    org.webrtc.JavaI420Buffer i420Buffer = streamBitmap == null
                            ? ImageUtils.imageProxyToI420(imageProxy)
                            : ImageUtils.bitmapToI420(streamBitmap);
                    if (i420Buffer != null) {
                        int frameRotation = streamBitmap == null ? rotationDegrees : 0;
                        VideoFrame frame = new VideoFrame(i420Buffer, frameRotation, System.nanoTime());
                        webRtcStreamer.sendFrame(frame);
                        frame.release();
                    }
                }
                MPImage mpImage = new BitmapImageBuilder(bitmap).build();

                ImageProcessingOptions imageProcessingOptions =
                        ImageProcessingOptions.builder()
                                .setRotationDegrees(0)
                                .build();

                long timestamp = System.currentTimeMillis();
                if (currentMode == RenderMode.POSE) {
                    poseLandmarker.detectAsync(mpImage, imageProcessingOptions, timestamp);
                } else if (currentMode == RenderMode.POSE_HAND) {
                    poseLandmarker.detectAsync(mpImage, imageProcessingOptions, timestamp);
                    handLandmarker.detectAsync(mpImage, imageProcessingOptions, timestamp);
                } else if (currentMode == RenderMode.FACE) {
                    faceLandmarker.detectAsync(mpImage, imageProcessingOptions, timestamp);
                } else {
                    handLandmarker.detectAsync(mpImage, imageProcessingOptions, timestamp);
                }
            } catch (Exception ignored) {
                imageProxy.close();
                return;
            }
            imageProxy.close();
        });

        boolean isFront = cameraSelector == CameraSelector.DEFAULT_FRONT_CAMERA;
        overlayView.setMirror(isFront);

        cameraProvider.unbindAll();
        cameraProvider.bindToLifecycle(
                this,
                cameraSelector,
                preview,
                imageAnalysis
        );
    }

    private void switchCamera() {
        if (currentCameraSelector == CameraSelector.DEFAULT_FRONT_CAMERA) {
            currentCameraSelector = CameraSelector.DEFAULT_BACK_CAMERA;
        } else {
            currentCameraSelector = CameraSelector.DEFAULT_FRONT_CAMERA;
        }
        bindUseCases(currentCameraSelector);
    }

    private void onPoseResult(PoseLandmarkerResult result, MPImage inputImage) {
        if (result == null || inputImage == null) {
            overlayView.clear();
            return;
        }

        overlayView.setPoseResults(result, inputImage.getWidth(), inputImage.getHeight());
        sendPoseLandmarks(result);
        long now = System.currentTimeMillis();
        if (now - lastPoseLogTimestampMs < 1000) {
            return;
        }
        lastPoseLogTimestampMs = now;

        if (!result.landmarks().isEmpty()) {
            Log.d(TAG, formatPoseLandmarksLog(result.landmarks().get(0)));
        }
    }

    private String formatPoseLandmarksLog(List<NormalizedLandmark> landmarks) {
        StringBuilder builder = new StringBuilder();
        builder.append("pose_landmarks=");
        for (int i = 0; i < landmarks.size(); i++) {
            NormalizedLandmark landmark = landmarks.get(i);
            builder.append(i)
                    .append(":")
                    .append(landmark.x())
                    .append(",")
                    .append(landmark.y())
                    .append(",")
                    .append(landmark.z())
                    .append(";");
        }
        return builder.toString();
    }

    private void onFaceResult(FaceLandmarkerResult result, MPImage inputImage) {
        if (result == null || inputImage == null) {
            overlayView.clear();
            return;
        }

        overlayView.setFaceResults(result, inputImage.getWidth(), inputImage.getHeight());
    }

    private void onHandResult(HandLandmarkerResult result, MPImage inputImage) {
        if (result == null || inputImage == null) {
            overlayView.clear();
            return;
        }

        overlayView.setHandResults(result, inputImage.getWidth(), inputImage.getHeight());
    }

    private void updatePoseClassification(PoseLandmarkerResult result) {
        if (poseClassText == null) {
            return;
        }
        if (currentMode != RenderMode.POSE && currentMode != RenderMode.POSE_HAND) {
            overlayView.setPoseLabel("");
            return;
        }
        if (result.landmarks().isEmpty()) {
            overlayView.setPoseLabel("");
            runOnUiThread(this::clearPoseClassText);
            return;
        }
        long now = System.currentTimeMillis();
        if (now - lastClassificationTimestampMs < CLASSIFY_INTERVAL_MS) {
            return;
        }
        lastClassificationTimestampMs = now;
        String label = classifyPose(result.landmarks().get(0));
        if (label.equals(getString(R.string.pose_unknown))) {
            overlayView.setPoseLabel("");
        } else {
            overlayView.setPoseLabel(label);
        }
        runOnUiThread(() -> poseClassText.setText(label));
    }

    private void handleServerPoseLabel(String label) {
        if (poseClassText == null) {
            return;
        }
        runOnUiThread(() -> {
            if (currentMode != RenderMode.POSE && currentMode != RenderMode.POSE_HAND) {
                clearPoseClassText();
                overlayView.setPoseLabel("");
                return;
            }
            if (label == null || label.isEmpty() || label.equals(getString(R.string.pose_unknown))) {
                clearPoseClassText();
                overlayView.setPoseLabel("");
                return;
            }
            poseClassText.setText(label);
            overlayView.setPoseLabel(label);
        });
    }

    private void sendPoseLandmarks(PoseLandmarkerResult result) {
        if (webRtcStreamer == null || result == null || result.landmarks().isEmpty()) {
            return;
        }
        long now = System.currentTimeMillis();
        if (now - lastPoseSendTimestampMs < CLASSIFY_INTERVAL_MS) {
            return;
        }
        lastPoseSendTimestampMs = now;
        webRtcStreamer.sendPoseLandmarks(result.landmarks().get(0));
    }

    private String classifyPose(List<NormalizedLandmark> landmarks) {
        if (landmarks == null || landmarks.size() <= 30) {
            return getString(R.string.pose_unknown);
        }
        NormalizedLandmark leftShoulder = landmarks.get(11);
        NormalizedLandmark rightShoulder = landmarks.get(12);
        NormalizedLandmark leftHip = landmarks.get(23);
        NormalizedLandmark rightHip = landmarks.get(24);
        NormalizedLandmark leftKnee = landmarks.get(25);
        NormalizedLandmark rightKnee = landmarks.get(26);
        NormalizedLandmark leftAnkle = landmarks.get(27);
        NormalizedLandmark rightAnkle = landmarks.get(28);
        NormalizedLandmark leftHeel = landmarks.get(29);
        NormalizedLandmark rightHeel = landmarks.get(30);

        float shoulderX = (leftShoulder.x() + rightShoulder.x()) * 0.5f;
        float shoulderY = (leftShoulder.y() + rightShoulder.y()) * 0.5f;
        float hipX = (leftHip.x() + rightHip.x()) * 0.5f;
        float hipY = (leftHip.y() + rightHip.y()) * 0.5f;
        float kneeY = (leftKnee.y() + rightKnee.y()) * 0.5f;
        float heelX = (leftHeel.x() + rightHeel.x()) * 0.5f;
        float heelY = (leftHeel.y() + rightHeel.y()) * 0.5f;

        float torsoDx = Math.abs(shoulderX - hipX);
        float torsoDy = Math.abs(shoulderY - hipY);
        if (torsoDx > torsoDy * 1.2f) {
            return getString(R.string.pose_lying);
        }

        float leftKneeAngle = calculateAngle(leftHip, leftKnee, leftAnkle);
        float rightKneeAngle = calculateAngle(rightHip, rightKnee, rightAnkle);
        float kneeAngle = (leftKneeAngle + rightKneeAngle) * 0.5f;
        float hipKneeDelta = Math.abs(hipY - kneeY);
        float hipToHeel = Math.abs(heelY - hipY);
        float hipHeelDeltaX = Math.abs(hipX - heelX);
        boolean crouchReliable = isConfident(leftHip, CROUCH_MIN_CONFIDENCE)
                && isConfident(rightHip, CROUCH_MIN_CONFIDENCE)
                && isConfident(leftKnee, CROUCH_MIN_CONFIDENCE)
                && isConfident(rightKnee, CROUCH_MIN_CONFIDENCE)
                && isConfident(leftHeel, CROUCH_MIN_CONFIDENCE)
                && isConfident(rightHeel, CROUCH_MIN_CONFIDENCE);
        boolean tightCrouch = crouchReliable
                && kneeAngle < CROUCH_KNEE_ANGLE_THRESHOLD
                && hipKneeDelta < CROUCH_HIP_OFFSET
                && hipHeelDeltaX < CROUCH_HIP_HEEL_X_THRESHOLD;
        boolean lowHipCrouch = crouchReliable
                && kneeAngle < CROUCH_KNEE_ANGLE_SOFT
                && hipToHeel < CROUCH_HIP_HEEL_THRESHOLD
                && hipKneeDelta < CROUCH_HIP_KNEE_SOFT
                && hipHeelDeltaX < CROUCH_HIP_HEEL_X_THRESHOLD;
        if (tightCrouch || lowHipCrouch) {
            return getString(R.string.pose_crouching);
        }
        if (kneeAngle < SIT_KNEE_ANGLE_THRESHOLD) {
            return getString(R.string.pose_sitting);
        }
        if (isWalking(landmarks, kneeAngle)) {
            return getString(R.string.pose_walking);
        }
        return getString(R.string.pose_standing);
    }

    private boolean isWalking(List<NormalizedLandmark> landmarks, float kneeAngle) {
        if (landmarks.size() <= 28 || kneeAngle < 150f) {
            return false;
        }
        NormalizedLandmark leftAnkle = landmarks.get(27);
        NormalizedLandmark rightAnkle = landmarks.get(28);
        long now = System.currentTimeMillis();
        if (lastAnkleTimestampMs == 0) {
            lastAnkleTimestampMs = now;
            lastLeftAnkleX = leftAnkle.x();
            lastLeftAnkleY = leftAnkle.y();
            lastRightAnkleX = rightAnkle.x();
            lastRightAnkleY = rightAnkle.y();
            return false;
        }
        long deltaMs = now - lastAnkleTimestampMs;
        if (deltaMs <= 0) {
            return false;
        }
        float leftMove = distance(leftAnkle.x(), leftAnkle.y(), lastLeftAnkleX, lastLeftAnkleY);
        float rightMove = distance(rightAnkle.x(), rightAnkle.y(), lastRightAnkleX, lastRightAnkleY);
        float avgMove = (leftMove + rightMove) * 0.5f;
        float speed = avgMove / (deltaMs / 1000f);
        lastAnkleTimestampMs = now;
        lastLeftAnkleX = leftAnkle.x();
        lastLeftAnkleY = leftAnkle.y();
        lastRightAnkleX = rightAnkle.x();
        lastRightAnkleY = rightAnkle.y();
        return speed > WALKING_SPEED_THRESHOLD;
    }

    private float distance(float x1, float y1, float x2, float y2) {
        float dx = x1 - x2;
        float dy = y1 - y2;
        return (float) Math.sqrt(dx * dx + dy * dy);
    }

    private boolean isConfident(NormalizedLandmark landmark, float threshold) {
        if (landmark == null) {
            return false;
        }
        float visibility = 0f;
        float presence = 0f;
        java.util.Optional<Float> visibilityOpt = landmark.visibility();
        java.util.Optional<Float> presenceOpt = landmark.presence();
        if (visibilityOpt != null && visibilityOpt.isPresent()) {
            visibility = visibilityOpt.get();
        }
        if (presenceOpt != null && presenceOpt.isPresent()) {
            presence = presenceOpt.get();
        }
        return Math.max(visibility, presence) >= threshold;
    }

    private float calculateAngle(
            NormalizedLandmark first,
            NormalizedLandmark mid,
            NormalizedLandmark last) {
        float ax = first.x() - mid.x();
        float ay = first.y() - mid.y();
        float bx = last.x() - mid.x();
        float by = last.y() - mid.y();
        float dot = ax * bx + ay * by;
        float magA = (float) Math.sqrt(ax * ax + ay * ay);
        float magB = (float) Math.sqrt(bx * bx + by * by);
        if (magA < 1e-6f || magB < 1e-6f) {
            return 180f;
        }
        float cosine = dot / (magA * magB);
        cosine = Math.max(-1f, Math.min(1f, cosine));
        return (float) Math.toDegrees(Math.acos(cosine));
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (cameraExecutor != null) {
            cameraExecutor.shutdown();
        }
        if (poseLandmarker != null) {
            poseLandmarker.close();
        }
        if (faceLandmarker != null) {
            faceLandmarker.close();
        }
        if (handLandmarker != null) {
            handLandmarker.close();
        }
        if (webRtcStreamer != null) {
            webRtcStreamer.stop();
        }
        if (remoteView != null) {
            remoteView.release();
        }
        if (eglBase != null) {
            eglBase.release();
        }
    }

    @Override
    protected void onStart() {
        super.onStart();
        if (webRtcStreamer != null && signalingUrl != null) {
            webRtcStreamer.start(signalingUrl);
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
                == PackageManager.PERMISSION_GRANTED) {
            startCamera();
        }
    }

    @Override
    protected void onStop() {
        super.onStop();
        if (cameraProvider != null) {
            cameraProvider.unbindAll();
        }
        if (webRtcStreamer != null) {
            webRtcStreamer.stop();
        }
    }

    private void switchMode() {
        if (currentMode == RenderMode.POSE) {
            currentMode = RenderMode.POSE_HAND;
            modeText.setText(R.string.mode_pose_hand);
        } else if (currentMode == RenderMode.POSE_HAND) {
            currentMode = RenderMode.FACE;
            modeText.setText(R.string.mode_face);
        } else if (currentMode == RenderMode.FACE) {
            currentMode = RenderMode.HAND;
            modeText.setText(R.string.mode_hand);
        } else {
            currentMode = RenderMode.POSE;
            modeText.setText(R.string.mode_pose);
        }
        overlayView.setRenderMode(mapOverlayMode(currentMode));
        updatePoseClassTextForMode();
        overlayView.clear();
    }

    private PoseOverlayView.RenderMode mapOverlayMode(RenderMode renderMode) {
        if (renderMode == RenderMode.POSE_HAND) {
            return PoseOverlayView.RenderMode.POSE_HAND;
        }
        if (renderMode == RenderMode.FACE) {
            return PoseOverlayView.RenderMode.FACE;
        }
        if (renderMode == RenderMode.HAND) {
            return PoseOverlayView.RenderMode.HAND;
        }
        return PoseOverlayView.RenderMode.POSE;
    }

    private void updatePoseClassTextForMode() {
        if (poseClassText == null) {
            return;
        }
        if (currentMode != RenderMode.POSE) {
            clearPoseClassText();
            overlayView.setPoseLabel("");
            return;
        }
        clearPoseClassText();
        overlayView.setPoseLabel("");
    }

    private void clearPoseClassText() {
        if (poseClassText == null) {
            return;
        }
        poseClassText.setText(R.string.text_empty);
    }


    @Override
    public void onRequestPermissionsResult(
            int requestCode,
            @NonNull String[] permissions,
            @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQUEST_CODE_CAMERA
                && grantResults.length > 0
                && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            startCamera();
        }
    }
}
