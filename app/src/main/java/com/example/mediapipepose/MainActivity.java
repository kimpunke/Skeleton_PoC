package com.example.mediapipepose;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.util.Log;
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
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends AppCompatActivity {
    private static final int REQUEST_CODE_CAMERA = 1001;
    private static final String MODEL_ASSET_PATH = "pose_landmarker_full.task";
    private static final String FACE_MODEL_ASSET_PATH = "face_landmarker.task";
    private static final String HAND_MODEL_ASSET_PATH = "hand_landmarker.task";
    private static final String TAG = "PoseTracking";

    private enum RenderMode {
        POSE,
        FACE,
        HAND
    }

    private PreviewView previewView;
    private PoseOverlayView overlayView;
    private TextView modeText;
    private ExecutorService cameraExecutor;
    private PoseLandmarker poseLandmarker;
    private FaceLandmarker faceLandmarker;
    private HandLandmarker handLandmarker;
    private ProcessCameraProvider cameraProvider;
    private CameraSelector currentCameraSelector = CameraSelector.DEFAULT_FRONT_CAMERA;
    private RenderMode currentMode = RenderMode.POSE;
    private long lastPoseLogTimestampMs = 0;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        previewView = findViewById(R.id.preview_view);
        overlayView = findViewById(R.id.overlay_view);
        overlayView.setMirror(true);
        modeText = findViewById(R.id.text_mode);
        Button switchButton = findViewById(R.id.button_switch_camera);
        switchButton.setOnClickListener(view -> switchCamera());
        Button modeButton = findViewById(R.id.button_switch_mode);
        modeButton.setOnClickListener(view -> switchMode());
        cameraExecutor = Executors.newSingleThreadExecutor();

        setupPoseLandmarker();

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
                .setNumHands(1)
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
                exception.printStackTrace();
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
                MPImage mpImage = new BitmapImageBuilder(bitmap).build();

                ImageProcessingOptions imageProcessingOptions =
                        ImageProcessingOptions.builder()
                                .setRotationDegrees(0)
                                .build();

                long timestamp = System.currentTimeMillis();
                if (currentMode == RenderMode.POSE) {
                    poseLandmarker.detectAsync(mpImage, imageProcessingOptions, timestamp);
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
        long now = System.currentTimeMillis();
        if (now - lastPoseLogTimestampMs < 1000) {
            return;
        }
        lastPoseLogTimestampMs = now;

        if (!result.landmarks().isEmpty()) {
            StringBuilder builder = new StringBuilder();
            builder.append("pose_landmarks=");
            for (int i = 0; i < result.landmarks().get(0).size(); i++) {
                NormalizedLandmark landmark = result.landmarks().get(0).get(i);
                builder.append(i)
                        .append(":")
                        .append(landmark.x())
                        .append(",")
                        .append(landmark.y())
                        .append(",")
                        .append(landmark.z())
                        .append(";");
            }
            Log.d(TAG, builder.toString());
        }
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
    }

    private void switchMode() {
        if (currentMode == RenderMode.POSE) {
            currentMode = RenderMode.FACE;
            modeText.setText("Face");
        } else if (currentMode == RenderMode.FACE) {
            currentMode = RenderMode.HAND;
            modeText.setText("Hand");
        } else {
            currentMode = RenderMode.POSE;
            modeText.setText("Pose");
        }
        overlayView.clear();
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
