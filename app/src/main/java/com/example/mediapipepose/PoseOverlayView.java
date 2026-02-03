package com.example.mediapipepose;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.util.AttributeSet;
import android.view.View;
import com.google.mediapipe.tasks.components.containers.NormalizedLandmark;
import com.google.mediapipe.tasks.vision.facelandmarker.FaceLandmarkerResult;
import com.google.mediapipe.tasks.vision.handlandmarker.HandLandmarkerResult;
import com.google.mediapipe.tasks.vision.poselandmarker.PoseLandmarkerResult;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

public class PoseOverlayView extends View {
    private static final float POSE_LANDMARK_RADIUS = 6f;
    private static final float FACE_LANDMARK_RADIUS = 3f;
    private static final float HAND_LANDMARK_RADIUS = 7f;
    private static final float LABEL_OFFSET_PX = 24f;
    private static final float MIN_LANDMARK_CONFIDENCE = 0.5f;
    private static final int[][] POSE_CONNECTIONS = new int[][]{
            {0, 1}, {1, 2}, {2, 3}, {3, 7},
            {0, 4}, {4, 5}, {5, 6}, {6, 8},
            {9, 10},
            {11, 12}, {11, 13}, {13, 15}, {15, 17}, {15, 19}, {15, 21}, {17, 19},
            {12, 14}, {14, 16}, {16, 18}, {16, 20}, {16, 22}, {18, 20},
            {11, 23}, {12, 24}, {23, 24},
            {23, 25}, {24, 26}, {25, 27}, {27, 29}, {29, 31},
            {26, 28}, {28, 30}, {30, 32}, {27, 31}, {28, 32}
    };

    public enum RenderMode {
        POSE,
        POSE_HAND,
        FACE,
        HAND
    }

    private final Paint linePaint = new Paint();
    private final Paint pointPaint = new Paint();
    private final Paint textPaint = new Paint();
    private final Object renderLock = new Object();

    private PoseLandmarkerResult poseResult;
    private FaceLandmarkerResult faceResult;
    private HandLandmarkerResult handResult;
    private String poseLabel = "";
    private int imageWidth;
    private int imageHeight;
    private boolean mirror;
    private RenderMode renderMode = RenderMode.POSE;

    public PoseOverlayView(Context context, AttributeSet attrs) {
        super(context, attrs);
        linePaint.setColor(0xFF00E676);
        linePaint.setStrokeWidth(4f);
        linePaint.setStyle(Paint.Style.STROKE);
        linePaint.setAntiAlias(true);

        pointPaint.setColor(0xFFFF5252);
        pointPaint.setStyle(Paint.Style.FILL);
        pointPaint.setAntiAlias(true);

        textPaint.setColor(0xFFFFFFFF);
        textPaint.setTextSize(32f);
        textPaint.setAntiAlias(true);
        textPaint.setShadowLayer(4f, 0f, 0f, 0xFF000000);
    }

    public void setPoseResults(PoseLandmarkerResult result, int imageWidth, int imageHeight) {
        synchronized (renderLock) {
            this.poseResult = result;
            this.imageWidth = imageWidth;
            this.imageHeight = imageHeight;
            this.faceResult = null;
            if (renderMode != RenderMode.POSE_HAND) {
                this.handResult = null;
                this.renderMode = RenderMode.POSE;
            }
        }
        postInvalidate();
    }

    public void setFaceResults(FaceLandmarkerResult result, int imageWidth, int imageHeight) {
        synchronized (renderLock) {
            this.poseResult = null;
            this.faceResult = result;
            this.handResult = null;
            this.imageWidth = imageWidth;
            this.imageHeight = imageHeight;
            this.renderMode = RenderMode.FACE;
        }
        postInvalidate();
    }

    public void setHandResults(HandLandmarkerResult result, int imageWidth, int imageHeight) {
        synchronized (renderLock) {
            this.faceResult = null;
            this.handResult = result;
            this.imageWidth = imageWidth;
            this.imageHeight = imageHeight;
            if (renderMode != RenderMode.POSE_HAND) {
                this.poseResult = null;
                this.renderMode = RenderMode.HAND;
            }
        }
        postInvalidate();
    }

    public void setRenderMode(RenderMode renderMode) {
        synchronized (renderLock) {
            this.renderMode = renderMode;
        }
    }

    public void setMirror(boolean mirror) {
        synchronized (renderLock) {
            this.mirror = mirror;
        }
        postInvalidate();
    }

    public void clear() {
        synchronized (renderLock) {
            this.poseResult = null;
            this.faceResult = null;
            this.handResult = null;
            this.poseLabel = "";
        }
        postInvalidate();
    }

    public void setPoseLabel(String label) {
        synchronized (renderLock) {
            this.poseLabel = label == null ? "" : label;
        }
        postInvalidate();
    }

    public void drawOverlay(Canvas canvas, int outputWidth, int outputHeight) {
        synchronized (renderLock) {
            drawToCanvas(canvas, outputWidth, outputHeight, mirror);
        }
    }

    public void drawOverlay(Canvas canvas, int outputWidth, int outputHeight, boolean mirrorOverride) {
        synchronized (renderLock) {
            drawToCanvas(canvas, outputWidth, outputHeight, mirrorOverride);
        }
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        synchronized (renderLock) {
            drawToCanvas(canvas, getWidth(), getHeight(), mirror);
        }
    }

    private void drawToCanvas(Canvas canvas, int outputWidth, int outputHeight, boolean mirrorOverride) {
        if (imageWidth == 0 || imageHeight == 0 || outputWidth == 0 || outputHeight == 0) {
            return;
        }

        float scale = Math.max(
                outputWidth / (float) imageWidth,
                outputHeight / (float) imageHeight
        );
        float offsetX = (outputWidth - imageWidth * scale) / 2f;
        float offsetY = (outputHeight - imageHeight * scale) / 2f;

        if (renderMode == RenderMode.POSE) {
            drawPose(canvas, scale, offsetX, offsetY, outputWidth, mirrorOverride);
        } else if (renderMode == RenderMode.POSE_HAND) {
            drawPose(canvas, scale, offsetX, offsetY, outputWidth, mirrorOverride);
            drawHands(canvas, scale, offsetX, offsetY, outputWidth, mirrorOverride);
        } else if (renderMode == RenderMode.FACE) {
            drawFace(canvas, scale, offsetX, offsetY, outputWidth, mirrorOverride);
        } else {
            drawHands(canvas, scale, offsetX, offsetY, outputWidth, mirrorOverride);
        }
    }

    private void drawPose(
            Canvas canvas,
            float scale,
            float offsetX,
            float offsetY,
            float canvasWidth,
            boolean mirrorOverride) {
        if (poseResult == null || poseResult.landmarks().isEmpty()) {
            return;
        }

        List<NormalizedLandmark> landmarks = poseResult.landmarks().get(0);
        if (landmarks == null || landmarks.isEmpty()) {
            return;
        }

        List<float[]> points = new ArrayList<>(landmarks.size());
        for (NormalizedLandmark landmark : landmarks) {
            if (!isLandmarkConfident(landmark)) {
                points.add(null);
                continue;
            }
            float x = landmark.x() * imageWidth * scale + offsetX;
            float y = landmark.y() * imageHeight * scale + offsetY;
            if (mirrorOverride) {
                x = canvasWidth - x;
            }
            points.add(new float[]{x, y});
        }

        for (int[] connection : POSE_CONNECTIONS) {
            if (connection[0] < points.size() && connection[1] < points.size()) {
                float[] start = points.get(connection[0]);
                float[] end = points.get(connection[1]);
                if (start != null && end != null) {
                    canvas.drawLine(start[0], start[1], end[0], end[1], linePaint);
                }
            }
        }

        drawPoseLabel(canvas, points, canvasWidth);

        for (float[] point : points) {
            if (point != null) {
                canvas.drawCircle(point[0], point[1], POSE_LANDMARK_RADIUS, pointPaint);
            }
        }
    }

    private void drawPoseLabel(Canvas canvas, List<float[]> points, float canvasWidth) {
        if (poseLabel == null || poseLabel.isEmpty()) {
            return;
        }

        int[] headIndices = new int[]{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10};
        float minY = Float.MAX_VALUE;
        float sumX = 0f;
        int count = 0;
        for (int index : headIndices) {
            if (index >= points.size()) {
                continue;
            }
            float[] point = points.get(index);
            if (point == null) {
                continue;
            }
            sumX += point[0];
            minY = Math.min(minY, point[1]);
            count++;
        }
        if (count == 0) {
            return;
        }
        float centerX = sumX / count;
        float textWidth = textPaint.measureText(poseLabel);
        float drawX = centerX - textWidth * 0.5f;
        if (drawX < 0f) {
            drawX = 0f;
        } else if (drawX + textWidth > canvasWidth) {
            drawX = canvasWidth - textWidth;
        }
        float drawY = minY - LABEL_OFFSET_PX;
        if (drawY < textPaint.getTextSize()) {
            drawY = textPaint.getTextSize();
        }
        canvas.drawText(poseLabel, drawX, drawY, textPaint);
    }

    private void drawFace(
            Canvas canvas,
            float scale,
            float offsetX,
            float offsetY,
            float canvasWidth,
            boolean mirrorOverride) {
        if (faceResult == null || faceResult.faceLandmarks().isEmpty()) {
            return;
        }

        for (List<NormalizedLandmark> landmarks : faceResult.faceLandmarks()) {
            for (NormalizedLandmark landmark : landmarks) {
                if (!isLandmarkConfident(landmark)) {
                    continue;
                }
                float x = landmark.x() * imageWidth * scale + offsetX;
                float y = landmark.y() * imageHeight * scale + offsetY;
                if (mirrorOverride) {
                    x = canvasWidth - x;
                }
                canvas.drawCircle(x, y, FACE_LANDMARK_RADIUS, pointPaint);
            }
        }
    }

    private void drawHands(
            Canvas canvas,
            float scale,
            float offsetX,
            float offsetY,
            float canvasWidth,
            boolean mirrorOverride) {
        if (handResult == null || handResult.landmarks().isEmpty()) {
            return;
        }

        int[][] handConnections = new int[][]{
                {0, 1}, {1, 2}, {2, 3}, {3, 4},
                {0, 5}, {5, 6}, {6, 7}, {7, 8},
                {0, 9}, {9, 10}, {10, 11}, {11, 12},
                {0, 13}, {13, 14}, {14, 15}, {15, 16},
                {0, 17}, {17, 18}, {18, 19}, {19, 20}
        };

        for (List<NormalizedLandmark> landmarks : handResult.landmarks()) {
            List<float[]> points = new ArrayList<>(landmarks.size());
            for (NormalizedLandmark landmark : landmarks) {
                if (!isLandmarkConfident(landmark)) {
                    points.add(null);
                    continue;
                }
                float x = landmark.x() * imageWidth * scale + offsetX;
                float y = landmark.y() * imageHeight * scale + offsetY;
                if (mirrorOverride) {
                    x = canvasWidth - x;
                }
                points.add(new float[]{x, y});
            }

            for (int[] connection : handConnections) {
                if (connection[0] < points.size() && connection[1] < points.size()) {
                    float[] start = points.get(connection[0]);
                    float[] end = points.get(connection[1]);
                    if (start != null && end != null) {
                        canvas.drawLine(start[0], start[1], end[0], end[1], linePaint);
                    }
                }
            }

            for (float[] point : points) {
                if (point != null) {
                    canvas.drawCircle(point[0], point[1], HAND_LANDMARK_RADIUS, pointPaint);
                }
            }
        }
    }

    private boolean isLandmarkConfident(NormalizedLandmark landmark) {
        if (renderMode != RenderMode.POSE) {
            return true;
        }
        float visibility = 0f;
        float presence = 0f;
        Optional<Float> visibilityOpt = landmark.visibility();
        Optional<Float> presenceOpt = landmark.presence();
        if (visibilityOpt != null && visibilityOpt.isPresent()) {
            visibility = visibilityOpt.get();
        }
        if (presenceOpt != null && presenceOpt.isPresent()) {
            presence = presenceOpt.get();
        }
        float confidence = Math.max(visibility, presence);
        return confidence >= MIN_LANDMARK_CONFIDENCE;
    }
}
